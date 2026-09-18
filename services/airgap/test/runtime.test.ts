import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { distributionKeyId, generateX25519KeyPair } from "@airprompter/agent-sdk";
import { readAirgapEnv } from "../src/env.js";
import { PROBE_TAG, PROBE_TICKET, decideApply, parseDistributionKeyFile, readJsonFile } from "../src/runtime.js";
import { buildStatusDoc, parseStatusDoc, STATUS_APPLIES_KEPT, STATUS_LOG_KEPT } from "../src/status.js";
import { renderAirgapEnv } from "../render.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const ENV: NodeJS.ProcessEnv = {
  ZUDOCS_HOST_ID: "ap-southeast-1/airgap", ZUDOCS_REGION: "ap-southeast-1", EXCHANGE_BUCKET: "zudocs-exchange-1", RELEASES_TABLE: "zudocs-agent-releases",
  AIRPROMPTER_ORG: "org-1", AIRPROMPTER_AGENT: "agent_x", AIRPROMPTER_ENVIRONMENT: "dev", AIRPROMPTER_HOSTED_ENVIRONMENT: "dev", AIRPROMPTER_ROOT_JWK_PATH: "/etc/airprompter/root.jwk.json", AIRPROMPTER_STATE_DIR: "/var/lib/airprompter",
  ZUDOCS_DISTRIBUTION_KEY_PATH: "/var/lib/airprompter/keys/airgap.key.json", ZUDOCS_VENDORED_BUNDLE_PATH: "/var/lib/airprompter/vendored.apbundle", ZUDOCS_EXPORT_STATE_PATH: "/var/lib/zudocs/export/last.json", ZUDOCS_PROBE_PATH: "/var/lib/zudocs/probe.json",
};

test("readAirgapEnv: every name; a key or a base URL in the environment is refused; the cadences have floors and defaults", () => {
  const env = readAirgapEnv(ENV);
  assert.equal(env.applyIntervalSeconds, 30);
  assert.equal(env.statusIntervalSeconds, 60);
  assert.equal(env.renderIntervalSeconds, 120);
  assert.equal(env.distributionKeyPath, "/var/lib/airprompter/keys/airgap.key.json");
  assert.throws(() => readAirgapEnv({ ...ENV, AIRPROMPTER_AGENT_KEY: "apa_x" }), /holds no Agent key/);
  assert.throws(() => readAirgapEnv({ ...ENV, AIRPROMPTER_BASE_URL: "https://api.example" }), /nothing on this host calls home/);
  assert.throws(() => readAirgapEnv({ ...ENV, RELEASES_TABLE: "" }), /RELEASES_TABLE is missing/);
  assert.throws(() => readAirgapEnv({ ...ENV, ZUDOCS_APPLY_INTERVAL_SECONDS: "1" }), /at least 5/);
});

test("the rendered zudocs.env: the placeholder for the bucket, no key, no base URL, the identifiers; a value that looks like a key or a URL is refused", () => {
  const config = { organizationId: "org-1", agentId: "agent_x", environment: "dev", hostedEnvironment: "dev" };
  const cdk = { regions: { site: "us-east-1", sharedHost: "eu-west-1", fleet: "ap-southeast-1" } };
  const text = renderAirgapEnv(config, cdk, {});
  assert.ok(text.includes("ZUDOCS_HOST_ID=ap-southeast-1/airgap\n"));
  assert.ok(text.includes("EXCHANGE_BUCKET=@EXCHANGE_BUCKET@\n"), "the account-qualified bucket is filled by the boot");
  assert.ok(!/BASE_URL|AGENT_KEY|https?:/.test(text), "no way home, no key");
  const parsed = Object.fromEntries(text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("=") as [string, string]));
  assert.doesNotThrow(() => readAirgapEnv({ ...parsed, EXCHANGE_BUCKET: "zudocs-exchange-1" }), "what the build renders is what the runtime reads");
  assert.throws(() => renderAirgapEnv(config, cdk, { AIRPROMPTER_AGENT_ID: "apa_looks_like_a_key" }), /looks like a key/);
  assert.throws(() => renderAirgapEnv(config, { regions: {} }, {}), /regions.fleet/);
});

