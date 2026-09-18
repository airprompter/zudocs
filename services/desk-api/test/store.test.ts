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
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { collectObservations, tapObservations } from "../src/runtime.js";
import { EVENT_RETENTION_DAYS, createStore } from "../src/store.js";

const TABLES = { tickets: "t", customers: "c", runs: "r", feedback: "f", status: "s", events: "e", counters: "n" };

/** A counter table that enforces `runs < :cap` the way DynamoDB does; everything else records the command. */
function fakeClient(options: { failWith?: Error } = {}) {
  const counters = new Map<string, number>();
  const sent: unknown[] = [];
  return {
    sent,
    counters,
    async send(command: unknown) {
      sent.push(command);
      if (options.failWith) throw options.failWith;
      if (command instanceof UpdateCommand && command.input.TableName === TABLES.counters) {
        const key = (command.input.Key as { pk: string }).pk;
        const cap = (command.input.ExpressionAttributeValues as { ":cap": number })[":cap"];
        const current = counters.get(key) ?? 0;
        if (current >= cap) throw new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
        counters.set(key, current + 1);
        return { Attributes: { runs: current + 1 } };
      }
      if (command instanceof GetCommand && command.input.TableName === TABLES.counters) {
        const key = (command.input.Key as { pk: string }).pk;
        return { Item: counters.has(key) ? { runs: counters.get(key) } : undefined };
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
