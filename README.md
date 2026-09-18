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

## What is here today (phases 1–3)

```
infra/             CDK: ZudocsCi (the deploy role), ZudocsDns (the zone), ZudocsSite (landing page,
                   sign-in, budget, trail), ZudocsDesk (the desk API, its tables and key, the desk app) — all us-east-1
apps/landing/      the public site at zudocs.com
apps/desk/         the desk at desk.zudocs.com: React + Vite, hosted-UI sign-in, the run panel, the fleet, the timeline
services/desk-api/ the us-east-1 host: one Lambda running the Agent SDK in on_invoke mode (docs/DESK.md)
airprompter.config.json   where the prompts live in AirPrompter: identifiers only, never a key
prompts/           the local registry for `airprompter dev` — ignored; `npm run prompts:seed` fills it
keys/              public root JWKs the hosts and the verify action pin (dev today, prod at the cutover)
scripts/           prompts-seed, dev-smoke, dev-proof, desk-proof, ssm-put-agent-key.sh, cognito-users.sh,
                   account-baseline.sh, check-headers, check-keys
docs/              ARCHITECTURE.md, PROMPTS.md (the slots, variables, checks, golden set, models), DESK.md (the host and the app)
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
[desk.zudocs.com](https://desk.zudocs.com). `docs/DESK.md` is the tour. Phases 4 and 5 add `services/eu-host/` and
`services/puller/` + `services/airgap/`; phase 6 the demo script and the reset path. See `docs/ARCHITECTURE.md`.

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
npm run build          # the desk API bundle (esbuild) and the desk app (vite) — the desk stack deploys these
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
next request after it exists starts the host. Bedrock in a fresh account needs, per model, an agreement (`CreateFoundationModelAgreement`,
which the console's "model access" page does) and an account verification AWS runs in the background; until both are
done the desk shows the refusal on the run panel — it never simulates a model. `npm run desk:proof` (with
`ZUDOCS_PROOF_PASSWORD` in the environment) runs one ticket end to end and checks the status row, the timeline and
the CloudWatch metrics; `--expect-cap N` after a deploy with `--context dailyRunCap=N` proves the daily cap refuses
visibly. The owner signs in at https://desk.zudocs.com with the hosted UI; the proof user signs in only through the
`proof` client's password flow, which has no hosted UI.

## Licence

BSD-3-Clause. Zudocs is a fictional company built to demonstrate AirPrompter.
