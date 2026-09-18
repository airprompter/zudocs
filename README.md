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

## Layout

```
infra/             CDK: one stack per region plus the CI (GitHub OIDC) stack
apps/landing/      the public site at zudocs.com
apps/desk/         the support desk (React) at desk.zudocs.com — phase 3
services/          the hosts: desk-api (us-east-1 Lambda), eu-host (daemon + workers), puller, airgap
prompts/           the local registry for `airprompter dev` — seeded by a script, never committed
keys/              public root JWKs the verify action pins
scripts/           account baseline, seed, replay, reset, cost report, teardown
docs/              ARCHITECTURE, COST, RUNBOOK, DEMO
```

## Run it

```sh
npm install
npm test                                   # infra assertions
npm run synth                              # CDK synth, no credentials needed
AWS_PROFILE=zudocs npm run deploy -- ZudocsSite   # from a signed-in Identity Center session
```

The account baseline (`scripts/account-baseline.sh`) runs once per account and needs an administrator
session; every deploy after that comes from CI through the OIDC role.

## Status

Phase 1 of the plan (site, sign-in, budget, trail). Later phases add the desk, the three host shapes,
the demo script and the reset path. See `docs/ARCHITECTURE.md`.

## Licence

BSD-3-Clause. Zudocs is a fictional company built to demonstrate AirPrompter.
