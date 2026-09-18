# The desk: the us-east-1 host and the app

Phase 3 is the first production host and the screen a prospect watches. One Lambda runs the public Agent SDK; one
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
| Variables | `customer_tier` from the customers table, registered once as a source (`trust: operator`, 1.5 s timeout); `tone: "formal"` passed only for an enterprise customer; the ticket fenced as end-user text | `src/runtime.ts`, `src/run.ts` |
| Judge | `ap.judge(runRef, output, "prompt", invoke)` — the reply prompt's own `## Success criteria`, scored on Nova Micro; only the score leaves the host | `src/run.ts` |
| Feedback | thumbs / accepted / edited → `ap.feedback(runRef, signals)`; the SDK's verdict (declared signals only) is the API's answer | `src/handler.ts` |
| Telemetry | The SDK's normal upload to AirPrompter, and the tee: the same segment's rows as CloudWatch EMF lines on stdout, only after AirPrompter accepted the segment; dimensions capped to `tag`, `versionId`, `arm`, `status` | `src/tee.ts` |
| Cap | 2,000 runs per UTC day (an atomic DynamoDB counter, refused at the line); HTTP 429 `daily_cap` with the count — nothing is simulated | `src/store.ts`, `src/handler.ts` |
| Status and timeline | Every run and presenter action writes `status()` + `healthz()` to the status table (one row per host); `onChange` and every action append to the events table (partitioned by UTC day) | `src/runtime.ts`, `src/store.ts` |

Routes (all behind the Cognito JWT authorizer; `src/router.ts` is what the stack registers):
`GET /tickets`, `GET /tickets/{id}`, `POST /tickets/{id}/run`, `POST /tickets/{id}/escalate`,
`POST /runs/{id}/feedback`, `GET /state`, `GET /events?since=`, `POST /presenter/{heartbeat|upload|sync|seed|replay}`,
`GET /healthz`.

### What each number on the run panel is

- **version badge** `reply rev-2 · release #1` — `Rendered.versionId` and `Rendered.generation`.
- **arm badge** — `Rendered.arm` (`none` shows as "no experiment").
- **Why this text** — `Rendered.text`, with each declared variable (`handle.variables()`) labelled by the SDK's
  precedence: passed at the call site, filled by the desk's registered source, or the version's default; the
  fence around end-user text; the version's `inference` block.
- **checks strip** — `ap.checks(rendered, output, { record: false })`: the per-check verdicts of the checks the
  wrapper already counted on the window.
- **latency · tokens · usage · status** — the `Observation` the SDK filed for the call (tapped from the spool
  writer, so it is the SDK's number, not the app's stopwatch); **cost** is that usage at list price.
- **judge** — `JudgeResult.score` and the task pass/fail counts.
- **feedback row** — what `ap.feedback` accepted.

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
  events (content-free by design) and the tee's metric lines; never a render, a ticket or an answer.

## The app (`apps/desk`)

Sign-in is the hosted UI over PKCE with the `desk` client (no library; `src/auth.ts`). The columns: the inbox;
the ticket with Run / Escalate and every run's cards; the fleet (host cards from the status table), the presenter
panel (replay N on this host, heartbeat / upload / sync now, re-seed), and the timeline (the events table, polled).
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
