import assert from "node:assert/strict";
import { test } from "node:test";
import { IMPORT_MAX_ATTEMPTS, agentKeyFrom, importPass, markerNameOf, outcomeOf, parseImportReport, type ImportPorts } from "../src/importTelemetry.js";
import { renderHostEnv } from "../render.mjs";

test("the Agent key comes from the mounted credential (systemd's LoadCredential), or the environment for an operator's manual run; never from anywhere else", () => {
  const files: Record<string, string> = { "/run/credentials/zudocs-import.service/airprompterd.env": "AIRPROMPTER_AGENT_KEY=apa_from_credential\n" };
  const read = (path: string): string => {
    if (!(path in files)) throw new Error(`ENOENT ${path}`);
    return files[path]!;
  };
  assert.equal(agentKeyFrom({ CREDENTIALS_DIRECTORY: "/run/credentials/zudocs-import.service" }, read), "apa_from_credential");
  assert.equal(agentKeyFrom({ AIRPROMPTER_AGENT_KEY: "apa_manual", CREDENTIALS_DIRECTORY: "/run/credentials/zudocs-import.service" }, read), "apa_manual", "an operator's environment wins");
  assert.throws(() => agentKeyFrom({}, read), /neither CREDENTIALS_DIRECTORY/);
  files["/run/credentials/other/airprompterd.env"] = "# nothing yet\n";
  assert.throws(() => agentKeyFrom({ CREDENTIALS_DIRECTORY: "/run/credentials/other" }, read), /does not carry AIRPROMPTER_AGENT_KEY/);
});

test("the CLI's --json report is read strictly: counts must be numbers, instances carry their grant, a held import carries retryAfterSeconds", () => {
  const report = parseImportReport(JSON.stringify({ in: "x", segments: 3, uploaded: 3, refused: 0, quarantined: 0, instances: [{ instanceId: "inst-1", segments: 3, uploaded: 3, grant: "grant-1" }] }));
  assert.equal(report.uploaded, 3);
  assert.deepEqual(report.instances, [{ instanceId: "inst-1", segments: 3, uploaded: 3, grant: "grant-1" }]);
  assert.equal(report.retryAfterSeconds, undefined);
  const held = parseImportReport(JSON.stringify({ segments: 1, uploaded: 0, refused: 0, quarantined: 0, instances: [{ instanceId: "inst-1", segments: 1, uploaded: 0, grant: null }], retryAfterSeconds: 60 }));
  assert.equal(held.retryAfterSeconds, 60);
  assert.throws(() => parseImportReport(JSON.stringify({ segments: "3" })), /segments is not a number/);
  assert.equal(IMPORT_MAX_ATTEMPTS, 5);
});

test("outcomeOf: only a clean exit with a report and nothing refused is imported; a hold, a refused segment, an exit without a report or a CLI that did not run is held until the attempts run out", () => {
  const clean = { segments: 2, uploaded: 2, refused: 0, quarantined: 0, instances: [] };
  assert.deepEqual(outcomeOf({ status: 0 }, clean, 0), { outcome: "imported", why: "clean" });
  assert.equal(outcomeOf({ status: 1 }, { ...clean, uploaded: 0, retryAfterSeconds: 60 }, 0).outcome, "held");
  assert.match(outcomeOf({ status: 1 }, { ...clean, uploaded: 0, retryAfterSeconds: 60 }, 0).why, /retry in 60s/);
  assert.equal(outcomeOf({ status: 1 }, { ...clean, uploaded: 1, refused: 1 }, 0).outcome, "held", "a refused segment (an expired grant) is tried again");
  assert.equal(outcomeOf({ status: 1 }, null, 0).outcome, "held", "the CLI threw (a heartbeat refused, a network failure): tried again, never marked done");
  assert.equal(outcomeOf({ status: null, error: new Error("ETIMEDOUT") }, null, 0).outcome, "held", "a CLI that did not run");
  assert.equal(outcomeOf({ status: 1 }, null, IMPORT_MAX_ATTEMPTS - 1).outcome, "failed", "the last attempt is recorded as failed");
  assert.equal(outcomeOf({ status: 0 }, null, 0).outcome, "held", "exit 0 with no report is not trusted either");
});

