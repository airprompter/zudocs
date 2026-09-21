# Runbook

The operator's side of the demo company: where every key lives and how to rotate it, the drills the CLI runs,
how to replace a host, the reset, the vendoring pull request, the weekly workflow — and, since phase 8, the steady
state: the eu-west host asleep at night and woken for a session, the demo-mode cadence switch, the cost report, the
monthly cost check and the teardown. DEMO.md is what the presenter does; this is what keeps it true. Every command here takes secrets from the environment or from SSM by
name — never argv, never git, never a log, never a GitHub secret.

## Keys, exactly

| Secret | Lives | Written by | Read by | Rotate |
|---|---|---|---|---|
| Agent key, dev (`zudocs-support`) | SSM SecureString `/zudocs/dev/agent-key` in us-east-1 (`alias/zudocs-desk`), eu-west-1 and ap-southeast-1 (`alias/aws/ssm`); the owner's `~/.config/zudocs/dev.env` (0600) | `scripts/ssm-put-agent-key.sh` from the env file, per region | us-east: the desk Lambda at cold start; eu-west: `zudocs-agent-key` into `/etc/airprompter/airprompterd.env` at every daemon start; ap-southeast: the puller at cold start | mint a second key in the console (two live per target), put it in all three regions, restart the daemon (`sudo systemctl restart airprompterd` through Run Command) and bump the desk Lambda's `STATE_EPOCH` (a new container reads the new value), revoke the old one |
| Staging run key (`agent_run`, staging) | SSM SecureString `/zudocs/staging/run-key` in us-east-1 (`alias/zudocs-desk`) only | the owner: mint in the console (Settings › Keys › run key, target staging), write the put-parameter document to a 0600 temp file outside any repository, `aws ssm put-parameter --cli-input-json file://…`, delete the file | the desk Lambda on the first *Run on staging* | mint, put, bump `STATE_EPOCH`, revoke |
| CI vendoring agent's key (`zudocs-ci`, dev) | the owner's `~/.config/zudocs/ci.env` (0600) only — never SSM, never CI | the console | `scripts/vendor.sh` on the owner's laptop | mint, replace the file, revoke |
| Session token (`airprompter login`) | the environment for the length of a terminal | `airprompter login` (password from `AIRPROMPTER_PASSWORD`) | `demo:console`, `demo:dryrun`, `demo:reset`, `prompts:seed` | expires in about an hour; log in again |
| Proof user's password (`proof@zudocs.com`) | the owner's password store; `ZUDOCS_PROOF_PASSWORD` in the environment | `scripts/cognito-users.sh proof` | the proofs, the dry run, the reset (they sign in through the `proof` client) | `cognito-users.sh proof` again with a new password |
| Store keys | us-east: a data key wrapped by KMS `alias/zudocs-desk`; eu-west and the air-gapped host: `file_key` (0600, shown amber) | the SDK | the SDK | replace the store (a new container / instance) |
| Distribution key | born on the air-gapped host (`airprompter keygen --purpose distribution`, 0600); the public half in the exchange bucket under `keys/` | the host's first boot | the puller seals to it; the host opens with it | `airgap:down` / `airgap:up` — a new host is a new key; the puller re-seals |
| Public root JWKs | `keys/dev.root.jwk.json` in git (prod at the cutover) | the platform's ceremony | every host, the verify workflow, the verify action | commit the new document; hosts accept a rotation signed by the old key |

Nothing else is a secret: `airprompter.config.json` carries identifiers (organisation, workspace, agents, the
hosted run URL, the edge pointer); the desk's `config.json` carries the pool and client ids of a public PKCE client.

## The drills, by command

All against dev; the CLI is `.bin/airprompter` (`docs/PROMPTS.md` says how to install and verify it). `set -a;
. ~/.config/zudocs/dev.env; set +a` puts the Agent key in the environment first; the strip (`npm run demo:strip`)
runs every one of these for real and records the output to `docs/strips/`.

