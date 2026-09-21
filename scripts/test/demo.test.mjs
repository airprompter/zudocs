/**
 * The demo's pure parts: the beat transforms append one line and are idempotent, the ramp is what the platform
 * accepts (every step below 100 % holds, the last is 100 %), the canonical pins come from the config with one slot
 * replaced, the fleet-agreement check ignores a stale optional host and names the disagreeing ones, the console
 * client acknowledges only the benign seal warnings and returns a blocked document instead of throwing, and the
 * vendored-bundle check refuses the support agent's bundle and any foreign slot.
 *
 * @example
 * ```sh
 * node --test scripts/test/demo.test.mjs
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { vendoredBreaches } from "../check-vendored.mjs";
import { ACKNOWLEDGEABLE, ConsoleRefusal, createConsole, withPin } from "../lib/console.mjs";
import { BEATS, RAMP, appendLine, armsByCustomer, canonicalPins, fleetAgreement, releaseLine } from "../lib/demo.mjs";

test("beat transforms append one line once and never touch the rest", () => {
  const text = "You are the reply step.\n\n## Success criteria\n- Signs off as the team\n";
  const once = BEATS.warmerSignoff.transform(text);
  assert.ok(once.startsWith(text.trimEnd()), "the original text is kept whole");
  assert.ok(once.trimEnd().endsWith(BEATS.warmerSignoff.line));
  assert.equal(BEATS.warmerSignoff.transform(once), once, "idempotent");
  assert.notEqual(BEATS.changeWords.transform(text), once, "each beat is its own change");
  assert.match(BEATS.undeclaredPlaceholder.transform(text), /\{\{region_note\}\}/);
  assert.equal(appendLine("x")("a\n\n"), "a\n\nx\n");
  for (const beat of Object.values(BEATS)) if (beat.line) assert.ok(!/[{}]/.test(beat.line) || beat === BEATS.undeclaredPlaceholder, `${beat.tag}: no placeholder but the one on purpose`);
});

test("the ramp: every step short of 100 % holds for at least the platform's minimum; the last step is everyone", () => {
  assert.equal(RAMP[RAMP.length - 1].weightBps, 10000);
  for (const step of RAMP.slice(0, -1)) assert.ok(step.holdMinutes >= 10, "a held step");
  assert.deepEqual(RAMP.map((s) => s.weightBps), [1000, 5000, 10000], "10 % → 50 % → 100 %");
  assert.ok(RAMP.every((s, i) => i === 0 || s.weightBps > RAMP[i - 1].weightBps), "strictly increasing");
});

test("canonical pins come from the config; one slot may be replaced; a missing config is refused", () => {
  const config = { canonical: { "support.triage": { versionId: "rev-2", model: "amazon.nova-micro" }, "support.reply": { versionId: "rev-3", model: "amazon.nova-2-lite" } } };
  assert.deepEqual(canonicalPins(config), [{ tag: "support.triage", versionId: "rev-2", model: "amazon.nova-micro" }, { tag: "support.reply", versionId: "rev-3", model: "amazon.nova-2-lite" }]);
  assert.deepEqual(canonicalPins(config, { "support.reply": { versionId: "rev-9" } })[1], { tag: "support.reply", versionId: "rev-9", model: "amazon.nova-2-lite" });
  assert.throws(() => canonicalPins({ canonical: {} }), /canonical pins are missing/);
  assert.deepEqual(withPin(canonicalPins(config), "support.triage", { model: "x" })[0], { tag: "support.triage", versionId: "rev-2", model: "x" });
  assert.throws(() => withPin([], "nope", {}), /no pin for nope/);
  assert.equal(releaseLine(7, "sha256:0123456789abcdef0123"), "#7 sha256:0123456789ab…");
});

test("fleet agreement: every fresh row at the generation; a stale optional host is ignored; disagreement is named", () => {
  const now = Date.parse("2026-09-19T00:00:00Z");
  const row = (hostId, generation, minutesAgo, kind = "lambda") => ({ hostId, kind, writtenAt: new Date(now - minutesAgo * 60_000).toISOString(), status: { generation, applyState: "active", stagedGeneration: null } });
  const agree = fleetAgreement([row("us-east-1/lambda", 9, 1), row("eu-west-1/ec2", 9, 1, "daemon"), row("ap-southeast-1/puller", 9, 3, "puller"), row("ap-southeast-1/airgap", 4, 120, "airgapped")], 9, { now });
  assert.equal(agree.agree, true, "the air-gapped host's row is two hours old: it is down, not behind");
  const behind = fleetAgreement([row("us-east-1/lambda", 9, 1), row("eu-west-1/ec2", 8, 1, "daemon")], 9, { now });
  assert.equal(behind.agree, false);
  assert.deepEqual(behind.disagree.map((r) => r.hostId), ["eu-west-1/ec2"]);
  const airgapUp = fleetAgreement([row("us-east-1/lambda", 9, 1), row("ap-southeast-1/airgap", 8, 2, "airgapped")], 9, { now });
  assert.equal(airgapUp.agree, false, "an air-gapped host that is up and behind counts");
  assert.equal(fleetAgreement([], 9, { now }).agree, false, "nothing reporting is no agreement");
  assert.deepEqual(armsByCustomer([{ customerId: "c1", tag: "support.reply", generation: 5, arms: { a: "control" }, consistent: true }, { customerId: "c1", tag: "support.triage", generation: 5, arms: { a: "candidate" }, consistent: true }], "support.reply"), { c1: { arms: { a: "control" }, consistent: true, generation: 5 } });
  const dialled = [{ customerId: "c1", tag: "support.reply", generation: 6, arms: { a: "candidate" }, consistent: true }, { customerId: "c1", tag: "support.reply", generation: 5, arms: { a: "control" }, consistent: true }];
  assert.deepEqual(armsByCustomer(dialled, "support.reply"), { c1: { arms: { a: "candidate" }, consistent: true, generation: 6 } }, "the newest release's row wins after a dial");
  assert.deepEqual(armsByCustomer(dialled, "support.reply", 5), { c1: { arms: { a: "control" }, consistent: true, generation: 5 } }, "a generation asked for is the one answered");
});

test("the console client: benign warnings are acknowledged once, a real blocker comes back as a document, a refusal names the code", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, body });
    assert.equal(init.headers.authorization, "Bearer session-token");
    const reply = (status, json) => ({ status, text: async () => JSON.stringify(json) });
    if (path.endsWith("/board")) return reply(200, { board: { environments: { dev: { generation: 4, releaseDigest: "sha256:a", stateRevision: 5, frozen: false, applyPolicy: "auto", experiments: [] } }, rows: [{ tag: "support.reply", artifactId: "p1", cells: { dev: { versionId: "rev-3", model: "amazon.nova-2-lite" } } }] } });
    if (path.endsWith("/releases")) {
      if (body.pins[0].versionId === "rev-bad") return reply(409, { error: "blocked", details: { status: "blocked", warnings: [], blockers: [{ code: "variable_undeclared", tag: "support.reply", detail: "rev-bad uses {{x}}" }] } });
      if (!body.acknowledgedWarningCodes) return reply(409, { error: "blocked", details: { status: "blocked", warnings: [{ code: "variable_uncovered", requiresAck: true }, { code: "model_not_reported", requiresAck: false }], blockers: [{ code: "ack_required", detail: "variable_uncovered" }] } });
      return reply(201, { status: "sealed", release: { releaseDigest: "sha256:new", pins: body.pins }, warnings: [{ code: "variable_uncovered" }] });
    }
    if (path.endsWith("/promote")) return reply(409, { code: "environment_frozen", message: "frozen" });
    return reply(404, { error: "no route" });
  };
  const con = createConsole({ config: { baseUrl: "https://api.test", workspaceId: "ws", organizationId: "org", agentId: "agent" }, token: "session-token", fetchImpl });
  const pins = await con.pins("dev");
  assert.deepEqual(pins, [{ tag: "support.reply", versionId: "rev-3", model: "amazon.nova-2-lite", artifactId: "p1" }]);
  const sealed = await con.seal({ environment: "dev", pins, notes: "n" });
  assert.equal(sealed.release.releaseDigest, "sha256:new");
  const sealCalls = calls.filter((c) => c.path.endsWith("/releases"));
  assert.equal(sealCalls.length, 2, "one refusal for the acknowledgement, one sealed");
  assert.deepEqual(sealCalls[1].body.acknowledgedWarningCodes, ["variable_uncovered"]);
  assert.ok(ACKNOWLEDGEABLE.includes("variable_uncovered") && !ACKNOWLEDGEABLE.includes("variable_undeclared"));
  const blocked = await con.seal({ environment: "dev", pins: withPin(pins, "support.reply", { versionId: "rev-bad" }), notes: "n" });
  assert.equal(blocked.release, null);
  assert.equal(blocked.blocked.blockers[0].code, "variable_undeclared");
  await assert.rejects(con.promote({ environment: "dev", releaseDigest: "sha256:new", notes: "n" }), (error) => error instanceof ConsoleRefusal && error.code === "environment_frozen" && error.status === 409);
  assert.throws(() => createConsole({ config: {}, token: "" }), /session token/);
  await assert.rejects(con.pins("qa"), /dev, staging or prod/);
});

test("the console client retries a 5xx once (logged as such) and never a 4xx", async () => {
  let boards = 0;
  const logs = [];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    const reply = (status, json) => ({ status, text: async () => JSON.stringify(json) });
    if (path.endsWith("/board")) { boards += 1; return boards === 1 ? reply(500, { error: "Internal server error" }) : reply(200, { board: { environments: { dev: { generation: 1, releaseDigest: "sha256:a", stateRevision: 1, frozen: false, applyPolicy: "auto", experiments: [] } }, rows: [] } }); }
    if (path.endsWith("/promote")) return reply(409, { code: "stale_state_revision", message: "moved" });
    return reply(404, { error: "no route" });
  };
  const con = createConsole({ config: { baseUrl: "https://api.test", workspaceId: "ws", organizationId: "org", agentId: "agent" }, token: "t", fetchImpl, log: (e) => logs.push(e) });
  const before = Date.now();
  assert.deepEqual(await con.pins("dev"), []);
  assert.equal(boards, 2, "one 500, one answer");
  assert.ok(Date.now() - before >= 2900, "three seconds between them");
  assert.equal(logs.filter((l) => l.event === "platform_5xx_retry").length, 1);
  assert.equal(logs[0].status, 500);
  let promotes = 0;
  const counting = async (url, init) => { if (new URL(url).pathname.endsWith("/promote")) promotes += 1; return fetchImpl(url, init); };
  const con2 = createConsole({ config: { baseUrl: "https://api.test", workspaceId: "ws", organizationId: "org", agentId: "agent" }, token: "t", fetchImpl: counting });
  await assert.rejects(con2.promote({ environment: "dev", releaseDigest: "sha256:a", notes: "n" }), (error) => error instanceof ConsoleRefusal && error.status === 409);
  assert.equal(promotes, 1, "a 4xx is the platform's word");
});

test("the vendored bundle: the CI agent's only, one placeholder slot, verified", () => {
  const config = { organizationId: "org", agentId: "agent_support", ciAgentId: "agent_ci" };
  const meta = { kind: "airprompter-bundle-meta", organizationId: "org", agentId: "agent_ci", generation: 1 };
  assert.deepEqual(vendoredBreaches({ meta, verify: { ok: true, manifest: { slots: 1 } }, config }), []);
  assert.deepEqual(vendoredBreaches({ meta, verify: { ok: true, manifest: { slots: [{ tag: "ci.vendoring" }] } }, config }), []);
  assert.match(vendoredBreaches({ meta: { ...meta, agentId: "agent_support" }, verify: { ok: true, manifest: { slots: 1 } }, config }).join("\n"), /support agent/);
  assert.match(vendoredBreaches({ meta, verify: { ok: true, manifest: { slots: 4 } }, config }).join("\n"), /carries 4 slot/);
  assert.match(vendoredBreaches({ meta, verify: { ok: true, manifest: { slots: [{ tag: "support.reply" }] } }, config }).join("\n"), /outside the CI agent's: support.reply/);
  assert.match(vendoredBreaches({ meta, verify: { ok: false, step: "root", reason: "root_scope_mismatch", manifest: { slots: 1 } }, config }).join("\n"), /root_scope_mismatch/);
  assert.match(vendoredBreaches({ meta, verify: null, config: { ...config, ciAgentId: null } }).join("\n"), /no ciAgentId/);
});
