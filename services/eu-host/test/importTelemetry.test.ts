import assert from "node:assert/strict";
import { test } from "node:test";
import { IMPORT_MAX_ATTEMPTS, agentKeyFrom, markerNameOf, parseImportReport } from "../src/importTelemetry.js";
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

test("a marker name is one safe path segment per object key", () => {
  assert.equal(markerNameOf("telemetry/i-0abc/2026-09-18T20-05-00Z.aptelemetry"), "telemetry_i-0abc_2026-09-18T20-05-00Z.aptelemetry");
  assert.ok(!markerNameOf("telemetry/../x").includes("/"));
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
