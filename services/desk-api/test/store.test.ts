/**
 * The store over a fake document client that behaves like DynamoDB where it matters: the cap is one atomic
 * conditional ADD that is refused at the line (a ConditionalCheckFailedException, then a read of the count), any
 * other error propagates, events carry the TTL attribute, and the observation tap shadows the spool writer's
 * method while still calling the original.
 *
 * @example
 * ```sh
 * npx tsx --test test/store.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { collectObservations, tapObservations } from "../src/runtime.js";
import { EVENT_RETENTION_DAYS, approvalIdOf, createStore, type ApprovalRow } from "../src/store.js";

const TABLES = { tickets: "t", customers: "c", runs: "r", feedback: "f", status: "s", events: "e", counters: "n", approvals: "a" };

const conditionFailed = () => new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });

/**
 * A fake that behaves like DynamoDB where it matters: the counter table enforces `runs < :cap`; the queue rows
 * (`queue#…`) honour list_append and the conditional REMOVE of the head; the approvals table honours the three
 * conditions the store uses (create-once, pending→approved, settle-from-pending-or-approved). Everything else
 * records the command.
 */
function fakeClient(options: { failWith?: Error } = {}) {
  const counters = new Map<string, number>();
  const queues = new Map<string, string[]>();
  const approvals = new Map<string, Record<string, any>>();
  const sent: unknown[] = [];
  return {
    sent,
    counters,
    queues,
    approvals,
    async send(command: unknown) {
      sent.push(command);
      if (options.failWith) throw options.failWith;
      if (command instanceof UpdateCommand && command.input.TableName === TABLES.counters) {
        const key = (command.input.Key as { pk: string }).pk;
        if (key.startsWith("queue#")) {
          const items = queues.get(key) ?? [];
          if (command.input.UpdateExpression?.startsWith("SET")) {
            const appended = [...items, ...(command.input.ExpressionAttributeValues as { ":one": string[] })[":one"]];
            queues.set(key, appended);
            return { Attributes: { items: appended } };
          }
          const first = (command.input.ExpressionAttributeValues as { ":first": string })[":first"];
          if (items[0] !== first) throw conditionFailed();
          queues.set(key, items.slice(1));
          return {};
        }
        const cap = (command.input.ExpressionAttributeValues as { ":cap": number })[":cap"];
        const current = counters.get(key) ?? 0;
        if (current >= cap) throw conditionFailed();
        counters.set(key, current + 1);
        return { Attributes: { runs: current + 1 } };
      }
      if (command instanceof GetCommand && command.input.TableName === TABLES.counters) {
        const key = (command.input.Key as { pk: string }).pk;
        if (key.startsWith("queue#")) return { Item: queues.has(key) ? { pk: key, items: queues.get(key) } : undefined };
        return { Item: counters.has(key) ? { runs: counters.get(key) } : undefined };
      }
      if (command instanceof PutCommand && command.input.TableName === TABLES.approvals) {
        const row = command.input.Item as Record<string, any>;
        const existing = approvals.get(row.approvalId);
        if (existing && !["superseded", "failed"].includes(existing.decision)) throw conditionFailed();
        approvals.set(row.approvalId, { ...row });
        return {};
      }
      if (command instanceof GetCommand && command.input.TableName === TABLES.approvals) {
        const id = (command.input.Key as { approvalId: string }).approvalId;
        return { Item: approvals.has(id) ? { ...approvals.get(id) } : undefined };
      }
      if (command instanceof UpdateCommand && command.input.TableName === TABLES.approvals) {
        const id = (command.input.Key as { approvalId: string }).approvalId;
        const row = approvals.get(id);
        const values = command.input.ExpressionAttributeValues as Record<string, any>;
        if (!row) throw conditionFailed();
        if (command.input.ConditionExpression === "decision = :pending") {
          if (row.decision !== "pending") throw conditionFailed();
          Object.assign(row, { decision: values[":approved"], decidedBy: values[":by"], decidedAt: values[":at"], updatedAt: values[":at"] });
        } else {
          if (!["pending", "approved"].includes(row.decision)) throw conditionFailed();
          Object.assign(row, { decision: values[":decision"], outcome: values[":outcome"], activatedAt: values[":activatedAt"], updatedAt: values[":at"] });
        }
        return { Attributes: { ...row } };
      }
      return {};
    },
  };
}

