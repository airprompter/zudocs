# Security

Zudocs is a reference deployment that runs on real AWS infrastructure and publicly documents its own
threat model (`RUNBOOK.md` › "Keys, exactly", `docs/EU-WEST.md`, `docs/FLEET.md`, `docs/ARCHITECTURE.md` ›
Invariants). This file says how to report a problem with it, and what in this repository is public on
purpose so a scanner's alarm can be judged against the intent.

## Reporting

Do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting on this
repository ("Security" → "Report a vulnerability"). Say which host or
region the finding touches (us-east-1 desk API, eu-west-1 daemon host, ap-southeast-1 puller or air-gapped
host, the desk app, the deploy role) and include the desk's `state()` output or the SDK's event names if
they help — never a key, a session token or prompt text.

Findings against the AirPrompter platform, the Agent SDK or the released CLI belong to those projects;
report them there. What this repository owns is how a customer wires those pieces to AWS.

## Public on purpose

A secret scanner will flag some of what is committed here. Each of these is intended and checked:

- `keys/*.jwk.json` — **public** root keys the hosts and the verify action pin. `npm run check-keys` refuses
  a file with a private member; CI runs it.
- `airprompter.config.json` — organization, workspace and agent identifiers, the dev CDN root and pointer
  URLs. Identifiers only; a key never enters a script except through the environment, and no script prints
  one or takes one on argv (`CONTRIBUTING.md`).
- `vendored/zudocs-ci.dev.apbundle` — one signed bundle: the `zudocs-ci` Agent's placeholder slot, not a
  Zudocs prompt. `npm run check-vendored` refuses any other agent or slot; it is verified weekly with no key.
- `infra/cdk.json` — the domain, the GitHub owner and repository ids the deploy role trusts, and SES DKIM
  tokens. All are public or derivable; none grants access.

## Never in this repository

An Agent key, the run key, a session token, a private JWK, prompt text, a ticket body or a model's answer.
The hosts read keys from SSM SecureStrings at start; user data never carries one and `infra/test/*` pins
that. If you find one of these in git history, report it as above — that is a real leak, whatever the file.

## Scope of the deployment

This is a demonstration account with a monthly budget and no customer data. A fork deploys to *your*
account: change `infra/cdk.json`'s `github.ownerId` / `repoId` before the deploy role exists, or the role
trusts the upstream repository, not yours.
