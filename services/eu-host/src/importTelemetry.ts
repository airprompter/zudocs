/**
 * The import timer's work on the eu-west host: the air-gapped host's telemetry exports, carried from the exchange
 * bucket to AirPrompter. Every run lists `telemetry/` in the bucket (ap-southeast-1, read by this host's role), takes
 * each object it has not imported before — the ledger is a marker object per export under `imports/` in the same
 * bucket, so a replaced instance does not import (and heartbeat for) a month of exports again — downloads it to a
 * 0600 inbox file and runs the released CLI's `airprompter import-telemetry` on it, which heartbeats as each offline
 * instance the document carries (`syncMode: offline`) for an upload grant and posts the segments through it: the
 * air-gapped instance appears on AirPrompter's fleet page with its windows although it never had a wire. The
 * platform is idempotent by key (importing a file twice changes nothing); the ledger keeps this host from paying
 * the heartbeat twice. Anything but a clean import — the platform's "retry later", a refused segment, a network
 * failure, a CLI that did not answer — is retried on the next pass, up to `IMPORT_MAX_ATTEMPTS`, then recorded as
 * failed with a marker. Every file is a `telemetry_imported` timeline row and the host's status row gets an
 * `imports` part.
 *
 * The Agent key reaches the CLI's environment and nothing else: systemd hands this unit the daemon's root-only env
 * file as a credential (`LoadCredential=`), the script reads the value from `$CREDENTIALS_DIRECTORY` and passes it
 * to the child process only. The pass is built over ports (`importPass`) so a test drives it with fakes. Logs are
 * JSON lines with counts, ids and outcomes — never a row, never the key.
 *
 * @example
 * ```sh
 * # as the airprompter user, with /etc/airprompter/zudocs.env in the environment and the credential mounted (systemd: zudocs-import.service)
 * node /opt/zudocs/import.mjs
 * ```
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createStore } from "../../desk-api/src/store.js";
import { readHostEnv, type HostEnv } from "./hostEnv.js";

const log = (event: Record<string, unknown>) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), source: "zudocs-import", ...event }) + "\n");
/** An import that did not come back clean is retried this many passes, then recorded as failed (a marker is written either way). */
export const IMPORT_MAX_ATTEMPTS = 5;
/** The exports, and the ledger of what was imported, in the exchange bucket. */
export const TELEMETRY_PREFIX = "telemetry/";
export const IMPORTS_PREFIX = "imports/";

/** The CLI's `--json` answer to `import-telemetry`, the fields this host records. */
export interface ImportReport {
  segments: number;
  uploaded: number;
  refused: number;
  quarantined: number;
  instances: Array<{ instanceId: string; segments: number; uploaded: number; grant: string | null }>;
  retryAfterSeconds?: number;
}

/** The marker's name for an object key: one path segment, the key's characters that are safe in a file name. */
export const markerNameOf = (key: string): string => key.replace(/[^A-Za-z0-9._-]+/g, "_");

/** The Agent key from the mounted credential (`AIRPROMPTER_AGENT_KEY=…` on one line) or, for an operator's manual run, the environment. Never logged. */
export function agentKeyFrom(env: NodeJS.ProcessEnv, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): string {
  if (env.AIRPROMPTER_AGENT_KEY?.trim()) return env.AIRPROMPTER_AGENT_KEY.trim();
  const dir = env.CREDENTIALS_DIRECTORY;
  if (!dir) throw new Error("no Agent key: neither CREDENTIALS_DIRECTORY (systemd's LoadCredential) nor AIRPROMPTER_AGENT_KEY is set");
  const text = readFile(join(dir, "airprompterd.env"));
  const match = /^AIRPROMPTER_AGENT_KEY=(\S+)\s*$/m.exec(text);
  if (!match) throw new Error("the mounted credential does not carry AIRPROMPTER_AGENT_KEY=… (zudocs-agent-key writes it before every daemon start)");
  return match[1]!;
}

/** The CLI's JSON output parsed to the report; a missing or malformed field is a refusal to record, never a guess. */
export function parseImportReport(stdout: string): ImportReport {
  const parsed = JSON.parse(stdout) as Partial<ImportReport>;
  const n = (value: unknown, name: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`import-telemetry --json: ${name} is not a number`);
    return value;
  };
  return {
    segments: n(parsed.segments, "segments"),
    uploaded: n(parsed.uploaded, "uploaded"),
    refused: n(parsed.refused, "refused"),
    quarantined: n(parsed.quarantined, "quarantined"),
    instances: Array.isArray(parsed.instances) ? parsed.instances.map((i) => ({ instanceId: String(i.instanceId), segments: n(i.segments, "instances.segments"), uploaded: n(i.uploaded, "instances.uploaded"), grant: typeof i.grant === "string" ? i.grant : null })) : [],
    ...(typeof parsed.retryAfterSeconds === "number" ? { retryAfterSeconds: parsed.retryAfterSeconds } : {}),
  };
}

