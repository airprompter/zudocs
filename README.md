# Zudocs

Zudocs is a fictional documentation company. Its support desk is powered by prompts that live in
[AirPrompter](https://airprompter.com) — not in this repository — and this repository is the whole
company: the landing page, the desk, and the hosts in three AWS regions that run the prompts and report
back. It exists to show, on real infrastructure, how a customer deploys the AirPrompter Agent SDK, how a
prompt change reaches every running host without a deploy, what a run looks like, and what leaves the
host. It is also the demonstration we give prospects.

Everything here depends only on what any customer has: the public npm and PyPI packages, the released
CLI, the public root key, and keys issued in the AirPrompter console. No prompt text is committed. No key
is ever in this repository, on a command line, or in a log.

## What is here today (phases 1–6)

```
infra/             CDK: ZudocsCi (the deploy role), ZudocsDns (the zone), ZudocsSite (landing page, sign-in, budget,
                   trail), ZudocsDesk (the desk API, its tables and key, the desk app) in us-east-1;
                   ZudocsSharedHost (the daemon host and the wire function) in eu-west-1; ZudocsFleet (the puller, the
                   releases table, the exchange bucket, the nudge queue) and ZudocsAirgap (the air-gapped host, on demand) in
                   ap-southeast-1
apps/landing/      the public site at zudocs.com
apps/desk/         the desk at desk.zudocs.com: React + Vite, hosted-UI sign-in, the run panel, the fleet, approvals, the timeline
services/desk-api/ the us-east-1 host: one Lambda running the Agent SDK in on_invoke mode (docs/DESK.md)
services/eu-host/  the eu-west-1 host: airprompterd, the Node and Python workers, the import timer, the units, the boot script, the wire (docs/EU-WEST.md)
services/puller/   the ap-southeast-1 puller: pointer-first pullBundle into the releases table and the exchange bucket, the nudge's consumer (docs/FLEET.md)
services/airgap/   the ap-southeast-1 air-gapped host: the offline runtime, the keygen, the export timer, the units, the boot script (docs/FLEET.md)
airprompter.config.json   where the prompts live in AirPrompter: identifiers only, never a key
prompts/           the local registry for `airprompter dev` — ignored; `npm run prompts:seed` fills it
keys/              public root JWKs the hosts and the verify action pin (dev today, prod at the cutover)
vendored/          the one bundle in git: the zudocs-ci Agent's placeholder slot, verified weekly with no key (vendored/README.md)
scripts/           prompts-seed, dev-smoke, dev-proof, desk-proof, eu-host-proof, fleet-proof, airgap (up / down / status / run),
                   demo-console (the presenter's console acts), demo-dryrun (the nine beats, asserted), demo-reset (reset means
                   advance), strip.sh (the recorded CLI strips), vendor.sh (the vendoring PR), ci-telemetry-validate,
                   check-vendored, ssm-put-agent-key.sh, cognito-users.sh, account-baseline.sh, check-headers, check-keys
docs/              ARCHITECTURE.md, PROMPTS.md (the slots, variables, checks, golden set, models), DESK.md (the us-east host
                   and the app), EU-WEST.md (the daemon host, the approval, the wire), FLEET.md (the puller, the exchange, the
                   air-gapped host, export/import), strips/ (the recorded terminal strips)
DEMO.md            the nine-beat script for the presenter: clicks, what the prospect sees, timings, before and after
RUNBOOK.md         the operator's side: every key and its rotation, the drills, host replacement, the reset, the vendoring PR
```

Phase 2 put the prompts in AirPrompter: one Agent, `zudocs-support`, four slots (`support.triage` on Nova Micro;
`support.reply` and the two-step escalation on GPT-5.6 Luna), variables the desk fills from its own customer table,
declared output checks, a golden set, settings on the version — promoted to the dev environment. `docs/PROMPTS.md`
is the contract; the text is not here.

Phase 3 built the first production host and the app a prospect watches: the desk API on Lambda in us-east-1 — the
SDK in `on_invoke` mode, the store key wrapped by KMS, the Agent key read from SSM at cold start, Luna through
Bedrock's OpenAI-compatible endpoint under `wrap()`, Nova Micro through Converse under `aiSdkMiddleware()`, the
`customer_tier` variable from the desk's own table, telemetry to AirPrompter and, through a tee, to CloudWatch
metrics — behind an HTTP API with the Cognito JWT authorizer, and the desk app at
[desk.zudocs.com](https://desk.zudocs.com). `docs/DESK.md` is the tour.

Phase 4 built the second host and the second shape: a `t4g.micro` in eu-west-1 running `airprompterd` (the released
CLI's daemon, one key, `unlock_required` pinned on the host, `file_key` shown honestly) with a Node worker and a
Python worker attached to it over its socket, neither holding a key; the desk's **Approvals** page, where a release
AirPrompter staged waits for the owner and activates through the daemon when approved; the second host card; and
the wire-cut drill with its automatic restore. It also re-pinned the reply and escalation slots to Nova 2 Lite while
the account's access to GPT-5.6 Luna is gated — the first change that reached every host. `docs/EU-WEST.md` is the
tour.

Phase 5 built the third region and the third shape: in ap-southeast-1 a **puller** Lambda holds the region's Agent key
and pulls each promoted release pointer-first (an idle tick is one CDN read, no API call) into a releases table and an
**exchange bucket**, sealed to the distribution key of the **air-gapped host** — a `t4g.micro` in a VPC with no internet
gateway and no NAT, deployed on demand, that generated that key itself at first boot (only the public half left it),
boots the SDK offline on a vendored bundle fetched through a gateway endpoint, applies every newer bundle from the
exchange, cannot call a model and files every render as a refusal, and exports its telemetry to the bucket — from where
the eu-west host's import timer carries it to AirPrompter, so the offline instance appears on the fleet page. The desk
gained the two host cards, the **Nudge the fleet** action (the change-notification placeholder: the puller reads the
origin now), and the timeline rows; the us-east host's status row is now written every five minutes between runs.
`docs/FLEET.md` is the tour.

Phase 6 is the story. `DEMO.md` scripts nine beats (twenty minutes; the first four are the five-minute cut) and
`npm run demo:dryrun` performs every click and console act against the live deployment and asserts what the
prospect would see; `npm run demo:reset` implements *reset means advance* (two fresh canonical generations, every
drill undone by moving forward). On the desk: **Run on staging** (AirPrompter's hosted execution with a run key —
the stream replayed as it arrived, the feedback, and the OpenAI-compatible call with the caller's temperature shown
ignored beside the version's sealed settings; on dev today the hosted run route answers `internal (500)`, platform
issue #906, and the panel says so), the **Experiments** panel (per-arm results from the desk's own records, and the
same customer on the same arm on every host), the ramp plan on the eu-west approval row (one approval for the whole
plan), the freeze banding every ticket with the SDK's reason (Run stays clickable and answers `423 frozen`),
one-click `zudocs-cli` drills on the eu-west host
through Run Command (`policy show`, `rollback`, `unlock`, `status`, `doctor`), the golden set run before a release activates
on us-east (a failing set leaves it staged under `auto`), and the recorded strips under `docs/strips/`. The weekly
*Vendored bundle* workflow verifies the committed bundle with no key. See `docs/ARCHITECTURE.md`.

## Present it

```sh
eval "$(.bin/airprompter login --email you@zudocs.com --base-url https://api-dev.airprompter.com)"
export AWS_PROFILE=zudocs ZUDOCS_PROOF_PASSWORD='…'
npm run demo:reset                       # before a session: reset means advance (~4 minutes)
npm run airgap:up                        # wake the air-gapped host (~6 minutes; optional in the five-minute cut)
npm run demo:console -- change-words     # every console act of DEMO.md as one command
npm run demo:dryrun -- --skip-wire       # the rehearsal: every beat performed and asserted (~18 minutes)
```

`DEMO.md` is the script; `RUNBOOK.md` is the operator's side.

## Work on the prompts locally

```sh
# once: the released CLI (verify the digest; see docs/PROMPTS.md), installed at .bin/airprompter or on PATH
eval "$(.bin/airprompter login --email you@zudocs.com --base-url https://api-dev.airprompter.com)"
npm run prompts:seed            # ./prompts from the release promoted to dev (prompt text stays out of git)
npm run dev:smoke               # airprompter dev --daemon + the SDK: every slot renders, fills, fences, passes its checks (no model)
set -a; . ~/.config/zudocs/dev.env; set +a        # the Agent key, from a 0600 file, into the environment
npm run dev:proof               # the same render against AirPrompter dev: two customers, two tiers, a heartbeat
```

## Run the checks

```sh
npm install
npm run check-headers && npm run check-keys && npm run typecheck && npm test
npm run build          # the desk API bundle, the desk app, the eu-west host bundle and the wire function — the stacks deploy these
npm run synth          # CDK synth with a placeholder account and no budget e-mail: no credentials needed
```

## Run the desk on a laptop

The app talks to the deployed API (the SDK runs on the host, not in the browser). Write the deployed values into
`apps/desk/public/config.json` (ignored; the same shape the desk stack writes at deploy time — `apiUrl`, `region`,
`userPoolId`, `clientId`, `hostedUi`, `deskUrl`, `environment`, `agentId`, all from the `ZudocsSite` and
`ZudocsDesk` stack outputs), then `npm run dev --workspace apps/desk` and sign in at http://localhost:5173 — the
Cognito client names that callback on purpose. When another server already holds `localhost:5173` (the API's CORS
names that origin only), set `ZUDOCS_API_PROXY=<the API URL>` for the dev server and `"apiUrl": "/api"` in the
config: the dev server forwards same-origin.

## First deploy (owner's session, once)

Everything after this comes from CI. Order matters: the site's certificate validates through the
domain's public nameservers, so the zone must exist and the registrar must point at it before
`ZudocsSite` can finish.

```sh
export AWS_PROFILE=zudocs BUDGET_EMAIL=billing@zudocs.com
bash scripts/account-baseline.sh
cd infra
npx cdk bootstrap aws://<account>/us-east-1 aws://<account>/eu-west-1 aws://<account>/ap-southeast-1
npx cdk deploy ZudocsCi ZudocsDns          # ZudocsCi is never deployed by CI
# point the registrar at the NameServers output; wait until `dig NS zudocs.com` agrees
npx cdk deploy ZudocsSite
```

Things a synth cannot catch: if the registrar is not repointed yet, `ZudocsSite` sits in
CREATE_IN_PROGRESS on the certificate until ACM gives up (hours) and rolls back — a killed CLI does not
stop CloudFormation. An account holds one GitHub OIDC provider; if one exists, pass
`--context githubOidcProviderArn=arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`
to `ZudocsCi`. One cost anomaly monitor of the service kind is allowed per account, and Budgets and
Cost Explorer take up to a day to switch on in a fresh account.

Then set the repository variables `AWS_ACCOUNT_ID` and `BUDGET_EMAIL`, and `main` deploys. The deploy
role trusts GitHub's immutable subject (`repo:owner@id/repo@id:ref:refs/heads/main`); the ids in
`infra/cdk.json` › `github` come from `gh api repos/airprompter/zudocs/actions/oidc/customization/sub`.

### The desk (phase 3), once

`ZudocsDesk` deploys from CI like the site, but three things are the owner's, by hand, in this order — the stack
first, because the parameter is encrypted with the key the stack creates:

```sh
npm run build && cd infra && npx cdk deploy ZudocsDesk && cd ..     # or let main deploy it
set -a; . ~/.config/zudocs/dev.env; set +a                          # AIRPROMPTER_AGENT_KEY into the environment
bash scripts/ssm-put-agent-key.sh                                   # → /zudocs/dev/agent-key, SecureString under alias/zudocs-desk
bash scripts/cognito-users.sh owner seth@zudocs.com                 # Cognito e-mails the temporary password
ZUDOCS_PROOF_PASSWORD="$(openssl rand -base64 27 | tr -d '/+=' | cut -c1-30)Aa1" bash scripts/cognito-users.sh proof proof@zudocs.com   # meets the pool's policy; keep it in your store
```

Until the parameter exists, every request answers `503 host_unavailable` with a message naming the parameter; the
next request after it exists starts the host.

### The fleet (phase 5), once

`ZudocsFleet` deploys from CI. The puller reads the same parameter name in its own region (the AWS-managed SSM key, like
eu-west), so the owner writes it there once; until it exists every tick logs `agent_key_unreadable` and the puller's card
says so. The air-gapped host is the owner's, on demand — it exists only while `airgap:up`:

```sh
set -a; . ~/.config/zudocs/dev.env; set +a
AWS_PROFILE=zudocs AWS_REGION=ap-southeast-1 ZUDOCS_SSM_KEY_ID=alias/aws/ssm bash scripts/ssm-put-agent-key.sh
export AWS_PROFILE=zudocs BUDGET_EMAIL=billing@zudocs.com
npm run airgap:up             # ~10 minutes: the tools staged in the exchange, the stack, the host's first status document
npm run fleet:proof -- --airgap --nudge --import      # with ZUDOCS_PROOF_PASSWORD: the claims in docs/FLEET.md
npm run airgap:down           # the exchange keeps every artefact; the card fades
```

### The eu-west host (phase 4), once

`ZudocsSharedHost` deploys from CI. The host reads the same parameter name in its own region, under the AWS-managed
SSM key (no key of ours exists in eu-west-1), so the owner writes it there once; the daemon's unit reads it into a
root-only file before every start (its `ExecStartPre`), and until it exists that step fails and systemd retries
the daemon every five seconds — the units and the log shipping are installed before the boot ever asks for it:

```sh
set -a; . ~/.config/zudocs/dev.env; set +a
AWS_PROFILE=zudocs AWS_REGION=eu-west-1 ZUDOCS_SSM_KEY_ID=alias/aws/ssm bash scripts/ssm-put-agent-key.sh
npm run eu:proof              # with ZUDOCS_PROOF_PASSWORD: the row, then status and doctor on the host through Run Command
```

The first boot takes about ten minutes (the Python worker's dependencies), and a fresh host — this one, and every
replacement — starts with the current release **staged**: the daemon pins `unlock_required`, so the desk's Approvals
section shows it and the owner approves it before the host serves anything. `docs/EU-WEST.md` has the proof flags
(`--approve`, `--enqueue`, `--cli`, `--wire`). Bedrock in a fresh account needs, per model, an agreement (`CreateFoundationModelAgreement`,
which the console's "model access" page does) and an account verification AWS runs in the background; until both are
done the desk shows the refusal on the run panel — it never simulates a model. `npm run desk:proof` (with
`ZUDOCS_PROOF_PASSWORD` in the environment) runs one ticket end to end and checks the status row, the timeline and
the CloudWatch metrics; `--expect-cap N` after a deploy with `--context dailyRunCap=N` proves the daily cap refuses
visibly. The owner signs in at https://desk.zudocs.com with the hosted UI; the proof user signs in only through the
`proof` client's password flow, which has no hosted UI.

## Licence

BSD-3-Clause. Zudocs is a fictional company built to demonstrate AirPrompter.
