# Zudocs

Zudocs is a fictional documentation company. Its support desk is powered by prompts that live in
[AirPrompter](https://airprompter.com) — not in this repository — and this repository is the whole
company: the landing page, the desk, and the hosts in three AWS regions that run the prompts and report
back. It exists to show, on real infrastructure, how a customer deploys the AirPrompter Agent SDK, how a
prompt change reaches every running host without a deploy, what a run looks like, and what leaves the
host.

Everything here depends only on what any customer has: the public npm and PyPI packages, the released
CLI, the public root key, and keys issued in the AirPrompter console. No prompt text is committed. No key
is ever in this repository, on a command line, or in a log.

## Start here

Pick by who you are.

| You are… | Read | Then |
|---|---|---|
| an engineer asking "how do I wire the Agent SDK into Lambda, a daemon host, or an air-gapped box?" | `docs/ARCHITECTURE.md` (the diagram and the invariants) | `docs/DESK.md` → `services/desk-api/src/`; `docs/EU-WEST.md` → `services/eu-host/`; `docs/FLEET.md` → `services/puller/`, `services/airgap/` |
| operating the deployment | `RUNBOOK.md` (every key, every drill, the reset) | `npm run demo:dryrun` exercises every panel against the live deployment |
| changing the code | `CONTRIBUTING.md` (the rules that do not bend) | `SECURITY.md` for what is public on purpose |
| forking it | "First deploy" below | change `infra/cdk.json` before the deploy role exists |

**What runs with nothing.** `npm ci && npm test && npm run synth` needs no AWS credentials, no AirPrompter
login and no CLI: the tests run against the SDK's fake control plane, and synth uses a placeholder account.
Every check in "Run the checks" is credential-less; CI runs the same list on every pull request, forks included.

**What does not.** Deploying needs your own AWS account and an AirPrompter organization; the proofs, the
smoke and the dry run need a login to AirPrompter dev, an Agent key from the console and the owner's AWS profile.
Nothing here can be stood up from a clone alone; `git log` owns the how, the tree owns the where.

## What is here

```
infra/             CDK: ZudocsCi (the deploy role), ZudocsDns (the zone), ZudocsSite (landing page, sign-in, budget,
                   trail, the monthly cost check), ZudocsDesk (the desk API, its tables and key, the desk app) in us-east-1;
                   ZudocsSharedHost (the daemon host, the wire and power functions, the nightly sleep, the demo-mode switch) in eu-west-1; ZudocsFleet (the puller, the
                   releases table, the exchange bucket, the nudge queue) and ZudocsAirgap (the air-gapped host, on demand) in
                   ap-southeast-1
apps/landing/      the public site at zudocs.com
apps/desk/         the desk at desk.zudocs.com: React + Vite, hosted-UI sign-in, the run panel, the fleet, approvals, the timeline
services/desk-api/ the us-east-1 host: one Lambda running the Agent SDK in on_invoke mode (docs/DESK.md)
services/eu-host/  the eu-west-1 host: airprompterd, the Node and Python workers, the import timer, the units, the boot script, the wire, the power (docs/EU-WEST.md)
services/cost-check/ the monthly cost check: Cost Explorer → cost/YYYY-MM.json in the trail bucket + Zudocs/Cost metrics
services/puller/   the ap-southeast-1 puller: pointer-first pullBundle into the releases table and the exchange bucket, the nudge's consumer (docs/FLEET.md)
services/airgap/   the ap-southeast-1 air-gapped host: the offline runtime, the keygen, the export timer, the units, the boot script (docs/FLEET.md)
airprompter.config.json   where the prompts live in AirPrompter: identifiers only, never a key; `providers` names the model the
                   desk's provider switch sends a reply to on the OpenAI API and the Claude API (the keys are SSM parameters)
prompts/           the local registry for `airprompter dev` — ignored; `npm run prompts:seed` fills it
keys/              public root JWKs the hosts and the verify action pin (dev today, prod at the cutover)
vendored/          the one bundle in git: the zudocs-ci Agent's placeholder slot, verified weekly with no key (vendored/README.md)
scripts/           prompts-seed, dev-smoke, dev-proof, desk-proof, eu-host-proof, fleet-proof, airgap (up / down / status / run),
                   demo-console (every console act as one command), demo-dryrun (every panel exercised and asserted), demo-reset
                   (reset means advance), power (host:sleep / host:wake / host:status / demo:mode), cost-report, teardown (dry run
                   or for real), strip.sh (the CLI drills, recorded outside the tree), vendor.sh (the vendoring PR), ci-telemetry-validate,
                   check-vendored, ssm-put-agent-key.sh, cognito-users.sh, account-baseline.sh, check-headers, check-keys
docs/              ARCHITECTURE.md, PROMPTS.md (the slots, variables, checks, golden set, models), DESK.md (the us-east host
                   and the app), EU-WEST.md (the daemon host, the approval, the wire), FLEET.md (the puller, the exchange, the
                   air-gapped host, export/import)
RUNBOOK.md         the operator's side: every key and its rotation, the drills, host replacement, the reset, the vendoring PR
SECURITY.md        how to report a vulnerability, and what is committed on purpose (public root keys, identifiers, one placeholder bundle)
```

## What it shows

- **The prompts live in AirPrompter, not here.** One Agent, four slots (triage, reply, a two-step escalation), variables,
  declared output checks, a golden set, settings sealed on the version — `docs/PROMPTS.md` is the contract; the text is not in git.
- **Three shapes of host, one signed release.** A Lambda in `on_invoke` mode (`docs/DESK.md`), a daemon host with attached
  Node and Python workers under `unlock_required` (`docs/EU-WEST.md`), a puller feeding an air-gapped host by sealed
  exchange (`docs/FLEET.md`). A promotion reaches all of them without a deploy; the owner activates where the policy says so.
- **What a run looks like.** Every number on the desk's run panel is the SDK's own: the render, the observation, the
  per-check verdicts, the judge, the feedback — nothing simulated, every refusal in the platform's words.
- **Four routes for the same reply.** The release's model in this account (Bedrock), the OpenAI API and the Claude API
  with keys of the customer's own (ordinary clients under the SDK's `wrap()`; the observation is filed under the
  model the call named, the release's settings applied in the provider's names), and AirPrompter's hosted route.
  **Compare all** on the desk runs every configured route and shows the rows side by side.
- **Experiments, safety nets, the wire.** Ramped experiments with per-host arm assignment, a freeze that refuses before a
  cap slot is taken, rollback, golden sets, a cut wire the host serves through for the lease, and only rows — never text —
  leaving the host.
- **The steady state.** The eu-west host sleeps at night and wakes on demand; a demo-mode switch sets the workers' cadence;
  a monthly cost check and a teardown script.

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
npm run check-headers && npm run check-keys && npm run check-vendored && npm run typecheck && npm test
npm run build          # the desk API bundle, the desk app, the eu-west host bundle, the wire and power functions, the puller, the cost check — the stacks deploy these
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

### The desk, once

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

### The fleet, once

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

### The eu-west host, once

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