export type ImportOutcome = "imported" | "held" | "failed";

/** The verdict on one CLI run: clean (exit 0) is imported; anything else is held for another pass until the attempts run out. Pure. */
export function outcomeOf(run: { status: number | null; error?: Error | undefined }, report: ImportReport | null, attempts: number): { outcome: ImportOutcome; why: string } {
  if (!run.error && run.status === 0 && report && report.refused === 0) return { outcome: "imported", why: "clean" };
  const why = run.error ? `the CLI did not run: ${run.error.message}` : report?.retryAfterSeconds !== undefined ? `the platform asked to retry in ${report.retryAfterSeconds}s` : report && report.refused > 0 ? `${report.refused} segment(s) refused` : report ? `exit ${run.status}` : `exit ${run.status}, no report`;
  return { outcome: attempts + 1 >= IMPORT_MAX_ATTEMPTS ? "failed" : "held", why };
}

export interface ImportPorts {
  hostId: string;
  scope: { organizationId: string; agentId: string; environment: string };
  baseUrl: string;
  listExports(): Promise<string[]>;
  listMarkers(): Promise<Set<string>>;
  getObject(key: string): Promise<string>;
  putMarker(name: string, body: string): Promise<void>;
  /** The attempts so far for a marker name, kept locally between passes (a held import); reset when the marker is written. */
  attempts(name: string): number;
  setAttempts(name: string, count: number): void;
  /** Write the inbox file (0600), run the CLI on it with the key in its environment only, remove the file. */
  runCli(file: string, text: string, apiKey: string): { status: number | null; stdout: string; stderr: string; error?: Error | undefined };
  inboxPath(name: string): string;
  appendEvent(event: Record<string, unknown> & { at: string; kind: string; host: string }): Promise<void>;
  updateStatus(hostId: string, fields: Record<string, unknown>): Promise<void>;
  apiKey(): string;
  now(): string;
  log(event: Record<string, unknown>): void;
}

export interface ImportPassResult {
  objects: number;
  pending: number;
  imported: number;
  results: Array<Record<string, unknown>>;
}

/** One pass over the exchange's exports: each new one through the CLI, the ledger, the timeline, the status row. */
export async function importPass(p: ImportPorts): Promise<ImportPassResult> {
  const apiKey = p.apiKey();
  const keys = (await p.listExports()).filter((key) => /\.aptelemetry$/.test(key)).sort();
  const markers = await p.listMarkers();
  const pending = keys.filter((key) => !markers.has(markerNameOf(key)));
  p.log({ event: "import_pass", objects: keys.length, pending: pending.length });
  let imported = 0;
  const results: Array<Record<string, unknown>> = [];
  for (const key of pending) {
    const name = markerNameOf(key);
    const attempts = p.attempts(name);
    const text = await p.getObject(key);
    let exportedAt: string | null = null;
    let generation: number | null = null;
    let exportedInstances = 0;
    try {
      const doc = JSON.parse(text) as { exportedAt?: string; generation?: number; segments?: Array<{ instanceId?: string }> };
      exportedAt = typeof doc.exportedAt === "string" ? doc.exportedAt : null;
      generation = typeof doc.generation === "number" ? doc.generation : null;
      exportedInstances = new Set((doc.segments ?? []).map((s) => s.instanceId)).size;
    } catch {
      // The CLI refuses a malformed document with its own words below.
    }
    const at = p.now();
    const run = p.runCli(p.inboxPath(name), text, apiKey);
    const stderr = (run.stderr ?? "").trim().slice(0, 400);
    let report: ImportReport | null = null;
    try {
      report = run.stdout?.trim() ? parseImportReport(run.stdout) : null;
    } catch (error) {
      p.log({ event: "import_report_unreadable", object: key, reason: (error as Error).message.slice(0, 200) });
    }
    const { outcome, why } = outcomeOf(run, report, attempts);
    const result = { at, object: key, outcome, why, exit: run.status, attempts: attempts + 1, exportedAt, generation, exportedInstances, segments: report?.segments ?? null, uploaded: report?.uploaded ?? null, refused: report?.refused ?? null, quarantined: report?.quarantined ?? null, instances: report?.instances.map((i) => i.instanceId) ?? [], granted: report?.instances.filter((i) => i.grant).length ?? null, retryAfterSeconds: report?.retryAfterSeconds ?? null, stderr: stderr || null };
    p.log({ event: `import_${outcome}`, ...result });
    if (outcome === "held") {
      p.setAttempts(name, attempts + 1);
    } else {
      await p.putMarker(name, JSON.stringify(result) + "\n");
      p.setAttempts(name, 0);
      if (outcome === "imported") imported += 1;
    }
    await p.appendEvent({ kind: "telemetry_imported", host: p.hostId, ...result }).catch((error) => p.log({ event: "event_write_failed", reason: (error as Error).message.slice(0, 200) }));
    results.push(result);
  }
  const last = results.at(-1) ?? null;
  const status = { lastPassAt: p.now(), objects: keys.length, pending: pending.length - imported, imported, last };
  await p.updateStatus(p.hostId, { imports: status }).catch((error) => p.log({ event: "status_write_failed", reason: (error as Error).message.slice(0, 200) }));
  p.log({ event: "import_done", ...status, last: last ? { object: last.object, outcome: last.outcome } : null });
  return { objects: keys.length, pending: pending.length - imported, imported, results };
}

