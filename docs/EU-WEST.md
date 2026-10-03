# The eu-west host: a telemetry daemon, two workers, and the approval that makes a release live

Phase 4 is the second production host and the second host shape: one small EC2 instance in eu-west-1. Each worker
loads its own release (resident sync, Agent key injected by systemd). `airprompterd` ships the spool and holds no
store. It is the host that shows the resident SDK, `file_key` honestly, the `unlock_required` policy pinned on the
worker and granted from the desk's Approvals page, the operator's CLI (`status`, `doctor`, `unlock`, `rollback`,
`policy`), and the "losing the wire" drill. This page is the tour: what is where, how the approval flows, what the
boot does, and the honest notes.

## The host (`services/eu-host`, `infra/lib/shared-host-stack.ts`)

| Piece | What it is | Where |
|---|---|---|
| Instance | `t4g.micro`, Amazon Linux 2023 arm64, IMDSv2 required, 8 GiB gp3 encrypted, a public IPv4 for egress; one public subnet, no NAT, no endpoints; a security group with **no inbound rule** (Session Manager only, through the instance role) | `shared-host-stack.ts` |
| `airprompterd` | Telemetry only (`protocol/daemon.md` at SDK 0.3.0): `--org`, `--agent`, `--environment`, dev `--base-url`, `--json`. The Agent key in `/etc/airprompter/airprompterd.env` (root:root 0600, written from the eu-west SSM SecureString by `zudocs-agent-key` before every start) is an upload grant. The executable is pinned to `cli/v0.3.0` by digest | `host/units/airprompterd.service`, `host/bin/zudocs-agent-key` |
| Node worker | `@airprompter/agent-sdk` 0.3.0 in resident mode, with the Agent key systemd injects and `apply.policy: "unlock_required"`. The first staged release is held inside `start()` until the desk approves; later ones are `ap.unlock()`. Tickets run through the same `runTicket` the us-east host uses: `support.triage` and `support.reply` on the release's models through Bedrock in us-east-1, the judge, the checks; feedback from the SDK's own check verdicts; the record in the runs table with `host: eu-west-1/ec2`, under the fleet's shared daily cap | `src/worker.ts` |
| Approvals | The `ApprovalWatcher`: a staged generation → a row in the approvals table → the owner's decision on the desk → `ap.unlock()` on this process's store → the row settled and the host card flipped (below) | `src/approvals.ts` |
| Status | Every 30 s: this process's `status()` and `healthz()` written as the host's row; every health transition is a timeline row. `healthz.telemetry` says whether the daemon is shipping the spool | `src/statusRow.ts` |
| Python worker | `airprompter-agent` 0.3.0 (installed by the pinned commit; PyPI also carries the release) in resident mode with its own store under `/var/lib/airprompter/python`. It stages a release under `unlock_required` and unlocks it when a fresh Node status says that generation is active after desk approval. It writes to the daemon's shared telemetry spool; `support.reply` runs through LiteLLM to Bedrock's Converse API with the instance role, the SDK's LiteLLM callback, the declared checks, its own record in the runs table and its own part of the status row (`python`) | `host/pyworker.py` |
| The wire | A Lambda (`zudocs-wire`) that replaces the group's open egress with HTTPS to DynamoDB in us-east-1 only (cut) or puts it back (restore); an EventBridge rule every five minutes restores a cut older than 15 minutes whatever the presenter forgot; every change is a timeline row | `src/wire.ts` |
| Logs | The units append JSON lines to `/var/log/zudocs/*.log`; the CloudWatch agent ships them to `/zudocs/eu-host` (seven days). Never a render, a ticket or an answer | `host/cloudwatch-agent.json` |
| The operator's CLI | `zudocs-cli <command>`: `airprompter <command>` as the airprompter user, scoped to this host, on the worker's store — `status`, `doctor` (with the key in its environment, from the root-only file), `unlock`, `rollback`, `policy show|set`, `diff`, `export-telemetry`. The pinned binary is `cli/v0.3.0` | `host/bin/zudocs-cli` |

