# The fleet: a puller, an exchange, and a host with no route out

Phase 5 is the third region and the third host shape. In ap-southeast-1 one Lambda — the **puller** — holds the
region's Agent key and pulls each promoted release into a table and a bucket the company owns; behind it a
**t4g.micro in a VPC with no internet gateway and no NAT** runs the Agent SDK offline on a bundle it fetched from
that bucket through a gateway endpoint, sealed to a distribution key that was generated on the host itself. It
cannot call a model and says so. Its telemetry leaves the host as a file, rides the bucket to the eu-west host,
and arrives at AirPrompter through `import-telemetry` — the offline instance appears on the fleet page although it
never had a wire. The desk shows both as host cards, and the presenter can nudge the puller. This page is the tour.

## What is where

| Piece | What it is | Where |
|---|---|---|
| Exchange bucket | `zudocs-exchange-<account>`: versioned, private, TLS only, retained. `releases/<gen>-<digest>-<key>.apbundle` and `latest.json` (the puller writes), `keys/airgap.distribution.pub.json` (the host writes — its role can put exactly that one key object), `status/airgap.json` and `telemetry/<instance>/<time>.aptelemetry` (the host writes), `imports/<marker>` (the eu-west import timer's ledger), `tools/` (what `airgap:up` stages for the first boot) | `infra/lib/fleet-stack.ts`, `fleet-names.ts` |
| Releases table | `zudocs-agent-releases`: one row per generation pulled (digest, when, the key it is sealed to, the object) and the puller's own state row — the edge pointer's ETags, the backoff, what it mirrored last — written in the same transaction as the release row, so a saved ETag never outruns its row, and conditioned on the version that was read, so two invocations at once (a nudge during a tick) cannot both win | `services/puller/src/tables.ts` |
| Puller | `zudocs-puller` (Node 22 arm64): every five minutes (one in `--context demo=true`) the SDK's `pullBundle` against AirPrompter, pointer-first; sealed to the host's public key when the exchange holds one, plaintext otherwise (dev only — the SDK refuses plaintext on any other target); the nudge queue's consumer; the mirror of the host's status document into the desk's tables | `services/puller/src/handler.ts`, `plan.ts` |
| Nudge queue | `zudocs-nudge` (+ a dead-letter queue after three receipts): the change-notification placeholder. The desk's presenter posts one message; the puller pulls with `skipPointer`. A nudge can only say "look" | `fleet-stack.ts`, `services/desk-api/src/handler.ts` › `nudge` |
| Air-gapped host | `ZudocsAirgap`, on demand: one private subnet, no route out, S3 and DynamoDB gateway endpoints (their policies name the exchange, the deployment's asset bucket and the table), an Instance Connect Endpoint for the shell, IMDSv2, no public address, no key pair; a role that reads `releases/` and `tools/`, writes exactly the public key, the status and the exports, queries the table — no SSM, no logs, no Bedrock | `infra/lib/airgap-stack.ts` |
| The runtime | `AirPrompterAgent.start` with `sync: "offline"`, no Agent key, no base URL, the distribution private key from a 0600 file, the vendored bundle as the floor; every newer row in the table fetched from the exchange and handed to `applyBundle()`; a render probe every two minutes filed as a **refused** observation; the status document every minute | `services/airgap/src/runtime.ts`, `status.ts` |
| Export | `zudocs-airgap-export.timer`: every five minutes `airprompter export-telemetry` over the runtime's spool, the document to `telemetry/<instance>/…` | `services/airgap/host/bin/zudocs-airgap-export` |
| Import | `zudocs-import.timer` on the eu-west host: every five minutes, each export not yet imported (the ledger is a marker per export under `imports/` in the bucket, so a replaced instance imports nothing twice) through `airprompter import-telemetry` with the Agent key as a systemd credential; a `telemetry_imported` timeline row per file and an `imports` part on the eu-west row | `services/eu-host/src/importTelemetry.ts` |

## The pull, exactly

The puller is the SDK's fleet pattern (`docs/change-notification.md` in the SDK repository) on a schedule:

1. Read the state row (the edge pointer URL the control plane named, the pointer's ETag, the manifest's ETag, when
   the origin last answered; the backoff; its version), the table's newest row, and the host's public key from the
   exchange (a missing key is "absent" — the puller's role may list exactly the two keys the host writes, which is
   what makes a missing one a 404; a read that is *refused* is reported as `denied` and stops the puller, and so does
   an object that is not a key: `public_key_malformed` on its card — never a quiet downgrade to plaintext).
2. Decide (`plan.ts`): a **tick** with ticks left to skip does nothing; a **nudge** pulls now and skips the pointer;
   a **re-seal** (the host published a key the held generation is not sealed to) reads the origin with the manifest
   ETag dropped, so a 304 cannot stand in for the bundle — given up after three failures on that key, said on the
   card, until the key changes; otherwise a tick pulls pointer-first.
3. `pullBundle`: the pointer (a few hundred bytes behind the CDN) first — a 304, or a generation already held, ends
   the pull with no API call. Only a moved pointer, a nudge, a re-seal, or a pointer that has said "nothing moved"
   for over an hour (the stuck-pointer bound) reaches the origin, and that read is conditional too. On `ok` the whole
   chain is verified (the root document against the pinned key, the manifest's signature and scope, every payload's
   hash) before the bundle is built.
4. On `ok`: the bundle object (its key carries the generation, the digest and the recipient), then the row and the
   state in one transaction, then `latest.json`, then a `bundle_pulled` timeline row. The same generation with another
   digest never happens on an honest control plane; if it did, the row and its object stand, `pull_conflict` says so
   on the timeline, and the card says so until a newer generation lands. `latest.json` follows the table's newest
   row and is repaired on the next tick whenever the last write did not match it. On `unchanged`, and on a refusal,
   an outage or nothing promoted: the SDK's `nextPullDelayMs` stretches the interval, kept as ticks to skip — 1 → 2 →
   4 → 5 minutes in demo; at the five-minute schedule the cap equals the tick and nothing is ever skipped — and a
   change, a nudge or a re-seal snaps it back (whatever a nudge finds, a person said "look" and the schedule resumes
   from the start). A failure is one `pull_failed` timeline row per change of reason, not one per tick; the health
   says so until a pull works. Two invocations at once (a nudge during a tick) both pull; the second to write loses
   on the state's version (`state_race_lost`) and its table and timeline writes never happen (its bundle object, an
   idempotent copy, may). A tick that lost stops there — the winner's word stands; a nudge that lost runs once more
   on the fresh state, so what a person asked for is never dropped. A nudge is counted and announced once per
   message id (the count and the id are written before the pull), whatever brings the message back — a lost race
   or the queue's redelivery.
5. Every tick also mirrors `status/airgap.json`, when it changed, into the air-gapped host's row and turns what
   changed into timeline rows (`airgap_started`, `distribution_key_born`, `airgap_applied`, `telemetry_exported`,
   `health_changed`).

The puller's card shows the generation the exchange holds and what it is sealed to, the last pull and its trigger,
this hour's CDN and API reads, the backoff, the nudges, and whose key it seals to.

## The key, exactly

`airprompter keygen --purpose distribution` runs on the air-gapped host at first boot, as the runtime's user, under
`/var/lib/airprompter/keys` — a directory that is not a git worktree (the CLI refuses one). The private half stays
there at 0600 and opens every bundle; the runtime refuses to start on a private key readable by anyone else. The
public half is copied to the exchange by its exact name (`zudocs-airgap-keygen` refuses to publish a file that
carries a private member, and the instance role can put that one key object and nothing else under `keys/`). The
puller reads it, checks the id against the key, and from then on seals every bundle to it — re-sealing the generation
it already held, so the host is never waiting on a promotion to get its first bundle. `airgap:down` removes the
public half (the private half died with the host); the next host is a new key and a new re-seal.

What the SDK supports today, and what the exchange therefore carries: `pullBundle` seals to an X25519 public key
(HPKE) or writes plaintext for the dev target only; `openBundle` (in `start`'s vendored bundle and in
`applyBundle()`) opens either. The exchange carries **one** bundle per generation: sealed when a host key exists,
plaintext (dev) when none does. The console's *Download update file* path seals to the key registered on the
environment; registering this host's public half there is a console act the owner can do from the object in the
bucket, and is not needed for the puller.

## The host, exactly

The first boot (`services/airgap/host/user-data.sh`) cannot `dnf install`, `pip install` or `curl` anything: there
is no route. Node and the released CLI come from the exchange's `tools/` prefix through the S3 gateway endpoint —
`npm run airgap:up` downloads both to a cache, verifies them against the pins (`services/airgap/pins.json`,
`services/eu-host/pins.json`) and uploads them with the digest as metadata; the boot verifies both again before
either is executable. The runtime bundle comes from the deployment's asset bucket through the same endpoint and is
unpacked with the image's own Python (no `unzip` on the image). Then the probe (an HTTPS connect to the API host —
it times out; a public name lookup — it resolves, because the VPC's resolver answers for any name and a name is not
a route), the keygen, the units.