test("the cap: one conditional ADD per run, refused at the line with the count read back, never over", async () => {
  const client = fakeClient();
  const store = createStore(client, TABLES);
  assert.deepEqual(await store.takeRunSlot("2026-09-18", 2), { ok: true, used: 1 });
  assert.deepEqual(await store.takeRunSlot("2026-09-18", 2), { ok: true, used: 2 });
  assert.deepEqual(await store.takeRunSlot("2026-09-18", 2), { ok: false, used: 2 });
  assert.deepEqual(await store.takeRunSlot("2026-09-18", 2), { ok: false, used: 2 }, "still refused, still two");
  assert.equal(client.counters.get("day#2026-09-18"), 2, "the counter never passed the line");
  assert.deepEqual(await store.takeRunSlot("2026-09-19", 2), { ok: true, used: 1 }, "a new day is a new counter");
  const update = client.sent.find((c) => c instanceof UpdateCommand) as UpdateCommand;
  assert.equal(update.input.UpdateExpression, "ADD runs :one");
  assert.equal(update.input.ConditionExpression, "attribute_not_exists(runs) OR runs < :cap");
  assert.equal(await store.readRunSlots("2026-09-18"), 2);
  assert.equal(await store.readRunSlots("2026-09-20"), 0);
});

test("the cap: an error other than the condition propagates — the desk never runs on a guess", async () => {
  const store = createStore(fakeClient({ failWith: Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }) }), TABLES);
  await assert.rejects(() => store.takeRunSlot("2026-09-18", 2), /throttled/);
});

