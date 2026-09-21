/**
 * Hosted staging (D7): the same ticket through AirPrompter's hosted execution — no store, no model key of ours, a
 * run key bound to one environment (read by NAME from an SSM SecureString the first time it is needed, held in memory,
 * never logged). One "Run on staging" does three things and records each as the route answered it:
 *
 * 1. `ManagedAgent.stream()` on `support.reply`: the deltas as they arrive, each with its offset from the first byte,
 *    so the desk can replay the stream at the cadence it really had (the record says so — nothing is animated that
 *    did not happen), then the `done` frame: version, arm, generation, usage, latency, price in micros.
 * 2. `ManagedAgent.feedback()` on that run's reference (T30: a run's quality signal from any process that kept the ref).
 * 3. One call through the **OpenAI-compatible** route with a `temperature` and `top_p` the caller has no say over: the
 *    request as sent, the answer as received (its `airprompter.runRef`), and — beside them — the slot's sealed
 *    `inference` from the hosted catalogue, which is what the run used. The response carries no inference block;
 *    the catalogue is the authority, and the record says that too.
 *
 * `customer_tier` is filled by this process from the desk's own customer table before the POST (the hosted route has
 * no way into our systems; `ManagedAgent.start({ variables })` is how it gets there). The subject is the customer id,
 * hashed here with the experiment's salt; the raw id never leaves. A refusal is recorded with the route's code and
 * status and the record says which step refused; nothing is retried but a 429 (the client's own rule).
 *
 * @example
 * ```ts
 * const record = await hostedRun(host, ticket, { by: "seth@zudocs.com" });
 * record.stream.result?.arm;          // "control"
 * record.compat.request.temperature;  // 1.9 — and record.catalogue.slot.inference is what the run actually used
 * ```
 */
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { ManagedAgent, isManagedRunError, type ManagedCatalogue, type ManagedRunResult } from "@airprompter/agent-sdk";
import type { DeskEnv } from "./env.js";
import type { Customer, Store, Ticket } from "./store.js";
import { TAGS } from "./run.js";

export interface HostedRefusal {
  code: string;
  status: number;
  message: string;
  detail?: string;
}

export interface HostedStreamRecord {
  /** Each delta's offset from the first byte (ms) and its text. */
  deltas: Array<{ atMs: number; text: string }>;
  /** The first byte's offset from the POST (ms) — the route's time to first token, not the client's start. */
  firstByteMs: number | null;
  result: ManagedRunResult | null;
  refusal: HostedRefusal | null;
}

export interface HostedCompatRecord {
  request: { url: string; model: string; temperature: number; top_p: number; variables: string[] };
  response: { status: number; runRef: string | null; runId: string | null; model: string | null; finishReason: string | null; usage: Record<string, unknown> | null; text: string | null; error: Record<string, unknown> | null };
  /** The response carries no inference block; the slot's sealed settings (the catalogue) are what the run used. */
  /** The caller's parameters the hosted route ignores BY CONTRACT (the release owns them); the response carries no settings, so this is the contract's word, never an observation. */
  ignoredByContract: string[];
}

export interface HostedRunRecord {
  runId: string;
  ticketId: string;
  customerId: string;
  at: string;
  by: string;
  host: string;
  kind: "hosted";
  target: string;
  runUrl: string;
  subjectHash: string | null;
  catalogue: { generation: number; releaseDigest: string; slot: { tag: string; model: string; inference: Record<string, unknown> | null; variables: string[] } | null; experiments: Array<{ experimentId: string; tag: string | null; arms: string[] }> };
  stream: HostedStreamRecord;
  feedback: { accepted: boolean; attributedTo: Record<string, unknown> | null; refusal: HostedRefusal | null } | null;
  compat: HostedCompatRecord | null;
  durationMs: number;
  ok: boolean;
  /** What did not happen and why, in the route's own words — the desk shows this line first. */
  gaps: string[];
}