interface ImportEnv {
  readonly host: HostEnv;
  readonly exchangeBucket: string;
  readonly exchangeRegion: string;
  readonly baseUrl: string;
  readonly importDir: string;
  readonly cli: string;
}

function readImportEnv(env: NodeJS.ProcessEnv): ImportEnv {
  // The worker's reader refuses a key in the environment; this process may carry one only for an operator's manual run.
  const { AIRPROMPTER_AGENT_KEY: _key, ...rest } = env;
  const host = readHostEnv(rest);
  const need = (name: string): string => {
    const value = env[name];
    if (!value || !value.trim()) throw new Error(`import env: ${name} is missing`);
    return value.trim();
  };
  return { host, exchangeBucket: need("EXCHANGE_BUCKET"), exchangeRegion: need("ZUDOCS_EXCHANGE_REGION"), baseUrl: need("AIRPROMPTER_BASE_URL"), importDir: env.ZUDOCS_IMPORT_DIR?.trim() || "/var/lib/zudocs/import", cli: env.ZUDOCS_CLI?.trim() || "/usr/local/bin/airprompter" };
}

async function main(): Promise<void> {
  const env = readImportEnv(process.env);
  const s3 = new S3Client({ region: env.exchangeRegion });
  const store = createStore(DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.host.tablesRegion }), { marshallOptions: { removeUndefinedValues: true } }), env.host.tables);
  const inbox = join(env.importDir, "inbox");
  const attemptsDir = join(env.importDir, "attempts");
  mkdirSync(inbox, { recursive: true, mode: 0o700 });
  mkdirSync(attemptsDir, { recursive: true, mode: 0o700 });
  const listPrefix = async (prefix: string): Promise<string[]> => {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: env.exchangeBucket, Prefix: prefix, ContinuationToken: token }));
      for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  };
  await importPass({
    hostId: env.host.hostId,
    scope: { organizationId: env.host.airprompter.organizationId, agentId: env.host.airprompter.agentId, environment: env.host.airprompter.environment },
    baseUrl: env.baseUrl,
    listExports: () => listPrefix(TELEMETRY_PREFIX),
    listMarkers: async () => new Set((await listPrefix(IMPORTS_PREFIX)).map((key) => key.slice(IMPORTS_PREFIX.length))),
    async getObject(key) {
      const out = await s3.send(new GetObjectCommand({ Bucket: env.exchangeBucket, Key: key }));
      return out.Body ? out.Body.transformToString("utf8") : "";
    },
    async putMarker(name, body) {
      await s3.send(new PutObjectCommand({ Bucket: env.exchangeBucket, Key: `${IMPORTS_PREFIX}${name}`, Body: body, ContentType: "application/json" }));
    },
    attempts: (name) => (existsSync(join(attemptsDir, name)) ? Number(readFileSync(join(attemptsDir, name), "utf8")) || 0 : 0),
    setAttempts: (name, count) => {
      if (count === 0) {
        if (existsSync(join(attemptsDir, name))) unlinkSync(join(attemptsDir, name));
      } else writeFileSync(join(attemptsDir, name), String(count));
    },
    runCli(file, text, apiKey) {
      writeFileSync(file, text, { mode: 0o600 });
      try {
        const run = spawnSync(env.cli, ["import-telemetry", "--org", env.host.airprompter.organizationId, "--agent", env.host.airprompter.agentId, "--environment", env.host.airprompter.environment, "--in", file, "--base-url", env.baseUrl, "--json"], {
          // The key in the child's environment only; nothing else of this process's environment goes along.
          env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "/var/lib/airprompter", AIRPROMPTER_AGENT_KEY: apiKey },
          encoding: "utf8",
          timeout: 120_000,
        });
        return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "", error: run.error };
      } finally {
        if (existsSync(file)) unlinkSync(file);
      }
    },
    inboxPath: (name) => join(inbox, name),
    appendEvent: (event) => store.appendEvent(event as never),
    updateStatus: (hostId, fields) => store.updateStatus(hostId, fields),
    apiKey: () => agentKeyFrom(process.env),
    now: () => new Date().toISOString(),
    log,
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error: Error) => {
    log({ event: "import_failed", name: error.name, message: error.message.slice(0, 400) });
    process.exit(1);
  });
}
