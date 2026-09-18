import assert from "node:assert/strict";
import { test } from "node:test";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createExchange } from "../src/exchange.js";
import { EMPTY_STATE, type PullerState } from "../src/plan.js";
import { createDeskTables, createReleasesTable, RaceLost } from "../src/tables.js";

const row = { generation: 3, releaseDigest: "sha256:3", pulledAt: "t", keyId: null, object: "releases/3-3-plain.apbundle", bytes: 1, notAfter: "n", via: "tick" as const };

/** A document client that records commands and answers what the test queued. */
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

test("the releases table: the state row is read consistently; a write is conditioned on the version read and bumps it; a lost condition is RaceLost", async () => {
  const client = fakeClient([{ Item: { state: { nudges: 2 }, version: 4 } }, {}, Object.assign(new Error("cond"), { name: "ConditionalCheckFailedException" })]);
  const table = createReleasesTable(client, "zudocs-agent-releases", "agent_x/dev");
  const read = await table.readState();
  assert.equal(read.version, 4);
  assert.equal(read.state.nudges, 2);
  assert.deepEqual(read.state.airgap, EMPTY_STATE.airgap, "missing parts are filled from the empty state");
  const get = client.sent[0] as GetCommand;
  assert.equal(get.input.ConsistentRead, true);
  assert.deepEqual(get.input.Key, { pk: "puller#agent_x/dev", generation: 0 });
  assert.equal(await table.writeState(read.state, 4), 5);
  const put = client.sent[1] as PutCommand;
  assert.equal(put.input.ConditionExpression, "version = :v");
  assert.deepEqual(put.input.ExpressionAttributeValues, { ":v": 4 });
  assert.equal((put.input.Item as { version: number }).version, 5);
  await assert.rejects(() => table.writeState(read.state, 4), (error: unknown) => error instanceof RaceLost);
  const fresh = fakeClient([{}]);
  await createReleasesTable(fresh, "t", "s").writeState({ ...EMPTY_STATE }, 0);
  assert.equal((fresh.sent[0] as PutCommand).input.ConditionExpression, "attribute_not_exists(pk) OR version = :v", "a first write tolerates an absent row");
});

test("the releases table: the newest row is one consistent query, newest first; a release and the state go in one transaction whose cancellation reasons are read", async () => {
  const client = fakeClient([{ Items: [{ pk: "release#agent_x/dev", ...row }] }, {}]);
  const table = createReleasesTable(client, "zudocs-agent-releases", "agent_x/dev");
  const newest = await table.newest();
  assert.equal(newest?.generation, 3);
  const query = client.sent[0] as QueryCommand;
  assert.equal(query.input.ScanIndexForward, false);
  assert.equal(query.input.Limit, 1);
  assert.equal(query.input.ConsistentRead, true);
  const state: PullerState = { ...EMPTY_STATE, nudges: 1 };
  assert.deepEqual(await table.writeRelease(row, state, 4), { written: true, version: 5 });
  const tx = client.sent[1] as TransactWriteCommand;
  const items = tx.input.TransactItems!;
  assert.equal(items.length, 2);
  assert.equal(items[0]!.Put!.ConditionExpression, "attribute_not_exists(pk) OR releaseDigest = :d");
  assert.deepEqual(items[0]!.Put!.ExpressionAttributeValues, { ":d": "sha256:3" });
  assert.equal(items[1]!.Put!.ConditionExpression, "version = :v");
  assert.deepEqual(items[1]!.Put!.ExpressionAttributeValues, { ":v": 4 });
  assert.equal((items[1]!.Put!.Item as { version: number }).version, 5);
  // The row's condition failed (another digest): the state is written alone, and `written` is false.
  const conflict = fakeClient([Object.assign(new Error("tx"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] }), {}]);
  assert.deepEqual(await createReleasesTable(conflict, "t", "s").writeRelease(row, state, 4), { written: false, version: 5 });
  assert.ok(conflict.sent[1] instanceof PutCommand, "the state was written on its own");
  // The state's condition failed: the other invocation won.
  const race = fakeClient([Object.assign(new Error("tx"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }] })]);
  await assert.rejects(() => createReleasesTable(race, "t", "s").writeRelease(row, state, 4), (error: unknown) => error instanceof RaceLost);
  const other = fakeClient([Object.assign(new Error("boom"), { name: "InternalServerError" })]);
  await assert.rejects(() => createReleasesTable(other, "t", "s").writeRelease(row, state, 4), /boom/, "anything else is an error");
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

test("the exchange: a missing object is null whether S3 answers 404 or 403; a malformed key is a reason; a real error is thrown; writes carry their metadata", async () => {
  const body = (text: string) => ({ Body: { transformToString: async () => text } });
  const notFound = Object.assign(new Error("nope"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
  const denied = Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
  const client = fakeClient([notFound, denied, body("{}"), body(JSON.stringify({ kind: "airprompter-airgap-status", v: 1, hostId: "h", writtenAt: "w", startedAt: "s", applies: [] })), Object.assign(new Error("throttled"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } }), {}, {}]);
  const exchange = createExchange(client, "b");
  assert.deepEqual(await exchange.readPublicKey(), { key: null, reason: "absent" });
  assert.deepEqual(await exchange.readPublicKey(), { key: null, reason: "absent" }, "a 403 on a key the role may not list is also absent");
  assert.equal((await exchange.readPublicKey()).reason, "not a distribution public key file (kind airprompter-distribution-public-key)");
  assert.equal((await exchange.readStatusDoc())?.hostId, "h");
  await assert.rejects(() => exchange.readStatusDoc(), /throttled/);
  await exchange.writeBundle("releases/3-3-plain.apbundle", "{}", { generation: "3" });
  await exchange.writeLatest({ generation: 3, releaseDigest: "d", keyId: null, object: "o", pulledAt: "t", notAfter: "n" });
  const put = client.sent[5] as { input: { Key: string; Metadata: Record<string, string>; ContentType: string } };
  assert.equal(put.input.Key, "releases/3-3-plain.apbundle");
  assert.deepEqual(put.input.Metadata, { generation: "3" });
  const latest = client.sent[6] as { input: { Key: string; CacheControl: string } };
  assert.equal(latest.input.Key, "latest.json");
  assert.equal(latest.input.CacheControl, "no-store");
});
