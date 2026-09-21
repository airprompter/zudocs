# Architecture

Zudocs is one AWS account, three regions, three host shapes, one AirPrompter organization. The prompts
are the product's brain and none of them are in this repository.

```
                     AirPrompter (api.airprompter.com, the CDN edge)
                        ▲ heartbeat · manifest · telemetry grants        ▲ pointer, root.json
                        │                                                │
   us-east-1            │              eu-west-1                         │           ap-southeast-1
   ┌────────────────────┴───┐          ┌──────────────────────────┐      │    ┌──────────────────────────┐
   │ desk API (Lambda)      │          │ t4g.micro, no inbound    │      └────┤ puller (Lambda, schedule)│
   │  SDK on_invoke, auto   │          │  airprompterd (daemon)   │           │  pointer-first pull      │
   │  KMS store key         │          │  Node worker (Luna, wrap)│           │  → releases table        │
   │  key from SSM at start │          │  Python worker (LiteLLM) │           │  → exchange bucket (S3)  │
   │  tee sink → AP + EMF   │          │  unlock_required, file_key│          └────────────┬─────────────┘
   │  approvals: desk grants  │
   └──────────┬─────────────┘          │  imports airgap exports  │                        │ S3/DynamoDB gateway endpoints
              │                        └──────────────────────────┘           ┌────────────▼─────────────┐
   CloudFront ▼ landing (S3)                                                  │ air-gapped t4g.micro      │
   desk.zudocs.com (React) · Cognito                                          │  offline, vendored bundle │
   status table · events table (DynamoDB, every host writes)                  │  keypair born on the host │
                                                                              │  export-telemetry → bucket│
                                                                              └───────────────────────────┘
```

Phase 1: the hosted zone and mail records, the landing page, sign-in, the budget, the trail, the CI deploy role.
Phase 2: the prompts in AirPrompter (`PROMPTS.md`), the local registry seed and the laptop smoke.
Phase 3: the us-east-1 host and the desk (`DESK.md`) — the API, its tables and key, the app, the Budgets action.
Phase 4: the eu-west-1 host (`EU-WEST.md`) — `airprompterd` with a Node and a Python worker attached, the approvals
table and page, the wire function and its restore rule; the reply and escalation slots re-pinned to Nova 2 Lite
while Luna is gated (generation 2 on dev, the first change that reached every host).
Phase 5: ap-southeast-1 (`FLEET.md`) — the puller (pointer-first `pullBundle` into a releases table and an exchange
bucket, the nudge queue as the change-notification placeholder), the air-gapped host on demand (no route out; gateway
endpoints; the SDK offline on a vendored bundle, `applyBundle` from the exchange, a distribution key born on the host,
render probes filed as refusals, `export-telemetry` to the bucket) and the import timer on eu-west that carries the
exports to AirPrompter; the desk's two new cards, the nudge, and the us-east status tick.
The full plan, its reviewers' findings and the demo script live with the AirPrompter team; the phases land here
one pull request at a time.

## Phase 6: the story

The desk gained the presenter's drills (a hosted staging run through AirPrompter's execution with a run key read
from SSM by name; an allowlisted `zudocs-cli` command on the eu-west host through the desk's own Run Command document
targeted by the instance's Name tag; this host's own apply policy through the SDK; the golden set on demand; the reset's clearing
step), the per-arm fold of its own records (`GET /arms`) with the stickiness table, the ramp plan on an approval
row (read by us-east from the same signed manifest), and the freeze as the SDK reports it (a `disable` directive:
every run refuses with HTTP 423 before a cap slot is taken). The us-east host runs golden sets before activating a
staged release (`golden.invoke`, T34) — a failing set leaves the release staged under `auto`. The scripts:
`demo-console` (the console's acts over the workspace API with a session token), `demo-dryrun` (the nine beats
asserted against the live deployment), `demo-reset` (reset means advance), `strip.sh` (the recorded CLI drills,
scanned for anything key-shaped), `vendor.sh` (the vendoring pull request from the `zudocs-ci` Agent — a separate
Agent with one placeholder slot, so the one committed bundle carries no Zudocs prompt), and the weekly *Vendored
bundle* workflow (credential-less: `verify`, the verify action pinned by commit, `telemetry validate`, the tests
that start the real SDK against the `/testing` kit). DEMO.md and RUNBOOK.md are the two faces.