Everything the stack installs is pinned in `services/eu-host/pins.json` (the CLI's digest, the Python SDK's
commit, the AL2023 arm64 image per region) and rendered by `npm run build` into `dist/bundle/` — the worker bundled
by esbuild, the units, the helpers, `zudocs.env` (identifiers and table names, never a key; the build refuses a
key-shaped value) and `requirements.txt`. The stack ships the bundle as an asset the instance downloads at boot; a
change to the bundle, the boot script or the pinned image replaces the instance (`userDataCausesReplacement`),
because the host is cattle: its store is rebuilt from one sync — which, under `unlock_required`, lands the current
release *staged*, so every replacement ends with an approval on the desk (the watcher opens a fresh row: the row's
id carries the worker's store id). For a minute or two both instances run with the same key; both write the same
status row and mind approvals, and the older one's rows are settled `superseded` by the new one's reconcile. The
image is pinned rather than resolved at deploy so an AL2023 refresh cannot replace the host as a side effect.

## Keys, exactly

One dev Agent key exists on the host. Systemd injects it into the telemetry daemon and both SDK workers. The owner writes it once
in eu-west-1 as an SSM SecureString under the AWS-managed SSM key (no KMS key of ours in the region):

```sh
set -a; . ~/.config/zudocs/dev.env; set +a
AWS_PROFILE=zudocs AWS_REGION=eu-west-1 ZUDOCS_SSM_KEY_ID=alias/aws/ssm bash scripts/ssm-put-agent-key.sh
```

The instance role may read that one parameter by ARN — not `AmazonSSMManagedInstanceCore`, which would also grant
`ssm:GetParameter` on every parameter in the account; Session Manager and Run Command are granted by their own
actions. `zudocs-agent-key` reads it into `/etc/airprompter/airprompterd.env` (0600, root) through a 0600 temporary
and an atomic rename, as `ExecStartPre=+…` of the daemon's unit, so a rotated parameter is live at the next
restart; the file is optional to systemd (`EnvironmentFile=-`), so a host booted before the parameter exists keeps
retrying it at every daemon start instead of never starting. The boot installs and enables the units and the
CloudWatch agent *before* it fetches the key, so a missing parameter leaves the units retrying. The shared
`zudocs.env` carries identifiers only; the root-only key file is injected into each unit by systemd. User data never
carries a key (the stack's test pins it).

The workers and daemon run as the same local user and share the spool. This is one trust boundary: the workers are
this repository's code, and each needs its own key to sync its release. The import timer receives the key as a
systemd credential; the key file remains root-only on disk.

Each worker's store key is a **file** (`store.key`, 0600, next to its store), so the host reports
`storageProtection: file_key` and the host card shows it in amber.

## The approval, step by step

1. AirPrompter promotes generation N. The worker's next poll (30 s) verifies it and, under `unlock_required`,
   stages it: `applyState: awaiting_unlock`, `stagedGeneration: N`. On a fresh store `start()` returns at
   generation 0, leaving the staged release visible to the approval watcher.
2. The watcher opens the row `eu-west-1-ec2-gN-<store id>` (`pending`; created once — a restarted worker on the
   same store resumes it, a replaced instance gets a fresh one) and writes `release_staged` to the timeline. The desk's Approvals section shows *release #N · staged — awaiting your
   approval on eu-west-1/ec2*, with the console's request note if the worker received one.
3. The owner presses *Approve*: `POST /approvals/{id}/approve` flips `pending → approved` exactly once
   (a conditional write; a second press, another tab, another container answers `already: true` with the row as it
   stands) under the signer's e-mail, and writes `approval_decided`.
4. The watcher's next tick (5 s) sees `approved` and calls `ap.unlock()`. The store flips, the row settles
   `activated`, and the timeline writes `release_activated … by seth@zudocs.com`. The card flips to `#N · active`.
5. If an operator unlocked the worker's store on the host instead (or a window opened, or a rollback moved
   the generation), the staged generation vanishes without the watcher's unlock: the row settles `superseded`
   with the reason and the timeline says `activated on the host`. If the console promoted again before anyone
   decided, the worker stages the newer generation in place of the old one: the watcher settles the old row
   `superseded` (naming the generation staged in its place), writes `release_unstaged`, and opens the newer row —
   and the desk refuses a late click on the old row (`409 approval_stale`) even before the tick that settles it. A
   store refusal settles the row `failed` with it and is not retried in a loop; only a restarted
   worker re-opens a `failed` row — an operator's deliberate retry.

## Reset means advance

Generations are monotonic. `airprompter rollback` on the host is a forced downgrade: the fleet page reports it,
the store holds that generation and older back, and the desk shows *forced downgrade* on the card until the console
promotes something newer — which then arrives staged, for the owner to approve (or for `zudocs-cli unlock` on the
host). Two things the drill taught: a release is content-addressed, so sealing the same pins again is the same
digest and "already what runs here" — advancing needs a real change (a version, a setting); and the SDK never
clears the `forcedDowngrade` flag once the host has moved past the rollback (`heldBackBelow` lifts, the flag stays),
so the card keeps saying *forced downgrade* until the store is replaced — filed upstream (#45). The worker's policy
is `apply.policy: "unlock_required"`, which no desk button changes (the shell row runs `policy show`,
`status`, `doctor`, `unlock` and `rollback`; the loosening drill is the us-east host's own `setApplyPolicy`).
Nothing here restores an old state; every reset is a promotion.

## The wire-cut drill

*Cut the wire* on the presenter panel calls the wire function: the published DynamoDB CIDRs for us-east-1 (from
`ip-ranges.json`, fetched at cut time; a handful) go on as HTTPS-only rules, the group is tagged with the instant, then
the open rule comes off — the status writer never loses the tables, so the card keeps updating while AirPrompter
and Bedrock are unreachable: after three failed polls (~90 s) the worker's `healthz` says `degraded: sync_failing`,
the card turns amber, the timeline gets `health_changed`. Session Manager is unreachable for the duration too (it
needs egress), which is why the rule exists: every five minutes it restores any cut older than 15 minutes, and
writes `wire restored … by the rule`. *Restore the wire* does it now. The worker's next poll clears the failures
and the card returns to `ok`. Two things to know during a cut: `zudocs-agent-key` cannot reach SSM, so a daemon
restart in that window fails its `ExecStartPre` until the wire is back (systemd keeps retrying); and a stack update
that rewrites the group's tags mid-drill would drop the cut's instant — the tick treats a cut with no instant as an
old one and restores it on its next pass, so neither strands the host.

## Sleep, wake and the cadence (phase 8)

The host is stopped every night (`zudocs-eu-host-sleep`, ten in the morning UTC, three attempts twenty minutes
apart) and started by the owner alone — *Wake the fleet* on the desk or `npm run host:wake -- --wait`. What a
stop/start does to this host (proven live at the phase-8 merge, airprompter/zudocs#18; the transcript is in that pull request): systemd's `enabled` units come back
in order, `airprompterd`'s `ExecStartPre` re-reads the Agent key from SSM into its root-only file, then each worker
reopens its store on the root volume (the generation is unchanged; a promotion made while asleep lands staged under
`unlock_required` for the desk to approve). The Node worker reconciles approvals, the Python worker follows, and
the row is written within about three minutes of the start. The public
IPv4 is released on stop and a new one is assigned on start (no Elastic IP) — nothing here depends on it. The card
reads *asleep since …* from the row's `power` marker, which the power function writes and its tick reconciles; the
workers' rows go quiet while the host is off and are shown as from before the sleep. The host CLI row is refused
(`409 host_asleep`) while it sleeps.

The workers' ticket cadence is idle by default — the Node worker one inbox ticket an hour, the Python worker every
two hours — and both read the demo-mode parameter (`/zudocs/dev/demo-mode`, a String in this region the host's role
may read beside the Agent key's name) every minute: on (two and five minutes) only while the document says so and its
`until` is ahead (four hours at most), off with a reason otherwise; the status row's `cadence` block says which and
when it was last read. The desk's presenter panel writes it.

## Proof

`npm run eu:proof` (with `ZUDOCS_PROOF_PASSWORD` in the environment) reads the stack outputs in both regions,
signs in through the proof client, checks the host's row (`file_key`, `unlock_required`, both workers serving and
fresh), then exercises approvals and ticket runs. Its CLI checks require a binary compatible with the 0.3.0
telemetry daemon. `cli/v0.3.0` is pinned and the proof checks its daemon discovery document.

## Honest notes

- The Node and Python workers load their own releases. The daemon ships their shared telemetry spool, so their
  in-process upload is disabled. Verify a real ticket and an acknowledged upload after replacing the host.
- The Python SDK's LiteLLM callback files the observation under the wire's model id (`bedrock/…`) rather than the
  release's; the worker subclasses it so the window lands on the model the version pins, like the Node wrappers do.
  Filed as a gap (`litellm_metadata(rendered, model=)` cannot override it).
- LiteLLM has no provider for Bedrock's OpenAI-shaped endpoint, so the Python worker calls Converse models only; a
  release on Luna is refused visibly on that worker (the Node worker carries the OpenAI-shaped path).
- The first boot takes about ten minutes: pip resolves LiteLLM's dependency tree on one vCPU (a 1 GiB swap file
  is added first). The Node worker starts before the Python worker.
- Every deploy that changes the bundle, the boot script or the pinned image replaces the instance. A fresh host
  starts with the current release *staged* (approve it on the desk), then holds one generation until the next
  promotion, so `rollback` right after a replacement refuses with `no_previous_release` — as it should.
- The first deploy: the eu-west stack lands before the desk stack creates the approvals table, so the worker's
  first `reconcile` fails and is logged (`reconcile_failed`); the watcher's ticks keep trying and the row appears
  once the table exists. Nothing to do.
- A replaced or reset worker store stages the current release again and opens a fresh approval row. The row's id
  carries the store id, so a stale decision for an old instance cannot unlock the new one.
