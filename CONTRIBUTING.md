# Contributing

Zudocs is a reference deployment, so the bar is "would a customer copy this?". Every change is a pull
request that goes through an adversarial review before merge, and `main` deploys.

## Rules that do not bend

- Only public packages (`@airprompter/agent-sdk`, `airprompter-agent`, the released CLI). Nothing
  imports from AirPrompter's private repositories; nothing uses a platform-internal name.
- No key anywhere in git, on a command line, or in a log. Agent keys and the run key are SSM
  SecureStrings the owner writes with `--cli-input-json file://…`; hosts read them at start.
- No prompt text in git. `prompts/` is ignored and seeded from a console export.
- `keys/` holds public JWKs only (`npm run check-keys` refuses a private member).
- Nothing on the desk is invented: every value comes from the SDK's results. At a cap, refuse visibly.

## File headers

Every source file (`.ts`, `.mjs`, `.js`, `.py`, `.sh`) opens with a header that says what the file is
for and carries one small usage example: an `@example` fenced block, a `$ command` line, or an
indented call. Tests are exempt. `npm run check-headers` enforces it; CI runs it.

## Before you push

```sh
npm run check-headers && npm run check-keys && npm run typecheck && npm test && npm run synth
```

## Deploying

CI deploys `ZudocsDns` and `ZudocsSite` from `main` through the OIDC role. `ZudocsCi` (the role
itself) and the CDK bootstrap are deployed from the owner's Identity Center session only — see the
README's "First deploy".