test("the distribution private key file: as keygen writes it, 0600, the id checked; anything else is refused", () => {
  const pair = generateX25519KeyPair();
  const jwk = pair.privateKey.export({ format: "jwk" }) as { d: string };
  const publicKey = Buffer.from(pair.publicRaw).toString("base64url");
  const keyId = distributionKeyId(pair.publicRaw);
  const file = JSON.stringify({ kind: "airprompter-distribution-key", v: 1, keyId, publicKey, privateKey: jwk.d, createdAt: "2026-09-18T20:00:00.000Z" });
  const loaded = parseDistributionKeyFile(file, 0o100600);
  assert.equal(loaded.keyId, keyId);
  assert.deepEqual([...loaded.key.publicRaw], [...pair.publicRaw]);
  assert.throws(() => parseDistributionKeyFile(file, 0o100644), /readable by others/);
  assert.throws(() => parseDistributionKeyFile(JSON.stringify({ kind: "airprompter-distribution-public-key", keyId, publicKey }), 0o100600), /kind airprompter-distribution-key/);
  assert.throws(() => parseDistributionKeyFile(JSON.stringify({ kind: "airprompter-distribution-key", keyId: "nope", publicKey, privateKey: jwk.d }), 0o100600), /keyId does not match/);
});

test("decideApply: nothing without a row; wait while the newest row is sealed to another key or is plaintext; apply only a generation above what was handed over; a failed start holds the same digest for the cooldown", () => {
  const now = "2026-09-18T20:00:00.000Z";
  assert.equal(decideApply({ newest: null, keyId: "k1", attempted: 0, startFailure: null, now }).action, "nothing");
  const wait = decideApply({ newest: { generation: 3, releaseDigest: "d", keyId: "other-key-id", object: "o", pulledAt: "t" }, keyId: "k1", attempted: 0, startFailure: null, now });
  assert.equal(wait.action, "wait_for_reseal");
  assert.match(wait.reason, /sealed to key other-ke…; this host's key is k1…/);
  assert.equal(decideApply({ newest: { generation: 3, releaseDigest: "d", keyId: null, object: "o", pulledAt: "t" }, keyId: "k1", attempted: 0, startFailure: null, now }).action, "wait_for_reseal", "a plaintext bundle is not for this host");
  assert.equal(decideApply({ newest: { generation: 3, releaseDigest: "d", keyId: "k1", object: "o", pulledAt: "t" }, keyId: "k1", attempted: 3, startFailure: null, now }).action, "nothing");
  assert.equal(decideApply({ newest: { generation: 3, releaseDigest: "d", keyId: "k1", object: "o", pulledAt: "t" }, keyId: "k1", attempted: 4, startFailure: null, now }).action, "nothing", "never below what was handed over");
  assert.equal(decideApply({ newest: { generation: 4, releaseDigest: "d", keyId: "k1", object: "o", pulledAt: "t" }, keyId: "k1", attempted: 3, startFailure: null, now }).action, "apply");
  const failed = { at: "2026-09-18T19:55:00.000Z", generation: 4, releaseDigest: "d", code: "store_corrupt", message: "x" };
  assert.equal(decideApply({ newest: { generation: 4, releaseDigest: "d", keyId: "k1", object: "o", pulledAt: "t" }, keyId: "k1", attempted: 3, startFailure: failed, now }).action, "nothing", "the same digest inside the cooldown");
  assert.equal(decideApply({ newest: { generation: 4, releaseDigest: "d", keyId: "k1", object: "o", pulledAt: "t" }, keyId: "k1", attempted: 3, startFailure: failed, now: "2026-09-18T20:10:00.000Z" }).action, "apply", "after the cooldown");
  assert.equal(decideApply({ newest: { generation: 5, releaseDigest: "e", keyId: "k1", object: "o", pulledAt: "t" }, keyId: "k1", attempted: 3, startFailure: failed, now }).action, "apply", "a newer digest at once");
});

test("the status document: the SDK's documents verbatim, the newest applies and log lines only, a monotonic seq; parse refuses other shapes; the probe is what the boot wrote", () => {
  const applies = Array.from({ length: 30 }, (_, i) => ({ at: `2026-09-18T20:${String(i).padStart(2, "0")}:00.000Z`, generation: i, outcome: "activated" as const, reason: null, detail: null, source: "exchange" as const, object: null }));
  const log = Array.from({ length: 40 }, (_, i) => ({ event: `e${i}` }));
  const doc = buildStatusDoc({ hostId: "ap-southeast-1/airgap", region: "ap-southeast-1", sdk: "agent-sdk-ts/0.2.14", startedAt: "2026-09-18T19:00:00.000Z", now: "2026-09-18T20:30:00.000Z", seq: 7, ec2: null, keyId: "k1", phase: "serving", waitingFor: null, status: null, healthz: null, applies, startFailure: null, renders: { count: 0, lastAt: null, last: null, observation: "refused" }, export: null, probe: null, log });
  assert.equal(doc.applies.length, STATUS_APPLIES_KEPT);
  assert.equal(doc.applies[0]!.generation, 10, "the oldest go");
  assert.equal(doc.log.length, STATUS_LOG_KEPT);
  assert.equal(doc.writtenAt, "2026-09-18T20:30:00.000Z");
  assert.equal(doc.seq, 7);
  assert.equal(parseStatusDoc(JSON.stringify(doc))?.keyId, "k1");
  assert.equal(parseStatusDoc(JSON.stringify({ ...doc, kind: "x" })), null);
  assert.equal(readJsonFile("/nonexistent/probe.json"), null);
  assert.deepEqual(readJsonFile<{ ok: boolean }>(join(here, "fixtures", "probe.json")), { at: "2026-09-18T20:00:10Z", curl: { url: "https://api-dev.airprompter.com/", exit: 28, seconds: 8.0, meaning: "connect timed out — no route out" }, dns: { name: "api-dev.airprompter.com", resolved: true, detail: "resolved by the VPC resolver (a name is not a route)" } });
});

test("the render probe: a fixed sentence for the triage slot, never a ticket; the units run as the airprompter user with no key; the boot template parses and installs the keygen before the units", () => {
  assert.equal(PROBE_TAG, "support.triage");
  assert.match(PROBE_TICKET, /render-only probe/);
  const runtimeUnit = readFileSync(join(here, "..", "host", "units", "zudocs-airgap.service"), "utf8");
  assert.ok(runtimeUnit.includes("User=airprompter") && runtimeUnit.includes("EnvironmentFile=/etc/airprompter/zudocs.env") && !runtimeUnit.includes("airprompterd.env"), "no key file in the runtime's unit");
  const exportUnit = readFileSync(join(here, "..", "host", "units", "zudocs-airgap-export.service"), "utf8");
  assert.ok(exportUnit.includes("User=airprompter") && exportUnit.includes("ExecStart=/usr/local/bin/zudocs-airgap-export"));
  const timer = readFileSync(join(here, "..", "host", "units", "zudocs-airgap-export.timer"), "utf8");
  assert.ok(timer.includes("OnUnitActiveSec=5min"));
  const boot = readFileSync(join(here, "..", "host", "user-data.sh"), "utf8");
  const commands = boot.split("\n").filter((line) => !line.trimStart().startsWith("#"));
  assert.ok(!commands.some((line) => /dnf |pip |curl -fsSL|npm |wget /.test(line)), "nothing that needs a route out");
  assert.ok(boot.indexOf("zudocs-airgap-keygen") < boot.indexOf("systemctl enable"), "the keypair is born before the runtime starts");
  assert.ok(boot.includes("python3 -m zipfile"), "the bundle is unpacked with what the image has (no unzip)");
  const keygen = readFileSync(join(here, "..", "host", "bin", "zudocs-airgap-keygen"), "utf8");
  assert.ok(keygen.includes("--purpose distribution") && keygen.includes("keys/airgap.distribution.pub.json") && !keygen.includes("*.key.json") && !keygen.includes("keys/*"), "publishes the public half by its exact name; never a glob over the keys");
  assert.ok(!/keygen[^\n]*--json/.test(keygen), "keygen's plain output: its JSON names a privateKey field (a path) that reads as a secret in the boot log");
  assert.ok(boot.includes("systemctl disable --now amazon-ssm-agent"), "the SSM agent has nowhere to go");
  assert.ok(keygen.includes('grep -q \'"privateKey"\' "$public" &&'), "refuses to publish a file carrying a private member");
});
