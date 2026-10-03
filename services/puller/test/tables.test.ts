/**
 * The puller's state object and the desk tables it still writes.
 *
 * @example
 * ```sh
 * npm test --workspace services/puller
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createExchange } from "../src/exchange.js";
import { EMPTY_STATE } from "../src/plan.js";
import { PULLER_STATE_KEY, RaceLost, createDeskTables, createPullerState } from "../src/tables.js";

/** A client that records commands and answers what the test queued. */
function fakeClient(answers: Array<unknown | Error> = []) {
  const sent: unknown[] = [];
  return {
    sent,
    async send(command: unknown) {
      sent.push(command);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? {};
    },
  };
}

test("the puller's state object: a missing object is the empty state; a write is conditioned on the ETag; a lost condition is RaceLost", async () => {
  const missing = Object.assign(new Error("nope"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
  const body = (text: string, etag: string) => ({ Body: { transformToString: async () => text }, ETag: etag });
  const client = fakeClient([
    missing,
    { ETag: '"1"' },
    body(JSON.stringify({ state: { nudges: 2 } }), '"1"'),
    { ETag: '"2"' },
    Object.assign(new Error("cond"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } }),
  ]);
  const store = createPullerState(client, "bucket");
  const fresh = await store.read();
  assert.equal(fresh.version, null);
  assert.equal(fresh.state.nudges, 0);
  assert.equal(await store.write(fresh.state, null), '"1"');
  const first = client.sent[1] as PutObjectCommand;
  assert.equal(first.input.Key, PULLER_STATE_KEY);
  assert.equal(first.input.IfNoneMatch, "*");
  const read = await store.read();
  assert.equal(read.version, '"1"');
  assert.equal(read.state.nudges, 2);
  assert.deepEqual(read.state.airgap, EMPTY_STATE.airgap);
  assert.equal(await store.write(read.state, '"1"'), '"2"');
  const put = client.sent[3] as PutObjectCommand;
  assert.equal(put.input.IfMatch, '"1"');
  await assert.rejects(() => store.write(read.state, '"1"'), (error: unknown) => error instanceof RaceLost);
});

test("the desk's tables: updateStatus merges fields with SET; appendEvent writes the day, the sort key and the expiry the desk's store writes", async () => {
  const client = fakeClient([{}, {}]);
  const desk = createDeskTables(client, { status: "zudocs-desk-status", events: "zudocs-desk-events" });
  await desk.updateStatus("ap-southeast-1/puller", { kind: "puller", writtenAt: "t" });
  const update = client.sent[0] as UpdateCommand;
  assert.equal(update.input.UpdateExpression, "SET #f0 = :v0, #f1 = :v1");
  assert.deepEqual(update.input.ExpressionAttributeNames, { "#f0": "kind", "#f1": "writtenAt" });
  await desk.appendEvent({ at: "2026-09-18T20:00:00.000Z", kind: "bundle_pulled", host: "ap-southeast-1/puller", generation: 3 });
  const put = client.sent[1] as PutCommand;
  const item = put.input.Item as { day: string; sk: string; expiresAt: number; kind: string };
  assert.equal(item.day, "2026-09-18");
  assert.ok(item.sk.startsWith("2026-09-18T20:00:00.000Z#"));
  assert.equal(item.expiresAt, Math.floor(Date.parse("2026-09-18T20:00:00.000Z") / 1000) + 14 * 86_400);
  assert.equal(item.kind, "bundle_pulled");
});

test("the exchange: a missing object (404) is absent; a refused read (403) is reported as denied — never taken for absent; a malformed key is a reason; a real error is thrown", async () => {
  const body = (text: string) => ({ Body: { transformToString: async () => text } });
  const notFound = Object.assign(new Error("nope"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
  const denied = Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
  const client = fakeClient([notFound, denied, body("{}"), body(JSON.stringify({ kind: "airprompter-airgap-status", v: 1, hostId: "h", writtenAt: "w", startedAt: "s", applies: [] })), Object.assign(new Error("throttled"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } }), denied]);
  const exchange = createExchange(client, "b");
  assert.deepEqual(await exchange.readPublicKey(), { key: null, reason: "absent" });
  assert.deepEqual(await exchange.readPublicKey(), { key: null, reason: "denied:AccessDenied" });
  assert.equal((await exchange.readPublicKey()).reason, "not a distribution public key file (kind airprompter-distribution-public-key)");
  assert.equal((await exchange.readStatusDoc()).doc?.hostId, "h");
  await assert.rejects(() => exchange.readStatusDoc(), /throttled/);
  assert.deepEqual(await exchange.readStatusDoc(), { doc: null, denied: "AccessDenied" });
  assert.ok(client.sent[0] instanceof GetObjectCommand);
});
