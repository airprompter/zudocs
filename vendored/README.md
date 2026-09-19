# vendored/

The one bundle this public repository commits: `zudocs-ci.dev.apbundle` (and its `.meta.json` sidecar), pulled
from the **`zudocs-ci`** Agent on AirPrompter dev — a separate Agent with a single placeholder slot,
`ci.vendoring`, whose only text says it is a placeholder. It exists so that a real, signed bundle can be verified
in CI with no key (`airprompter verify … --root keys/dev.root.jwk.json`) and so the vendoring pull request is a real
drill (`diff --against`, the verify action): the Zudocs support prompts live in the `zudocs-support` Agent and are
never vendored. `scripts/check-vendored.mjs` refuses any other agent or slot; the CLI's `pull --plaintext` warning
(*dev only; never commit it*) is about a customer's own prompts, which this is not.

Refresh: `npm run vendor` with the CI agent's key in the environment (RUNBOOK.md › The vendoring pull request).
