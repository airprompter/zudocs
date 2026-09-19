# The demonstration

Twenty minutes, nine beats; the first four are the five-minute cut. The prospect sees the desk first
(https://desk.zudocs.com), AirPrompter's console second, a terminal only as a recorded strip. Everything they see
is the real deployment doing the real thing: three AWS regions, the public SDK, a promotion reaching every host
without a deploy, and every refusal in the platform's own words. Nothing on the desk is invented, and nothing in
this script asks you to pretend — where dev cannot do something today, the beat says so (see *Honest notes*).

Two windows: the desk signed in as the owner (the hosted UI at desk.zudocs.com), and a terminal in this repository
with the session token in the environment (`eval "$(.bin/airprompter login --email you@zudocs.com --base-url
https://api-dev.airprompter.com)"`), plus the AirPrompter console open on the **Zudocs** workspace › **Agents** ›
**zudocs-support** for the console beats. `npm run demo:console -- <act>` is every console act as one command
(the same routes the console calls), so a beat never depends on finding a button.

| # | Beat | Where | 20 min | 5 min |
|---|---|---|---|---|
| 0 | Cold open | desk | 1:00 | 0:45 |
| 1 | Change the words, no deploy | console → desk | 3:00 | 1:30 |
| 2 | The fleet | desk | 2:00 | 0:45 |
| 3 | You activate, not us; the freeze | desk + console | 3:00 | 1:15 |
| 4 | Measure | desk + console | 3:30 | 0:45 |
| 5 | Safety nets | console + terminal | 2:30 | — |
| 6 | Your data, your variables | desk | 1:30 | — |
| 7 | Losing the wire | desk | 2:00 | — |
| 8 | What leaves the host | console + CloudWatch + GitHub | 1:00 | — |
| 9 | Close: the strip | recorded | 0:30 | — |

## Before the session (15 minutes, the day of)

1. **Reset** from the last session: `npm run demo:reset` (session token, `ZUDOCS_PROOF_PASSWORD`, `AWS_PROFILE=zudocs`).
   It ends experiments, unfreezes, puts the policies back, purges the nudge queue, restores the wire, promotes two
   fresh canonical generations and approves each on eu-west, clears the desk's records, re-seeds the inbox, bumps
   the desk Lambda's `STATE_EPOCH` and ends when every status row agrees. ~4 minutes. (RUNBOOK.md › Reset.)
2. **Wake the fleet**: `npm run airgap:up` (~6 minutes; the air-gapped host publishes its key, the puller re-seals
   the held generation, the card appears). Optional in the five-minute cut. The puller's demo cadence (a pull every
   minute instead of five) is a deploy flag (`--context demo=true`, RUNBOOK.md); the presenter's **Nudge the fleet**
   makes the wait seconds either way, so leave the deployed cadence alone.