export interface HostedPorts {
  env: Pick<DeskEnv, "hosted" | "hostId" | "region"> & { readonly agentId: string };
  store: Pick<Store, "getCustomer" | "putRun" | "appendEvent">;
  /** The run key by parameter name: SSM in production, a literal in tests. Never logged. */
  readSecret?: (parameterName: string) => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
  /** The hosted client, memoised per key; a start refusal is not memoised. */
  managed?: { start: typeof ManagedAgent.start };
}

const refusalOf = (error: unknown): HostedRefusal => {
  if (isManagedRunError(error)) return { code: error.code, status: error.status, message: error.message.slice(0, 300), ...(error.detail ? { detail: String(error.detail).slice(0, 300) } : {}) };
  const e = error as Error & { code?: string; status?: number };
  return { code: e?.code ?? e?.name ?? "error", status: typeof e?.status === "number" ? e.status : 0, message: String(e?.message ?? error).slice(0, 300) };
};

async function readFromSsm(region: string, name: string): Promise<string> {
  const out = await new SSMClient({ region }).send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = out.Parameter?.Value;
  if (!value) throw new Error(`the SSM parameter ${name} has no value`);
  return value;
}

/** Whether this deployment names a run key parameter and a run URL: without both, hosted staging is honestly "not configured". */
export function hostedConfigured(env: Pick<DeskEnv, "hosted">): boolean {
  return env.hosted.runKeyParameter !== "" && env.hosted.runUrl !== "";
}

export interface HostedClient {
  agent(): Promise<ManagedAgent>;
  catalogue(): Promise<ManagedCatalogue>;
  key(): Promise<string>;
}

/** The hosted client for a deployment: one per container, started on first use; a refused start or read is retried next time. */
export function createHostedClient(ports: HostedPorts): HostedClient {
  const { env, store } = ports;
  const readSecret = ports.readSecret ?? ((name: string) => readFromSsm(env.region, name));
  const start = ports.managed?.start ?? ((options: Parameters<typeof ManagedAgent.start>[0]) => ManagedAgent.start(options));
  let key: Promise<string> | null = null;
  let agent: Promise<ManagedAgent> | null = null;
  const keyOf = (): Promise<string> => {
    if (!key) {
      key = readSecret(env.hosted.runKeyParameter).catch((error) => {
        key = null;
        throw new Error(`the SSM parameter ${env.hosted.runKeyParameter} could not be read (${(error as Error).name}): the owner writes the staging run key there (RUNBOOK.md › Keys)`);
      });
    }
    return key;
  };
  const agentOf = (): Promise<ManagedAgent> => {
    if (!agent) {
      agent = keyOf()
        .then((apiKey) => start({ agentId: env.agentId, target: env.hosted.target, apiKey, baseUrl: env.hosted.runUrl, ...(ports.fetch ? { fetch: ports.fetch as never } : {}), variables: { customer_tier: { resolve: async ({ subject }) => (subject ? (await store.getCustomer(subject))?.tier : undefined), trust: "operator", timeoutMs: 1500 } } }))
        .catch((error) => {
          agent = null;
          throw error;
        });
    }
    return agent;
  };
  return { key: keyOf, agent: agentOf, catalogue: async () => (await agentOf()).slots };
}

/** The route's error, whichever shape it took: `{error:{code,message}}` (OpenAI's), `{error:"…",code:"…"}` (the run route's), or none. Pure. */
export function compatErrorOf(parsed: Record<string, unknown>, status: number): Record<string, unknown> {
  const e = parsed.error;
  if (typeof e === "object" && e !== null) return e as Record<string, unknown>;
  return { ...(typeof parsed.code === "string" ? { code: parsed.code } : {}), message: typeof e === "string" ? e : `HTTP ${status}`, ...(typeof parsed.detail === "string" ? { detail: parsed.detail } : {}) };
}

