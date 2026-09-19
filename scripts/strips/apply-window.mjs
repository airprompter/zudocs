#!/usr/bin/env node
/**
 * `apply.window` on a laptop store (the bonus beat of beat 5): the SDK starts against dev with `apply.policy:
 * "unlock_required"` and a local window that opens one minute from now and closes three minutes from now. On a
 * fresh store the first sync stages the promoted release (nothing to serve, `applyState: staged`); nobody unlocks;
 * when the window opens the SDK activates it on its own (`window_unlock` in its log) and serves — a standing
 * approval for a time of day, the change-control integration a daemon host would take from its manifest. Prints the
 * SDK's own events (content-free by design) with the clock, then stops. The Agent key comes from the environment.
 *
 * Honest note: this is a laptop process because the eu-west host's daemon (the released CLI's `airprompter daemon`)
 * takes no local window flag and no golden hook — those live in the process that syncs, and on that host the daemon
 * syncs. The manifest's `unlockWindow` would reach it, but setting one on the environment tightens every host to
 * `unlock_required`, which the Lambda cannot unlock; RUNBOOK.md says so.
 *
 * @example
 * ```sh
 * set -a; . ~/.config/zudocs/dev.env; set +a
 * node scripts/strips/apply-window.mjs --state-dir /tmp/zudocs-window       # 1–2 minutes; the log is the strip
 * ```
 */
import { readFileSync } from "node:fs";
import { AirPrompterAgent } from "@airprompter/agent-sdk";
import { readConfig, repoRoot, secretFromEnv } from "../lib/config.mjs";

const args = process.argv.slice(2);
const stateDir = args.includes("--state-dir") ? args[args.indexOf("--state-dir") + 1] : null;
if (!stateDir) { console.log("usage: apply-window.mjs --state-dir <fresh directory>"); process.exit(2); }
const config = readConfig();
const apiKey = secretFromEnv("AIRPROMPTER_AGENT_KEY", "the Agent key (owner's 0600 file)");
const root = JSON.parse(readFileSync(`${repoRoot}/keys/${config.hostedEnvironment}.root.jwk.json`, "utf8"));
const started = Date.now();
const clock = () => `+${String(Math.round((Date.now() - started) / 1000)).padStart(3, " ")}s`;
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
// A window is minute-granular ("HH:MM-HH:MM UTC"), so it opens on the first minute boundary at least sixty seconds
// away — sixty to a hundred and nineteen seconds from now — and closes two minutes after that; the header says when.
const opens = Math.ceil((started + 60_000) / 60_000) * 60_000;
const window = `${hhmm(opens)}-${hhmm(opens + 120_000)} UTC`;
console.log(`# apply.window on a laptop store — ${new Date(started).toISOString()} — window "${window}" (opens in ${Math.round((opens - started) / 1000)} s), policy unlock_required, dev release`);
const ap = await AirPrompterAgent.start({
  organizationId: config.organizationId,
  agentId: config.agentId,
  target: config.environment,
  apiKey,
  baseUrl: config.baseUrl,
  stateDir,
  root: { pinned: root, hostedEnvironment: config.hostedEnvironment },
  sync: { mode: "resident", pollSeconds: 20, rootUrl: config.rootUrl, ...(config.edgePointerUrl ? { edgePointerUrl: config.edgePointerUrl } : {}) },
  apply: { policy: "unlock_required", window },
  models: config.models,
  telemetry: { upload: false },
  logger: (event) => console.log(`${clock()} sdk ${JSON.stringify(event)}`),
});
const line = (label) => { const s = ap.status(); console.log(`${clock()} ${label}: generation ${s.generation} · staged ${s.stagedGeneration ?? "—"} · applyState ${s.applyState} · policy ${s.applyPolicy.effective} (${s.applyPolicy.source}) · window ${s.window ? `${s.window.source} ${s.window.open ? "OPEN" : "closed"} ${s.window.opensAt.slice(11, 16)}–${s.window.closesAt.slice(11, 16)}Z` : "none"}`); };
line("after start");
let served = false;
for (let i = 0; i < 30 && !served; i += 1) {
  await new Promise((r) => setTimeout(r, 5000));
  const s = ap.status();
  if (s.applyState === "active" && s.generation > 0) served = true;
  if (i % 3 === 2 || served) line(served ? "ACTIVATED by the window" : "waiting");
}
if (served) {
  const r = ap.prompt("support.triage", { subject: "cust-1001" }).render({ ticket: "Search still returns a page we deleted last week." });
  console.log(`${clock()} render: ${r.tag} ${r.versionId} on ${r.model} · release #${r.generation} · ${r.text.length} chars (not shown)`);
} else console.log(`${clock()} the window never opened within two and a half minutes — check the clock`);
await ap.stop();
console.log(`${clock()} stopped`);
process.exit(served ? 0 : 1);
