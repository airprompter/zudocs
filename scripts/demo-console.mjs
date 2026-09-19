#!/usr/bin/env node
/**
 * The presenter's console acts, from a terminal: what the owner does in AirPrompter during a session, as one command
 * each, with the session token `airprompter login` prints in the environment (`AIRPROMPTER_SESSION_TOKEN`). Every
 * act is a real change on dev — a new prompt version, a sealed release, a promotion, an experiment, a freeze — and
 * prints ids, generations, codes and warnings, never prompt text or a token. The drills that end in a refusal print
 * the refusal in the route's own words; that is the beat.
 *
 * @example
 * ```sh
 * eval "$(.bin/airprompter login --email you@zudocs.com --base-url https://api-dev.airprompter.com)"
 * npm run demo:console -- board                       # the pointers and pins of every environment
 * npm run demo:console -- change-words                # beat 1: a new reply version, sealed and promoted (no deploy)
 * npm run demo:console -- experiment start            # beat 4: the warmer sign-off at 10 %, a ramp plan to 50 % and 100 %
 * npm run demo:console -- experiment triage           # beat 4: the second, independent split on support.triage
 * npm run demo:console -- experiment dial 50          # beat 4: the candidate's share now (a new generation)
 * npm run demo:console -- experiment winner           # beat 4: promote the candidate; the experiment ends as promoted
 * npm run demo:console -- experiment end              # roll back to the control (the reset's path)
 * npm run demo:console -- experiment read             # the rollout page's document (per-arm results)
 * npm run demo:console -- freeze | unfreeze           # beat 3
 * npm run demo:console -- drill seal-placeholder      # beat 5: the seal refuses {{region_note}}
 * npm run demo:console -- drill model-required        # beat 5: a required model no host reports — sealed, promoted, refused by every host
 * npm run demo:console -- drill golden-fail           # beat 5: a triage version the golden set refuses — staged on us-east, not activated
 * npm run demo:console -- advance                     # a fresh canonical generation (the summary's cap +1): the reset's move
 * npm run demo:console -- staging promote             # hosted staging: the dev pins sealed for staging and promoted
 * ```
 */
import { readConfig, secretFromEnv } from "./lib/config.mjs";
import { createConsole, withPin } from "./lib/console.mjs";
import { BEATS, RAMP, canonicalPins, releaseLine } from "./lib/demo.mjs";

const args = process.argv.slice(2);
const command = args[0] ?? "board";
const sub = args[1] ?? null;
const say = (line) => console.log(line);