```sh
# a laptop store in a scratch directory (the strip does this; the commands take --state-dir)
airprompter pull --org … --agent … --environment dev --hosted-environment dev --root keys/dev.root.jwk.json \
  --root-url https://…/roots/dev/root.json --base-url https://api-dev.airprompter.com --plaintext --out current.apbundle
airprompter verify current.apbundle --org … --agent … --environment dev --hosted-environment dev --root keys/dev.root.jwk.json
airprompter pull … --out current.apbundle --check --max-behind 1      # exit 3 when the vendored bundle is stale
airprompter diff current.apbundle … --against previous.apbundle       # the block a vendoring PR carries
airprompter apply current.apbundle … --state-dir ./state              # activated under auto; staged under unlock_required
airprompter status … --state-dir ./state
airprompter policy show … --state-dir ./state
airprompter policy set unlock_required … --state-dir ./state --by "a ticket id"
airprompter unlock … --state-dir ./state --generation N               # the operator's activation, by generation
airprompter rollback … --state-dir ./state                            # the other slot; forced when it goes below the stored generation
airprompter apply previous.apbundle … --state-dir ./state --force     # a forced downgrade, stamped on evidence
airprompter doctor … --root keys/dev.root.jwk.json --base-url … --edge-pointer-url … --state-dir ./state
airprompter export-telemetry … --state-dir ./state --out laptop.aptelemetry
airprompter telemetry verify --budget 4194304 --sink-absent           # SDK #49: other budgets report a false violation
node scripts/ci-telemetry-validate.mjs                                # a spool-writer segment through telemetry validate
node scripts/strips/apply-window.mjs --state-dir ./window             # apply.window: staged, then activated by the SDK when the window opens
```

On the eu-west host the same commands run as the daemon's user through `zudocs-cli` (`sudo zudocs-cli status
--json`, `doctor`, `unlock`, `rollback`, `policy show`) — through Session Manager's Run Command from a laptop
(`npm run eu:proof -- --cli "policy show"`), or one click on the desk's presenter panel (the *eu-west shell* row:
`policy show`, `status`, `doctor`, `unlock`, `rollback` — an allowlist; the API queues the command as a job the
Lambda hands itself and the CLI's document lands on the timeline, because the HTTP API caps an integration at 30 s;
the Lambda's role may send exactly one Run Command document — the eu-west stack's `zudocs-desk-host-cli`, whose one
parameter's allowed values are that allowlist and whose shell line is fixed, so SSM refuses any other value before it
reaches the host — and only to the instance carrying the `zudocs-eu-host` Name tag; never `AWS-RunShellScript`. The
CLI's stdout and stderr go through the strips' key-shaped scan before the row is written; a hit is redacted and the
row says so). Not on the list: `apply` (the daemon owns that store; a second writer is not a drill) and `policy set` (the
daemon runs with `--apply-policy unlock_required`, a local policy the CLI's `policy set` does not loosen — the
loosening drill is the us-east host's own `setApplyPolicy`, the presenter's *set auto*).

The console's acts (`npm run demo:console -- <act>`): `board`, `change-words`, `experiment start|triage|dial
<pct>|winner|end|read`, `freeze|unfreeze`, `drill seal-placeholder|model-required|golden-fail`, `advance`,
`staging promote`. Each is the workspace API call the console itself makes, with the session token from the
environment.

## Hosted staging

The staging environment runs in AirPrompter's hosted mode (`executionMode: managed`, set once from the console or
`POST …/environments/staging/mode`). The desk reaches it with a run key bound to staging and the run route's origin
(`hostedRunUrl` in `airprompter.config.json` = the execution stack's `AgentRunUrl`; the console shows it on the
environment's settings). `npm run demo:console -- staging promote` seals the current dev pins for staging and
promotes them (a release is content-addressed, so the digest matches dev's). The desk's *Run on staging* does the
stream, the feedback and one OpenAI-compatible call and records what the route answered. **On dev today every
hosted run answers `internal (500)`** (lexerio-seth/prompt-haven#906); the catalogue read works. Re-run `npm run
demo:dryrun -- --hosted` after the fix lands; the assertion becomes the full run.

## Replacing a host

- **us-east (Lambda)**: nothing to replace; a new container is a new store. `STATE_EPOCH` (the reset bumps it
  through `UpdateFunctionConfiguration`; a later deploy that touches the function puts the stack's value back, which
  is also a new container) forces every container to start from an empty state directory.
- **eu-west**: any change under `services/eu-host/` or to its `pins.json` replaces the instance on the next deploy
  (`CONTRIBUTING.md`). A fresh instance is a fresh store: its first release lands **staged** under
  `unlock_required` — approve it on the desk (`npm run eu:proof -- --approve` proves it). The sticky flags from a
  rollback drill (SDK #45/#46) go with the old store.
- **the air-gapped host**: `npm run airgap:down` then `npm run airgap:up` (~6 minutes); a new host is a new
  distribution key and the puller re-seals the held generation to it — no promotion needed. Never deployed by CI.
  While it is down no distribution key is published, and the puller writes plaintext bundles to the (private)
  exchange bucket — allowed on dev only; the SDK refuses plaintext on any other target.
- **the puller**: a Lambda; redeploys with `ZudocsFleet`. Its state row (`puller#…`) in the releases table carries
  the backoff and the pointer etag; deleting it is a fresh start.

