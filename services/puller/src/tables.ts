/**
 * The puller's two stores. Its own state is one object in the exchange bucket (`puller/state.json`): the backoff,
 * the nudge ids, and what it mirrored last — written with S3's conditional put (`If-None-Match: *` the first time,
 * `If-Match` after), so two invocations at once cannot both win and the loser learns it (`RaceLost`). The release
 * is not in this object; `pullToDatastore` writes that in the SDK's format. The desk's status and events tables
 * (us-east-1) keep the row shapes `services/desk-api/src/store.ts` writes.
 *
 * @example
 * ```ts
 * const state = createPullerState(s3, bucket);
 * const { state: remembered, version } = await state.read();
 * await state.write(remembered, version);   // throws RaceLost when another invocation wrote first
 * const desk = createDeskTables(usEastClient, { status: "zudocs-desk-status", events: "zudocs-desk-events" });
 * await desk.appendEvent({ at, kind: "bundle_pulled", host: "ap-southeast-1/puller", generation: 3 });
 * ```
 */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { EVENT_RETENTION_DAYS, dayOf } from "../../desk-api/src/store.js";
import { EMPTY_STATE, type PullerState } from "./plan.js";

type Send = (command: unknown) => Promise<any>;

/** Another invocation wrote the state object first: this one stops without writing anything more. */
export class RaceLost extends Error {
  constructor(readonly expectedVersion: string | null) {
    super(`the puller's state moved past ${expectedVersion ?? "absent"}: another invocation won`);
    this.name = "RaceLost";
  }
}

/** The exchange object that holds the puller's schedule. Not a release, and not inside the SDK's `airprompter/` prefix. */
export const PULLER_STATE_KEY = "puller/state.json";

export interface PullerStateStore {
  read(): Promise<{ state: PullerState; version: string | null }>;
  /** Write the state, conditioned on `expectedVersion` (`null` when the object is absent). The new ETag is returned. Throws `RaceLost`. */
  write(state: PullerState, expectedVersion: string | null): Promise<string>;
}

const isMissing = (error: unknown): boolean => {
  const name = (error as { name?: string; Code?: string }).name ?? (error as { Code?: string }).Code;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
};

const isLostRace = (error: unknown): boolean => {
  const name = (error as { name?: string; Code?: string }).name ?? (error as { Code?: string }).Code;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === "PreconditionFailed" || name === "ConditionalRequestConflict" || status === 412 || status === 409;
};

const remembered = (saved: Partial<PullerState> | undefined): PullerState =>
  saved ? { ...EMPTY_STATE, ...saved, reads: { ...EMPTY_STATE.reads, ...(saved.reads ?? {}) }, airgap: { ...EMPTY_STATE.airgap, ...(saved.airgap ?? {}) }, nudgeIds: saved.nudgeIds ?? [] } : { ...EMPTY_STATE, nudgeIds: [] };

export function createPullerState(client: Pick<S3Client, "send">, bucket: string, key = PULLER_STATE_KEY): PullerStateStore {
  const send = client.send.bind(client) as Send;
  return {
    async read() {
      try {
        const out = await send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const text = out.Body ? await out.Body.transformToString("utf8") : "";
        const parsed = text ? (JSON.parse(text) as { state?: Partial<PullerState> }) : {};
        if (!out.ETag) throw new Error(`S3 answered ${key} without an ETag; conditional writes need one`);
        return { state: remembered(parsed.state), version: out.ETag };
      } catch (error) {
        if (isMissing(error)) return { state: remembered(undefined), version: null };
        throw error;
      }
    },
    async write(state, expectedVersion) {
      try {
        const out = await send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify({ state }),
          ContentType: "application/json; charset=utf-8",
          ...(expectedVersion ? { IfMatch: expectedVersion } : { IfNoneMatch: "*" }),
        }));
        if (!out.ETag) throw new Error(`S3 wrote ${key} without an ETag`);
        return out.ETag;
      } catch (error) {
        if (isLostRace(error)) throw new RaceLost(expectedVersion);
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
