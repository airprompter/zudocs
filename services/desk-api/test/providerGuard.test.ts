/**
 * The two guards on the direct providers: the switch reads fail-closed (an absent, unparseable, unlisted or `off`
 * door is closed, and says which), the document the desk writes names every door so no reader has to guess, and the
 * ports cache the read so a kill switch takes effect within its window and not on every run.
 *
 * @example
 * ```sh
 * npx tsx --test test/providerGuard.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SWITCH_CACHE_SECONDS, createProviderSwitchPorts, parseProviderSwitch, providerSwitchDocument, withDoor } from "../src/providerGuard.js";

test("the switch is fail-closed: only an explicit `on` opens a door, and every other reading says why", () => {
  assert.deepEqual(parseProviderSwitch('{"openai":"on","anthropic":"on"}'), { openai: { open: true, reason: null }, anthropic: { open: true, reason: null } });
  assert.deepEqual(parseProviderSwitch('{"openai":"on","anthropic":"off"}').anthropic, { open: false, reason: "off" });
  assert.deepEqual(parseProviderSwitch('{"openai":"on"}').anthropic, { open: false, reason: "unlisted" }, "a door the document forgot is closed, not assumed");
  for (const [text, reason] of [[null, "absent"], ["", "absent"], ["   ", "absent"], ["on", "unparseable"], ["[]", "unparseable"], ['"on"', "unparseable"]] as const) {
    const doors = parseProviderSwitch(text);
    assert.deepEqual([doors.openai.open, doors.anthropic.open], [false, false], `${String(text)} closes every door`);
    assert.equal(doors.openai.reason, reason, String(text));
  }
  // A value that is not the string "on" — a truthy one included — is closed: no cleverness about intent.
  assert.deepEqual(parseProviderSwitch('{"openai":true,"anthropic":1}').openai, { open: false, reason: "off" });
});

test("the document names every door and carries who and when; flipping one leaves the other as it reads", () => {
  const written = providerSwitchDocument({ openai: "on", anthropic: "off" }, "seth@zudocs.com", Date.parse("2026-09-22T10:00:00Z"));
  assert.deepEqual(JSON.parse(written), { openai: "on", anthropic: "off", by: "seth@zudocs.com", at: "2026-09-22T10:00:00.000Z" });
  assert.deepEqual(parseProviderSwitch(written), { openai: { open: true, reason: null }, anthropic: { open: false, reason: "off" } });
  // withDoor over a switch that had a door unlisted: the untouched door keeps what it *reads* (closed), never "unlisted".
  assert.deepEqual(withDoor(parseProviderSwitch('{"openai":"on"}'), "anthropic", "on"), { openai: "on", anthropic: "on" });
  assert.deepEqual(withDoor(parseProviderSwitch('{"openai":"on","anthropic":"on"}'), "openai", "off"), { openai: "off", anthropic: "on" });
});

test("the ports cache the read inside the window and not past it; a write takes effect at once and an unreadable parameter closes every door", async () => {
  let clock = 1_000_000;
  const reads: string[] = [];
  const puts: string[] = [];
  let value: string | null = '{"openai":"on","anthropic":"on"}';
  const client = {
    send: async (command: unknown) => {
      const { constructor, input } = command as { constructor: { name: string }; input: Record<string, string> };
      if (constructor.name === "PutParameterCommand") { puts.push(input.Value!); value = input.Value!; return {}; }
      reads.push(input.Name!);
      if (value === null) throw Object.assign(new Error("not found"), { name: "ParameterNotFound" });
      return { Parameter: { Value: value } };
    },
  };
  const ports = createProviderSwitchPorts("us-east-1", "/zudocs/dev/providers", () => clock, client);
  assert.equal((await ports.read()).openai.open, true);
  assert.equal((await ports.read()).openai.open, true);
  assert.equal(reads.length, 1, "two reads inside the window, one call");
  clock += (SWITCH_CACHE_SECONDS + 1) * 1000;
  assert.equal((await ports.read()).openai.open, true);
  assert.equal(reads.length, 2, "past the window it reads again");
  const after = await ports.write("anthropic", "off", "seth@zudocs.com");
  assert.equal(after.anthropic.open, false);
  assert.deepEqual(JSON.parse(puts[0]!).openai, "on", "the door not flipped keeps its state");
  assert.deepEqual(JSON.parse(puts[0]!).by, "seth@zudocs.com");
  const before = reads.length;
  assert.equal((await ports.read()).anthropic.open, false, "the write seeds the cache; no read follows it");
  assert.equal(reads.length, before);
  value = null;
  clock += (SWITCH_CACHE_SECONDS + 1) * 1000;
  const gone = await ports.read();
  assert.deepEqual([gone.openai.open, gone.anthropic.open], [false, false], "a deleted parameter closes the doors");
  assert.equal(gone.openai.reason, "absent");
});
