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

## What is here today (phases 1–2)

```
infra/             CDK: ZudocsCi (the deploy role), ZudocsDns (the zone), ZudocsSite (landing page,
                   sign-in, budget, trail) — all us-east-1
apps/landing/      the public site at zudocs.com
airprompter.config.json   where the prompts live in AirPrompter: identifiers only, never a key
prompts/           the local registry for `airprompter dev` — ignored; `npm run prompts:seed` fills it
keys/              public root JWKs the hosts and the verify action pin (dev today, prod at the cutover)
scripts/           prompts-seed, dev-smoke, dev-proof, account-baseline.sh, check-headers, check-keys
docs/              ARCHITECTURE.md, PROMPTS.md (the slots, variables, checks, golden set, models)
```

Phase 2 put the prompts in AirPrompter: one Agent, `zudocs-support`, four slots (`support.triage` on Nova Micro;
`support.reply` and the two-step escalation on GPT-5.6 Luna), variables the desk fills from its own customer table,
declared output checks, a golden set, settings on the version — promoted to the dev environment. `docs/PROMPTS.md`
is the contract; the text is not here.

Later phases add `apps/desk/` (phase 3), `services/` (phases 3–5), the demo script and the reset path
(phase 6). See `docs/ARCHITECTURE.md`.

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
npm run synth          # CDK synth with a placeholder account and no budget e-mail: no credentials needed
```

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

## Licence

BSD-3-Clause. Zudocs is a fictional company built to demonstrate AirPrompter.
