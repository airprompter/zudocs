# The prompts

Zudocs' support desk is one AirPrompter Agent, `zudocs-support`, with four prompt slots. The prompt text lives in
AirPrompter and is never in this repository; what this page describes is the contract the desk codes against —
slots, variables, checks, golden sets, models, environments — and how a developer gets a local copy to work with.

## Where they live

`airprompter.config.json` names the deployment (identifiers only; every value can be overridden by the environment
variable of the same name, `AIRPROMPTER_AGENT_ID` and so on):

| Field | Value | Meaning |
|---|---|---|
| `baseUrl` | `https://api-dev.airprompter.com` | AirPrompter's dev deployment — phases 2–6 prove there; the prod cutover switches it |
| `hostedEnvironment` | `dev` | which AirPrompter deployment's root key is pinned (`keys/dev.root.jwk.json`) |
| `rootUrl` | `https://dwp5emkmjpv8.cloudfront.net/roots/dev/root.json` | the signed root document the pinned key verifies |
| `organizationId` / `workspaceId` / `agentId` | the "Zudocs" workspace and the `zudocs-support` Agent | the scope every SDK call carries |
| `environment` | `dev` | the Agent environment this checkout syncs (`staging`, `prod` later) |
| `models` | `amazon.nova-micro`, `openai.gpt-5-6-luna` | what this application can call — reported on every heartbeat; a seal refuses a slot pinned to a model no instance reports |

Secrets are never in that file. Two of them exist:

- **The Agent key** (`AIRPROMPTER_AGENT_KEY`): minted in the console under the app's Settings › Keys, bound to one
  environment. On a laptop it lives in a `0600` file outside the repository (for example `~/.config/zudocs/dev.env`)
  and enters the environment with `set -a; . ~/.config/zudocs/dev.env; set +a`. On hosts it is an SSM SecureString.
- **A session token** (`AIRPROMPTER_SESSION_TOKEN`): what `airprompter login` prints for a signed-in workspace member;
  it lasts about an hour and is what the seed reads. Team reads and writes are a person's, never an API key's.

## The slots

| Slot | Model | Variables | Declared output checks | Settings on the version |
|---|---|---|---|---|
| `support.triage` | `amazon.nova-micro` | `ticket?` | `shape` (json_schema: `category`, `priority`, `summary`), `category` (enum), `priority` (enum) | temperature 0, max 200 tokens |
| `support.reply` | `openai.gpt-5-6-luna` | `tone=friendly`, `customer_tier!~`, `ticket?` | `under-300-tokens` (length), `no-guarantee` (must_not_match), `signed` (must_match) | max 600 tokens, reasoning effort low |
| `support.escalate.summary` | `openai.gpt-5-6-luna` | `ticket?` | `has-symptom` (must_match), `under-400-tokens` (length) | max 400 tokens, reasoning effort low |
| `support.escalate.handoff` | `openai.gpt-5-6-luna` | `summary!`, `customer_tier!~` | `has-severity` (must_match) | max 500 tokens, reasoning effort low |

The variable markers are the CLI's grammar: `name!` required, `name?` end-user text — fenced `<name>…</name>` at
render time, so a ticket is data the model reads and never instructions it follows — `name~` filled by the
application's own source (`source: runtime`), `name=default` an optional operator variable with its default.

- `tone` has a default: nobody passes it and the reply is friendly; the desk passes `tone: "formal"` for an
  enterprise customer and nothing else changes.
- `customer_tier` is the desk's own data. The runtime registers once how a customer's plan is found in its own
  table and every version that uses the variable is filled at render time; the call site never passes it.
  `status().variables.unsourced` at start-up names it if nothing fills it (`needs()` answers the same per render),
  and the console warns at seal time when no live instance reports the name.
- `ticket` is what the customer wrote: end-user trust, always fenced.
- `support.reply` carries a `## Success criteria` section; `ap.judge(runRef, output, "prompt", invoke)` reads it
  and files a score, never the reasoning.
- `support.escalate` is the desk's two-step escalation: step 1 (`summary`) condenses the ticket, the desk passes its
  answer to step 2 (`handoff`) as `summary`. It is two prompt slots the application chains rather than one workflow
  slot — see *Gaps* below.

Categories the triage prompt answers with: `search`, `permissions`, `publishing`, `billing`, `other`; priorities:
`low`, `normal`, `high`, `urgent`. The `shape` check pins that as a JSON schema, so an answer that is not that JSON
counts as a failed check on the host and nothing of it leaves.

Nova Micro takes every setting, so triage pins temperature 0. GPT-5.6 Luna is a reasoning model and takes no
temperature or top-p — the seal refuses them for it — so the Luna slots carry an output cap and a reasoning effort.
The settings are part of the version and ride the release pin; the SDK's wrappers apply them when the call names
the same model.

## The golden set

