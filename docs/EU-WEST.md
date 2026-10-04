# The eu-west host: a telemetry daemon and two automatic SDK workers

The Node and Python workers independently sync, verify and apply signed releases published in AirPrompter.
AirPrompter owns approval, version selection and A/B schedules. Zudocs has no release approval or policy override.
The SDK stores the release locally and evaluates its percentages on the host's clock; DynamoDB stores reports,
replies and assignments. `airprompterd` ships the shared telemetry spool and does not distribute releases.

Both SDK workers use resident sync every 30 seconds and `apply.policy: auto`. Node runs `support.triage` and
`support.reply` through Bedrock; Python runs `support.reply` through LiteLLM and Bedrock Converse. Each has its
own SDK store, while both write observations to the daemon's spool. See `src/worker.ts` and `host/pyworker.py`.

Worker bundle or boot changes replace the EC2 instance. Its fresh SDK stores are rebuilt from a verified sync
of the published release. During replacement both instances may briefly write the same host row; compare the
instance ID to the stack output. The AMI is pinned to avoid unrelated replacements.

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

## Published release to local assignment

1. Approve and publish a release or experiment in AirPrompter with automatic application enabled.
2. Each worker polls every 30 seconds and independently verifies the signed manifest and payloads.
3. The SDK activates the verified release in its own store. No Zudocs approval, unlock or percentage write occurs.
4. The SDK evaluates the signed ramp schedule locally and assigns the customer ID consistently across hosts.
5. Replies record the SDK generation, version, arm, settings and metrics in Zudocs's database.
6. System compares independently verified AirPrompter metadata against host reports. Experiments shows the
   published plan first; its optional simulation does not alter a release or emit measurements.

Signature checks, lease enforcement, disable directives and manifest policy tightening remain in the public SDK.
If AirPrompter publishes `unlock_required`, the SDK can still hold that release; Zudocs does not bypass that policy.
A historical operator pin may also require host maintenance. Legacy local approval records remain read-only in Database.
The desk's host CLI allows only `status`, `doctor` and `policy show`; legacy approval/policy writes answer 409.

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
reopens its store on the root volume and automatically syncs newer published releases. The row is written within
about three minutes of the start. The public
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
signs in through the proof client, checks the host's row (`file_key`, `auto`, both workers serving and
fresh), then verifies ticket runs. Its CLI checks require a binary compatible with the 0.3.0
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
- Every deploy that changes the worker bundle, boot script or pinned image replaces the instance. A fresh host
  verifies and applies the current published release automatically under its signed policy.