The runtime waits for the table's newest row to be sealed to its key (`waiting_for_reseal` in its log and
`awaiting_bundle` on the card until then), fetches the bundle from the exchange, writes it as the vendored file
(0600) and starts the SDK on it: `sync: "offline"`, `apply.policy: "auto"`, a `file_key` store, no `models`
declared — this host can call none, and a declared empty catalogue would refuse every release over a model, so it
declares nothing and renders only. A bundle the SDK cannot start on is recorded (`startFailure` in the document, on
the card) and tried again after ten minutes, or the moment a newer row appears — never silently given up. Every later
row above what it handed over goes to `applyBundle()`; the outcome is the SDK's (`activated`, `unchanged`,
`held_back`, `refused` with its reason) and is recorded and mirrored; an activation also refreshes the vendored file,
so a restart boots on the newest and the floor is never stale.

Every two minutes the runtime renders `support.triage` for one seeded customer id with a fixed probe sentence as the
ticket — the release resolves (version, arm, model) exactly as on every other host, the sticky arm included — and
files an observation with `status: "refused"`, zero latency, usage unavailable: this host has no route to any model
and says so. It never invents an answer. The SDK writes the window rows to its spool; the export timer packs them.

The status document (`status.ts`) carries the SDK's `status()` and `healthz()` verbatim, the key id, the phase,
what it waits for, the last twenty apply outcomes, the render count, the last export, the probe, and the last thirty
log lines (ids and outcomes, never a render). The puller mirrors it; the card's "written" instant is the host's own,
so a torn-down host fades exactly as a silent one would.

