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

## What is here today (phase 1)

```
infra/             CDK: ZudocsCi (the deploy role), ZudocsDns (the zone), ZudocsSite (landing page,
                   sign-in, budget, trail) — all us-east-1
apps/landing/      the public site at zudocs.com
prompts/           the local registry for `airprompter dev` — ignored; seeded in phase 2
keys/              public root JWKs the verify action pins — filled in phase 2
scripts/           account-baseline.sh, check-headers.mjs, check-keys.mjs
docs/              ARCHITECTURE.md
```

Later phases add `apps/desk/` (phase 3), `services/` (phases 3–5), the demo script and the reset path
(phase 6). See `docs/ARCHITECTURE.md`.

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

Then set the repository variables `AWS_ACCOUNT_ID` and `BUDGET_EMAIL`, and `main` deploys.

## Licence

BSD-3-Clause. Zudocs is a fictional company built to demonstrate AirPrompter.
