/**
 * The puller's two tables. The releases table (ap-southeast-1): one row per generation under `release#<scope>` and
 * the puller's own state under `puller#<scope>` at generation 0 — a release row and the state that goes with it are
 * written in one transaction, so a saved manifest ETag never outruns the row it was returned beside, and every
 * state write is conditioned on the version that was read: two invocations at once (a nudge during a tick) cannot
 * both win, and the loser learns it (`RaceLost`) instead of writing over the winner. The desk's status and events
 * tables (us-east-1): the same row shapes `services/desk-api/src/store.ts` writes, over a client for that region —
 * `updateStatus` merges fields into a host's row, `appendEvent` writes a timeline row that expires with the others.
 *
 * @example
 * ```ts
 * const releases = createReleasesTable(docClient, "zudocs-agent-releases", "agent_x/dev");
 * const { state, version } = await releases.readState();
 * const newest = await releases.newest();                          // { generation: 3, keyId: "…", object: "releases/3-…apbundle", … } | null
 * await releases.writeRelease(row, state, version);                 // one transaction: the row (unless it exists with another digest) and the state
 * const desk = createDeskTables(usEastClient, { status: "zudocs-desk-status", events: "zudocs-desk-events" });
 * await desk.appendEvent({ at, kind: "bundle_pulled", host: "ap-southeast-1/puller", generation: 3 });
 * ```
 */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { EVENT_RETENTION_DAYS, dayOf } from "../../desk-api/src/store.js";
import { EMPTY_STATE, type PullerState, type ReleaseRow } from "./plan.js";

type Send = (command: unknown) => Promise<any>;

/** Another invocation wrote the state row first: this one stops without writing anything more. */
export class RaceLost extends Error {
  constructor(readonly expectedVersion: number) {
    super(`the puller's state row moved past version ${expectedVersion}: another invocation won`);
    this.name = "RaceLost";
  }
}

export interface ReleasesTable {
  readonly scope: string;
  readState(): Promise<{ state: PullerState; version: number }>;
  /** Write the state, conditioned on `expectedVersion`; the new version is returned. Throws `RaceLost`. */
  writeState(state: PullerState, expectedVersion: number): Promise<number>;
  newest(): Promise<ReleaseRow | null>;
  /**
   * The row and the state together, conditioned on the state's version. `written: false` when the generation exists
   * with a different digest (kept as it was; the state is then written on its own). Throws `RaceLost`.
   */
  writeRelease(row: Omit<ReleaseRow, "pk">, state: PullerState, expectedVersion: number): Promise<{ written: boolean; version: number }>;
}

export const releasePk = (scope: string): string => `release#${scope}`;
export const statePk = (scope: string): string => `puller#${scope}`;
const isConditionFailed = (error: unknown): boolean => (error as { name?: string })?.name === "ConditionalCheckFailedException";

export function createReleasesTable(client: Pick<DynamoDBDocumentClient, "send">, tableName: string, scope: string): ReleasesTable {
  const send = client.send.bind(client) as Send;
  const stateItem = (state: PullerState, version: number) => ({ pk: statePk(scope), generation: 0, state, version, updatedAt: new Date().toISOString() });
  // The condition: the row is absent (version 0 expected) or carries exactly the version that was read.
  const stateCondition = (expectedVersion: number) => expectedVersion === 0 ? { ConditionExpression: "attribute_not_exists(pk) OR version = :v", ExpressionAttributeValues: { ":v": 0 } } : { ConditionExpression: "version = :v", ExpressionAttributeValues: { ":v": expectedVersion } };
  return {
    scope,
    async readState() {
      const out = await send(new GetCommand({ TableName: tableName, Key: { pk: statePk(scope), generation: 0 }, ConsistentRead: true }));
      const saved = out.Item?.state as Partial<PullerState> | undefined;
      const version = Number(out.Item?.version ?? 0);
      return { state: saved ? { ...EMPTY_STATE, ...saved, reads: { ...EMPTY_STATE.reads, ...(saved.reads ?? {}) }, airgap: { ...EMPTY_STATE.airgap, ...(saved.airgap ?? {}) } } : { ...EMPTY_STATE }, version };
    },
    async writeState(state, expectedVersion) {
      try {
        await send(new PutCommand({ TableName: tableName, Item: stateItem(state, expectedVersion + 1), ...stateCondition(expectedVersion) }));
        return expectedVersion + 1;
      } catch (error) {
        if (isConditionFailed(error)) throw new RaceLost(expectedVersion);
        throw error;
      }
    },
    async newest() {
      const out = await send(new QueryCommand({ TableName: tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": releasePk(scope) }, ScanIndexForward: false, Limit: 1, ConsistentRead: true }));
      return (out.Items?.[0] as ReleaseRow | undefined) ?? null;
    },
    async writeRelease(row, state, expectedVersion) {
      const condition = stateCondition(expectedVersion);
      try {
        await send(new TransactWriteCommand({
          TransactItems: [
            // The same generation twice is the same digest on an honest control plane: a re-seal replaces the row; a different digest keeps the row and says so.
            { Put: { TableName: tableName, Item: { pk: releasePk(scope), ...row }, ConditionExpression: "attribute_not_exists(pk) OR releaseDigest = :d", ExpressionAttributeValues: { ":d": row.releaseDigest } } },
            { Put: { TableName: tableName, Item: stateItem(state, expectedVersion + 1), ConditionExpression: condition.ConditionExpression, ExpressionAttributeValues: condition.ExpressionAttributeValues } },
          ],
        }));
        return { written: true, version: expectedVersion + 1 };
      } catch (error) {
        const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
        if ((error as { name?: string }).name === "TransactionCanceledException" && reasons) {
          if (reasons[1]?.Code === "ConditionalCheckFailed") throw new RaceLost(expectedVersion);
          if (reasons[0]?.Code === "ConditionalCheckFailed") {
            const version = await this.writeState(state, expectedVersion);
            return { written: false, version };
          }
        }
        throw error;
      }
    },
  };
}

export interface DeskTables {
  updateStatus(hostId: string, fields: Record<string, unknown>): Promise<void>;
  appendEvent(event: Record<string, unknown> & { at: string; kind: string; host: string }): Promise<void>;
}

export function createDeskTables(client: Pick<DynamoDBDocumentClient, "send">, tables: { status: string; events: string }): DeskTables {
  const send = client.send.bind(client) as Send;
  return {
    async updateStatus(hostId, fields) {
      const names = Object.keys(fields).filter((k) => k !== "hostId");
      if (names.length === 0) return;
      await send(new UpdateCommand({
        TableName: tables.status,
        Key: { hostId },
        UpdateExpression: `SET ${names.map((_, i) => `#f${i} = :v${i}`).join(", ")}`,
        ExpressionAttributeNames: Object.fromEntries(names.map((name, i) => [`#f${i}`, name])),
        ExpressionAttributeValues: Object.fromEntries(names.map((name, i) => [`:v${i}`, fields[name]])),
      }));
    },
    async appendEvent(event) {
      const day = dayOf(event.at);
      const sk = `${event.at}#${Math.random().toString(36).slice(2, 8)}`;
      const expiresAt = Math.floor(Date.parse(event.at) / 1000) + EVENT_RETENTION_DAYS * 86_400;
      await send(new PutCommand({ TableName: tables.events, Item: { day, sk, expiresAt, ...event } }));
    },
  };
}
