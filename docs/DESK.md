# The desk: the us-east-1 host and the app

Phase 3 is the first production host and the desk app. One Lambda runs the public Agent SDK; one
React app shows what it did. This page is the tour of what is where, what each number on the run panel is, and
the honest notes — what the SDK cannot do on this host yet, and how the desk says so instead of pretending.

## The host (`services/desk-api`)

| Piece | What it is | Where |
|---|---|---|
| Sync | `sync: { mode: "on_invoke" }` — a pull before every invocation through the edge pointer (one CDN 304 when nothing moved), the invocation's telemetry flushed under the runtime's own grant before `invoke()` returns | `src/runtime.ts` |
| Store | `stateDir: /tmp/airprompter/<STATE_EPOCH>`; the slot store's data key wrapped by a KMS key through `customKeyProvider` — one Encrypt when a container first opens the store, one Decrypt on later opens; the heartbeat reports `storageProtection: kms` | `src/runtime.ts`, the key in `infra/lib/desk-stack.ts` |
| Agent key | Read at cold start from the SSM SecureString `/zudocs/dev/agent-key` by NAME (the function's only SSM permission), decrypted by SSM with the same key; held in memory, never an environment variable, never logged | `src/runtime.ts`, `scripts/ssm-put-agent-key.sh` |
| Policy | `apply.policy: "auto"` — a container has nobody to unlock it; `unlock_required` is the eu-west host's beat (phase 4) | `src/runtime.ts` |
| Models | `models: ["openai.gpt-5-6-luna", "amazon.nova-micro", "anthropic.claude-haiku-4-5"]` reported on every heartbeat, in AirPrompter's spelling; a release pinned to anything else is refused before it activates | `src/modelCatalogue.ts` |
| Luna | Bedrock's OpenAI-compatible `bedrock-mantle` endpoint — the one with a live GPT-5.6 quota in a fresh account — through an `openai` client under `ap.wrap()`; the transport signs with SigV4 from the role and rewrites `model` to Bedrock's id (`openai.gpt-5.6-luna`); the wrapper applies the version's settings (output cap, reasoning effort) and files the observation under the release's name | `src/bedrock.ts` |
| Nova Micro, Haiku | Converse through the Vercel AI SDK's Bedrock provider under `ap.aiSdkMiddleware()`; the provider model is aliased to the release's name so settings and observations land on it | `src/bedrock.ts` |
| Provider switch | Phase 9: `POST /tickets/{id}/run` with `{ "provider": "openai" \| "anthropic" }` sends the reply step to that API with the customer's own key — an ordinary `openai` / `@anthropic-ai/sdk` client under `ap.wrap()`, the render's text in the request, the observation filed under the model the call named (`gpt-5.6-luna`, `claude-opus-5`; `OPENAI_MODEL` / `ANTHROPIC_MODEL`), the release's settings applied here in the provider's names and the record saying which the model does not take. Triage stays on the host's own path. The keys are SSM SecureStrings by NAME (`OPENAI_KEY_PARAMETER`, `ANTHROPIC_KEY_PARAMETER`), read on first use, held in memory; a provider the stack names no parameter for answers 501 `provider_not_configured`. `GET /state` carries `providers` (configured, model — never a key). AirPrompter's own door is the hosted route below | `src/providers.ts`, `src/run.ts`, `src/handler.ts` |
| Variables | `customer_tier` from the customers table, registered once as a source (`trust: operator`, 1.5 s timeout); `tone: "formal"` passed only for an enterprise customer; the ticket fenced as end-user text | `src/runtime.ts`, `src/run.ts` |
| Judge | `ap.judge(runRef, output, "prompt", invoke)` — the reply prompt's own `## Success criteria`, scored on Nova Micro; only the score leaves the host | `src/run.ts` |
| Feedback | thumbs / accepted / edited → `ap.feedback(runRef, signals)`; the SDK's verdict (declared signals only) is the API's answer | `src/handler.ts` |
| Telemetry | The SDK's normal upload to AirPrompter, and the tee: the same segment's rows as CloudWatch EMF lines on stdout, only after AirPrompter accepted the segment; dimensions capped to `tag`, `versionId`, `arm`, `status` | `src/tee.ts` |
| Cap | 2,000 runs per UTC day (an atomic DynamoDB counter, refused at the line); HTTP 429 `daily_cap` with the count — nothing is simulated | `src/store.ts`, `src/handler.ts` |
| Status and timeline | Every run and presenter action writes `status()` + `healthz()` to the status table (one row per host); `onChange` and every action append to the events table (partitioned by UTC day). The eu-west host writes the same tables across regions (`docs/EU-WEST.md`) | `src/runtime.ts`, `src/store.ts` |
| Approvals | The eu-west host's staged releases: the host opens the row, `POST /approvals/{id}/approve` flips it `pending → approved` exactly once under the signer's e-mail (a repeat answers `already: true` with the row as it stands; a row the host has moved past — a newer generation staged on the same store, or the host's later status row naming another staged generation — answers `409 approval_stale` and records nothing), the host activates through its daemon and settles it | `src/store.ts`, `src/handler.ts` |

Routes (all behind the Cognito JWT authorizer; `src/router.ts` is what the stack registers):
`GET /tickets`, `GET /tickets/{id}`, `POST /tickets/{id}/run`, `POST /tickets/{id}/escalate`,
`POST /runs/{id}/feedback`, `GET /state`, `GET /events?since=`, `GET /approvals`, `POST /approvals/{id}/approve`
(phase 4: the owner's decision on a release staged on the eu-west host, recorded once — `docs/EU-WEST.md`),
`POST /presenter/{heartbeat|upload|sync|seed|replay|enqueue|cut_wire|restore_wire|nudge|host_cli|policy|golden|reset|sleep_host|wake_host|demo_mode}`, `GET /healthz`.

### What each number on the run panel is

- **version badge** `reply rev-2 · release #1` — `Rendered.versionId` and `Rendered.generation`.
- **arm badge** — `Rendered.arm` (`none` shows as "no experiment").
- **Why this text** — `Rendered.text`, with each declared variable (`handle.variables()`) labelled by the SDK's
  precedence: passed at the call site, filled by the desk's registered source, or the version's default; the
  fence around end-user text; the version's `inference` block. The labels are the desk's own reconstruction of
  that precedence (`variableOrigins` in `run.ts`, over the declarations, the values passed and the sources
  registered) — the SDK's `Rendered` carries the text, not per-variable provenance.
- **checks strip** — `ap.checks(rendered, output, { record: false })`: the per-check verdicts of the checks the
  wrapper already counted on the window.
- **latency · tokens · usage · status** — the `Observation` the SDK filed for the call (tapped from the spool
  writer, so it is the SDK's number, not the app's stopwatch); **cost** is that usage at list price.
- **judge** — `JudgeResult.score` and the task pass/fail counts.
- **feedback row** — what `ap.feedback` accepted.
- **via the Claude API / OpenAI API** (phase 9, a run that named a provider) — `StepRecord.provider`: the model the
  call named, the release's settings the desk applied in the provider's names, the ones the model takes none of.
  The **compare table** above the runs (once two doors have answered) is one row per route, the latest run each,
  every cell the record's own number: the hosted row's price is the route's price book and it carries no per-check
  verdicts, and the table says so (`compareRows` in `TicketView.tsx`).

### Phase 6 on the desk

- `POST /tickets/{id}/hosted-run` (`hosted.ts`): the ticket through AirPrompter's hosted execution on staging —
  `ManagedAgent.stream` with the deltas' arrival offsets, `feedback` on the run's reference, one OpenAI-compatible
  call with `temperature 1.9` / `top_p 0.1` the release ignores, beside the catalogue's sealed `inference`. The run
  key is read from SSM by NAME on the first call and held in memory; a refusal is recorded in the route's words.
- `GET /arms` (`arms.ts`): the per-arm fold of the runs and feedback tables (runs by host, judge mean, cost mean,
  checks, thumbs) and the stickiness table — one row per customer, slot **and release** (the weights in force: a dial
  is a new generation, and a customer whose bucket moved with it landed on the control before and the candidate after,
  by design; hosts are compared only under the same release, so the panel never reads *control+candidate* after a
  dial). `GET /approvals` rows carry the ramp plan this host read from the same generation.
- The compat record's `ignoredByContract` (`hosted.ts`) is a constant — the contract's word that the release owns
  `temperature` and `top_p`; the response carries no settings, so nothing observes the ignoring, and the desk's chip
  says *ignored by contract* rather than pretending the route reported it.
- Presenter actions: `host_cli` (an allowlisted `zudocs-cli` command on the eu-west host through Run Command by Name
  tag, sent as the one parameter of the desk's own Command document `zudocs-desk-host-cli` — allowed values are the
  allowlist, the shell line is fixed, the role may send no other document; the CLI's document comes back, goes through
  the strips' key-shaped scan (`redact.ts`) and lands on the timeline), `policy` (`ap.setApplyPolicy`), `golden`
  (`ap.golden()` on the active release; counts only), `reset` (clear runs, feedback, approvals, events, counters;
  re-seed), `replay` up to 30.
- `/state` carries `frozen` (the manifest's `disable` directive as `status().disabled.agent`, with one fixed
  reason — `lastRefusal` may name another refusal entirely)
  and a run on a frozen host answers `423 frozen` before the cap is taken; `features.hosted`, `features.hostCli`,
  `features.power` and `features.demoMode` say what the presenter panel may offer.
- Phase 8 (`hostPower.ts`): `sleep_host` / `wake_host` invoke the eu-west power function by its fixed ARN and answer
  with its own document (a refusal — `wire_cut`, `demo_mode_on`, `several_instances`, `instance_pending`,
  `instance_stopping` — is 409 and on the timeline); `/state` folds the eu-west row's `power` marker into
  `hosts[].powerView` (asleep since / going to sleep / waking / started) and, when the marker is in transition past
  twenty seconds, asks the function to look now (a `tick`); `demo_mode` writes the eu-west switch parameter (on for
  four hours, or off — `demoMode.ts` is the one parser every reader shares) and `/state.demoMode` is the reading
  through a thirty-second cache; `host_cli` answers `409 host_asleep` while the marker says the host is off.
- The SDK starts with `golden.invoke` (a caller with no wrapper — the hook runs inside the boot sync), so every
  staged release's golden sets run against the pinned model before the apply decision; below the floor the release
  stays staged under `auto` and `status().golden` says so.

### Honest notes

- `telemetry.uploadSink` is honoured by the resident uploader; on `on_invoke` the flush posts under the grant
  through the `fetch` port, so the tee sits on that port (filed as an SDK gap). The result is the same: a window
  reaches CloudWatch exactly when it reaches AirPrompter.
- The SDK's wrappers apply a version's settings only when the call names the release's model; Bedrock spells the
  same model differently, so the transport translates and the app never writes a Bedrock id.
- `uploadNow()` answers `null` here (no resident uploader); the presenter's *Upload now* runs `flushTelemetry()`,
  which is this host's upload, and shows both answers.
- Bedrock in a fresh account: a per-model agreement (created by API) and an account verification AWS runs; until
  both are done a run shows the provider's refusal on the step and the record says `ok: false`.
- Model-invocation logging stays off (it would write prompt text to CloudWatch). The function logs the SDK's own
  events (content-free by design; the one that would echo a rejected feedback name is reduced to the SDK's reason
  codes, and the API files accepted signals only) and the tee's metric lines; never a render, a ticket or an answer.
- A run reference is minted with a key derived from the store's id, and every Lambda container creates its own
  store under `/tmp` — so a reference from the container that served a run does not parse on another (an SDK gap:
  references are not portable across serverless containers). Feedback that lands on another container is filed
  against a fresh render of the same slot for the same customer on that container — no model call (a render that
  itself fails files the SDK's error observation), the arm is sticky — and only when the prompt version, arm and
  model agree with the step's record, the facts feedback lands under on the window; otherwise the API answers
  `409 run_reference_foreign` and says why. The response's `container` field says which path filed it.
- The Budgets deny policy covers `bedrock-mantle:*` as well as `bedrock:*` invocation actions: the OpenAI-compatible
  endpoint authorises its own action (`bedrock-mantle:CreateInference` on the account's default project), which the
  first real run found and the stack now grants and denies alike.
- The app is a single-page app behind CloudFront: a path the bucket does not hold answers `index.html`. A tab left
  open across a deploy may hold a chunk name the new build pruned — reload it before a session.
- Two phase-3 follow-ups fixed in phase 4: the `cap_refused` row said "on undefined" because the event's `day` field
  is also the events table's partition key, which the reader strips — the field is `capDay` now; and the timeline
  showed rows twice because the first load and the first interval tick both polled with no `since` — one poll of
  each kind is in flight at a time now, and rows merge by the API's row id (`format.ts` › `mergeEvents`).

## The app (`apps/desk`)

Sign-in is the hosted UI over PKCE with the `desk` client (no library; `src/auth.ts`). The columns: the inbox;
the ticket with Run / Escalate and every run's cards (a run the eu-west worker made lands here too, marked with its
host); the approvals (a release staged on a host, with its Approve button, and the last decisions with their
instants), the fleet (host cards from the status table — the daemon host shows its store key in amber, its policy
pin, its lease as a countdown, its sync failures and both attached workers), the presenter panel (replay N on this
host, "run this ticket on eu-west now", heartbeat / upload / sync now, re-seed, cut / restore the wire), and the
timeline (the events table, polled; every host's activation with its instant).
Vocabulary is the customer's — *prompt version*, *release #N* — and *generation*, *manifest*, *slot*, *arm* live in
tooltips. Everything shown is the API's record.

## Sign-in users

Two, both created by hand (`scripts/cognito-users.sh`): the owner (`seth@zudocs.com`, hosted UI, temporary
password by e-mail, replaced on first sign-in) and `proof@zudocs.com`, used only by `npm run desk:proof` through
the `proof` client (server-side password flow, no hosted UI; its password lives in the owner's environment). The
JWT authorizer accepts both clients' audiences. Sales people later get their own owner-style login.

## Cost notes

Lambda arm64 at 1024 MB, on-demand tables, one KMS key ($1/month), a CloudFront distribution, an HTTP API,
seven-day logs, and up to ~20 metric series from the tee. Model spend at the cap (2,000 runs/day of triage on
Nova Micro + a reply on Luna + a judge on Nova Micro) stays under the monthly budget line; the Budgets action
attaches the Bedrock deny policy to the function's role at 100 % of `zudocs-monthly` regardless.