## Phase 8: the steady state

The deployment idles for pennies and wakes for a session. The eu-west host is stopped every night by an EventBridge
Scheduler schedule invoking the **power function** (`services/eu-host/src/power.ts`: `StopInstances` / `StartInstances`
on the one instance carrying the host's Name tag, a five-minute tick that reconciles the status row's `power` marker
with what EC2 says) and started only by the owner — the desk's *Wake the fleet* or `npm run host:wake`; the card reads
*asleep since …* from the marker rather than a stale, degraded host, and the daemon re-reads its Agent key from SSM at
every start while the store stays on the root volume (the generation survives; a promotion made meanwhile lands
staged). The **demo-mode switch** (one SSM String the desk writes for at most four hours and both workers read every
minute, fail-closed: no expiry is off) turns the idle cadence — a ticket an hour on the Node worker, every two hours
on the Python worker — into one every two and five minutes for a session; the schedule's sleep is refused while it is
on. `npm run cost:report` and the monthly **cost check** (`services/cost-check`, a Lambda on a Scheduler schedule)
share one Cost Explorer query (`scripts/lib/cost.mjs`): by service and by day, the budget, fixed vs variable, the
expected month; the check files `cost/YYYY-MM.json` in the trail bucket and puts `Zudocs/Cost` metrics.
`npm run teardown` deletes every stack in the order they can be (`scripts/lib/teardown.mjs`) and lists what
CloudFormation leaves, with the commands; its dry run is the reviewed form. docs/COST.md has every line.

## Invariants

- Only public packages, the released CLI, the public root key, keys from the console.
- Keys travel by environment or SSM SecureString, read at cold start; never argv, never git, never logs.
- Nothing on the desk is invented: every value comes from the SDK's `Rendered`, `observe`, `checks`,
  `healthz` and `status`. At a spend cap the desk refuses visibly.
- No prompt text in git; `prompts/` is seeded and ignored.
- No inbound port on any host; hosts push their status to a table and the desk reads the table (the air-gapped host
  pushes a document to the exchange bucket and the puller mirrors it — a host with no route out cannot reach a table
  in another region; its only inbound is port 22 from the Instance Connect Endpoint's own group).
- A host that cannot call a model does not pretend to: the air-gapped host's observations are refusals.
- The console stages; the customer activates. Under `unlock_required` a release goes live only through the desk's
  Approvals page (the owner) or an operator's `unlock` on the host — never through AirPrompter.
- Reset means advance: generations are monotonic, a rollback is a forced downgrade held back until something newer
  is promoted, a tightened policy is loosened only on the host. `npm run demo:reset` is that rule as a script.
- The one bundle in git is the `zudocs-ci` Agent's placeholder (`vendored/`, `scripts/check-vendored.mjs`); the
  strips under `docs/strips/` are scanned for anything key-shaped before they are written.
- Nothing starts a host but a person: the nightly schedule only stops the eu-west host, and refuses to while demo
  mode is on or the wire is cut; the power function's IAM stops and starts instances carrying the host's Name tag
  and nothing else (no terminate, no launch). A switch that could cost money expires on its own (demo mode: four hours).
- Nothing typed on the desk reaches a shell: the host CLI is an allowlist of exact command lines, sent as the one
  parameter of the desk's own Run Command document (allowed values = the allowlist, a fixed shell line); the desk's
  role may send no other document — never `AWS-RunShellScript`. The CLI's output is scanned for anything key-shaped
  before it is stored.
