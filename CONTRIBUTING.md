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
- The desk API never logs `rendered.text`, a ticket body or a model's answer; log lines carry ids, counts and
  the SDK's own events. The app's CSP allows no inline style or script, so components use classes only.

## File headers

Every source file (`.ts`, `.mjs`, `.js`, `.py`, `.sh`) opens with a header that says what the file is
for and carries one small usage example: an `@example` fenced block, a `$ command` line, or an
indented call. Tests are exempt. `npm run check-headers` enforces it; CI runs it.

## Before you push

```sh
npm run check-headers && npm run check-keys && npm run typecheck && npm test && npm run synth
```

A change to the seed, the smoke or the prompt-file grammar is also run for real: `npm run prompts:seed && npm run
dev:smoke` (needs the CLI and a login), and `npm run dev:proof` when the SDK path changed (needs the Agent key in
the environment). Their output carries ids, counts and verdicts and never prompt text or a key, so paste it into
the pull request.

## Deploying

CI deploys `ZudocsDns`, `ZudocsSite` and `ZudocsDesk` from `main` through the OIDC role (the desk API bundle and
the desk app are built in the workflow first: `npm run build`). `ZudocsCi` (the role
itself) and the CDK bootstrap are deployed from the owner's Identity Center session only — see the
README's "First deploy".