test("events carry the TTL attribute the table expires on, and listing strips the keys", async () => {
  const client = fakeClient();
  const store = createStore(client, TABLES);
  await store.appendEvent({ at: "2026-09-18T15:00:00.000Z", kind: "ticket_run", host: "us-east-1/lambda" });
  const put = client.sent.find((c) => c instanceof PutCommand) as PutCommand;
  const item = put.input.Item as Record<string, unknown>;
  assert.equal(item.day, "2026-09-18");
  assert.equal(item.expiresAt, Math.floor(Date.parse("2026-09-18T15:00:00.000Z") / 1000) + EVENT_RETENTION_DAYS * 86_400);
  assert.match(String(item.sk), /^2026-09-18T15:00:00\.000Z#[a-z0-9]{6}$/);
});

test("events come back with the row's sort key as their id (the desk de-duplicates on it), never the partition key", async () => {
  const client = { async send(command: unknown) { return command instanceof QueryCommand ? { Items: [{ day: "2026-09-18", sk: "2026-09-18T15:00:00.000Z#abc123", expiresAt: 1, at: "2026-09-18T15:00:00.000Z", kind: "cap_refused", host: "h", capDay: "2026-09-18" }] } : {}; } };
  const store = createStore(client, TABLES);
  const [event] = await store.listEvents(null);
  assert.deepEqual(event, { id: "2026-09-18T15:00:00.000Z#abc123", at: "2026-09-18T15:00:00.000Z", kind: "cap_refused", host: "h", capDay: "2026-09-18" });
  assert.ok(!("day" in event!) && !("sk" in event!) && !("expiresAt" in event!));
});

test("approvals: created once per host and generation, approved exactly once (a repeat reads the row as it is), settled from pending or approved only; a settled superseded row may be re-opened", async () => {
  const client = fakeClient();
  const store = createStore(client, TABLES);
  const id = approvalIdOf("eu-west-1/ec2", 2, "i-abcDEF123_-");
  assert.equal(id, "eu-west-1-ec2-g2-i-abcDEF123_-", "one path segment: host, generation, store");
  assert.notEqual(approvalIdOf("eu-west-1/ec2", 2, "i-other"), id, "the same generation on another store is another row");
  assert.equal(approvalIdOf("h", 1, "!!"), "h-g1-store");
  const row: ApprovalRow = { approvalId: id, hostId: "eu-west-1/ec2", storeId: "i-abcDEF123_-", generation: 2, releaseDigest: null, stagedAt: "2026-09-18T15:00:00.000Z", unlockRequest: null, decision: "pending", decidedBy: null, decidedAt: null, activatedAt: null, outcome: null, updatedAt: "2026-09-18T15:00:00.000Z" };
  assert.deepEqual(await store.openApproval(row), { created: true });
  assert.deepEqual(await store.openApproval(row), { created: false }, "a restarted worker finds its row, it does not make a second");
  const first = await store.approve(id, "seth@zudocs.com", "2026-09-18T15:01:00.000Z");
  assert.equal(first.ok, true);
  assert.equal(first.row?.decision, "approved");
  assert.equal(first.row?.decidedBy, "seth@zudocs.com");
  const second = await store.approve(id, "sales@zudocs.com", "2026-09-18T15:01:05.000Z");
  assert.equal(second.ok, false, "the second approve is not a second decision");
  assert.equal(second.row?.decidedBy, "seth@zudocs.com", "the first decision stands");
  const settled = await store.settleApproval(id, { decision: "activated", outcome: "activated through the daemon", activatedAt: "2026-09-18T15:01:10.000Z", at: "2026-09-18T15:01:10.000Z" });
  assert.equal(settled?.decision, "activated");
  assert.equal(await store.settleApproval(id, { decision: "superseded", outcome: "again", at: "x" }), null, "an activated row is not settled twice");
  assert.equal((await store.approve(id, "seth@zudocs.com", "later")).ok, false, "nor approved after it settled");
  assert.equal(await store.getApproval("nope"), null);
  assert.deepEqual(await store.approve("nope", "x", "y"), { ok: false, row: null });
  assert.deepEqual(await store.openApproval(row), { created: false }, "an activated generation is not re-opened");
  client.approvals.get(id)!.decision = "superseded";
  assert.deepEqual(await store.openApproval(row), { created: true }, "a superseded row may be re-opened (the generation is staged again)");
});

test("the queue: append in order, take the head atomically (the condition names the head this reader saw), empty is null", async () => {
  const client = fakeClient();
  const store = createStore(client, TABLES);
  assert.equal(await store.dequeueTicket("eu-west-1/ec2"), null);
  assert.equal(await store.enqueueTicket("eu-west-1/ec2", "T-1"), 1);
  assert.equal(await store.enqueueTicket("eu-west-1/ec2", "T-2"), 2);
  assert.equal(await store.dequeueTicket("eu-west-1/ec2"), "T-1");
  assert.equal(await store.dequeueTicket("eu-west-1/ec2"), "T-2");
  assert.equal(await store.dequeueTicket("eu-west-1/ec2"), null);
  assert.equal(await store.dequeueTicket("other/host"), null, "queues are per host");
  const remove = client.sent.filter((c) => c instanceof UpdateCommand && c.input.UpdateExpression === "REMOVE #items[0]") as UpdateCommand[];
  assert.equal(remove.length, 2);
  assert.equal(remove[0]!.input.ConditionExpression, "#items[0] = :first");
});

test("updateStatus merges the given fields and nothing else (the Python worker's part of the row survives the Node writer)", async () => {
  const client = fakeClient();
  const store = createStore(client, TABLES);
  await store.updateStatus("eu-west-1/ec2", { hostId: "ignored", writtenAt: "now", status: { generation: 2 } });
  const update = client.sent.find((c) => c instanceof UpdateCommand && c.input.TableName === TABLES.status) as UpdateCommand;
  assert.equal(update.input.UpdateExpression, "SET #f0 = :v0, #f1 = :v1");
  assert.deepEqual(update.input.ExpressionAttributeNames, { "#f0": "writtenAt", "#f1": "status" });
  assert.deepEqual(update.input.Key, { hostId: "eu-west-1/ec2" });
  await store.updateStatus("eu-west-1/ec2", {});
  assert.equal(client.sent.filter((c) => c instanceof UpdateCommand && c.input.TableName === TABLES.status).length, 1, "nothing to set, nothing sent");
});

test("the observation tap shadows spool.observe, still calls the original, collects per request, and is idempotent", async () => {
  const written: unknown[] = [];
  class Writer {
    observe(observation: unknown, nowMs: number) { written.push([observation, nowMs]); }
  }
  const ap = { spool: new Writer() };
  tapObservations(ap);
  tapObservations(ap);
  assert.ok(Object.prototype.hasOwnProperty.call(ap.spool, "observe"), "an own property shadows the prototype method");
  const row = { tag: "support.reply", versionId: "rev-2", arm: "none", model: "m", status: "ok" as const, latencyMs: 5, usageSource: "reported" as const };
  const inside = await collectObservations(async () => {
    setTimeout(() => ap.spool.observe(row, 1), 0);   // the wrappers file one turn after the call settles
    return "answer";
  });
  assert.equal(inside.result, "answer");
  assert.deepEqual(inside.observations, [row], "captured for the request that made the call");
  assert.equal(written.length, 1, "the original wrote it once (the second tap did not double it)");
  const failed = await collectObservations(async () => { throw new Error("refused"); });
  assert.equal((failed.error as Error).message, "refused");
  assert.deepEqual(failed.observations, [], "a call nothing observed returns after the bounded wait");
  ap.spool.observe(row, 2);
  assert.equal(written.length, 2);
  assert.equal(inside.observations.length, 1, "an observation outside a request lands nowhere");
});
