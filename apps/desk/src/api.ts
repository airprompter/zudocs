/**
 * The desk API from the browser: every call carries the id token, JSON in and out, an HTTP error surfaced with
 * the API's own `error` and `message` (a 429 at the daily cap reads exactly as the API said it). The types here
 * mirror `services/desk-api` records — the app renders them, it never derives a number of its own.
 *
 * @example
 * ```ts
 * const api = createApi(config.apiUrl, () => auth.idToken());
 * const { tickets } = await api.tickets();
 * const { run } = await api.runTicket("T-1041");      // throws ApiError { status: 429, error: "daily_cap", … }
 * const { approval, already } = await api.approve("eu-west-1-ec2-g2");   // the owner's decision, recorded once
 * ```
 */

export class ApiError extends Error {
  constructor(readonly status: number, readonly error: string, message: string, readonly body: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Customer { customerId: string; name: string; tier: "trial" | "team" | "enterprise"; seats: number; since: string }
export interface Ticket { ticketId: string; customerId: string; subject: string; body: string; receivedAt: string; channel: string; customer: Customer | null; lastRun?: { runId: string; at: string; category?: string | null; priority?: string | null; versionId?: string; arm?: string } | null }
export interface Observation { status: string; errorClass?: string | null; latencyMs: number; tokens?: { input?: number; cachedInput?: number; output?: number }; usageSource?: string; checks?: { passed?: number; failed?: number } }
export interface VariableOrigin { name: string; trust: "operator" | "end_user"; origin: "call_site" | "your_source" | "default" | "unfilled"; value: string | null; fenced: boolean; required: boolean }
export interface Step {
  step: "triage" | "reply" | "summary" | "handoff";
  tag: string;
  versionId: string | null;
  arm: string | null;
  model: string | null;
  generation: number | null;
  runRef: string | null;
  rendered: { text: string; variables: VariableOrigin[]; inference: Record<string, unknown> | null } | null;
  output: string | null;
  observation: Observation | null;
  checks: Array<{ name: string; kind: string; verdict: "pass" | "fail"; reason?: string }>;
  costUsd: number | null;
  judge: { score: number | null; taskPass: number; taskFail: number; taskUnclear: number; flagged: boolean; model: string } | null;
  error: { name: string; message: string } | null;
}
export interface Run { runId: string; ticketId: string; customerId: string; at: string; by: string; host: string; kind: "run" | "escalate"; generation: number; applyState: string; steps: Step[]; triage: { category: string | null; priority: string | null; summary: string | null } | null; reply: string | null; handoff: string | null; durationMs: number; capUsed: number; ok: boolean; feedback?: Array<{ at: string; signals: Record<string, unknown>; by: string; filed: boolean }> }
/** A hosted staging run (phase 6): the stream as it arrived, the feedback, the compat call beside the catalogue's sealed settings; refusals in the route's words. */
export interface HostedRefusal { code: string; status: number; message: string; detail?: string }
export interface HostedRun {
  runId: string; ticketId: string; customerId: string; at: string; by: string; host: string; kind: "hosted"; target: string; runUrl: string; subjectHash: string | null;
  catalogue: { generation: number; releaseDigest: string; slot: { tag: string; model: string; inference: Record<string, unknown> | null; variables: string[] } | null; experiments: Array<{ experimentId: string; tag: string | null; arms: string[] }> };
  stream: { deltas: Array<{ atMs: number; text: string }>; firstByteMs: number | null; result: { runId: string; runRef: string; output: string; model: string; versionId: string; arm: string; generation: number; usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }; latencyMs: number; priceMicros: number; priceBookRevision: string; stopReason: string; source: string } | null; refusal: HostedRefusal | null };
  feedback: { accepted: boolean; attributedTo: Record<string, unknown> | null; refusal: HostedRefusal | null } | null;
  compat: { request: { url: string; model: string; temperature: number; top_p: number; max_tokens: number; variables: string[] }; response: { status: number; runRef: string | null; runId: string | null; model: string | null; finishReason: string | null; usage: Record<string, unknown> | null; text: string | null; error: Record<string, unknown> | null }; ignored: string[] } | null;
  durationMs: number; ok: boolean; gaps: string[];
}
export type AnyRun = Run | HostedRun;
export const isHostedRun = (run: AnyRun): run is HostedRun => run.kind === "hosted";
/** The per-arm fold of the desk's own records (`GET /arms`) and the ramp plans this host walks. */
export interface ArmSummary { tag: string; arm: string; versionId: string; model: string; runs: number; hosts: Record<string, number>; judgeMean: number | null; judged: number; costMeanUsd: number | null; costed: number; checksPassed: number; checksFailed: number; latencyMeanMs: number | null; errors: number; feedback: { up: number; down: number; accepted: number; edited: number } }
export interface Stickiness { customerId: string; tag: string; arms: Record<string, string>; consistent: boolean }
export interface Ramp { experimentId: string; tag: string | null; arms: string[]; weightBps: number[]; step: number; nextStepAt: string | null; plan: Array<{ notBefore: string; weightBps: number[] }>; readBy?: string }
export interface Arms { arms: ArmSummary[]; stickiness: Stickiness[]; ramps: Ramp[]; readAt: string; runsRead: number }
export interface HostStatus {
  hostId: string;
  region: string;
  kind: string;
  sdk: string;
  writtenAt: string;
  status: Record<string, any>;
  healthz: Record<string, any>;
  container: { instanceId: string; coldStart: boolean; startedAt: string; invocations: number };
  /** The eu-west host's attached workers: the Node worker that writes the row, the Python worker's own part. */
  worker?: { instanceId: string; sdk: string; startedAt: string; tickets: number; source: string; attached: boolean; healthz: string; reasons: string[] } | null;
  python?: { instanceId: string; sdk: string; startedAt: string; writtenAt: string; generation: number; stagedGeneration: number | null; applyState: string; source: string; attached: boolean; healthz: string; reasons: string[]; runs: number; lastRunAt: string | null } | null;
  ec2?: { instanceId: string; availabilityZone: string } | null;
  /** The puller mirrors the air-gapped host's document: when it looked, and the host's own part (`services/airgap/src/status.ts`). */
  mirroredAt?: string;
  airgap?: {
    keyId: string | null;
    keyPublished: boolean;
    phase: "awaiting_bundle" | "serving";
    waitingFor: { newest: { generation: number; keyId: string | null } | null } | null;
    applies: Array<{ at: string; generation: number | null; outcome: string; reason: string | null; detail: string | null; source: "vendored" | "exchange"; object: string | null }>;
    renders: { count: number; lastAt: string | null; last: { tag: string; versionId: string; arm: string; model: string; subject: string } | null; observation: "refused" };
    export: { at: string; segments: number; bytes: number; instances: number; object: string | null; generation: number } | null;
    probe: { at: string; curl: { url: string; exit: number; seconds: number; meaning: string }; dns: { name: string; resolved: boolean; detail: string } } | null;
    startFailure: { at: string; generation: number; releaseDigest: string; code: string | null; message: string } | null;
    seq: number;
  } | null;
  /** The eu-west host's import timer: the air-gapped host's exports carried to AirPrompter. */
  imports?: { lastPassAt: string; objects: number; pending: number; imported: number; last: Record<string, unknown> | null } | null;
}
export interface State { host: { hostId: string; region: string; sdk: string; instanceId: string; startedAt: string; invocations: number; coldStart: boolean; status: Record<string, any>; healthz: Record<string, any>; models: string[]; stateDir: string }; hosts: HostStatus[]; cap: { day: string; used: number; cap: number }; airprompter: { baseUrl: string; environment: string; agentId: string }; features?: { wire: boolean; nudge: boolean; hosted?: boolean; hostCli?: boolean }; hosted?: { target: string; runUrl: string } | null; frozen?: { frozen: boolean; reason: string | null }; hostCliCommands?: string[] }
export interface TimelineEvent { at: string; kind: string; host: string; id?: string; [key: string]: unknown }
export type ApprovalDecision = "pending" | "approved" | "activated" | "superseded" | "failed";
export interface Approval { approvalId: string; hostId: string; generation: number; releaseDigest: string | null; stagedAt: string; unlockRequest: { requestedBy: string; requestedAt: string; expiresAt: string; note?: string } | null; decision: ApprovalDecision; decidedBy: string | null; decidedAt: string | null; activatedAt: string | null; outcome: string | null; updatedAt: string; ramps?: Ramp[] }

export interface Api {
  tickets(): Promise<{ tickets: Ticket[] }>;
  ticket(ticketId: string): Promise<{ ticket: Ticket; runs: AnyRun[] }>;
  runTicket(ticketId: string): Promise<{ run: Run; cap: State["cap"] }>;
  escalateTicket(ticketId: string): Promise<{ run: Run; cap: State["cap"] }>;
  /** Hosted staging: the record comes back with the route's refusals inside it (a 502 still carries the record). */
  hostedRun(ticketId: string): Promise<{ run: HostedRun }>;
  arms(): Promise<Arms>;
  feedback(runId: string, step: string, signals: Record<string, unknown>): Promise<{ filed: boolean; message: string }>;
  state(): Promise<State>;
  events(since: string | null): Promise<{ events: TimelineEvent[] }>;
  approvals(): Promise<{ approvals: Approval[]; pending: number }>;
  approve(approvalId: string): Promise<{ approval: Approval; already: boolean; message: string }>;
  presenter(action: string, body?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function createApi(baseUrl: string, tokenOf: () => Promise<string | null>, fetchImpl: typeof fetch = fetch): Api {
  const call = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const token = await tokenOf();
    if (!token) throw new ApiError(401, "signed_out", "sign in to use the desk", {});
    const response = await fetchImpl(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { message: text.slice(0, 200) };
    }
    if (!response.ok) throw new ApiError(response.status, typeof parsed.error === "string" ? parsed.error : `http_${response.status}`, typeof parsed.message === "string" ? parsed.message : `the API answered ${response.status}`, parsed);
    return parsed as T;
  };
  // A run whose model refused answers 502 WITH the record (ok: false): the record is what the desk shows.
  const runOrRecord = async <T extends { run: unknown }>(path: string): Promise<T> => {
    try {
      return await call<T>("POST", path, {});
    } catch (error) {
      if (error instanceof ApiError && error.status === 502 && typeof error.body.run === "object" && error.body.run !== null) return error.body as unknown as T;
      throw error;
    }
  };
  return {
    tickets: () => call("GET", "/tickets"),
    ticket: (ticketId) => call("GET", `/tickets/${encodeURIComponent(ticketId)}`),
    runTicket: (ticketId) => runOrRecord<{ run: Run; cap: State["cap"] }>(`/tickets/${encodeURIComponent(ticketId)}/run`),
    escalateTicket: (ticketId) => runOrRecord<{ run: Run; cap: State["cap"] }>(`/tickets/${encodeURIComponent(ticketId)}/escalate`),
    hostedRun: (ticketId) => runOrRecord<{ run: HostedRun }>(`/tickets/${encodeURIComponent(ticketId)}/hosted-run`),
    arms: () => call("GET", "/arms"),
    feedback: (runId, step, signals) => call("POST", `/runs/${encodeURIComponent(runId)}/feedback`, { step, signals }),
    state: () => call("GET", "/state"),
    events: (since) => call("GET", `/events${since ? `?since=${encodeURIComponent(since)}` : ""}`),
    approvals: () => call("GET", "/approvals"),
    approve: (approvalId) => call("POST", `/approvals/${encodeURIComponent(approvalId)}/approve`, {}),
    presenter: (action, body = {}) => call("POST", `/presenter/${encodeURIComponent(action)}`, body),
  };
}
