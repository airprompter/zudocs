/**
 * The desk's own data plane: seven DynamoDB tables behind one small interface — tickets and customers (seeded,
 * re-seedable), runs and feedback (what the desk did), status (one row per host, written on every invoke), events
 * (the timeline, partitioned by UTC day), counters (the daily run cap, incremented atomically and refused at the
 * line). Every method takes and returns plain records; the handler never sees a DynamoDB command, and a test hands
 * `createStore` a fake document client.
 *
 * @example
 * ```ts
 * const store = createStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), env.tables);
 * const taken = await store.takeRunSlot("2026-09-18", 2000);   // { ok: true, used: 12 } | { ok: false, used: 2000 }
 * await store.appendEvent({ at, kind: "release_changed", host, generation: 2 });
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
  kind: "lambda" | "daemon" | "airgapped";
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
  listStatus(): Promise<StatusRow[]>;
  appendEvent(event: TimelineEvent): Promise<void>;
  /** Events after `since` (exclusive), newest last, across the UTC days the range spans (at most two). */
  listEvents(since: string | null, limit?: number): Promise<TimelineEvent[]>;
  /** One more run today, unless the day is at the cap: atomic, refused at the line, never over. */
  takeRunSlot(day: string, cap: number): Promise<{ ok: true; used: number } | { ok: false; used: number }>;
  readRunSlots(day: string): Promise<number>;
  /** Replace the seeded tables' contents (tickets and customers) and forget the runs' headlines. */
  seed(customers: Customer[], tickets: Ticket[]): Promise<{ customers: number; tickets: number }>;
}

export const dayOf = (iso: string): string => iso.slice(0, 10);

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
    listStatus: () => scanAll<StatusRow>(tables.status),
    async appendEvent(event) {
      const day = dayOf(event.at);
      const sk = `${event.at}#${Math.random().toString(36).slice(2, 8)}`;
      await send(new PutCommand({ TableName: tables.events, Item: { day, sk, ...event } }));
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
          const { day: _day, sk: _sk, ...event } = item;
          items.push(event as TimelineEvent);
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
  };
}