let config;
let token;
try {
  config = readConfig();
  token = secretFromEnv("AIRPROMPTER_SESSION_TOKEN", "the session token `airprompter login` prints");
} catch (error) {
  console.log(error.message);
  process.exit(2);
}
const con = createConsole({ config, token, log: (e) => say(`  · ${e.event}${Object.entries(e).filter(([k]) => k !== "event").map(([k, v]) => ` ${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join("")}`) });
const ENV = config.environment;

const describeSeal = (sealed) => {
  if (sealed.blocked) {
    say(`  seal REFUSED (HTTP ${sealed.status}):`);
    for (const b of sealed.blocked.blockers) say(`    blocker ${b.code}${b.tag ? ` on ${b.tag}` : ""}${b.detail ? `: ${b.detail}` : ""}`);
    for (const w of sealed.blocked.warnings) say(`    warning ${w.code}${w.tag ? ` on ${w.tag}` : ""}${w.requiresAck ? " (needs acknowledgement)" : ""}${w.detail ? `: ${w.detail}` : ""}`);
    return null;
  }
  say(`  sealed ${sealed.release.releaseDigest.slice(0, 24)}… (${sealed.release.pins.map((p) => `${p.tag}@${p.versionId}/${p.model.replace(/^amazon\./, "")}`).join(", ")})${sealed.warnings.length ? ` warnings ${sealed.warnings.map((w) => w.code).join(",")}` : ""}`);
  return sealed.release;
};

/** A version + seal + promote on the environment, from the current pins with one slot replaced. */
async function promoteChange(beat, extra = {}) {
  const v = await con.newVersion({ tag: beat.tag, transform: beat.transform, message: beat.message });
  say(`  ${beat.tag}: version ${v.versionId} (${v.changed ? "text changed" : "settings only"})`);
  const pins = withPin(await con.pins(ENV), beat.tag, { versionId: v.versionId, ...(extra.model ? { model: extra.model } : {}) });
  const release = describeSeal(await con.seal({ environment: ENV, pins, notes: beat.notes, ...(extra.modelRequired ? { modelRequired: [beat.tag] } : {}) }));
  if (!release) return null;
  const pointer = await con.promote({ environment: ENV, releaseDigest: release.releaseDigest, notes: beat.notes });
  say(`  promoted: ${ENV} is at generation ${pointer.generation} (${pointer.applyPolicy}, ${pointer.frozen ? "FROZEN" : "not frozen"}) at ${new Date().toISOString()}`);
  return { version: v, release, pointer };
}

const liveExperiments = async () => (await con.experiments.list({ environment: ENV })).filter((e) => ["running", "held", "complete"].includes(e.status ?? "running"));

switch (command) {
  case "board": {
    const b = await con.board();
    for (const [name, p] of Object.entries(b.environments)) say(`${name.padEnd(8)} ${releaseLine(p.generation, p.releaseDigest)} · policy ${p.applyPolicy} · ${p.frozen ? "FROZEN" : "not frozen"} · revision ${p.stateRevision} · experiments ${(p.experiments ?? []).length ? (p.experiments ?? []).map((e) => `${e.experimentId} ${e.tag ?? "*"} ${e.status ?? "?"} ${e.weightBps ?? "?"}bps`).join("; ") : "none"}`);
    for (const r of b.rows.filter((r) => !r.retiredAt)) say(`  ${r.tag.padEnd(26)} ${Object.entries(r.cells).map(([e, c]) => `${e}: ${c ? `${c.versionId} ${c.model}` : "—"}`).join(" · ")}`);
    break;
  }
  case "change-words": {
    await promoteChange(BEATS.changeWords);
    break;
  }
  case "experiment": {
    if (sub === "start" || sub === "triage") {
      const beat = sub === "start" ? BEATS.warmerSignoff : BEATS.tighterTriage;
      const v = await con.newVersion({ tag: beat.tag, transform: beat.transform, message: beat.message });
      say(`  ${beat.tag}: candidate version ${v.versionId}`);
      const pins = withPin(await con.pins(ENV), beat.tag, { versionId: v.versionId });
      const release = describeSeal(await con.seal({ environment: ENV, pins, notes: beat.notes }));
      if (!release) process.exit(1);
      const started = await con.experiments.start({ environment: ENV, candidateReleaseDigest: release.releaseDigest, ramp: [...RAMP], notes: beat.notes });
      const e = started.experiment;
      say(`  experiment ${e.experimentId} on ${e.tag}: control ${e.control.versionId} vs candidate ${e.candidate.versionId} at ${e.weightBps / 100} % · plan ${(e.plan ?? []).map((s) => `${s.weightBps / 100} % from ${s.notBefore.slice(11, 16)}Z`).join(" → ")} · generation ${started.pointer.generation}`);
    } else if (sub === "dial") {
      const pct = Number(args[2] ?? "50");
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) { say("dial takes a percentage"); process.exit(2); }
      const tag = args[3] ?? "support.reply";
      const live = (await liveExperiments()).find((e) => (e.tag ?? "support.reply") === tag);
      if (!live) { say(`no live experiment on ${tag}`); process.exit(1); }
      const out = await con.experiments.weights({ environment: ENV, experimentId: live.experimentId, action: "set", weightBps: Math.round(pct * 100), notes: `Zudocs demo: the ${tag} candidate dialled to ${pct} %` });
      say(`  ${live.experimentId}: candidate now ${out.experiment.weightBps / 100} % · generation ${out.pointer.generation}`);
    } else if (sub === "end") {
      for (const live of await liveExperiments()) {
        const out = await con.experiments.weights({ environment: ENV, experimentId: live.experimentId, action: "end", notes: "Zudocs demo: rolled back to the control" });
        say(`  ${live.experimentId} (${live.tag ?? "*"}): ${out.experiment.status} · generation ${out.pointer.generation}`);
      }
    } else if (sub === "winner") {
      const tag = args[2] ?? "support.reply";
      const live = (await liveExperiments()).find((e) => (e.tag ?? "support.reply") === tag);
      if (!live) { say(`no live experiment on ${tag}`); process.exit(1); }
      const doc = await con.experiments.read({ environment: ENV, experimentId: live.experimentId });
      say(`  rollout ${live.experimentId}: control ${doc.arms.control.runs} runs / candidate ${doc.arms.candidate.runs} runs · evaluation ${doc.evaluation?.decision ?? "—"} · promote ${doc.promote.recommended ? "recommended" : "not recommended"}: ${doc.promote.reason}`);
      const pointer = await con.promote({ environment: ENV, releaseDigest: doc.experiment.candidate.releaseDigest, notes: `Zudocs demo: the ${tag} candidate promoted as the winner` });
      const after = await con.experiments.read({ environment: ENV, experimentId: live.experimentId });
      say(`  winner promoted: generation ${pointer.generation} · experiment now ${after.experiment.status}`);
    } else if (sub === "read") {
      for (const e of await con.experiments.list({ environment: ENV })) {
        const doc = await con.experiments.read({ environment: ENV, experimentId: e.experimentId });
        const arm = (a) => `${a.runs} runs · p50 ${a.p50Ms ?? "—"} ms · tokens/run ${a.tokensPerRun ?? "—"} · quality ${a.quality ? `${a.quality.signal} ${a.quality.valueBps / 100} % (n=${a.quality.n})` : "—"} · outcomes ${JSON.stringify(a.outcomes ?? {})}`;
        say(`${e.experimentId} ${doc.experiment.tag} ${doc.experiment.status} at ${doc.experiment.weightBps / 100} % (generation ${doc.experiment.generation}, window ${doc.window.usageSource})`);
        say(`  control   ${doc.experiment.control.versionId}: ${arm(doc.arms.control)}`);
        say(`  candidate ${doc.experiment.candidate.versionId}: ${arm(doc.arms.candidate)}`);
        say(`  evaluation: ${doc.evaluation ? `${doc.evaluation.decision} (runs ${doc.evaluation.runs.control}/${doc.evaluation.runs.candidate}; ${doc.evaluation.checks.map((c) => `${c.name} ${c.verdict}`).join(", ")})` : "none yet"} · promote: ${doc.promote.reason}`);
      }
    } else {
      say("experiment start | triage | dial <pct> [tag] | winner [tag] | end | read");
      process.exit(2);
    }
    break;
  }
  case "freeze":
  case "unfreeze": {
    const { pointer, changed } = await con.freeze({ environment: ENV, frozen: command === "freeze", notes: `Zudocs demo, beat 3: ${command}` });
    say(`  ${ENV} ${pointer.frozen ? "FROZEN" : "not frozen"}${changed ? ` (generation ${pointer.generation} carries the directive)` : " (already)"}`);
    break;
  }
  case "drill": {
    if (sub === "seal-placeholder") {
      const beat = BEATS.undeclaredPlaceholder;
      const v = await con.newVersion({ tag: beat.tag, transform: beat.transform, message: beat.message });
      say(`  ${beat.tag}: version ${v.versionId} uses a placeholder the slot does not declare`);
      const sealed = await con.seal({ environment: ENV, pins: withPin(await con.pins(ENV), beat.tag, { versionId: v.versionId }), notes: beat.notes });
      describeSeal(sealed);
      const refused = sealed.blocked?.blockers.some((b) => b.code === "variable_undeclared");
      say(refused ? "  → the seal refused it (variable_undeclared): a runtime never renders a literal {{name}}" : "  → NOT refused: the seal accepted an undeclared placeholder (file this)");
      process.exit(refused ? 0 : 1);
    } else if (sub === "model-required") {
      const beat = BEATS.unreportedModel;
      const pins = withPin(await con.pins(ENV), beat.tag, { model: beat.model });
      const sealed = await con.seal({ environment: ENV, pins, notes: beat.notes, modelRequired: [beat.tag] });
      const release = describeSeal(sealed);
      if (!release) { say("  → refused at the seal"); process.exit(0); }
      say("  → the seal accepted it with a warning; promoting so every host can refuse it (status.lastRefusal = model_unavailable):");
      const pointer = await con.promote({ environment: ENV, releaseDigest: release.releaseDigest, notes: beat.notes });
      say(`  promoted generation ${pointer.generation}; run \`npm run demo:console -- advance\` to move past it once the refusal has been seen`);
    } else if (sub === "golden-fail") {
      const out = await promoteChange(BEATS.goldenFail);
      if (out) say("  → us-east runs the golden set before activating: 1/5 is below the 80 % floor, so the release stays staged there; eu-west stages it under unlock_required (do not approve); advance when done");
    } else {
      say("drill seal-placeholder | model-required | golden-fail");
      process.exit(2);
    }
    break;
  }
  case "advance": {
    const v = await con.newVersion({ tag: "support.escalate.summary", inference: (current) => ({ ...current, maxOutputTokens: Number(current.maxOutputTokens ?? 400) + 1 }), message: "Reset means advance: the summary's cap +1" });
    say(`  support.escalate.summary: version ${v.versionId} (cap ${v.inference?.maxOutputTokens})`);
    const pins = canonicalPins(config, { "support.escalate.summary": { versionId: v.versionId } });
    const release = describeSeal(await con.seal({ environment: ENV, pins, notes: `Zudocs reset: a fresh canonical generation (summary cap ${v.inference?.maxOutputTokens})` }));
    if (!release) process.exit(1);
    const pointer = await con.promote({ environment: ENV, releaseDigest: release.releaseDigest, notes: "Zudocs reset: advance" });
    say(`  promoted: ${ENV} is at generation ${pointer.generation}`);
    break;
  }
  case "staging": {
    if (sub !== "promote") { say("staging promote"); process.exit(2); }
    const pins = (await con.pins(ENV)).map(({ tag, versionId, model }) => ({ tag, versionId, model }));
    const release = describeSeal(await con.seal({ environment: "staging", pins, notes: "Zudocs hosted staging: the dev pins" }));
    if (!release) process.exit(1);
    const current = await con.pointer("staging");
    if (current.releaseDigest === release.releaseDigest) say(`  staging already at ${releaseLine(current.generation, current.releaseDigest)}`);
    else {
      const pointer = await con.promote({ environment: "staging", releaseDigest: release.releaseDigest, notes: "Zudocs hosted staging" });
      say(`  promoted: staging is at generation ${pointer.generation}`);
    }
    const models = await con.models("staging");
    say(`  hosted models (${models.source}): ${models.models.map((m) => m.model).join(", ")}`);
    break;
  }
  default:
    say("commands: board · change-words · experiment … · freeze · unfreeze · drill … · advance · staging promote");
    process.exit(2);
}
