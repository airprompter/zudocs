# Contributing

Zudocs is a reference deployment, so the bar is "would a customer copy this?". Every change is a pull
request that goes through an adversarial review before merge, and `main` deploys.

## Rules that do not bend

- Only public packages (`@airprompter/agent-sdk`, `airprompter-agent`, the released CLI). Nothing
  imports from AirPrompter's private repositories; nothing uses a platform-internal name.
- No key anywhere in git, on a command line, or in a log. Agent keys and the run key are SSM
  SecureStrings the owner writes with `--cli-input-json file://…`; hosts read them at start.
- No prompt text in git. `prompts/` is ignored and seeded from AirPrompter by `npm run prompts:seed` (the
  session token from `airprompter login` in the environment); the golden cases under it are content too.
- `keys/` holds public JWKs only (`npm run check-keys` refuses a private member).
- Identifiers (organization, workspace, agent ids) may be committed in `airprompter.config.json`; keys and
  session tokens enter a script through the environment only, and no script prints one or takes one on argv.
- Nothing on the desk is invented: every value comes from the SDK's results. At a cap, refuse visibly.
- The desk API and the eu-west workers never log `rendered.text`, a ticket body or a model's answer; log lines
  carry ids, counts and the SDK's own events. The app's CSP allows no inline style or script, so components use
  classes only.
- On the eu-west host one process is configured with the Agent key (`airprompterd`, from a root-only file written
  from SSM); the workers' environment carries identifiers only and they refuse to start with a key in it; the import
  timer gets the same file as a systemd credential and hands the value to the CLI's environment only. User data
  never carries a key; the stack's tests pin it. The workers share the daemon's uid (the socket is 0600), so this is
  configuration, not a boundary — `docs/EU-WEST.md` › "Keys, exactly" says so.
- The air-gapped host holds no Agent key and no base URL (its env reader refuses either); its distribution private
  key is born on the host, stays at 0600, and its role can write exactly the public half to the exchange. The puller
  is the one process in ap-southeast-1 with the Agent key, read from SSM by name at cold start.
- Nothing on the air-gapped host pretends to call a model: its render probes file `status: "refused"` observations.
- The one bundle in git is `vendored/zudocs-ci.dev.apbundle`, the `zudocs-ci` Agent's placeholder slot;
  `npm run check-vendored` refuses any other agent or slot. The recorded strips under `docs/strips/` are written by
  `scripts/strip.sh`, which refuses to keep anything key-shaped; do not edit them by hand.
- The desk's host CLI is an allowlist of exact `zudocs-cli` lines (`services/desk-api/src/hostCli.ts`); a new drill
  is a new entry and a test, never an argument from the request.

## File headers

Every source file (`.ts`, `.mjs`, `.js`, `.py`, `.sh`, a shebang script with no extension, a systemd unit) opens
with a header that says what the file is for and carries one small usage example: an `@example` fenced block, a
`$ command` line, or an indented call. Tests are exempt. `npm run check-headers` enforces it; CI runs it.

## Before you push

```sh
npm run check-headers && npm run check-keys && npm run check-vendored && npm run typecheck && npm test && npm run build && npm run synth
```

A change to the seed, the smoke or the prompt-file grammar is also run for real: `npm run prompts:seed && npm run
dev:smoke` (needs the CLI and a login), and `npm run dev:proof` when the SDK path changed (needs the Agent key in
the environment). Their output carries ids, counts and verdicts and never prompt text or a key, so paste it into
the pull request.

## Deploying

CI deploys `ZudocsDns`, `ZudocsSite`, `ZudocsSharedHost`, `ZudocsFleet` and `ZudocsDesk` from `main` through the OIDC
role (the desk API bundle, the desk app, the eu-west host bundle, the puller and the airgap bundle are built in the
workflow first: `npm run build`; the desk stack is ordered after the host and fleet stacks because it names the host's
role and function and the nudge queue). A change under `services/eu-host/` or to its `pins.json` replaces the eu-west
instance; a change under `services/airgap/` or to its `pins.json` replaces the air-gapped instance on the next
`airgap:up`. `ZudocsAirgap` is deployed on demand from the owner's profile only (`npm run airgap:up` / `airgap:down`;
`infra/test/airgap-stack.test.ts` pins that CI never lists it). `ZudocsCi` (the role itself) and the CDK bootstrap are
deployed from the owner's Identity Center session only — see the README's "First deploy".