`support.triage` carries a golden set of five cases (floor 80 %): a double charge (billing),
a deleted page still in search (search), a viewer who could edit (permissions, high or urgent), a public site
returning 502 (publishing, urgent), a dark-mode request (other, low). Each case is a ticket text plus expectations
in the output-check grammar — `enum` on `category` and on `priority`. A host with a model configured
(`golden.invoke`, or `airprompter verify --golden --run`) renders each case with the release's own text, asks the
model, and refuses to activate a release below the floor; only counts leave the host. The cases are content, as
sensitive as the prompt they exercise: the seed writes them under `prompts/golden/`, which is ignored.

## Environments and versions

Every slot is pinned to `rev-2` on `dev` (apply policy `auto`, lease 3600 s, `degrade` on expiry; the seed prints
the current generation and release digest). `rev-1` is the imported text; `rev-2` is the same text with the
version's settings.
Staging and prod hold nothing yet; prod's policy is `unlock_required` by default, which phase 4's eu-west host will
show. A promotion is a new generation, and every host learns of it by pull — the SDK's edge pointer (one CDN
304 per idle poll), the origin only when the pointer moved.

## The local registry (`./prompts`)

`airprompter dev ./prompts --daemon` serves a directory of prompt files as a registry over the protocol's own
routes — a dev key, a self-made root, every save a generation — so the desk on a laptop syncs from it exactly as
from AirPrompter. The directory is **ignored**; only `prompts/.gitkeep` is committed, and the seed fills it:

```sh
eval "$(.bin/airprompter login --email you@zudocs.com --base-url https://api-dev.airprompter.com)"
npm run prompts:seed            # ./prompts from the release promoted to dev
npm run dev:smoke               # airprompter dev --daemon + the SDK: renders, fills, fences, checks; no model, no AirPrompter
```

The seed writes one file per slot — front matter `tag`, `model`, `version`, `variables` (the grammar above), and
two lines the CLI ignores but the smoke reads, `checks:` (the pin's enabled checks) and `inference:` (the pin's
settings in the wire's integers, `temperatureMilli` and so on) as JSON — then the version's text; `release.json`
with the environment's apply policy and lease; `golden/<tag>.json` for each golden set, refused when the slot's set
is no longer the one the release pinned. It writes only after every read succeeded, only into a directory that
holds nothing but a registry, and replaces everything there except `.gitkeep` and `.airprompter-dev/` (the dev keys
and the generation counter, so a client that holds generation N never sees a fresh N). The four routes it reads are
the console's own workspace API — what the app's pages call, with no compatibility promise — so every field it
depends on is checked by name and a rename fails as an error, never as a corrupt file.

The CLI is installed by hand, not by npm: download `airprompter-darwin-arm64` (or your platform) and its `.sha256`
from the `cli/v0.1.0` release of `airprompter/airprompter-agent-sdk`, compare digests, `chmod +x`, and put it at
`.bin/airprompter` (ignored) or on your `PATH` (`AIRPROMPTER_CLI` overrides where the smoke looks).

`npm run dev:proof` is the same render against AirPrompter itself: the SDK syncs the promoted release with the
Agent key from the environment, verifies it against `keys/dev.root.jwk.json`, renders `support.reply` for two
customers whose tiers its own table supplies (the renders differ by exactly the tier), runs the checks on the wire
against a canned answer without recording them, and sends one heartbeat. It invents nothing: no observation of a
model call that did not happen. Neither script prints prompt text, so their output can go into a pull request.

## Gaps found while building this (recorded, not hidden)

- **No workflow slot.** The console has no path to a workflow *version*: `submitted_for_review` is emitted from
  exactly one place (snapshotting a prompt version), so a workflow never reaches the picker and `POST …/slots`
  with `kind: "workflow"` has nothing to attach. `airprompter dev` has no step grammar either. The escalation is
  therefore two prompt slots chained by the application; when workflow versions exist, `support.escalate` becomes
  one slot with `ap.workflow(tag)` and step attribution.
- **The dev registry carries no checks, settings or golden sets.** The CLI's front matter reads `tag`, `model`,
  `variables` and `version` only, so the daemon serves the release without `outputChecks`, `inference` or
  `goldenSet`; `ap.checks()` on a render from it finds nothing. The seed writes them anyway and the smoke evaluates
  the checks with the public evaluator (`evaluateChecks` from the SDK) so the file is a faithful copy of the pin.
  Against AirPrompter itself (`dev:proof`) the checks are on the wire and `ap.checks()` runs them.
- **`airprompter dev` serves every `.md` in the directory**, so a `README.md` beside the prompts became a slot
  called `readme` pinned to a model no host has. That is why the registry's README is this page and the directory
  holds a `.gitkeep`.
- **A default with a comma cannot be written.** The `variables:` line is comma-separated, so the seed refuses a
  default that holds one rather than corrupt it; change the default in AirPrompter or fill it at the call site.
