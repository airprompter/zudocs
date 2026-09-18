# prompts/

The local registry that `airprompter dev` serves while you work on the desk on a laptop. It is
**not committed** — prompt text lives in AirPrompter, and this directory also holds the dev root key
(`.airprompter-dev/`) that must never reach git.

Seed it from a console export (the seed script arrives in phase 2 with the prompts themselves):

```sh
npm run prompts:seed            # phase 2
airprompter dev ./prompts --daemon
```

Each file is one prompt with front matter for its model, variables and defaults (`customer_tier~`,
`tone=friendly`); `release.json` beside them carries the environment policy. See the SDK's
`cli/README.md` › `dev`.