## Reset means advance

`npm run demo:reset` (session token, `ZUDOCS_PROOF_PASSWORD`, `AWS_PROFILE=zudocs`; `--dry-run` says what it would
do). In order: end every live experiment (roll back to the control — a new generation without the split), unfreeze,
put the us-east host's policy back to `auto` (`setApplyPolicy` through the SDK; the eu-west daemon's policy is its
unit's flag and no drill changes it), wait for a replay in flight, purge the nudge queue and wait the minute SQS asks
for, restore the wire, promote two fresh canonical
generations (the canonical pins in `airprompter.config.json` › `canonical`, the escalation summary's output cap +1
each time — a real change, so each seals to a new digest; a store then holds two releases and `rollback` has
somewhere to go) and approve each on eu-west, nudging the fleet after each, clear the desk's runs, feedback,
approvals, events and counters and re-seed the inbox, bump the desk Lambda's `STATE_EPOCH`, then wait until every
reporting status row is at the last generation (the air-gapped host counts only while it is up). Idempotent:
every step reads first and says *found* or *did*; an eu-west row already at the generation, or already settled,
counts as done. Twenty sessions ≈ 160 generations.

What it does not do, on purpose: restore an old generation (anti-rollback), loosen a pin from the console (a
manifest may only tighten), or delete the organisation's rollout results (thumbs filed during a session stay).

## The vendoring pull request

The public repository commits one bundle: `vendored/zudocs-ci.dev.apbundle`, the `zudocs-ci` Agent's single
placeholder slot (`ci.vendoring`), plaintext because dev allows it and because its only text is the placeholder —
`scripts/check-vendored.mjs` refuses any other agent or slot, and the Zudocs support prompts are never vendored.

```sh
set -a; . ~/.config/zudocs/ci.env; set +a           # the CI agent's key, not the support agent's
npm run vendor                                       # pull → vendored/, verify, diff --against the committed bundle
git checkout -b vendor/gen-N && git add vendored/ && git commit                   # the diff block in the message
gh pr create --body-file <the diff block>            # the Vendored bundle workflow runs on the PR
```

The vendored bundle expires (`notAfter`, 90 days from the pull): the weekly job goes red the week it does — that is the
point — and `npm run vendor` on a fresh pull request is the fix. The weekly workflow (`.github/workflows/vendored.yml`, Mondays 06:17 UTC and on every change under `vendored/`)
downloads the released CLI (digest pinned in the workflow), runs `airprompter verify … --hosted-environment dev`
against `keys/dev.root.jwk.json`, checks the bundle is the CI agent's, runs the verify GitHub action pinned by
commit (`continue-on-error` until it accepts a hosted environment — SDK #50 — the direct verify step is the gate),
`telemetry validate` over a spool-writer segment, and `npm test`. `pull --check --max-behind` needs the Agent key,
so it is the owner's: `npm run vendor -- --check` (exit 3 when the committed bundle is behind).

## Sleep and wake (the eu-west host)

The eu-west host is put to sleep every night and woken for a session — the plan's "compute → near zero" (docs/COST.md).

- **The schedule**: EventBridge Scheduler `zudocs-eu-host-sleep`, `cron(0,20,40 10 * * ? *)` UTC (three idempotent
  attempts twenty minutes apart at ten in the morning UTC — night on both US coasts; the owner's sessions cluster
  00:00–08:00 UTC), invoking the power function `zudocs-power` with `{ action: "sleep", by: "the nightly schedule" }`.
  **No schedule starts the host.** The schedule's sleep is refused while **demo mode is on** (a session is never
  stopped by a clock; demo mode lapses on its own after four hours) and while the **wire is cut** (the rule restores
  the wire within fifteen minutes; the next of the three attempts sleeps — a refusal of the last one at 10:40 means
  the host stays awake until the next morning, about $0.34: click *Sleep* when a session ends) — each refusal is a
  `power` row on the timeline.
