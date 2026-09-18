/**
 * The wire against a fake EC2: a cut adds the DynamoDB-only HTTPS rules and the tag before it revokes the open
 * rule (the tables never go dark), a second cut changes nothing, a restore puts the open rule back and clears the
 * narrow rules and the tag, a tick restores only when the cut is older than the limit, a group with an inbound
 * rule is refused, and ip-ranges.json that cannot be read refuses the cut.
 *
 * @example
 * ```sh
 * npx tsx --test test/wire.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthorizeSecurityGroupEgressCommand, CreateTagsCommand, DeleteTagsCommand, DescribeSecurityGroupsCommand, RevokeSecurityGroupEgressCommand, type IpPermission } from "@aws-sdk/client-ec2";
import { CUT_DESCRIPTION, CUT_TAG, OPEN_DESCRIPTION, RULE_DESCRIPTION, dynamoCidrsOf, shouldRestore, stateOf, wire, type WirePorts } from "../src/wire.js";

const IP_RANGES = { prefixes: [{ ip_prefix: "52.94.0.0/22", region: "us-east-1", service: "DYNAMODB" }, { ip_prefix: "3.218.180.0/22", region: "us-east-1", service: "DYNAMODB" }, { ip_prefix: "52.94.0.0/22", region: "us-east-1", service: "AMAZON" }, { ip_prefix: "52.94.24.0/22", region: "eu-west-1", service: "DYNAMODB" }] };

function fakeEc2(initial: { egress?: IpPermission[]; ingress?: IpPermission[]; tags?: Record<string, string> } = {}) {
  const group = { GroupId: "sg-1", IpPermissions: initial.ingress ?? [], IpPermissionsEgress: initial.egress ?? [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] }], Tags: Object.entries(initial.tags ?? {}).map(([Key, Value]) => ({ Key, Value })) };
  const calls: string[] = [];
  return {
    group,
    calls,
    async send(command: unknown) {
      if (command instanceof DescribeSecurityGroupsCommand) return { SecurityGroups: [structuredClone(group)] };
      if (command instanceof AuthorizeSecurityGroupEgressCommand) {
        calls.push(`authorize:${JSON.stringify(command.input.IpPermissions)}`);
        group.IpPermissionsEgress.push(...(command.input.IpPermissions ?? []));
        return {};
      }
      if (command instanceof RevokeSecurityGroupEgressCommand) {
        calls.push(`revoke:${JSON.stringify(command.input.IpPermissions)}`);
        for (const p of command.input.IpPermissions ?? []) group.IpPermissionsEgress = group.IpPermissionsEgress.filter((e) => !(e.IpProtocol === p.IpProtocol && (e.FromPort ?? null) === (p.FromPort ?? null) && JSON.stringify((e.IpRanges ?? []).map((r) => r.CidrIp)) === JSON.stringify((p.IpRanges ?? []).map((r) => r.CidrIp))));
        return {};
      }
      if (command instanceof CreateTagsCommand) {
        calls.push("tag");
        for (const t of command.input.Tags ?? []) group.Tags.push({ Key: t.Key!, Value: t.Value! });
        return {};
      }
      if (command instanceof DeleteTagsCommand) {
        calls.push("untag");
        group.Tags = group.Tags.filter((t) => !(command.input.Tags ?? []).some((d) => d.Key === t.Key));
        return {};
      }
      throw new Error(`unexpected ${String((command as { constructor: { name: string } }).constructor.name)}`);
    },
  };
}

function ports(ec2: ReturnType<typeof fakeEc2>, overrides: Partial<WirePorts> = {}): WirePorts & { events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  return {
    env: { securityGroupId: "sg-1", hostId: "eu-west-1/ec2", dynamoRegion: "us-east-1", eventsTable: "e", maxCutMinutes: 15, ipRangesUrl: "https://ip-ranges.example/ip-ranges.json" },
    ec2,
    fetchImpl: (async () => new Response(JSON.stringify(IP_RANGES), { status: 200 })) as unknown as typeof fetch,
    appendEvent: async (e) => void events.push(e),
    now: () => Date.parse("2026-09-18T15:00:00.000Z"),
    events,
    ...overrides,
  };
}

test("the rule descriptions are ones EC2 accepts (the first real restore failed on an apostrophe)", () => {
  assert.match(OPEN_DESCRIPTION, RULE_DESCRIPTION);
  assert.match(CUT_DESCRIPTION, RULE_DESCRIPTION);
  assert.doesNotMatch("the desk's tables", RULE_DESCRIPTION, "an apostrophe is refused by EC2");
});

test("pure helpers: the region's DynamoDB CIDRs, the group's state, the restore rule", () => {
  assert.deepEqual(dynamoCidrsOf(IP_RANGES, "us-east-1"), ["3.218.180.0/22", "52.94.0.0/22"]);
  assert.deepEqual(dynamoCidrsOf(IP_RANGES, "ap-southeast-1"), []);
  assert.deepEqual(stateOf({ IpPermissionsEgress: [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] }], Tags: [] }), { state: "connected", cutAt: null, egress: ["all → 0.0.0.0/0"] });
  assert.equal(stateOf({ IpPermissionsEgress: [{ IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "52.94.0.0/22" }] }], Tags: [{ Key: CUT_TAG, Value: "2026-09-18T14:50:00.000Z" }] }).cutAt, "2026-09-18T14:50:00.000Z");
  assert.equal(stateOf({ IpPermissionsEgress: [], Tags: [] }).state, "cut", "no rule at all is a cut too");
  assert.equal(stateOf({ IpPermissionsEgress: [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] }, { IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "52.94.0.0/22" }] }], Tags: [] }).state, "connected", "the open rule decides; an extra rule beside it is not a cut");
  const now = Date.parse("2026-09-18T15:00:00.000Z");
  assert.equal(shouldRestore(null, now, 15), true, "a cut with no instant (the tag lost to a stack update) is restored, never kept");
  assert.equal(shouldRestore("2026-09-18T14:50:00.000Z", now, 15), false);
  assert.equal(shouldRestore("2026-09-18T14:45:00.000Z", now, 15), true);
  assert.equal(shouldRestore("not a date", now, 15), true, "an unreadable tag never keeps a wire cut");
});

test("cut: the narrow HTTPS rules and the tag go on before the open rule comes off; the answer names the restore deadline; a second cut is a no-op", async () => {
  const ec2 = fakeEc2();
  const p = ports(ec2);
  const answer = await wire({ action: "cut", by: "seth@zudocs.com" }, p);
  assert.equal(answer.state, "cut");
  assert.equal(answer.changed, true);
  assert.equal(answer.cutAt, "2026-09-18T15:00:00.000Z");
  assert.equal(answer.restoreBy, "2026-09-18T15:15:00.000Z");
  assert.deepEqual(answer.egress, ["tcp/443 → 3.218.180.0/22", "tcp/443 → 52.94.0.0/22"]);
  assert.match(ec2.calls[0]!, /^authorize:.*"FromPort":443/);
  assert.equal(ec2.calls[1], "tag");
  assert.match(ec2.calls[2]!, /^revoke:.*0\.0\.0\.0\/0/);
  assert.equal(p.events.length, 1);
  assert.equal(p.events[0]!.kind, "wire");
  assert.equal(p.events[0]!.action, "cut");
  const again = await wire({ action: "cut" }, p);
  assert.equal(again.changed, false);
  assert.equal(ec2.calls.length, 3, "nothing sent the second time");
  assert.equal(p.events.length, 1);
});

test("restore: the open rule back, the narrow rules and the tag gone, one event; a restore on a connected group changes nothing", async () => {
  const ec2 = fakeEc2();
  const p = ports(ec2);
  await wire({ action: "cut" }, p);
  const restored = await wire({ action: "restore", by: "seth@zudocs.com" }, p);
  assert.equal(restored.state, "connected");
  assert.equal(restored.changed, true);
  assert.equal(restored.cutAt, null);
  assert.deepEqual(restored.egress, ["all → 0.0.0.0/0"]);
  assert.equal(ec2.group.Tags.length, 0);
  assert.equal(p.events.at(-1)!.action, "restore");
  const again = await wire({ action: "restore" }, p);
  assert.equal(again.changed, false);
  assert.equal(p.events.length, 2);
});

test("tick: a fresh cut stays cut; a cut older than the limit is restored by the rule, with the event saying so", async () => {
  const ec2 = fakeEc2();
  let now = Date.parse("2026-09-18T15:00:00.000Z");
  const p = ports(ec2, { now: () => now });
  await wire({ action: "cut" }, p);
  now += 10 * 60_000;
  assert.equal((await wire({ action: "tick" }, p)).state, "cut");
  now += 6 * 60_000;
  const restored = await wire({ action: "tick" }, p);
  assert.equal(restored.state, "connected");
  assert.equal(restored.changed, true);
  assert.match(String(p.events.at(-1)!.by), /the rule/);
  assert.equal((await wire({ action: "tick" }, p)).changed, false);
});

test("tick: a cut whose tag is gone is restored on the next tick regardless of age", async () => {
  const ec2 = fakeEc2({ egress: [{ IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "52.94.0.0/22", Description: CUT_DESCRIPTION }] }], tags: {} });
  const p = ports(ec2);
  const restored = await wire({ action: "tick" }, p);
  assert.equal(restored.state, "connected");
  assert.equal(restored.changed, true);
});

test("status reads only; a group with an inbound rule is refused; ip-ranges.json that cannot be read refuses the cut and leaves the group as it was", async () => {
  const ec2 = fakeEc2();
  const p = ports(ec2);
  assert.deepEqual(await wire({ action: "status" }, p), { action: "status", hostId: "eu-west-1/ec2", state: "connected", changed: false, cutAt: null, restoreBy: null, egress: ["all → 0.0.0.0/0"] });
  assert.equal(ec2.calls.length, 0);
  const inbound = fakeEc2({ ingress: [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "0.0.0.0/0" }] }] });
  await assert.rejects(() => wire({ action: "status" }, ports(inbound)), /has inbound rules/);
  const down = ports(ec2, { fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch });
  await assert.rejects(() => wire({ action: "cut" }, down), /ip-ranges\.json answered 503/);
  assert.equal(ec2.calls.length, 0, "nothing was authorised or revoked");
  assert.equal(stateOf(ec2.group).state, "connected");
});
