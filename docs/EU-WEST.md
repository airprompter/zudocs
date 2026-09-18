# The eu-west host: a daemon, two workers, and the approval that makes a release live

Phase 4 is the second production host and the second host shape: one small EC2 instance in eu-west-1 that runs
`airprompterd` — the released CLI's daemon: one sync loop, one encrypted store, one key — with two applications
attached to it over its socket, a Node ticket worker and a Python ticket worker, neither of which holds a key. It
is the host that shows the resident SDK, `file_key` honestly, the `unlock_required` policy pinned on the host and
granted from the desk's Approvals page, the operator's CLI (`status`, `doctor`, `unlock`, `rollback`, `policy`), and
the "losing the wire" drill. This page is the tour: what is where, how the approval flows, what the boot does, and
the honest notes.

## The host (`services/eu-host`, `infra/lib/shared-host-stack.ts`)

| Piece | What it is | Where |
|---|---|---|
| Instance | `t4g.micro`, Amazon Linux 2023 arm64, IMDSv2 required, 8 GiB gp3 encrypted, a public IPv4 for egress; one public subnet, no NAT, no endpoints; a security group with **no inbound rule** (Session Manager only, through the instance role) | `shared-host-stack.ts` |
| `airprompterd` | The released CLI (`cli/v0.1.0`, linux-arm64, sha256 verified before `chmod +x`) as the SDK's own systemd unit, adapted: identifiers from `/etc/airprompter/zudocs.env`, the Agent key from `/etc/airprompter/airprompterd.env` (root:root 0600, written from the eu-west SSM SecureString by `zudocs-agent-key` before every start), `--apply-policy unlock_required`, the dev root pinned (`--hosted-environment dev`), `--edge-pointer-url` so idle polls are one CDN 304, uploads every 60 s | `host/units/airprompterd.service`, `host/bin/zudocs-agent-key` |
| Node worker | `@airprompter/agent-sdk` in `sync: "daemon"` mode — no key, no store of its own; refuses to start (exit 3) when the daemon is not on the socket. Every 10 minutes it runs one inbox ticket (the presenter's queue first) through the same `runTicket` the us-east host uses: `support.triage` and `support.reply` on the release's models through Bedrock in us-east-1 (`aiSdkMiddleware()` on Converse, `wrap()` on the OpenAI-shaped endpoint), the judge, the checks; feedback filed from the SDK's own check verdicts (`accepted` when every declared check passed); the record in the runs table with `host: eu-west-1/ec2`, under the fleet's shared daily cap | `src/worker.ts` |
| Approvals | The `ApprovalWatcher`: a staged generation → a row in the approvals table → the owner's decision on the desk → `ap.unlock()` through the daemon → the row settled and the host card flipped (below) | `src/approvals.ts` |
| Status | Every 30 s: the daemon's own `status` and `healthz` documents (read over its socket with the public `DaemonClient`) merged into the host's row under the names the desk's card reads, with the worker's part beside them; every health transition is a timeline row | `src/statusRow.ts` |
| Python worker | `airprompter-agent` (the public Python SDK, installed by commit pin — PyPI does not carry it yet) attached to the same daemon; every 20 minutes `support.reply` rendered with `customer_tier` from the desk's table, LiteLLM to Bedrock's Converse API with the instance role, the SDK's LiteLLM callback filing the observation, the declared checks, feedback from their verdicts, its own record in the runs table and its own part of the status row (`python`) | `host/pyworker.py` |
| The wire | A Lambda (`zudocs-wire`) that replaces the group's open egress with HTTPS to DynamoDB in us-east-1 only (cut) or puts it back (restore); an EventBridge rule every five minutes restores a cut older than 15 minutes whatever the presenter forgot; every change is a timeline row | `src/wire.ts` |
| Logs | The units append JSON lines to `/var/log/zudocs/*.log`; the CloudWatch agent ships them to `/zudocs/eu-host` (seven days). Never a render, a ticket or an answer | `host/cloudwatch-agent.json` |
| The operator's CLI | `zudocs-cli <command>`: `airprompter <command>` as the daemon's user, scoped to this host, through the daemon's socket — `status`, `doctor` (with the key in its environment, from the root-only file), `unlock`, `rollback`, `policy show|set`, `diff`, `export-telemetry` | `host/bin/zudocs-cli` |

Everything the stack installs is pinned in `services/eu-host/pins.json` (the CLI's digest, the Python SDK's
commit) and rendered by `npm run build` into `dist/bundle/` — the worker bundled by esbuild, the units, the
helpers, `zudocs.env` (identifiers and table names, never a key; the build refuses a key-shaped value) and
`requirements.txt`. The stack ships the bundle as an asset the instance downloads at boot; a change to it replaces
the instance (`userDataCausesReplacement`), and so does a new AL2023 image, because the host is cattle: its store is
rebuilt from one sync.

## Keys, exactly

One key exists on the host — the dev Agent key — and one process reads it: `airprompterd`. The owner writes it once
in eu-west-1 as an SSM SecureString under the AWS-managed SSM key (no KMS key of ours in the region):

```sh
set -a; . ~/.config/zudocs/dev.env; set +a
AWS_PROFILE=zudocs AWS_REGION=eu-west-1 ZUDOCS_SSM_KEY_ID=alias/aws/ssm bash scripts/ssm-put-agent-key.sh
```

The instance role may read that one parameter by ARN — not `AmazonSSMManagedInstanceCore`, which would also grant
`ssm:GetParameter` on every parameter in the account; Session Manager and Run Command are granted by their own
actions. `zudocs-agent-key` reads it into `/etc/airprompter/airprompterd.env` (0600, root) through a 0600 temporary
and an atomic rename, as `ExecStartPre=+…` of the daemon's unit, so a rotated parameter is live at the next
restart. The workers' environment file carries no key, and `readHostEnv` (and the Python worker) refuse to start
if `AIRPROMPTER_AGENT_KEY` is set in theirs. User data never carries a key (the stack's test pins it).

The store key is a **file** (`store.key`, 0600, next to the store): `airprompterd` opens `fileKey` stores only, so
this host reports `storageProtection: file_key`, the card shows it in amber, and `doctor` warns about it. That is
the demo beat, not a thing to hide; the SDK gap (`airprompterd --key-provider`) is filed upstream.

## The approval, step by step

1. AirPrompter promotes generation N. The daemon's next poll (30 s) verifies it and, under `unlock_required`,
   stages it: `applyState: awaiting_unlock`, `stagedGeneration: N`. Every attached SDK learns of it over the
   socket, so the Node worker's `status()` reports it too. The attached SDKs' `apply.onStaged` hook does **not** run
   — the hook runs inside the process that syncs, which here is the daemon (an SDK gap, filed) — so the watcher
   reads the staged generation instead.
2. The watcher opens the row `eu-west-1-ec2-gN` (`pending`; created once — a restarted worker resumes it) and
   writes `release_staged` to the timeline. The desk's Approvals section shows *release #N · staged — awaiting your
   approval on eu-west-1/ec2*, with the console's request note when the host could read one (today it cannot:
   the daemon's socket carries no `unlockRequests`, so the row says so).
3. The owner presses *Approve*: `POST /approvals/{id}/approve` flips `pending → approved` exactly once
   (a conditional write; a second press, another tab, another container answers `already: true` with the row as it
   stands) under the signer's e-mail, and writes `approval_decided`.
4. The watcher's next tick (5 s) sees `approved`, calls `ap.unlock()` — host-wide through the daemon, so the
   Python worker switches in the same instant — settles the row `activated` with the instant, and writes
   `release_activated … by seth@zudocs.com`. The card flips to `#N · active`; the bar says `active on 2/2`.
5. If an operator ran `airprompter unlock` on the host's shell instead (or a window opened, or a rollback moved
   the generation), the staged generation vanishes without the watcher's unlock: the row settles `superseded`
   with the reason and the timeline says `activated on the host`. A refused unlock settles the row `failed` with the
   SDK's reason and is not retried in a loop.

## Reset means advance

Generations are monotonic. `airprompter rollback` on the host is a forced downgrade: the fleet page reports it,
the daemon holds that generation and older back, and the desk shows *forced downgrade* on the card until the console
promotes something newer — which then arrives staged, for the owner to approve. A tightened policy pin is loosened
only by `zudocs-cli policy set auto` on the host. Nothing here restores an old state; every reset is a promotion.

## The wire-cut drill

*Cut the wire* on the presenter panel calls the wire function: the six published DynamoDB CIDRs for us-east-1
(from `ip-ranges.json`, fetched at cut time) go on as HTTPS-only rules, the group is tagged with the instant, then
the open rule comes off — the status writer never loses the tables, so the card keeps updating while AirPrompter
and Bedrock are unreachable: after three failed polls (~90 s) the daemon's `healthz` says `degraded: sync_failing`,
the card turns amber, the timeline gets `health_changed`. Session Manager is unreachable for the duration too (it
needs egress), which is why the rule exists: every five minutes it restores any cut older than 15 minutes, and
writes `wire restored … by the rule`. *Restore the wire* does it now. The daemon's next poll clears the failures
and the card returns to `ok`.

## Proof

`npm run eu:proof` (with `ZUDOCS_PROOF_PASSWORD` in the environment) reads the stack outputs in both regions,
signs in through the proof client, checks the host's row (daemon host, `file_key`, `unlock_required`, both workers
attached, the stack's instance id, fresh), runs `airprompter status --json` and `doctor --json` on the host
through Run Command (the CLI's own output is printed; `doctor` must warn `key_protection: file_key` and fail
nothing), and with flags: `--approve` (approve what is staged, prove the second approve is not a decision, wait
for the activation and the card), `--enqueue T-1041` (run one ticket on eu-west now, read the record), `--cli
unlock` / `--cli rollback` / `--cli "policy show"` (the operator's commands on the host's shell), `--wire` (cut,
watch `sync_failing`, restore, watch it recover).

## Honest notes

- The `apply.onStaged` hook and `unlockRequest` do not reach a process attached to a daemon; the watcher reads
  `stagedGeneration` instead and the row's note is empty until the daemon's socket carries the request. Filed.
- The daemon's socket does not carry its heartbeat block; the card shows the daemon's last **contact** with the
  origin (a signed manifest or an authenticated answer) and says the heartbeat is the daemon's. AirPrompter's fleet
  page shows the heartbeat itself.
- Attached SDKs do not heartbeat and hand the daemon no variable names, so the console's "which instance fills
  `customer_tier`" line does not know about this host's workers (the phase 2 gap); the status row carries the
  names, so the desk does.
- The Python SDK's LiteLLM callback files the observation under the wire's model id (`bedrock/…`) rather than the
  release's; the worker subclasses it so the window lands on the model the version pins, like the Node wrappers do.
  Filed as a gap (`litellm_metadata(rendered, model=)` cannot override it).
- LiteLLM has no provider for Bedrock's OpenAI-shaped endpoint, so the Python worker calls Converse models only; a
  release on Luna is refused visibly on that worker (the Node worker carries the OpenAI-shaped path).
- The first boot takes about ten minutes: pip resolves LiteLLM's dependency tree on one vCPU (a 1 GiB swap file
  is added first). The worker and daemon are serving well before the Python worker is.
- Every deploy that changes the bundle, the boot script or the AL2023 image replaces the instance. A fresh host
  holds one generation until the next promotion, so `rollback` right after a replacement refuses with
  `no_previous_release` — as it should.
- Costs: the instance (~$6/month), its public IPv4 ($3.65), 8 GiB gp3 ($0.64), the log group, the wire function
  (a few hundred invocations a month). No NAT, no endpoints, no key, no load balancer.