- **Wake**: the desk's presenter panel, *Wake the fleet* — or `npm run host:wake -- --wait` from the owner's profile,
  which returns when the host's row is fresh and both workers report (about three minutes: EC2 start ~30 s, the
  daemon's `ExecStartPre` re-reads the Agent key from SSM, the workers wait for the socket and re-attach, the row
  is written). The store is on the root volume, so the generation is what it was; a promotion made while the host
  slept lands **staged** under `unlock_required` — the Approvals section shows it, approve it.
- **Sleep**: *Sleep* on the panel, or `npm run host:sleep`. A ticket in flight on the host is lost (the cap slot stays
  taken). `npm run host:status` prints EC2's state, the marker and the row.
- **What the card says**: the row's `power` marker — `going to sleep`, `asleep since …`, `waking`, `started, the
  workers are coming up` — with a dashed border; never *stale* or *degraded* for a host that is off. The marker is
  written by the power function (a sleep or a wake at once; the tick every five minutes reconciles it with what EC2
  says, so a host stopped or started outside the desk is shown as it is), and a desk poll that finds the marker in
  transition past twenty seconds asks the function to look now. The host CLI row answers `409 host_asleep` while the
  host sleeps instead of timing out on Run Command.
- **The address changes on every start** (no Elastic IP is allocated — nothing to pay for while asleep). Nothing
  depends on it: the group has no inbound rule, Run Command targets the instance by its Name tag, the wire's rules are
  by destination, every call the host makes is outbound.
- **Before a reset or a dry run**, the host must be awake: `npm run demo:reset` checks the marker first and stops with
  the wake command when it is not. The **IAM** of the power function: `ec2:StartInstances` / `StopInstances` only on
  instances carrying the `zudocs-eu-host` Name tag (a replacement in progress — two instances with the tag — is
  refused), read-only describes, the demo-mode parameter, the status row's marker and the timeline.

## Demo mode (the eu-west workers' cadence)

Idle, the eu-west workers run one inbox ticket an hour (Node) and every two hours (Python) — cents a day (docs/COST.md).
**Demo mode** drops that to every two and five minutes so the eu-west card moves while a prospect watches: the
presenter panel's *demo mode on* (or `npm run demo:mode -- on`) writes the SSM String `/zudocs/dev/demo-mode` in
eu-west-1 — `{"mode":"on","until":<now + 4 h>,"by":…}` — which both workers read every minute; *off* (or
`demo:mode -- off`) writes off. The rules are fail-closed (`services/desk-api/src/demoMode.ts`): on only while the
document parses, says on and its `until` is ahead and within four hours; a lapsed, missing, overlong or unreadable
document is off, with the reason on the eu-west card's *cadence* line. A read that fails (throttled, refused) keeps
the last reading and says so on the card. Switching on is felt within two minutes (the next ticket is pulled forward);
switching off lets the ticket already due run. The parameter is created *off* by `ZudocsSharedHost`; the desk's
writes drift it from the template on purpose, and CloudFormation rewrites it (to off) only when that resource's own
properties change — or the stack's tags (`app.ts`), which every taggable resource carries. The puller's demo cadence
is separate and stays a deploy flag (below).

## The cost report, the monthly check, the budget

```sh
AWS_PROFILE=zudocs npm run cost:report                # last 7 / 30 days by service and by day, the budget, fixed vs variable, the expected month
AWS_PROFILE=zudocs npm run cost:report -- --write     # and docs/COST.md's numbers section (between its markers; the explanations are hand-written)
```

One Cost Explorer query a run ($0.01 a page; the seven-day fold comes from the thirty-day answer). The **monthly
check** (`services/cost-check`, `zudocs-cost-check` in us-east-1) runs on the third of the month at 06:00 UTC (Cost
Explorer settles a day about a day late; by the third every day of the previous month is in, though amounts are
refined until the bill is finalised) from the Scheduler schedule
`zudocs-cost-check-monthly`: the
previous month by service and by day, the last seven days, the budget → `cost/YYYY-MM.json` in the trail bucket
(RETAIN; the trail's 90-day expiry covers only its own `AWSLogs/` prefix) and the metrics `Zudocs/Cost`
`expectedMonthlyUsd`, `monthUsd` (dimension `month`) and `budgetActualUsd`. By hand:
`aws lambda invoke --function-name zudocs-cost-check --payload '{"month":"2026-09"}' /dev/stdout` (a month still
running is filed up to yesterday and marked `partial`). The budget `zudocs-monthly` ($30; e-mail at 100 % and
166 %, forecast at 100 %, the Bedrock deny action at 100 %) and the anomaly monitor e-mail on their own — no
GitHub workflow is involved, because a scheduled workflow would need cloud credentials in the repository.

## Teardown

Owner-only, never from CI (`scripts/teardown.mjs` refuses under `CI`):

```sh
AWS_PROFILE=zudocs npm run teardown -- --dry-run     # the plan against the live account: nothing is deleted
AWS_PROFILE=zudocs npm run teardown                  # type the account id when asked; ~25 minutes
```

The stacks go in the order they can: `ZudocsAirgap` (if present), `ZudocsDesk` (it imports the site's certificate
and user pool and names the eu-west role, the wire and power functions and the nudge queue), `ZudocsFleet`,
`ZudocsSharedHost` (the instance is terminated, its volume with it), `ZudocsSite` (it imports the zone), `ZudocsDns`,
`ZudocsCi` (the deploy role, last) — straight through CloudFormation (`DeleteStack` + wait), so no build, no synth
and no `BUDGET_EMAIL` are needed. Then the plan lists **what `cdk destroy` leaves**, each with the exact commands:
the hosted zone (RETAIN — repoint the registrar first), the Cognito pool (RETAIN, deletion protection on), the
exchange bucket (RETAIN, versioned: every version and delete marker), the trail bucket (RETAIN), the SSM
SecureStrings the owner wrote (the Agent key in three regions, the staging run key — and revoke both keys in the
console), the KMS key pending deletion (30 days, $1/month until then), the log groups the custom-resource providers
created, the `CDKToolkit` bootstrap in three regions (not Zudocs's own — only when the account is being emptied),
the GitHub OIDC provider (only if `ZudocsCi` created it), and the reminders outside this account: the registrar's
name servers back to the management account's zone, the SES forwarder and the delegation record in the management
account, and the laptop's `~/.config/zudocs/*.env`.

## The puller's demo cadence

The puller pulls every five minutes (one CDN read when idle); `--context demo=true` on a `ZudocsFleet` deploy makes
it one minute. The presenter's *Nudge the fleet* makes any wait seconds, so the deployed cadence stays at five.
The air-gapped host costs while it is up (`airgap:up` before a session, `airgap:down` after); everything else is
on-demand tables, one `t4g.micro` (asleep at night), a handful of Lambdas and the desk's CloudFront — docs/COST.md
has the lines and `npm run cost:report` the numbers.

## When something is wrong

- The eu-west card reads *asleep since …*: the nightly schedule; *Wake the fleet* (or `npm run host:wake -- --wait`).
  *started, the workers have not reported* for more than ten minutes after a wake: the boot did not come back —
  `npm run eu:proof -- --cli status` through Run Command, or the host's log group `/zudocs/eu-host`.
- The host would not sleep (a `power` row says `refused: wire_cut` or `demo_mode_on`): restore the wire, or wait for
  demo mode to lapse (four hours) or switch it off; the next of the morning's three attempts sleeps, or tomorrow's —
  click *Sleep*. `several_instances` is a replacement in progress — wait for it.
- The eu-west card's *cadence* line says the switch could not be read: the host's role reads the demo-mode parameter
  by name; the last reading stands. `(expired)` beside *demo mode off* is normal — the four hours are up.
- The release bar reads *FROZEN* and nobody froze: `npm run demo:console -- board` shows `frozen`; `unfreeze`.
- us-east stays *staged* after a promotion: the golden set failed (the card's *golden* line); `advance`.
- eu-west shows *forced downgrade*: a rollback drill; the next promotion carries it forward (`advance`, approve).
- eu-west shows *staged* and nobody approved: the Approvals section; a fresh instance always starts this way.
  After the golden-fail drill the staged row is the release the golden set failed on us-east — do not approve it;
  `advance` (the next staging settles the row *superseded* on the host's next tick; a click on it after that is
  refused). The model-required drill leaves no row: the seal refuses it (`model_not_in_catalog`).
- us-east answers `502 no_verified_release` on every run: a fresh container booted while the golden-failing release
  was promoted and has nothing active; `advance`, then **Sync now**.
- The puller says `agent_key_unreadable`: the ap-southeast-1 parameter is missing (`ssm-put-agent-key.sh` with
  `AWS_REGION=ap-southeast-1 ZUDOCS_SSM_KEY_ID=alias/aws/ssm`).
- *Run on staging* answers `hosted_not_configured`: the stack has no run URL (`airprompter.config.json`) or the
  parameter is missing; `internal (500)` is the platform's (#906).
- A drill's command answers `stale_state_revision`: someone else moved the environment; run it again.
