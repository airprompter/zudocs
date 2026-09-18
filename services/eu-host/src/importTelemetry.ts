/**
 * The import timer's work on the eu-west host: the air-gapped host's telemetry exports, carried from the exchange
 * bucket to AirPrompter. Every run lists `telemetry/` in the bucket (ap-southeast-1, read by this host's role), takes
 * each object it has not imported before (a ledger of markers under `/var/lib/zudocs/import/done`), downloads it to
 * a 0600 inbox file and runs the released CLI's `airprompter import-telemetry` on it — which heartbeats as each
 * offline instance the document carries (`syncMode: offline`) for an upload grant and posts the segments through it,
 * so the air-gapped instance appears on AirPrompter's fleet page with its windows although it never had a wire.
 * The platform is idempotent by key (importing a file twice changes nothing); the ledger keeps this host from
 * paying the heartbeat twice. A held import (the platform said retry later) is retried on the next run, up to a
 * few times, then recorded as failed. Every file is a `telemetry_imported` timeline row and the host's status row
 * gets an `imports` part.
 *
 * The Agent key reaches the CLI's environment and nothing else: systemd hands this unit the daemon's root-only env
 * file as a credential (`LoadCredential=`), the script reads the value from `$CREDENTIALS_DIRECTORY` and passes it
 * to the child process only. Logs are JSON lines with counts, ids and outcomes — never a row, never the key.
 *
 * @example
 * ```sh
 * # as the airprompter user, with /etc/airprompter/zudocs.env in the environment and the credential mounted (systemd: zudocs-import.service)
 * node /opt/zudocs/import.mjs
 * ```
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { createStore } from "../../desk-api/src/store.js";
import { readHostEnv, type HostEnv } from "./hostEnv.js";

const log = (event: Record<string, unknown>) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), source: "zudocs-import", ...event }) + "\n");
/** A held import is retried this many runs, then recorded as failed (a marker is written either way). */
export const IMPORT_MAX_ATTEMPTS = 5;

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
  const apiKey = agentKeyFrom(process.env);
  const s3 = new S3Client({ region: env.exchangeRegion });
  const store = createStore(DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.host.tablesRegion }), { marshallOptions: { removeUndefinedValues: true } }), env.host.tables);
  const inbox = join(env.importDir, "inbox");
  const done = join(env.importDir, "done");
  mkdirSync(inbox, { recursive: true, mode: 0o700 });
  mkdirSync(done, { recursive: true, mode: 0o700 });

  // Every export object, oldest first (the keys carry the export's instant).
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: env.exchangeBucket, Prefix: "telemetry/", ContinuationToken: token }));
    for (const object of page.Contents ?? []) if (object.Key && /\.aptelemetry$/.test(object.Key)) keys.push(object.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  keys.sort();
  const markers = new Set(readdirSync(done));
  const pending = keys.filter((key) => !markers.has(markerNameOf(key)));
  log({ event: "import_pass", objects: keys.length, pending: pending.length });

  let imported = 0;
  let lastResult: Record<string, unknown> | null = null;
  for (const key of pending) {
    const marker = join(done, markerNameOf(key));
    const attemptsPath = `${marker}.attempts`;
    const attempts = existsSync(attemptsPath) ? Number(readFileSync(attemptsPath, "utf8")) || 0 : 0;
    const file = join(inbox, markerNameOf(key));
    const object = await s3.send(new GetObjectCommand({ Bucket: env.exchangeBucket, Key: key }));
    const text = object.Body ? await object.Body.transformToString("utf8") : "";
    writeFileSync(file, text, { mode: 0o600 });
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
    const at = new Date().toISOString();
    const run = spawnSync(env.cli, ["import-telemetry", "--org", env.host.airprompter.organizationId, "--agent", env.host.airprompter.agentId, "--environment", env.host.airprompter.environment, "--in", file, "--base-url", env.baseUrl, "--json"], {
      // The key in the child's environment only; nothing else of this process's environment goes along.
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "/var/lib/airprompter", AIRPROMPTER_AGENT_KEY: apiKey },
      encoding: "utf8",
      timeout: 120_000,
    });
    unlinkSync(file);
    const stderr = (run.stderr ?? "").trim().slice(0, 400);
    let report: ImportReport | null = null;
    try {
      report = run.stdout?.trim() ? parseImportReport(run.stdout) : null;
    } catch (error) {
      log({ event: "import_report_unreadable", object: key, reason: (error as Error).message.slice(0, 200) });
    }
    const held = run.status !== 0 && report?.retryAfterSeconds !== undefined;
    const outcome = run.status === 0 ? "imported" : held ? (attempts + 1 >= IMPORT_MAX_ATTEMPTS ? "failed" : "held") : "failed";
    const result = { at, object: key, outcome, exit: run.status, attempts: attempts + 1, exportedAt, generation, exportedInstances, segments: report?.segments ?? null, uploaded: report?.uploaded ?? null, refused: report?.refused ?? null, quarantined: report?.quarantined ?? null, instances: report?.instances.map((i) => i.instanceId) ?? [], granted: report?.instances.filter((i) => i.grant).length ?? null, retryAfterSeconds: report?.retryAfterSeconds ?? null, stderr: stderr || null };
    log({ event: "import_" + outcome, ...result });
    if (outcome === "held") {
      writeFileSync(attemptsPath, String(attempts + 1));
    } else {
      writeFileSync(marker, JSON.stringify(result) + "\n", { mode: 0o600 });
      if (existsSync(attemptsPath)) unlinkSync(attemptsPath);
      if (outcome === "imported") imported += 1;
    }
    await store.appendEvent({ kind: "telemetry_imported", host: env.host.hostId, ...result }).catch((error) => log({ event: "event_write_failed", reason: (error as Error).message.slice(0, 200) }));
    lastResult = result;
  }
  const status = { lastPassAt: new Date().toISOString(), objects: keys.length, pending: pending.length - imported, imported, last: lastResult };
  await store.updateStatus(env.host.hostId, { imports: status }).catch((error) => log({ event: "status_write_failed", reason: (error as Error).message.slice(0, 200) }));
  log({ event: "import_done", ...status, last: lastResult ? { object: lastResult.object, outcome: lastResult.outcome } : null });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error: Error) => {
    log({ event: "import_failed", name: error.name, message: error.message.slice(0, 400) });
    process.exit(1);
  });
}
