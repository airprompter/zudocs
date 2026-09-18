# keys/

Public root JWKs only — the keys the hosts and the verify action pin so a release is trusted only when
AirPrompter's root signed it. Public by nature; committing them is the point (a pull request that
changes one is a pull request everyone sees).

- `dev.root.jwk.json` — the dev root, while the demo proves on dev
- `prod.root.jwk.json` — the production root, from the prod cutover phase on

No private key of any kind is ever in this repository.
