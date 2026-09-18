# keys/

Public root JWKs only — the keys the hosts and the verify action pin so a release is trusted only when
AirPrompter's root signed it. Public by nature; committing them is the point (a pull request that
changes one is a pull request everyone sees).

- `dev.root.jwk.json` — the dev root, while the demo proves on dev: the `root` role key of the signed root
  document at `https://dwp5emkmjpv8.cloudfront.net/roots/dev/root.json` (`rootUrl` in `airprompter.config.json`),
  which is what the SDK verifies against this pin before trusting any manifest. Pinned by `scripts/dev-proof.mjs`
  and, from phase 3, by every host.
- `prod.root.jwk.json` — the production root, from the prod cutover phase on

`npm run check-keys` refuses any file here with a private member.

No private key of any kind is ever in this repository.