3. **Cut the wire** for beat 7 five minutes before you start if you want the degraded card ready when you get there
   (the rule restores it after 15 minutes regardless; the desk's *Cut the wire* is the click) — or cut it live in
   beat 7 and talk for the ninety seconds it takes.
4. Open the desk, sign in, check the release bar reads `release #N · active on 3/3` (4/4 with the air-gapped host),
   no *staged*, no *FROZEN*, the inbox holds twelve tickets, the Approvals section says *nothing waiting*.
5. Open the console on the agent's board; open a terminal with the session token; keep `docs/strips/cli.txt` and
   `docs/strips/apply-window.txt` open for beat 9.
6. Rehearsal: `npm run demo:dryrun -- --skip-wire` performs every click below and asserts what you will see (25 min
   with the wire, 18 without). Run it once the day before; run the reset after it.

## The beats

### 0 — Cold open (desk, 1:00)

Click **T-1041** in the inbox, then **Run**. Eight seconds later: the triage chips (`search` · `normal`), the reply
card with the badge `reply rev-N · release #G · Nova 2 Lite`, `no experiment`, the checks strip (three ✓), latency,
tokens (`usage reported`), the cost at list price, the judge's score on this host's judge model, and the feedback
row. Say: *this app's code contains no prompt text — the desk API rendered a signed release it pulled from
AirPrompter; the model call went to Bedrock from this account.* Click **Why this text**: the rendered prompt with
each variable highlighted by where its value came from (call site · your source · default) and the ticket inside
its fence.

### 1 — Change the words, no deploy (console → desk, 3:00)

Terminal: `npm run demo:console -- change-words`. It makes a new version of the reply (one appended guidance line —
*open with the customer's name*), reviews, verifies and approves it, seals a release with that one pin changed
(the console's own warnings acknowledged — *variable_uncovered* is the daemon host reporting no names, an SDK gap),
and promotes it to dev. Read the last line: *promoted: dev is at generation G+1*.

Desk: the timeline gets `release #G+1 active` on us-east within a few seconds (the status tick) or on the next
click — click **Sync now** to make it now. The Approvals section shows **release #G+1 staged — awaiting your
approval on eu-west-1/ec2** (that host runs `unlock_required`: AirPrompter staged, nobody activated). Click
**Approve**: within five seconds the row reads *live* with the instant, the eu-west card flips to `#G+1 · active`,
the timeline says `release #G+1 activated on the desk's approval by you`. Click **Nudge the fleet**: the puller
reads the origin now; the ap-southeast card reads *exchange holds #G+1*, and with the air-gapped host up its card
follows within a minute (*last apply #G+1 from the exchange*).

Re-run **T-1041**: the reply opens with the customer's name and the badge reads `rev-N+1 · release #G+1`. Nothing
deployed.

**Hosted staging** (optional, 0:45): click **Run on staging (hosted)**. The panel shows the hosted catalogue
(staging's generation, the reply's sealed settings — `temperatureMilli 300, maxOutputTokens 600`), the subject hash
computed on the desk (the customer id never leaves), then the stream replayed at the cadence it arrived, the done
frame (arm, price in micro-dollars, the price book), the feedback filed against the run's reference, and the
OpenAI-compatible call: `temperature 1.9` and `top_p 0.1` on the request marked *ignored*, the version's sealed
settings beside them, the route's answer with its `runRef`. **On dev today the hosted run route answers `internal
(500)`** for every run (platform issue #906, a DynamoDB condition-expression bug in the meter's reservation) — the
panel shows the refusal in the route's words and the catalogue read that did work. Say so, or skip the click.

### 2 — The fleet (desk, 2:00)

Point at the four host cards. **us-east-1 · lambda**: `kms` green, policy `auto (pinned)`, `agent-sdk-ts`, the
container id and its invocation count, the `customer_tier` source. **eu-west-1 · daemon host**: `file_key` amber
(*a 0600 file beside the store — doctor warns*; click **doctor** in the presenter's eu-west shell row later to show
the warning), policy `unlock_required (local)` — *the console says auto; that setting is advisory here* — two
workers attached (Node and Python on one daemon, no key in either), the import timer. **ap-southeast-1 · puller**:
what the exchange holds, sealed to the air-gapped host's key, CDN reads vs API reads this hour. **ap-southeast-1 ·
air-gapped host**: *route out: none*, the key born on it, render probes *each filed as refused: no model here*,
exports. Say: *four shapes of the same SDK — serverless, daemon, a puller, offline — and the same signed release
on all of them.* The same-customer-same-arm point is beat 4.

### 3 — You activate, not us; the freeze (desk + console, 3:00)

The approval was beat 1: AirPrompter *stages*; the owner activates, through the desk or through `airprompter
unlock` on the host; the console can only *request* an unlock (its note shows on the row when there is one).

Now the freeze. Terminal: `npm run demo:console -- freeze`. Desk, on the next poll (ten seconds; every poll syncs
first, so every warm container tells the same story): the release bar turns red — **FROZEN — every Run refuses** —
and the ticket card carries the band. Click **Run** on any ticket: the refusal comes back as itself, `HTTP 423
frozen`, with the reason — no model was called, no cap slot taken (the check runs inside the invoke, after its sync,
so the very first click after the freeze refuses too). Say: *a signed `disable` directive is honoured by the process that syncs the moment the manifest
verifies — the Lambda stopped before anyone approved anything.* On eu-west the freeze is a generation like any
other: the daemon verified it and staged it, but the workers attached to the daemon render from the active release
until it is unlocked (the daemon hands them no standing directives — airprompter-agent-sdk#51), so the Approvals section
shows the frozen generation staged: **Approve** it, and the eu-west card reads *frozen: yes* within thirty seconds.
`npm run demo:console -- unfreeze`: the bar clears, the buttons return, a run answers on us-east; approve the
unfreeze generation and eu-west lifts it too.

### 4 — Measure (desk + console, 3:30)

Terminal: `npm run demo:console -- experiment start`. A candidate reply (one line: *close warmly*) is versioned,
sealed as a release that differs in exactly one slot, and started as an experiment at **10 %** with a ramp plan
**10 % → 50 % → 100 %**, an hour per step. Desk: **Sync now**; the us-east card gains *experiments: reply: control
90 % · candidate 10 % (step 1/3)*; the Approvals section shows the staged generation **with the ramp plan on the
row** — *one approval unlocks the whole plan; the host walks it on its own clock*. Approve it.

Click **Replay 30** (us-east runs the inbox round-robin; two to three minutes) and, with **T-1041** selected, **Run
T-1041 on eu-west-1** three or four times for different tickets. The **Experiments** panel (under the ticket)
fills: per arm — runs by host, the judge's mean, cost per run, checks, thumbs — and the stickiness line: *N
customers seen on both us-east and eu-west, every host agrees* with the customer → arm pairs. Say: *the arm is a
hash of the release's salt and the customer id, computed on each host; no coordination, and the air-gapped host's
probe landed on the same arm offline.* At 10 % the candidate is a share of *customers* (twelve seeded), so the
panel says how many landed there — one or two, sometimes none; that is what 10 % means.

Console (AirPrompter › the agent › Rollouts, or `npm run demo:console -- experiment read`): the same split
computed from the windows the hosts uploaded — runs, p50, tokens per run, the quality signal, the evaluation.
Then `npm run demo:console -- experiment triage`: a second, independent split on `support.triage` (a tighter
summary), its own salt; the panel shows two experiments and the reply/triage arm combinations differ per customer.
`npm run demo:console -- experiment dial 50`: a new generation with the candidate at 50 % (us-east takes it on
its next invoke; eu-west stages it — approve). **Replay 12**; the candidate share on the panel moves to about half.
`npm run demo:console -- experiment winner`: the candidate release is promoted; the experiment ends as *promoted*;
approve on eu-west; run **T-1041**: the badge reads the candidate's version with *no experiment*.

Feedback filed during the demo (thumbs, *sent as is*) lands on the run's window and stays in the organisation's
rollout results — say so.

### 5 — Safety nets (console + terminal, 2:30)

Each is one command; each prints the refusal as the platform gave it.

- `npm run demo:console -- drill seal-placeholder` — a reply version that uses `{{region_note}}`, which the slot
  does not declare: **the seal refuses** (`variable_undeclared: rev-N uses {{region_note}} …`). No runtime ever
  renders a literal placeholder.
- `npm run demo:console -- drill model-required` — the reply pinned, as *required*, to a model no host reports.
  The seal warns (`model_not_reported`) and seals; the promotion goes through; **us-east refuses the release** and
  keeps serving the previous generation (the sync's outcome and the card say why; AirPrompter's fleet page counts
  the instances reporting the model unavailable). **eu-west stages it instead** — the released daemon declares no
  model catalogue (`airprompterd` has no `--models`; the workers' catalogue never reaches the process that syncs —
  airprompter-agent-sdk#51), so the Approvals section shows it staged: **do not approve it**; say why. Then `npm run
  demo:console -- advance` — the next promotion stages in its place, the host settles the old row *superseded* on
  its next tick (a click on it after that is refused: `409 approval_stale`), and the reply goes back to a model the
  fleet reports.
- `npm run demo:console -- drill golden-fail` — a triage version that answers `other`/`low` whatever the ticket
  says. us-east runs the golden set before activating (five cases against Nova Micro): **1/5 is below the 80 %
  floor, so the release stays staged — under `auto`**; the card reads *golden: 1/5 · below the floor — staged, not
  activated*. eu-west stages it too (do not approve). Click **Golden set now** on the presenter panel: the active
  release passes 5/5. `advance` to move past.
- The eu-west shell row on the presenter panel (Run Command; the API queues the command and the CLI's own document
  lands on the timeline and under the buttons within seconds — `doctor` takes up to a minute): **policy show** —
  *in force unlock_required (local); the console says auto — advisory here*; **rollback** — *generation G-1 live —
  a forced downgrade, stamped on evidence*; the eu-west card reads *forced downgrade* and the fleet page shows the
  instance's forced local rollback; the host is held back until the next promotion (`advance`), which lands staged —
  approve it. **unlock**, **status** and **doctor** are there too. There is no `policy set` for that host: its daemon
  runs with `--apply-policy unlock_required`, a local policy no `policy set` loosens; the loosening drill is the
  us-east host's own **set auto / set unlock_required** (the SDK's `setApplyPolicy`, an operator's act).
- `apply --force` and `apply.window` are laptop drills, recorded: `docs/strips/cli.txt` (`rollback`, then the older
  bundle refused — *a bundle never moves a host backwards* — then `apply --force`, staged and stamped as a forced
  downgrade on a laptop store) and `docs/strips/apply-window.txt` (a release staged under `unlock_required`,
  activated by the SDK on its own when a local window opened — `window_unlock` at +71 s in the committed
  recording; the window opens on the first minute boundary at least a minute out, so the instant varies by run).

### 6 — Your data, your variables (desk, 1:30)

Click **T-1043** (Orbital Bank, enterprise), **Run**, **Why this text**: `customer_tier = enterprise` from *your
source* (the desk's customer table — the SDK asked the app at render time), `tone = formal` from the *call site*
(the desk passes it for enterprise customers; every other ticket shows *default: friendly*), the ticket inside its
`<ticket>` fence as *end_user* text. The us-east card's *variables* line names the sources this host registered
and the names no source fills. The eu-west card's line is honest: the daemon reports no names until an attached
SDK hands them over (an SDK gap, filed).

### 7 — Losing the wire (desk, 2:00)

**Cut the wire (eu-west)**: the security group loses its way out except to the desk's tables. Ninety seconds
later the eu-west card turns amber — *degraded: sync_failing*, three failures in a row, the lease shown as a
countdown (it keeps serving), the spool growing — and the timeline says `health degraded: sync_failing`. Say: *the
row you are reading arrives over the one path we left; the host serves the last verified release for the lease.*
**Restore the wire**: the next poll clears it (thirty to sixty seconds). The air-gapped host's card, meanwhile,
never had a wire: its windows reached AirPrompter by export and import (the *exports* and *imports* lines).

### 8 — What leaves the host (console + CloudWatch + GitHub, 1:00)

The us-east card's spool line (segments, bytes, last upload); AirPrompter's metrics page for the agent — rows by
prompt, version, model and arm, no text; the same windows as `Zudocs/Desk` metrics in CloudWatch (the tee sink on
the fetch port); the monthly bill (Budgets: cents so far); the public repository; the vendoring pull request with
`diff --against` in its body and the weekly *Vendored bundle* workflow green (`airprompter verify` of the committed
bundle against the pinned dev root, `telemetry validate` over a spool-writer segment, the repository's own tests
starting the real SDK against the `/testing` kit). The verify GitHub action runs there too, pinned by commit; on a
dev bundle it refuses `root_scope_mismatch` — the action has no hosted-environment input yet (SDK #50) — and the
step says so.

### 9 — Close (recorded, 0:30)

`docs/strips/cli.txt` (recorded by `npm run demo:strip` on a laptop store with the previous generation in its cache
— generation 4 beside generation 5 in the committed recording), in order: `keygen`, `pull` (plaintext), `verify`,
`pull --check --max-behind`, `diff --against` (4 → 5: one slot changed), `apply` of the older bundle then of the
current one (slots A and B), `status`, `rollback` (4 live again, `forced: true`), `status`, `unlock` (refused:
nothing staged), `policy show`, `policy set unlock_required`, `apply` of the current bundle → *staged*, `unlock
--generation 5`, `status`, `apply` of the older bundle (refused: a bundle never moves a host backwards), `apply
--force` (staged under the pin, stamped as a forced downgrade), `status`, `policy set auto`, `doctor`,
`export-telemetry`, `telemetry verify`, `telemetry validate`. A first run on a laptop with an empty cache records the
first-run form (no diff, one apply, no rollback) and says so. The opening beat in reverse:
`login` + `import` of a `prompts/` directory is how the prompts got into AirPrompter in phase 2 (docs/PROMPTS.md).

## After the session

`npm run demo:reset`. It prints what it did and ends when every status row agrees on the new generation; then
`npm run airgap:down` (the exchange keeps everything; the card fades in fifteen minutes). Twenty sessions are about
160 generations — fine. Thumbs filed during the session stay in the organisation's rollout results.

## The five-minute cut

Beats 0–3 as written, and the first half of beat 4 (start the experiment, approve, Replay 30, the panel). Skip the
hosted-staging click, the second split, the dial and the winner. 5:00.

## Honest notes

- **Hosted staging on dev**: the catalogue read, the desk-side subject hash, the variable fill and the compatible
  endpoint's *request* are real; **the hosted run route answers `internal (500)` on dev today** (the meter's
  reservation carries arithmetic in a DynamoDB condition expression: lexerio-seth/prompt-haven#906). The panel
  records the refusal in the route's words. The beat becomes a full stream + feedback + compat answer the day the
  fix lands; nothing on the desk needs to change.
- **Golden sets run on us-east, not eu-west**: the SDK runs golden sets in the process that syncs and applies; on
  the daemon host that is `airprompterd`, and the released daemon has no golden hook or window flag (an attached
  worker cannot run them for a staged release). The desk shows us-east's verdict beside the eu-west approval row.
- **A fresh us-east container during the golden-fail drill serves nothing**: its boot sync stages the failing
  release and runs the golden set, which fails, so it has no active release — every run on that container answers
  `502 no_verified_release` until `advance`. The warm containers keep serving. Do the drill quickly, or say so.
- **The cold start now includes the golden set** (five Nova Micro calls after SSM, KMS and the sync): a first request
  on a cold container can pass the API's 30-second cap and answer 503 once; the next request finds the warm
  container. Click **Sync now** before beat 0 to warm it.
- **`apply.window` is a laptop strip** for the same reason. The manifest's `unlockWindow` would reach the daemon,
  but setting one on the environment sets `unlock_required` on it (the platform refuses a window without it),
  which pins every host including the Lambda — which nobody can unlock. RUNBOOK.md says why we do not.
- **The freeze on eu-west needs the approval** of the frozen generation: the released daemon takes the directive
  when it verifies the manifest, but an SDK attached over its socket renders from the daemon's active release and
  learns nothing of a staged manifest's directives (airprompter-agent-sdk#51). The Lambda, which
  syncs itself, stops at once. The dry run tries the honest path first (sixty seconds without an approval) and
  says which path it took.
- **10 % is a share of customers.** With twelve seeded customers the candidate holds one or two of them, or none.
  The panel says which. The dial to 50 % is where the split is visible; stickiness is visible at any share.
- **The candidate is a text change with a real effect** (a warmer closing line); the judge and the checks are the
  same on both arms, so the measure is honest and small. Cost per arm on the desk is list price from the reported
  tokens; AirPrompter's rollout page reports tokens, not money.
- **`telemetry verify`** in the strip runs at a 4 MiB budget: at 1, 2, 8, 10 and 16 MiB the released CLI reports
  its own invariant as violated by less than one segment (SDK #49); the strip shows the run that holds and links
  the issue.
- **The compatible endpoint's answer carries no inference block**; the version's sealed settings come from the
  hosted catalogue and the panel says so. The caller's parameters are named on the route's own log line.