export function newHostedRunId(now = Date.now()): string {
  return `hosted_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** The OpenAI-compatible route for this agent: the target is the key's own, so the path names none. */
export const compatChatUrl = (runUrl: string, agentId: string): string => `${runUrl.replace(/\/$/, "")}/v1/agents/${encodeURIComponent(agentId)}/openai/chat/completions`;

/** The caller's parameters the hosted route accepts and ignores by contract (the release owns them); named here so the record can say which — a constant, not something the response reports. */
export const COMPAT_IGNORED_BY_CONTRACT = Object.freeze(["temperature", "top_p"]);

export async function hostedRun(input: { ports: HostedPorts; client: HostedClient; ticket: Ticket; customer: Customer | null; by: string }): Promise<HostedRunRecord> {
  const { ports, client, ticket, customer, by } = input;
  const agentId = ports.env.agentId;
  const { env } = ports;
  const now = ports.now ?? Date.now;
  const fetchImpl = ports.fetch ?? globalThis.fetch;
  const started = now();
  const runId = newHostedRunId(started);
  const gaps: string[] = [];
  const record: HostedRunRecord = {
    runId, ticketId: ticket.ticketId, customerId: ticket.customerId, at: new Date(started).toISOString(), by, host: env.hostId, kind: "hosted", target: env.hosted.target, runUrl: env.hosted.runUrl, subjectHash: null,
    catalogue: { generation: 0, releaseDigest: "", slot: null, experiments: [] },
    stream: { deltas: [], firstByteMs: null, result: null, refusal: null },
    feedback: null, compat: null, durationMs: 0, ok: false, gaps,
  };
  let agent: ManagedAgent;
  try {
    agent = await client.agent();
  } catch (error) {
    const refusal = refusalOf(error);
    record.stream.refusal = refusal;
    gaps.push(`the hosted client could not start: ${refusal.code} (${refusal.status}) ${refusal.message}`);
    record.durationMs = now() - started;
    await ports.store.putRun(record as unknown as Record<string, unknown> & { runId: string; ticketId: string; at: string });
    return record;
  }
  const cat = agent.slots;
  const slot = cat.slots.find((s) => s.tag === TAGS.reply) ?? null;
  record.catalogue = {
    generation: cat.generation,
    releaseDigest: cat.releaseDigest,
    slot: slot ? { tag: slot.tag, model: slot.model, inference: (slot.inference as Record<string, unknown> | undefined) ?? null, variables: slot.variables.map((v) => v.name) } : null,
    experiments: (cat.experiments ?? (cat.experiment ? [{ experimentId: "legacy", tag: null, salt: cat.experiment.salt, subjectKey: cat.experiment.subjectKey, arms: cat.experiment.arms }] : [])).map((e) => ({ experimentId: e.experimentId, tag: e.tag, arms: [...e.arms] })),
  };
  record.subjectHash = agent.subjectHashFor(ticket.customerId, TAGS.reply) ?? null;
  const values: Record<string, string> = customer?.tier === "enterprise" ? { ticket: ticket.body, tone: "formal" } : { ticket: ticket.body };

  // 1. The stream, with every delta's arrival offset; the first byte's offset counts from the POST itself.
  try {
    const posted = now();
    const stream = await agent.stream(TAGS.reply, values, { subject: ticket.customerId, metadata: { ticketId: ticket.ticketId, host: env.hostId } });
    let first: number | null = null;
    for await (const delta of stream) {
      const t = now();
      if (first === null) first = t;
      record.stream.deltas.push({ atMs: t - first, text: delta });
    }
    record.stream.firstByteMs = first === null ? null : first - posted;
    record.stream.result = await stream.result;
  } catch (error) {
    record.stream.refusal = refusalOf(error);
    gaps.push(`the run route refused the stream: ${record.stream.refusal.code} (${record.stream.refusal.status}) ${record.stream.refusal.message}`);
  }

  // 2. Feedback against the run's reference, from this process.
  if (record.stream.result) {
    try {
      const outcome = await agent.feedback(record.stream.result.runRef, { thumbs: "up" });
      record.feedback = { accepted: outcome.accepted, attributedTo: (outcome.attributedTo as Record<string, unknown> | null) ?? null, refusal: null };
    } catch (error) {
      record.feedback = { accepted: false, attributedTo: null, refusal: refusalOf(error) };
      gaps.push(`feedback was refused: ${record.feedback.refusal!.code} (${record.feedback.refusal!.status})`);
    }
  }

  // 3. The compatible endpoint, with parameters the caller has no say over.
  const url = compatChatUrl(env.hosted.runUrl, agentId);
  // No max_tokens either: the version seals its own output cap and the route applies that, so a cap on the request
  // would only look like a setting that took.
  const request = { url, model: `slot:${TAGS.reply}`, temperature: 1.9, top_p: 0.1, variables: Object.keys(values).filter((v) => v !== "ticket").concat(customer ? ["customer_tier"] : []) };
  try {
    const apiKey = await client.key();
    const body = { model: request.model, temperature: request.temperature, top_p: request.top_p, messages: [{ role: "user", content: ticket.body }], airprompter: { variables: { ...(customer ? { customer_tier: customer.tier } : {}), ...(values.tone ? { tone: values.tone } : {}) }, ...(record.subjectHash ? { subjectHash: record.subjectHash } : {}), metadata: { ticketId: ticket.ticketId, host: env.hostId, via: "openai-compatible" } } };
    const response = await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { error: { message: text.slice(0, 200) } }; }
    const choice = (parsed.choices as Array<{ message?: { content?: unknown }; finish_reason?: string }> | undefined)?.[0];
    const content = choice?.message?.content;
    record.compat = {
      request,
      response: {
        status: response.status,
        runRef: response.headers.get("x-airprompter-runref") ?? ((parsed.airprompter as { runRef?: string } | undefined)?.runRef ?? null),
        runId: response.headers.get("x-agent-run-id") ?? ((parsed.airprompter as { runId?: string } | undefined)?.runId ?? null),
        model: typeof parsed.model === "string" ? parsed.model : null,
        finishReason: choice?.finish_reason ?? null,
        usage: (parsed.usage as Record<string, unknown> | undefined) ?? null,
        text: typeof content === "string" ? content : Array.isArray(content) ? content.map((p: { text?: string }) => p?.text ?? "").join("") : null,
        error: response.ok ? null : compatErrorOf(parsed, response.status),
      },
      ignoredByContract: [...COMPAT_IGNORED_BY_CONTRACT],
    };
    if (!response.ok) gaps.push(`the compatible endpoint answered ${response.status}: ${JSON.stringify(record.compat.response.error).slice(0, 200)}`);
  } catch (error) {
    const refusal = refusalOf(error);
    record.compat = { request, response: { status: refusal.status, runRef: null, runId: null, model: null, finishReason: null, usage: null, text: null, error: { code: refusal.code, message: refusal.message } }, ignoredByContract: [...COMPAT_IGNORED_BY_CONTRACT] };
    gaps.push(`the compatible endpoint could not be called: ${refusal.message}`);
  }

  record.durationMs = now() - started;
  record.ok = record.stream.result !== null && record.compat?.response.status === 200;
  await ports.store.putRun(record as unknown as Record<string, unknown> & { runId: string; ticketId: string; at: string });
  await ports.store.appendEvent({ at: new Date().toISOString(), kind: "hosted_run", host: env.hostId, target: env.hosted.target, ticketId: ticket.ticketId, runId, generation: record.catalogue.generation, versionId: record.stream.result?.versionId ?? null, arm: record.stream.result?.arm ?? null, model: record.stream.result?.model ?? null, ok: record.ok, refusal: record.stream.refusal?.code ?? null, compatStatus: record.compat?.response.status ?? null, deltas: record.stream.deltas.length, by });
  return record;
}
