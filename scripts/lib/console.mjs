/**
 * The console acts of the demo, as a customer's own tooling performs them: the workspace API AirPrompter's console
 * calls, with the session token `airprompter login` prints (from the environment, never argv, never printed). One
 * client over `fetch`; every call answers `{ status, json }` and the helpers throw with the route's own code when a
 * step is refused — a refusal is often the beat (the seal refusing an undeclared placeholder), so `seal` returns
 * blocked documents instead of throwing. Nothing here prints prompt text: versions are made by transforming the
 * draft's text in memory and the log lines carry ids, revisions and codes.
 *
 * What is here: the board and the current pins; a new version of a slot's prompt (a text transform, or new
 * settings, then review → verify → approve under the governance fence); seal and promote; experiments (start with a
 * ramp, dial, hold, end, read the rollout); freeze and unfreeze; the fleet and metrics reads; the seal probes the
 * safety-net drills use. The routes are the console's own (no compatibility promise), so every field is checked by
 * name and a rename fails here, not as a wrong demo.
 *
 * @example
 * ```js
 * const con = createConsole({ config: readConfig(), token: secretFromEnv("AIRPROMPTER_SESSION_TOKEN", "…") });
 * const pins = await con.pins("dev");                                   // [{ tag, versionId, model }]
 * const v = await con.newVersion({ tag: "support.reply", transform: (t) => t.replace(/The Zudocs team$/, "Warmly,\nThe Zudocs team"), message: "warmer sign-off" });
 * const sealed = await con.seal({ environment: "dev", pins: withPin(pins, "support.reply", v.versionId), notes: "…" });
 * await con.promote({ environment: "dev", releaseDigest: sealed.release.releaseDigest, notes: "…" });
 * ```
 */
import { randomBytes } from "node:crypto";

const ENVIRONMENTS = new Set(["dev", "staging", "prod"]);

export class ConsoleRefusal extends Error {
  constructor(what, status, json) {
    super(`${what}: HTTP ${status} ${JSON.stringify(json).slice(0, 500)}`);
    this.name = "ConsoleRefusal";
    this.status = status;
    this.json = json;
    this.code = json?.code ?? json?.details?.code ?? json?.error ?? null;
  }
}

/** Replace one tag's pin (version and/or model) in a pins list; pure. */
export function withPin(pins, tag, patch) {
  if (!pins.some((p) => p.tag === tag)) throw new Error(`withPin: no pin for ${tag}`);
  return pins.map((p) => (p.tag === tag ? { ...p, ...patch } : p));
}

/** The warnings a seal wants acknowledged, deduplicated; the drills acknowledge only these known, benign codes. */
export const ACKNOWLEDGEABLE = Object.freeze(["variable_uncovered", "model_changed", "model_partially_available"]);