test("a marker name is one safe path segment per object key", () => {
  assert.equal(markerNameOf("telemetry/i-0abc/2026-09-18T20-05-00Z.aptelemetry"), "telemetry_i-0abc_2026-09-18T20-05-00Z.aptelemetry");
  assert.ok(!markerNameOf("telemetry/../x").includes("/"));
});

interface Fake {
  ports: ImportPorts;
  exports: Map<string, string>;
  markers: Map<string, string>;
  attempts: Map<string, number>;
  runs: Array<{ file: string; apiKey: string }>;
  answers: Array<{ status: number | null; stdout: string; stderr: string; error?: Error }>;
  events: Array<Record<string, unknown>>;
  status: Record<string, unknown> | null;
  log: Array<Record<string, unknown>>;
}

function fake(over: Partial<Fake> = {}): Fake {
  const f: Fake = { exports: new Map(), markers: new Map(), attempts: new Map(), runs: [], answers: [], events: [], status: null, log: [], ports: null as never, ...over };
  f.ports = {
    hostId: "eu-west-1/ec2",
    scope: { organizationId: "org-1", agentId: "agent_x", environment: "dev" },
    baseUrl: "https://api-dev.example",
    listExports: async () => [...f.exports.keys()],
    listMarkers: async () => new Set(f.markers.keys()),
    getObject: async (key) => f.exports.get(key)!,
    putMarker: async (name, body) => { f.markers.set(name, body); },
    attempts: (name) => f.attempts.get(name) ?? 0,
    setAttempts: (name, count) => { if (count === 0) f.attempts.delete(name); else f.attempts.set(name, count); },
    runCli: (file, _text, apiKey) => { f.runs.push({ file, apiKey }); return f.answers.shift() ?? { status: 0, stdout: JSON.stringify({ segments: 1, uploaded: 1, refused: 0, quarantined: 0, instances: [{ instanceId: "inst-1", segments: 1, uploaded: 1, grant: "g" }] }), stderr: "" }; },
    inboxPath: (name) => `/inbox/${name}`,
    appendEvent: async (event) => { f.events.push(event); },
    updateStatus: async (_hostId, fields) => { f.status = fields; },
    apiKey: () => "apa_test",
    now: () => "2026-09-18T20:00:00.000Z",
    log: (event) => { f.log.push(event); },
  };
  return f;
}

const exportDoc = (instances: string[]) => JSON.stringify({ kind: "airprompter-telemetry-export", v: 1, exportedAt: "2026-09-18T19:55:00.000Z", generation: 3, segments: instances.map((instanceId) => ({ name: `${instanceId}-x`, instanceId, bytes: "AA" })) });

test("a pass: new exports go through the CLI once each (the key in the child only), a marker per import, a timeline row, the status part; a second pass imports nothing again; a marker outlives the ledger's host", async () => {
  const f = fake();
  f.exports.set("telemetry/i-1/a.aptelemetry", exportDoc(["inst-1"]));
  f.exports.set("telemetry/i-1/b.aptelemetry", exportDoc(["inst-1", "inst-2"]));
  f.exports.set("telemetry/i-1/not-an-export.json", "{}");
  const first = await importPass(f.ports);
  assert.deepEqual({ objects: first.objects, pending: first.pending, imported: first.imported }, { objects: 2, pending: 0, imported: 2 });
  assert.equal(f.runs.length, 2);
  assert.ok(f.runs.every((r) => r.apiKey === "apa_test" && r.file.startsWith("/inbox/")));
  assert.deepEqual([...f.markers.keys()].sort(), ["telemetry_i-1_a.aptelemetry", "telemetry_i-1_b.aptelemetry"]);
  assert.deepEqual(f.events.map((e) => [e.kind, e.outcome, e.object]), [["telemetry_imported", "imported", "telemetry/i-1/a.aptelemetry"], ["telemetry_imported", "imported", "telemetry/i-1/b.aptelemetry"]]);
  assert.equal(f.events[1]!.exportedInstances, 2);
  assert.equal(f.events[1]!.generation, 3);
  assert.deepEqual((f.status!.imports as { objects: number; pending: number; imported: number }), { ...(f.status!.imports as object), objects: 2, pending: 0, imported: 2 });
  assert.ok(!JSON.stringify(f.log).includes("apa_test") && !JSON.stringify(f.events).includes("apa_test"), "the key is nowhere but the child's environment");
  const second = await importPass(f.ports);
  assert.equal(second.imported, 0);
  assert.equal(f.runs.length, 2, "nothing imported twice");
  const replaced = fake({ exports: f.exports, markers: f.markers });
  await importPass(replaced.ports);
  assert.equal(replaced.runs.length, 0, "a replaced host reads the bucket's ledger and imports nothing again");
});

