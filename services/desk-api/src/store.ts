/**
 * The desk's own data plane: eight DynamoDB tables behind one small interface — tickets and customers (seeded,
 * re-seedable), runs and feedback (what the desk did), status (one row per host, written by every host), events
 * (the timeline, partitioned by UTC day), counters (the daily run cap, incremented atomically and refused at the
 * line; the per-host ticket queues the presenter fills), approvals (a release staged under `unlock_required` on a
 * host, waiting for the owner's decision; the host writes the row, the desk decides, the host activates and settles
 * it). Every method takes and returns plain records; the handler never sees a DynamoDB command, and a test hands
 * `createStore` a fake document client. The eu-west worker uses the same store over a us-east-1 client.
 *
 * @example
 * ```ts
 * const store = createStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), env.tables);
 * const taken = await store.takeRunSlot("2026-09-18", 2000);   // { ok: true, used: 12 } | { ok: false, used: 2000 }
 * await store.appendEvent({ at, kind: "release_changed", host, generation: 2 });
 * const decided = await store.approve("eu-west-1-ec2-g2-i-abc", "seth@zudocs.com", at);   // { ok: true, row } once; { ok: false, row } after
 * ```
 */
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BatchWriteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DeskEnv } from "./env.js";

export interface Customer {
  customerId: string;
  name: string;
  tier: "trial" | "team" | "enterprise";
  seats: number;
  since: string;
}

export interface Ticket {
  ticketId: string;
  customerId: string;
  subject: string;
  body: string;
  receivedAt: string;
  channel: "email" | "chat" | "form";
  /** The last run's headline, so the inbox shows a triaged ticket without reading every run. */
  lastRun?: { runId: string; at: string; category?: string | null; priority?: string | null; versionId?: string; arm?: string } | null;
}

export interface StatusRow {
  hostId: string;
  region: string;
  kind: "lambda" | "daemon" | "airgapped" | "puller";
  sdk: string;
  writtenAt: string;
  status: unknown;
  healthz: unknown;
  /** How the container came to hold its release: `cold_start` this invoke, or `warm`. */
  container: { instanceId: string; coldStart: boolean; startedAt: string; invocations: number };
}

export interface TimelineEvent {
  at: string;
  kind: string;
  host: string;
  [key: string]: unknown;
}

export type ApprovalDecision = "pending" | "approved" | "activated" | "superseded" | "failed";

/**
 * A release staged on a host under `unlock_required`, waiting for the owner. The host writes it (`pending`), the desk
 * decides (`approved`), the host activates through the daemon and settles it (`activated`, or `failed` with the
 * SDK's reason); a release that went live another way (an operator's `airprompter unlock` on the host's shell, an
 * update window) or was overtaken settles as `superseded`. The id is the host, the generation and the daemon's
 * store, so a restarted worker finds its own row, a replaced instance gets a fresh one, and the desk's approve is
 * idempotent. A `failed` row is re-opened only by a restarted worker — an operator's deliberate retry, never a loop.
 */
export interface ApprovalRow {
  approvalId: string;
  hostId: string;
  /** The daemon's store id the release was staged on: a replaced instance is a fresh store and a fresh row. */
  storeId: string;
  generation: number;
  releaseDigest: string | null;
  stagedAt: string;
  /** The console's open unlock request for this release, when the host could read one (`status().unlockRequests`). */
  unlockRequest: { requestedBy: string; requestedAt: string; expiresAt: string; note?: string } | null;
  decision: ApprovalDecision;
  decidedBy: string | null;
  decidedAt: string | null;
  activatedAt: string | null;
  /** What happened after the decision, in the SDK's words (an outcome, or the error that refused it). */
  outcome: string | null;
  updatedAt: string;
}

/**
 * `eu-west-1/ec2` at generation 2 on store `i-abc…` → `eu-west-1-ec2-g2-i-abc…`: one path segment (the approve route
 * names it), unique per staging — the same generation staged again on a fresh store is a new row.
 */
export const approvalIdOf = (hostId: string, generation: number, storeId: string): string => `${hostId.replace(/[^A-Za-z0-9-]+/g, "-")}-g${generation}-${storeId.replace(/[^A-Za-z0-9_.:-]+/g, "").slice(0, 24) || "store"}`;