## The telemetry, exactly

On the host: `airprompter export-telemetry --state-dir /var/lib/airprompter --out …` packs every closed, unsent
segment into one document (the segments verbatim, the store's generation beside them) and moves them to
`spool/telemetry/exported/`; the document goes to `telemetry/<instance>/<time>.aptelemetry` when it carries a
segment, and `last.json` records the result for the status document either way. A document whose upload failed is
kept and goes first on the next run — nothing the CLI packed is ever lost to one failed copy.

On eu-west: the import timer lists `telemetry/` and `imports/` (its role may read the first, write the second,
and list those two prefixes only), downloads each export it has no marker for, and runs `airprompter
import-telemetry` on it. The CLI heartbeats as each instance the document carries — `syncMode: offline`, the
exporting store's generation, `file_key` — for an upload grant to that instance's prefix and posts the segments
through it. The platform is idempotent by key (importing the same file twice changes nothing); the ledger — a marker
object per export in the bucket, so it outlives the instance — keeps the host from paying the heartbeat twice. Exit 0
is the CLI's contract for "every segment landed" and writes the marker (the `--json` document — the last line of
stdout — is read for the counts; unreadable, the counts stay null and the log says so). Anything else is held for
another pass: a transient failure (the CLI did not run, no document, the platform's "retry later") is held for as
long as it takes — the exports expire from the bucket after thirty days, and holding while the platform is down
costs nothing; only a deterministic verdict counts: segments the platform refused or quarantined (the CLI also folds a
segment's network failure into `refused`; a retry costs one heartbeat) count toward five attempts and end as failed,
and a usage error (exit 2: not a telemetry export, or one for another agent or target) is failed at once — both with a
marker (delete `imports/<marker>` in the bucket to try again). While an export is held, one `telemetry_imported` row
per change of reason, not one per pass. The CLI's stderr stays in the host's log and never reaches a timeline row. The Agent key
reaches the CLI as a systemd credential: `LoadCredential=` mounts the daemon's root-only env file for this unit
alone, the script reads the value and puts it in the child's environment only. On AirPrompter's fleet page the
air-gapped instance appears as an offline resident with its windows — every one of them a refusal.

## Reset means advance

Generations are monotonic here too: the table's newest generation is the puller's floor (`minimumGeneration`), and a
control plane answering below it is reported as `generation_rollback`, never stored; the host's SDK refuses an older
bundle (a rollback is `airprompter rollback`, never an older bundle). A new air-gapped host is a new key and a
re-seal of the held generation — no promotion is needed to bring it up.

## The owner's commands

```sh
export AWS_PROFILE=zudocs BUDGET_EMAIL=billing@zudocs.com
set -a; . ~/.config/zudocs/dev.env; set +a
AWS_REGION=ap-southeast-1 ZUDOCS_SSM_KEY_ID=alias/aws/ssm bash scripts/ssm-put-agent-key.sh   # once: the puller's key in its region
npm run airgap:up            # stage the tools, deploy ZudocsAirgap, wait for the first status document (~10 minutes)
npm run airgap:status        # the stack, latest.json, the public key, the host's document
node scripts/airgap.mjs run 'curl -sS -m 8 -o /dev/null https://api-dev.airprompter.com/; echo exit=$?'   # a command on the host through the endpoint
npm run fleet:proof -- --nudge --airgap --import      # the claims, with ZUDOCS_PROOF_PASSWORD in the environment
npm run airgap:down          # destroy the stack; the exchange keeps every artefact
```

The airgap stack is never in CI's deploy list (`infra/test/airgap-stack.test.ts` pins that); the fleet stack is.

## Honest notes

- The host's DNS resolves public names: the VPC resolver answers for any name, and the gateway endpoints need DNS
  support on. The boundary is the route table (no default route) and the endpoints' policies; the probe shows a
  connect that times out and a name that resolves, and the card says both.
- The host's security group allows HTTPS egress to any address: the gateway endpoints' prefix lists are a deploy-time
  lookup a credential-less synth cannot make. Nothing is reachable through it but the two endpoints.
- The import runs as the airprompter user with the key as a credential, not as root with the env file — but the
  workers share the daemon's uid on that host (`docs/EU-WEST.md` › "Keys, exactly"), so this is configuration, not
  a boundary, exactly as there.
- The render probe's ticket is a fixed sentence; the window rows carry no text either way. The observation status
  `refused` is the protocol's own word for a call the runtime would not make.
- The puller's backoff is the SDK's `nextPullDelayMs` under a fixed schedule, counted in ticks so the schedule's
  jitter can never skip a tick by accident: at the plan's five-minute tick it never skips (the cap equals the tick);
  at the demo's one-minute tick an idle puller stretches to five minutes and a nudge snaps it back. The proof's "one
  origin read per hour" is the SDK's stuck-pointer bound, visible in the log.
- The host's Instance Connect Endpoint is the only way in; the OS route table shows a default route from DHCP (every
  EC2 instance's does) — the VPC route table, which decides, has none, and the proof reads that one and asserts it
  carries exactly the local route and the two gateway endpoints' prefix lists, with the host's subnet on it.
- `npm run airgap:up` deploys `ZudocsAirgap --exclusively`: the fleet stack is CI's, and a deploy from a checkout
  must never redeploy it as a dependency.
- A replacement of the eu-west instance (this phase changed its bundle) resets the sticky `forced_downgrade` flag
  the phase-4 rollback drill left on its store, and lands the current release staged for the desk to approve.
- Costs: the puller's ticks (8,640 a month at five minutes — free tier), the table and the queue (free tier), the
  bucket (cents), the host only while `airgap:up` (~$0.30 a day for the instance and its volume); the gateway
  endpoints and the Instance Connect Endpoint are free. No NAT, no interface endpoint, no public address.