test("a transient failure is held and retried on later passes, then recorded as failed after the attempts run out — never marked done on the first failure", async () => {
  const f = fake();
  f.exports.set("telemetry/i-1/c.aptelemetry", exportDoc(["inst-1"]));
  f.answers.push({ status: 1, stdout: JSON.stringify({ ok: false, error: "heartbeat for inst-1 failed with HTTP 503", exitCode: 3 }), stderr: "" });
  await importPass(f.ports);
  assert.equal(f.markers.size, 0, "not done");
  assert.equal(f.attempts.get("telemetry_i-1_c.aptelemetry"), 1);
  assert.equal(f.events.at(-1)!.outcome, "held");
  assert.match(String(f.events.at(-1)!.why), /no report/);
  f.answers.push({ status: 1, stdout: JSON.stringify({ segments: 1, uploaded: 0, refused: 0, quarantined: 0, instances: [{ instanceId: "inst-1", segments: 1, uploaded: 0, grant: null }], retryAfterSeconds: 60 }), stderr: "held: the platform asked to retry in 60s" });
  await importPass(f.ports);
  assert.equal(f.attempts.get("telemetry_i-1_c.aptelemetry"), 2);
  assert.equal(f.events.at(-1)!.retryAfterSeconds, 60);
  f.answers.push({ status: null, stdout: "", stderr: "", error: new Error("spawnSync ETIMEDOUT") });
  await importPass(f.ports);
  assert.equal(f.attempts.get("telemetry_i-1_c.aptelemetry"), 3);
  await importPass(f.ports);
  assert.equal(f.events.at(-1)!.outcome, "imported", "the platform came back: imported on the fourth pass");
  assert.equal(f.markers.size, 1);
  assert.equal(f.attempts.size, 0, "the attempts are forgotten with the marker");
  const g = fake();
  g.exports.set("telemetry/i-1/d.aptelemetry", exportDoc(["inst-1"]));
  for (let i = 0; i < IMPORT_MAX_ATTEMPTS; i += 1) {
    g.answers.push({ status: 1, stdout: "", stderr: "network" });
    await importPass(g.ports);
  }
  assert.equal(g.events.at(-1)!.outcome, "failed");
  assert.equal(g.events.at(-1)!.attempts, IMPORT_MAX_ATTEMPTS);
  assert.ok(g.markers.has("telemetry_i-1_d.aptelemetry"), "recorded as failed, with a marker, after the fifth attempt");
  assert.equal(g.runs.length, IMPORT_MAX_ATTEMPTS);
});

test("the eu-west env names the exchange bucket by a placeholder the boot fills, its region and the import directory; never a value that looks like a key", () => {
  const config = { organizationId: "org-1", agentId: "agent_x", environment: "dev", hostedEnvironment: "dev", baseUrl: "https://api-dev.example", rootUrl: "https://edge.example/roots/dev/root.json", edgePointerUrl: "https://edge.example/g/tok/generation.json" };
  const cdk = { regions: { site: "us-east-1", sharedHost: "eu-west-1", fleet: "ap-southeast-1" } };
  const text = renderHostEnv(config, cdk, {});
  assert.ok(text.includes("EXCHANGE_BUCKET=@EXCHANGE_BUCKET@\n"));
  assert.ok(text.includes("ZUDOCS_EXCHANGE_REGION=ap-southeast-1\n"));
  assert.ok(text.includes("ZUDOCS_IMPORT_DIR=/var/lib/zudocs/import\n"));
  assert.throws(() => renderHostEnv(config, { regions: { site: "us-east-1", sharedHost: "eu-west-1" } }, {}), /regions.fleet/);
});