export interface Store {
  listCustomers(): Promise<Customer[]>;
  getCustomer(customerId: string): Promise<Customer | null>;
  listTickets(): Promise<Ticket[]>;
  getTicket(ticketId: string): Promise<Ticket | null>;
  putRun(run: Record<string, unknown> & { runId: string; ticketId: string; at: string }): Promise<void>;
  getRun(runId: string): Promise<(Record<string, unknown> & { runId: string; ticketId: string }) | null>;
  listRunsForTicket(ticketId: string, limit?: number): Promise<Array<Record<string, unknown> & { runId: string }>>;
  updateTicketLastRun(ticketId: string, lastRun: NonNullable<Ticket["lastRun"]>): Promise<void>;
  putFeedback(row: { runId: string; at: string; signals: Record<string, unknown>; by: string; filed: boolean }): Promise<void>;
  listFeedback(runId: string): Promise<Array<{ runId: string; at: string; signals: Record<string, unknown>; by: string; filed: boolean }>>;
  putStatus(row: StatusRow): Promise<void>;
  /** Merge fields into a host's row (two processes on one host — the Node worker and the Python worker — each keep their part). */
  updateStatus(hostId: string, fields: Record<string, unknown>): Promise<void>;
  listStatus(): Promise<StatusRow[]>;
  appendEvent(event: TimelineEvent): Promise<void>;
  /** Events after `since` (exclusive), newest last, across the UTC days the range spans (at most two). */
  listEvents(since: string | null, limit?: number): Promise<TimelineEvent[]>;
  /** One more run today, unless the day is at the cap: atomic, refused at the line, never over. */
  takeRunSlot(day: string, cap: number): Promise<{ ok: true; used: number } | { ok: false; used: number }>;
  readRunSlots(day: string): Promise<number>;
  /** Replace the seeded tables' contents (tickets and customers) and forget the runs' headlines. */
  seed(customers: Customer[], tickets: Ticket[]): Promise<{ customers: number; tickets: number }>;
  /** A host's ticket queue (the presenter's "run this on eu-west now"): append, and take the oldest — atomically. */
  enqueueTicket(hostId: string, ticketId: string): Promise<number>;
  dequeueTicket(hostId: string): Promise<string | null>;
  /** The host's staged row: created once per host and generation; a settled `superseded` or `failed` row may be re-opened. */
  openApproval(row: ApprovalRow): Promise<{ created: boolean }>;
  getApproval(approvalId: string): Promise<ApprovalRow | null>;
  /** Every approval row, newest staged first. */
  listApprovals(limit?: number): Promise<ApprovalRow[]>;
  /** The owner's decision: `pending` → `approved` exactly once; a repeat (or a settled row) answers ok:false with the row as it is. */
  approve(approvalId: string, by: string, at: string): Promise<{ ok: boolean; row: ApprovalRow | null }>;
  /** The host's word after the decision (or after the release moved without one). */
  settleApproval(approvalId: string, settle: { decision: Exclude<ApprovalDecision, "pending" | "approved">; outcome: string; activatedAt?: string | null; at: string }): Promise<ApprovalRow | null>;
}

export const dayOf = (iso: string): string => iso.slice(0, 10);
export const EVENT_RETENTION_DAYS = 14;