export function createConsole({ config, token, fetchImpl = globalThis.fetch, log = () => {} }) {
  if (!token) throw new Error("console: a session token is required (airprompter login)");
  const base = config.baseUrl.replace(/\/$/, "");
  const ws = config.workspaceId;
  const org = config.organizationId;
  const A = (agentId = config.agentId) => `/workspace/${ws}/agents/${agentId}`;
  const idem = () => ({ "idempotency-key": randomBytes(8).toString("hex") });

  const api = async (method, path, body, extra = {}) => {
    const response = await fetchImpl(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { text: text.slice(0, 300) }; }
    if (response.status === 401) throw new ConsoleRefusal(`${method} ${path}`, 401, { error: "the session token was not accepted; run `airprompter login` again (tokens last about an hour)" });
    return { status: response.status, json };
  };
  const must = (r, want, what) => {
    if (!(Array.isArray(want) ? want : [want]).includes(r.status)) throw new ConsoleRefusal(what, r.status, r.json);
    return r.json;
  };
  const env = (environment) => {
    if (!ENVIRONMENTS.has(environment)) throw new Error(`console: environment must be dev, staging or prod (got ${environment})`);
    return environment;
  };

  let fence = null;
  const governanceFence = async () => {
    if (!fence) {
      const viewer = must(await api("GET", `/organization/${org}/governance/policy`), 200, "governance policy").viewer;
      fence = { expectedMembershipId: viewer.membershipId, expectedAuthzEpoch: viewer.authzEpoch };
    }
    return fence;
  };

  const board = async (agentId) => must(await api("GET", `${A(agentId)}/board`), 200, "board").board;
  const rows = (b) => b.rows.filter((r) => !r.retiredAt);
  /** The environment's pointer: generation, releaseDigest, stateRevision, frozen, applyPolicy, experiments. */
  const pointer = async (environment, agentId) => {
    const b = await board(agentId);
    const p = b.environments[env(environment)];
    if (!p) throw new Error(`console: the board has no ${environment} environment`);
    return p;
  };
  /** The prompt id behind a slot tag, from the board. */
  const promptIdOf = async (tag, agentId) => {
    const row = rows(await board(agentId)).find((r) => r.tag === tag);
    if (!row) throw new Error(`console: no slot ${tag} on the board`);
    return row.artifactId;
  };

  return {
    api,
    must,
    board,
    pointer,
    promptIdOf,
    /** The current pins of an environment (`{ tag, versionId, model }`), from the board's cells. */
    async pins(environment, agentId) {
      const b = await board(agentId);
      const e = env(environment);
      return rows(b).map((r) => {
        const cell = r.cells?.[e];
        if (!cell?.versionId || !cell?.model) throw new Error(`console: ${r.tag} has no ${e} pin on the board`);
        return { tag: r.tag, versionId: cell.versionId, model: cell.model, artifactId: r.artifactId };
      });
    },
    /**
     * A new version of a slot's prompt: the draft's text through `transform` (identity for a settings-only version),
     * the draft saved with `inference` when given, a snapshot (rev-N), review → verify → approve under the fence, and
     * the draft put back to what it was so the head reads as the released text again. Returns the version id; never
     * the text.
     */
    async newVersion({ tag, transform = (t) => t, inference, message, agentId }) {
      const promptId = await promptIdOf(tag, agentId);
      const head = must(await api("GET", `/team/prompts/${promptId}/draft`), 200, `draft ${tag}`).draftHead;
      const original = head.content;
      const next = transform(original);
      if (typeof next !== "string" || !next.trim()) throw new Error(`newVersion: the transform for ${tag} produced no text`);
      const settings = (typeof inference === "function" ? inference(head.inference ?? {}) : inference) ?? head.inference ?? undefined;
      const saved = must(await api("PUT", `/team/prompts/${promptId}/draft`, { content: next, ...(settings ? { inference: settings } : {}), expectedRevision: head.revision }), 200, `save draft ${tag}`).draftHead;
      const snap = must(await api("POST", `/team/prompts/${promptId}/versions`, { expectedRevision: saved.revision, commitMessage: message.slice(0, 72) }, idem()), [200, 201], `snapshot ${tag}`);
      const versionId = snap.version.ref.versionId;
      const changed = next !== original;
      if (changed || inference) {
        const again = must(await api("GET", `/team/prompts/${promptId}/draft`), 200, `draft ${tag} (restore)`).draftHead;
        must(await api("PUT", `/team/prompts/${promptId}/draft`, { content: original, ...(head.inference ? { inference: head.inference } : {}), expectedRevision: again.revision }), 200, `restore draft ${tag}`);
      }
      const f = await governanceFence();
      const path = (suffix) => `/organization/${org}/workspaces/${ws}/governance/artifacts/prompt/${promptId}/versions/${versionId}${suffix}`;
      const steps = [["/review", { decision: "approved", notes: message }], ["/verify", { result: "passed", notes: message }], ["/approve", { approvalScope: "artifact_version", notes: message }]];
      for (const [suffix, body] of steps) {
        const r = await api("POST", path(suffix), { ...f, ...body, idempotencyKey: randomBytes(8).toString("hex") });
        if (r.status !== 409) must(r, [200, 201], `${suffix.slice(1)} ${tag} ${versionId}`);
      }
      log({ event: "version", tag, versionId, changed, inference: settings ?? null });
      return { promptId, versionId, changed, textLength: next.length, inference: settings ?? null };
    },
    /**
     * Seal a release for an environment. Acknowledges only the benign warnings (`ACKNOWLEDGEABLE`); any other blocker
     * comes back as `{ blocked: { blockers, warnings } }` — the drills show those. `release` is set when sealed.
     */
    async seal({ environment, pins, notes, modelRequired, agentId, acknowledge = true }) {
      const e = env(environment);
      const body = { environment: e, pins: pins.map(({ tag, versionId, model }) => ({ tag, versionId, model, ...(modelRequired?.includes(tag) ? { modelRequired: true } : {}) })), notes };
      let r = await api("POST", `${A(agentId)}/releases`, body);
      const blocked = r.status === 409 ? (r.json?.details?.status === "blocked" ? r.json.details : r.json?.status === "blocked" ? r.json : null) : null;
      if (blocked && acknowledge) {
        const acks = [...new Set((blocked.warnings ?? []).filter((w) => w.requiresAck && ACKNOWLEDGEABLE.includes(w.code)).map((w) => w.code))];
        const onlyAcks = (blocked.blockers ?? []).every((b) => b.code === "ack_required") && acks.length > 0;
        if (onlyAcks) r = await api("POST", `${A(agentId)}/releases`, { ...body, acknowledgedWarningCodes: acks });
      }
      const blockedAfter = r.status === 409 ? (r.json?.details?.status === "blocked" ? r.json.details : r.json?.status === "blocked" ? r.json : null) : null;
      if (blockedAfter) return { status: r.status, blocked: { blockers: blockedAfter.blockers ?? [], warnings: blockedAfter.warnings ?? [] }, release: null, warnings: blockedAfter.warnings ?? [] };
      const json = must(r, [200, 201], `seal ${e}`);
      log({ event: "sealed", environment: e, releaseDigest: json.release.releaseDigest, warnings: (json.warnings ?? []).map((w) => w.code) });
      return { status: r.status, blocked: null, release: json.release, warnings: json.warnings ?? [] };
    },
    /** Promote a sealed release; reads the pointer's revision fresh. Throws a ConsoleRefusal with the route's code on a refusal. */
    async promote({ environment, releaseDigest, notes, agentId }) {
      const p = await pointer(environment, agentId);
      const r = await api("POST", `${A(agentId)}/environments/${env(environment)}/promote`, { releaseDigest, expectedStateRevision: p.stateRevision, notes });
      const json = must(r, 200, `promote ${environment}`);
      log({ event: "promoted", environment, generation: json.pointer.generation, releaseDigest });
      return json.pointer;
    },
    async freeze({ environment, frozen, notes, agentId }) {
      const p = await pointer(environment, agentId);
      if (p.frozen === frozen) return { pointer: p, changed: false };
      const json = must(await api("POST", `${A(agentId)}/environments/${env(environment)}/freeze`, { frozen, expectedStateRevision: p.stateRevision, notes }), 200, `${frozen ? "freeze" : "unfreeze"} ${environment}`);
      log({ event: frozen ? "frozen" : "unfrozen", environment, generation: json.pointer.generation });
      return { pointer: json.pointer, changed: true };
    },
    experiments: {
      /** Start a split: a sealed candidate that differs from the promoted release in one slot, at the ramp's first share. */
      async start({ environment, candidateReleaseDigest, ramp, primarySignal, notes, agentId }) {
        const p = await pointer(environment, agentId);
        const r = await api("POST", `${A(agentId)}/environments/${env(environment)}/experiments`, { expectedStateRevision: p.stateRevision, candidateReleaseDigest, ...(ramp ? { ramp } : {}), ...(primarySignal ? { primarySignal } : {}), ...(notes ? { notes } : {}) });
        const json = must(r, [200, 201], `experiment start ${environment}`);
        log({ event: "experiment_started", environment, experimentId: json.experiment.experimentId, tag: json.experiment.tag, weightBps: json.experiment.weightBps, generation: json.pointer.generation });
        return json;
      },
      /** The dial (`set` with weightBps), `hold`, `resume`, or `end` (roll back to the control: a new generation without the split). */
      async weights({ environment, experimentId, action, weightBps, notes, agentId }) {
        const p = await pointer(environment, agentId);
        const r = await api("PUT", `${A(agentId)}/environments/${env(environment)}/experiments/${experimentId}/weights`, { expectedStateRevision: p.stateRevision, action, ...(weightBps !== undefined ? { weightBps } : {}), ...(notes ? { notes } : {}) });
        const json = must(r, 200, `experiment ${action} ${environment}`);
        log({ event: `experiment_${action}`, environment, experimentId, weightBps: json.experiment?.weightBps ?? null, status: json.experiment?.status ?? null, generation: json.pointer?.generation ?? null });
        return json;
      },
      /** The rollout page's document: the experiment row, per-arm metrics, the evaluation, the promote recommendation. */
      async read({ environment, experimentId, agentId }) {
        return must(await api("GET", `${A(agentId)}/environments/${env(environment)}/experiments/${experimentId}`), 200, `experiment read ${experimentId}`);
      },
      /** Every experiment the pointer carries, live or not, as the board lists them. */
      async list({ environment, agentId }) {
        const p = await pointer(environment, agentId);
        return p.experiments ?? (p.experiment ? [p.experiment] : []);
      },
    },
    /** The fleet page's document for an environment. */
    async fleet(environment, agentId) {
      return must(await api("GET", `${A(agentId)}/environments/${env(environment)}/fleet`), 200, `fleet ${environment}`);
    },
    /** The metrics page's rows (`tag, versionId, model, arm`), 24 h. */
    async metrics(environment, agentId, range = "24h") {
      return must(await api("GET", `${A(agentId)}/metrics?environment=${env(environment)}&range=${range}`), 200, `metrics ${environment}`);
    },
    /** The hosted models the execution route can call on a managed environment. */
    async models(environment, agentId) {
      return must(await api("GET", `${A(agentId)}/environments/${env(environment)}/models`), 200, `models ${environment}`);
    },
  };
}
