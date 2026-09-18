/**
 * The host's files: the rendered env carries identifiers and never a key (a key-shaped value or name is refused),
 * the requirements pin the SDK by the commit the tag names, the boot script and the helpers parse under `bash -n`
 * and carry exactly the placeholders the stack renders, the units name one fixed node path and the two env files
 * (the key file on the daemon alone), the status row is the daemon's word, and the worker's helpers pick tickets
 * and derive feedback from the checks only.
 *
 * @example
 * ```sh
 * npx tsx --test test/host.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CATALOGUE, MODELS } from "../../desk-api/src/modelCatalogue.js";
import { renderHostEnv, renderRequirements } from "../render.mjs";
import { readHostEnv } from "../src/hostEnv.js";
import { statusFields } from "../src/statusRow.js";
import { verifyRootDocument } from "../src/verifyRoot.js";
import { feedbackFromChecks, nextInboxTicket, nextQueuedTicket } from "../src/worker.js";
import { generateKeyPairSync } from "node:crypto";
import { canonicalBytes, keyThumbprint, signBytes } from "@airprompter/agent-sdk";

const here = fileURLToPath(new URL(".", import.meta.url));
const host = join(here, "..", "host");
const read = (path: string) => readFileSync(join(host, path), "utf8");
const CONFIG = { baseUrl: "https://api-dev.airprompter.com", hostedEnvironment: "dev", rootUrl: "https://edge.example/roots/dev/root.json", edgePointerUrl: "https://edge.example/g/tok/generation.json", organizationId: "org-1", agentId: "agent_x", environment: "dev" };
const CONTEXT = { regions: { site: "us-east-1", sharedHost: "eu-west-1", fleet: "ap-southeast-1" } };
const PINS = { cli: { tag: "cli/v0.1.0", asset: "a", sha256: "f".repeat(64), url: "https://github.com/airprompter/airprompter-agent-sdk/releases/download/cli/v0.1.0/airprompter-linux-arm64" }, pythonSdk: { tag: "sdk-python/v0.2.14", commit: "0".repeat(40), repo: "https://github.com/airprompter/airprompter-agent-sdk", packages: ["core", "sync", "telemetry", "runtime", "agent"] } };

test("zudocs.env: identifiers, table names, regions and cadences; the host id is the region's; never a key-shaped name or value", () => {
  const text = renderHostEnv(CONFIG, CONTEXT, {});
  const lines = Object.fromEntries(text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  assert.equal(lines.ZUDOCS_HOST_ID, "eu-west-1/ec2");
  assert.equal(lines.ZUDOCS_TABLES_REGION, "us-east-1");
  assert.equal(lines.ZUDOCS_AGENT_KEY_PARAMETER, "/zudocs/dev/agent-key", "a name, read by zudocs-agent-key as root");
  assert.equal(lines.APPROVALS_TABLE, "zudocs-desk-approvals");
  assert.equal(lines.AIRPROMPTER_EDGE_POINTER_URL, CONFIG.edgePointerUrl);
  assert.ok(!("AIRPROMPTER_AGENT_KEY" in lines));
  assert.equal(renderHostEnv(CONFIG, CONTEXT, { AIRPROMPTER_AGENT_ID: "agent_y" }).includes("AIRPROMPTER_AGENT=agent_y"), true, "the environment overrides an identifier");
  assert.throws(() => renderHostEnv({ ...CONFIG, agentId: "apa_test_secret" }, CONTEXT, {}), /looks like a key/);
  assert.throws(() => renderHostEnv({ ...CONFIG, edgePointerUrl: "" }, CONTEXT, {}), /edgePointerUrl is missing/);
  assert.throws(() => renderHostEnv({ ...CONFIG, organizationId: 'a"b' }, CONTEXT, {}), /misread/);
  const env = readHostEnv(Object.fromEntries(Object.entries(lines)));
  assert.equal(env.hostId, "eu-west-1/ec2");
  assert.equal(env.ticketIntervalSeconds, 600);
  assert.throws(() => readHostEnv({ ...lines, AIRPROMPTER_AGENT_KEY: "apa_x" }), /only the daemon holds the key/);
  assert.throws(() => readHostEnv({ ...lines, ZUDOCS_TICKET_INTERVAL_SECONDS: "5" }), /at least 30/);
});

test("requirements.txt: the five distributions by the pinned commit with the litellm extras on agent and runtime, then LiteLLM's peers; a bad commit is refused", () => {
  const text = renderRequirements(PINS);
  const lines = text.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.equal(lines.length, 6);
  assert.equal(lines[0], `airprompter-agent-core @ git+https://github.com/airprompter/airprompter-agent-sdk@${"0".repeat(40)}#subdirectory=sdk-python/packages/core`);
  assert.ok(lines.includes(`airprompter-agent[litellm] @ git+https://github.com/airprompter/airprompter-agent-sdk@${"0".repeat(40)}#subdirectory=sdk-python/packages/agent`));
  assert.ok(lines.some((l) => l.startsWith("airprompter-agent-runtime[litellm] @ ")));
  assert.equal(lines.at(-1), "boto3>=1.34");
  assert.throws(() => renderRequirements({ pythonSdk: { ...PINS.pythonSdk, commit: "abc" } }), /40-character commit/);
});

test("the boot script and the helpers parse; the script carries exactly the placeholders the stack renders and no key; the pins file is what it says", () => {
  for (const path of ["user-data.sh", "bin/zudocs-agent-key", "bin/zudocs-cli"]) execFileSync("bash", ["-n", join(host, path)]);
  const script = read("user-data.sh");
  assert.deepEqual([...new Set(script.match(/__[A-Z0-9_]+__/g))].sort(), ["__BUNDLE_S3_URL__", "__CLI_SHA256__", "__CLI_URL__", "__EXCHANGE_BUCKET__"]);
  assert.ok(script.includes("sed 's#@EXCHANGE_BUCKET@#__EXCHANGE_BUCKET__#'"), "the bucket's name reaches zudocs.env from the stack");
  assert.ok(script.indexOf("systemctl enable airprompterd") < script.indexOf("/usr/local/sbin/zudocs-agent-key ||"), "the units are installed and enabled before the key is fetched: a missing parameter never leaves a host with no units");
  assert.ok(script.indexOf("amazon-cloudwatch-agent-ctl") < script.indexOf("systemctl enable airprompterd"), "log shipping is up before the units start");
  assert.ok(/zudocs-agent-key \|\| echo/.test(script), "a missing parameter does not abort the boot; the daemon's ExecStartPre retries it");
  assert.ok(!read("bin/zudocs-cli").includes("setpriv") && read("bin/zudocs-cli").includes("runuser -u airprompter --"), "the drop to the daemon's user is runuser (util-linux-core), not setpriv");
  assert.ok(!/AIRPROMPTER_AGENT_KEY=|apa_/.test(script), "no key in user data, ever");
  assert.ok(script.includes("sha256sum -c"), "the CLI is verified before install");
  assert.ok(script.includes("zudocs-agent-key"), "the key file is written from SSM by the helper, not here");
  const pins = JSON.parse(readFileSync(join(here, "..", "pins.json"), "utf8"));
  assert.match(pins.cli.sha256, /^[0-9a-f]{64}$/);
  assert.match(pins.pythonSdk.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(pins.pythonSdk.packages, ["core", "sync", "telemetry", "runtime", "agent"], "dependency order: agent last");
  const keyHelper = read("bin/zudocs-agent-key");
  assert.ok(keyHelper.includes("umask 077") && keyHelper.includes("chmod 0600") && keyHelper.includes("--with-decryption"));
  assert.ok(!/echo.*\$value|printf.*%s.*\$value.*>&/.test(keyHelper.replace(/printf 'AIRPROMPTER_AGENT_KEY=%s\\n' "\$value" > "\$tmp"/, "")), "the value is written to the file only");
});

test("the units: the daemon alone reads the key file; every unit names the shared env file, the fixed node path or the venv, the log directory, and no inbound port", () => {
  const daemon = read("units/airprompterd.service");
  const worker = read("units/zudocs-worker.service");
  const py = read("units/zudocs-pyworker.service");
  const importer = read("units/zudocs-import.service");
  assert.ok(daemon.includes("EnvironmentFile=-/etc/airprompter/airprompterd.env"), "the key file, optional to systemd so ExecStartPre can create it before the first start");
  // The import pass is the one other unit that sees the key: as a systemd credential mounted for it alone, never as an EnvironmentFile.
  assert.ok(importer.includes("LoadCredential=airprompterd.env:/etc/airprompter/airprompterd.env") && !importer.includes("EnvironmentFile=-/etc/airprompter/airprompterd.env") && importer.includes("User=airprompter"), "the import pass gets the key as a credential, as the airprompter user");
  assert.ok(importer.includes("ExecStart=/usr/local/bin/node /opt/zudocs/import.mjs") && importer.includes("Type=oneshot"));
  assert.ok(read("units/zudocs-import.timer").includes("OnUnitActiveSec=5min"));
  assert.ok(daemon.includes("ExecStartPre=+/usr/local/sbin/zudocs-agent-key"), "the key file is refreshed as root before every start");
  assert.ok(worker.includes('Environment="ZUDOCS_WORKER_NAME=eu-west worker"'), "systemd's quoting: the whole assignment in quotes");
  assert.ok(daemon.includes("--apply-policy unlock_required"), "the host's policy pin");
  assert.ok(daemon.includes("--hosted-environment ${AIRPROMPTER_HOSTED_ENVIRONMENT}"), "the pinned root is the hosted deployment's");
  for (const unit of [worker, py]) {
    assert.ok(!unit.includes("airprompterd.env"), "a worker never sees the key file");
    assert.ok(unit.includes("EnvironmentFile=/etc/airprompter/zudocs.env"));
    assert.ok(unit.includes("User=airprompter"), "the same user as the daemon: the 0600 socket and the shared spool");
    assert.ok(unit.includes("After=network-online.target airprompterd.service"));
  }
  assert.ok(worker.includes("ExecStart=/usr/local/bin/node /opt/zudocs/worker.mjs"));
  assert.ok(py.includes("ExecStart=/opt/zudocs/venv/bin/python /opt/zudocs/pyworker.py"));
  for (const unit of [daemon, worker, py]) assert.ok(unit.includes("ReadWritePaths=/var/lib/airprompter /var/log/zudocs") && unit.includes("ProtectSystem=strict"));
  assert.ok(importer.includes("ReadWritePaths=/var/lib/zudocs /var/log/zudocs") && importer.includes("ProtectSystem=strict"), "the import pass writes its ledger and its log, never the store");
  const agent = JSON.parse(read("cloudwatch-agent.json"));
  assert.deepEqual(agent.logs.logs_collected.files.collect_list.map((f: { log_group_name: string }) => f.log_group_name), ["/zudocs/eu-host", "/zudocs/eu-host", "/zudocs/eu-host", "/zudocs/eu-host", "/zudocs/eu-host"]);
  assert.ok(agent.logs.logs_collected.files.collect_list.some((f: { file_path: string }) => f.file_path === "/var/log/zudocs/import.log"), "the import log ships too");
});

test("the status row is the daemon's word under the card's names, with what the socket lacks left null and the worker's part beside it", () => {
  const daemon = { daemon: "airprompter-cli/0.1.0", startedAt: "2026-09-18T15:00:00.000Z", instanceId: "i-daemon", generation: 2, stagedGeneration: 3, applyState: "awaiting_unlock", lastRefusal: null, storageProtection: "file_key", leaseExpiresAt: "2026-09-18T16:00:00.000Z", leaseExpired: false, lastContactAt: "2026-09-18T15:10:00.000Z", lastSyncAt: "2026-09-18T15:10:00.000Z", lastSyncOutcome: "staged", consecutiveFailures: 0, spool: { depthSegments: 1, depthBytes: 512 }, upload: null, applyPolicy: { effective: "unlock_required" as const, source: "local" as const, manifestSaid: "auto" as const }, socketPath: "/var/lib/airprompter/…/daemon.sock", clients: 2 };
  const healthz = { ok: true, status: "ok" as const, reasons: [], generation: 2, stagedGeneration: 3, applyState: "awaiting_unlock" as const, source: "store" as const, leaseExpiresAt: null, leaseExpired: false, onLeaseExpiry: null, lastSyncAt: null, lastSyncOutcome: null, consecutiveSyncFailures: 0, forcedDowngrade: false, daemon: null, spool: { depthSegments: 1, depthBytes: 512, budgetBytes: 104857600 }, lastUploadAt: null, backoffUntil: null };
  const worker = { instanceId: "i-worker", variables: { sources: ["customer_tier"], unsourced: [] }, unlockRequests: [], source: "daemon", daemon: { attached: true, socketPath: "x" } } as unknown as Parameters<typeof statusFields>[0]["worker"];
  const fields = statusFields({ hostId: "eu-west-1/ec2", region: "eu-west-1", daemon, healthz, worker, workerHealthz: { ...healthz, status: "ok", reasons: [] }, sdk: "agent-sdk-ts/0.2.14", tickets: 4, startedAt: "2026-09-18T15:01:00.000Z", now: "2026-09-18T15:20:00.000Z", ec2: { instanceId: "i-0abc", availabilityZone: "eu-west-1a" } });
  const status = fields.status as Record<string, unknown>;
  assert.equal(fields.kind, "daemon");
  assert.equal(fields.sdk, "agent-sdk-ts/0.2.14 via airprompter-cli/0.1.0");
  assert.equal(status.storageProtection, "file_key", "shown, never hidden");
  assert.equal(status.stagedGeneration, 3);
  assert.equal(status.consecutiveSyncFailures, 0);
  assert.equal(status.heartbeat, null, "not on the socket: not invented");
  assert.deepEqual(status.variables, { sources: ["customer_tier"], unsourced: [] });
  assert.deepEqual(fields.container, { instanceId: "i-daemon", coldStart: false, startedAt: "2026-09-18T15:00:00.000Z", invocations: 4 });
  assert.equal((fields.worker as { instanceId: string }).instanceId, "i-worker");
  assert.deepEqual(fields.ec2, { instanceId: "i-0abc", availabilityZone: "eu-west-1a" });
  assert.ok(!("hostId" in fields), "the key is not a field to set");
  const detached = statusFields({ hostId: "eu-west-1/ec2", region: "eu-west-1", daemon: { ...daemon, generation: 0, stagedGeneration: 1, applyState: "awaiting_unlock" }, healthz, worker: null, workerHealthz: null, sdk: "agent-sdk-ts/0.2.14", tickets: 0, startedAt: "x", now: "y" });
  assert.deepEqual((detached.worker as { attached: boolean; reasons: string[] }).attached, false);
  assert.deepEqual((detached.worker as { reasons: string[] }).reasons, ["awaiting_first_approval"], "a fresh host: the SDK attaches after the desk's first approval");
  assert.deepEqual((detached.status as { variables: unknown }).variables, { sources: [], unsourced: [] }, "no names invented while nothing is attached");
  assert.equal((detached.status as { stagedGeneration: number }).stagedGeneration, 1, "the daemon's staged generation is the row's, attached or not");
});

test("the Python worker's model map is the catalogue's (Converse ids and list prices), so a re-pin cannot drift between the two workers", () => {
  const py = read("pyworker.py");
  const converse = Object.fromEntries([...py.match(/BEDROCK_CONVERSE = \{([^}]*)\}/)![1]!.matchAll(/"([^"]+)": "([^"]+)"/g)].map((m) => [m[1], m[2]]));
  for (const [name, entry] of Object.entries(CATALOGUE)) {
    if (entry.path === "converse") assert.equal(converse[name], entry.bedrockId, `${name} on the Converse path`);
    else assert.equal(converse[name], undefined, `${name} is not a Converse model; the Python worker refuses it visibly`);
  }
  assert.deepEqual(Object.keys(converse).sort(), Object.entries(CATALOGUE).filter(([, e]) => e.path === "converse").map(([n]) => n).sort());
  const models = py.match(/^MODELS = \[([^\]]*)\]/m)![1]!.match(/"([^"]+)"/g)!.map((m) => m.slice(1, -1));
  assert.deepEqual(models.sort(), [...MODELS].sort(), "the same list the Node hosts report on the heartbeat");
  const prices = Object.fromEntries([...py.match(/USD_PER_MILLION = \{([^}]*)\}/)![1]!.matchAll(/"([^"]+)": \(([0-9.]+), ([0-9.]+)\)/g)].map((m) => [m[1], [Number(m[2]), Number(m[3])]]));
  for (const [name, entry] of Object.entries(CATALOGUE)) if (entry.path === "converse") assert.deepEqual(prices[name], [entry.usdPerMillion.input, entry.usdPerMillion.output], `${name} price`);
});

test("the root document the boot hands the daemon is verified against the pinned key for the hosted environment: a signed dev root passes; prod's scope, a tampered body or a private pinned key are refused", () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const priv = pair.privateKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string; y: string; d: string };
  const pinned = { kty: "EC", crv: "P-256", x: priv.x, y: priv.y };
  const keyId = keyThumbprint(pinned as never);
  const signed = { type: "root", protocol: "0.3.4", purpose: "platform", environment: "dev", version: 3, expires: "2030-01-01T00:00:00Z", keys: { [keyId]: { keyType: "ecdsa-p256", scheme: "ES256", publicKey: pinned } }, roles: { root: { keyIds: [keyId], threshold: 1 }, targets: { keyIds: [keyId], threshold: 1 } } };
  const doc = { signed, signatures: [{ keyId, sig: signBytes(canonicalBytes(signed), priv as never) }] };
  assert.deepEqual(verifyRootDocument(doc, pinned, "dev", "2026-09-18T18:00:00Z"), { ok: true, version: 3, keyIds: [keyId], expires: "2030-01-01T00:00:00Z" });
  assert.deepEqual(verifyRootDocument(doc, pinned, "prod", "2026-09-18T18:00:00Z"), { ok: false, reason: "root_scope_mismatch" }, "the released daemon's mistake, caught here instead");
  assert.deepEqual(verifyRootDocument({ ...doc, signed: { ...signed, version: 4 } }, pinned, "dev", "2026-09-18T18:00:00Z"), { ok: false, reason: "root_signature_invalid" });
  assert.deepEqual(verifyRootDocument(doc, pinned, "dev", "2031-01-01T00:00:00Z"), { ok: false, reason: "root_expired" });
  assert.deepEqual(verifyRootDocument(doc, priv, "dev"), { ok: false, reason: "pinned_key_private" });
  assert.deepEqual(verifyRootDocument({ signed }, pinned, "dev"), { ok: false, reason: "root_document_malformed" });
  assert.deepEqual(verifyRootDocument(doc, { kty: "RSA" }, "dev"), { ok: false, reason: "pinned_key_malformed" });
  const script = read("user-data.sh");
  assert.ok(script.includes("worker.mjs verify-root /tmp/root.json /etc/airprompter/root.jwk.json"), "the boot verifies the fetched document before installing it");
  assert.ok(script.indexOf("verify-root") < script.indexOf("install -m 0644 /tmp/root.json /etc/airprompter/root.json"), "verified first, installed second");
  assert.ok(read("units/airprompterd.service").includes("--root /etc/airprompter/root.json"), "the daemon trusts the verified document");
});

test("the worker's helpers: the inbox round-robin by id survives a re-seed, the queue takes existing tickets only, feedback comes from the checks alone", async () => {
  const tickets = [{ ticketId: "T-2" }, { ticketId: "T-1" }, { ticketId: "T-3" }] as never[];
  const store = { listTickets: async () => tickets };
  const cursor = { last: null as string | null };
  assert.equal((await nextInboxTicket(store, cursor))!.ticketId, "T-1");
  assert.equal((await nextInboxTicket(store, cursor))!.ticketId, "T-2");
  assert.equal((await nextInboxTicket(store, cursor))!.ticketId, "T-3");
  assert.equal((await nextInboxTicket(store, cursor))!.ticketId, "T-1", "round and round");
  assert.equal(await nextInboxTicket({ listTickets: async () => [] }, cursor), null);
  const queue = ["T-9", "T-2"];
  const q = { dequeueTicket: async () => queue.shift() ?? null, getTicket: async (id: string) => (tickets as Array<{ ticketId: string }>).find((t) => t.ticketId === id) ?? null };
  assert.equal((await nextQueuedTicket(q as never, "h"))!.ticketId, "T-2", "a queued id the inbox no longer holds is dropped");
  assert.equal(await nextQueuedTicket(q as never, "h"), null);
  assert.deepEqual(feedbackFromChecks({ runRef: "r", output: "x", checks: [{ name: "a", kind: "k", verdict: "pass" }, { name: "b", kind: "k", verdict: "fail" }] }), { runRef: "r", signals: { accepted: false } });
  assert.deepEqual(feedbackFromChecks({ runRef: "r", output: "x", checks: [{ name: "a", kind: "k", verdict: "pass" }] }), { runRef: "r", signals: { accepted: true } });
  assert.equal(feedbackFromChecks({ runRef: "r", output: "x", checks: [] }), null, "no checks, no verdict, no feedback");
  assert.equal(feedbackFromChecks({ runRef: null, output: "x", checks: [{ name: "a", kind: "k", verdict: "pass" }] }), null);
  assert.equal(feedbackFromChecks(undefined), null);
});