export function createStore(client: Pick<DynamoDBDocumentClient, "send">, tables: DeskEnv["tables"]): Store {
  const send = client.send.bind(client) as (command: unknown) => Promise<any>;
  const scanAll = async <T>(TableName: string): Promise<T[]> => {
    const items: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await send(new ScanCommand({ TableName, ExclusiveStartKey }));
      items.push(...((page.Items ?? []) as T[]));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  };
  const batchPut = async (TableName: string, items: Record<string, unknown>[]): Promise<void> => {
    for (let i = 0; i < items.length; i += 25) {
      let unprocessed: Record<string, unknown[]> | undefined = { [TableName]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) };
      for (let attempt = 0; unprocessed && Object.keys(unprocessed).length > 0; attempt += 1) {
        if (attempt > 5) throw new Error(`seed: ${TableName} kept returning unprocessed items`);
        const out = await send(new BatchWriteCommand({ RequestItems: unprocessed as any }));
        unprocessed = out.UnprocessedItems && Object.keys(out.UnprocessedItems).length > 0 ? (out.UnprocessedItems as Record<string, unknown[]>) : undefined;
      }
    }
  };
  return {
    listCustomers: () => scanAll<Customer>(tables.customers),
    async getCustomer(customerId) {
      const out = await send(new GetCommand({ TableName: tables.customers, Key: { customerId } }));
      return (out.Item as Customer | undefined) ?? null;
    },
    async listTickets() {
      const tickets = await scanAll<Ticket>(tables.tickets);
      return tickets.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));
    },
    async getTicket(ticketId) {
      const out = await send(new GetCommand({ TableName: tables.tickets, Key: { ticketId } }));
      return (out.Item as Ticket | undefined) ?? null;
    },
    async putRun(run) {
      await send(new PutCommand({ TableName: tables.runs, Item: run }));
    },
    async getRun(runId) {
      const out = await send(new GetCommand({ TableName: tables.runs, Key: { runId } }));
      return (out.Item as any) ?? null;
    },
    async listRunsForTicket(ticketId, limit = 10) {
      const out = await send(new QueryCommand({ TableName: tables.runs, IndexName: "byTicket", KeyConditionExpression: "ticketId = :t", ExpressionAttributeValues: { ":t": ticketId }, ScanIndexForward: false, Limit: limit }));
      return (out.Items ?? []) as any[];
    },
    async updateTicketLastRun(ticketId, lastRun) {
      await send(new UpdateCommand({ TableName: tables.tickets, Key: { ticketId }, UpdateExpression: "SET lastRun = :r", ConditionExpression: "attribute_exists(ticketId)", ExpressionAttributeValues: { ":r": lastRun } }));
    },
    async putFeedback(row) {
      await send(new PutCommand({ TableName: tables.feedback, Item: row }));
    },
    async listFeedback(runId) {
      const out = await send(new QueryCommand({ TableName: tables.feedback, KeyConditionExpression: "runId = :r", ExpressionAttributeValues: { ":r": runId }, ScanIndexForward: true }));
      return (out.Items ?? []) as any[];
    },
    async putStatus(row) {
      await send(new PutCommand({ TableName: tables.status, Item: row }));
    },
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
    listStatus: () => scanAll<StatusRow>(tables.status),
    async appendEvent(event) {
      const day = dayOf(event.at);
      const sk = `${event.at}#${Math.random().toString(36).slice(2, 8)}`;
      // The table's TTL attribute: a timeline row lives two weeks, then DynamoDB forgets it.
      const expiresAt = Math.floor(Date.parse(event.at) / 1000) + EVENT_RETENTION_DAYS * 86_400;
      await send(new PutCommand({ TableName: tables.events, Item: { day, sk, expiresAt, ...event } }));
    },
    async listEvents(since, limit = 100) {
      const now = new Date().toISOString();
      const days = since ? [...new Set([dayOf(since), dayOf(now)])] : [dayOf(now)];
      const items: TimelineEvent[] = [];
      for (const day of days) {
        const out = await send(new QueryCommand({
          TableName: tables.events,
          KeyConditionExpression: since ? "#d = :d AND sk > :s" : "#d = :d",
          ExpressionAttributeNames: { "#d": "day" },
          ExpressionAttributeValues: since ? { ":d": day, ":s": `${since}#~` } : { ":d": day },
          ScanIndexForward: false,
          Limit: limit,
        }));
        for (const item of (out.Items ?? []) as any[]) {
          // The row's sort key is the event's identity on the desk (two polls never show one row twice); the
          // partition key is the row's, not the event's — an event field of the same name is not returned.
          const { day: _day, sk, expiresAt: _expiresAt, ...event } = item;
          items.push({ ...event, id: sk } as TimelineEvent);
        }
      }
      return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(-limit);
    },
    async takeRunSlot(day, cap) {
      const key = { pk: `day#${day}` };
      try {
        const out = await send(new UpdateCommand({
          TableName: tables.counters,
          Key: key,
          UpdateExpression: "ADD runs :one",
          ConditionExpression: "attribute_not_exists(runs) OR runs < :cap",
          ExpressionAttributeValues: { ":one": 1, ":cap": cap },
          ReturnValues: "ALL_NEW",
        }));
        return { ok: true, used: Number(out.Attributes?.runs ?? 1) };
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException || (error as { name?: string })?.name === "ConditionalCheckFailedException") {
          const current = await send(new GetCommand({ TableName: tables.counters, Key: key }));
          return { ok: false, used: Number(current.Item?.runs ?? cap) };
        }
        throw error;
      }
    },
    async readRunSlots(day) {
      const current = await send(new GetCommand({ TableName: tables.counters, Key: { pk: `day#${day}` } }));
      return Number(current.Item?.runs ?? 0);
    },
    async seed(customers, tickets) {
      await batchPut(tables.customers, customers as unknown as Record<string, unknown>[]);
      await batchPut(tables.tickets, tickets.map((t) => ({ ...t, lastRun: null })) as unknown as Record<string, unknown>[]);
      return { customers: customers.length, tickets: tickets.length };
    },
    async enqueueTicket(hostId, ticketId) {
      const out = await send(new UpdateCommand({
        TableName: tables.counters,
        Key: { pk: `queue#${hostId}` },
        UpdateExpression: "SET #items = list_append(if_not_exists(#items, :empty), :one)",
        ExpressionAttributeNames: { "#items": "items" },
        ExpressionAttributeValues: { ":empty": [], ":one": [ticketId] },
        ReturnValues: "ALL_NEW",
      }));
      return ((out.Attributes?.items as string[] | undefined) ?? []).length;
    },
    async dequeueTicket(hostId) {
      const key = { pk: `queue#${hostId}` };
      const current = await send(new GetCommand({ TableName: tables.counters, Key: key, ConsistentRead: true }));
      const items = (current.Item?.items as string[] | undefined) ?? [];
      const first = items[0];
      if (first === undefined) return null;
      try {
        // Only the head this reader saw is removed: two workers on one queue never take the same ticket twice.
        await send(new UpdateCommand({ TableName: tables.counters, Key: key, UpdateExpression: "REMOVE #items[0]", ConditionExpression: "#items[0] = :first", ExpressionAttributeNames: { "#items": "items" }, ExpressionAttributeValues: { ":first": first } }));
        return first;
      } catch (error) {
        if (isConditionFailed(error)) return null;
        throw error;
      }
    },
    async openApproval(row) {
      try {
        await send(new PutCommand({ TableName: tables.approvals, Item: row, ConditionExpression: "attribute_not_exists(approvalId) OR decision IN (:superseded, :failed)", ExpressionAttributeValues: { ":superseded": "superseded", ":failed": "failed" } }));
        return { created: true };
      } catch (error) {
        if (isConditionFailed(error)) return { created: false };
        throw error;
      }
    },
    async getApproval(approvalId) {
      const out = await send(new GetCommand({ TableName: tables.approvals, Key: { approvalId }, ConsistentRead: true }));
      return (out.Item as ApprovalRow | undefined) ?? null;
    },
    async listApprovals(limit = 50) {
      const rows = await scanAll<ApprovalRow>(tables.approvals);
      return rows.sort((a, b) => (a.stagedAt < b.stagedAt ? 1 : a.stagedAt > b.stagedAt ? -1 : 0)).slice(0, limit);
    },
    async approve(approvalId, by, at) {
      try {
        const out = await send(new UpdateCommand({
          TableName: tables.approvals,
          Key: { approvalId },
          UpdateExpression: "SET decision = :approved, decidedBy = :by, decidedAt = :at, updatedAt = :at",
          ConditionExpression: "decision = :pending",
          ExpressionAttributeValues: { ":approved": "approved", ":pending": "pending", ":by": by, ":at": at },
          ReturnValues: "ALL_NEW",
        }));
        return { ok: true, row: out.Attributes as ApprovalRow };
      } catch (error) {
        if (isConditionFailed(error)) return { ok: false, row: await this.getApproval(approvalId) };
        throw error;
      }
    },
    async settleApproval(approvalId, settle) {
      try {
        const out = await send(new UpdateCommand({
          TableName: tables.approvals,
          Key: { approvalId },
          UpdateExpression: "SET decision = :decision, outcome = :outcome, activatedAt = :activatedAt, updatedAt = :at",
          ConditionExpression: "attribute_exists(approvalId) AND decision IN (:pending, :approved)",
          ExpressionAttributeValues: { ":decision": settle.decision, ":outcome": settle.outcome, ":activatedAt": settle.activatedAt ?? null, ":at": settle.at, ":pending": "pending", ":approved": "approved" },
          ReturnValues: "ALL_NEW",
        }));
        return out.Attributes as ApprovalRow;
      } catch (error) {
        if (isConditionFailed(error)) return null;
        throw error;
      }
    },
  };
}

const isConditionFailed = (error: unknown): boolean => error instanceof ConditionalCheckFailedException || (error as { name?: string })?.name === "ConditionalCheckFailedException";
