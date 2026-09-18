# Architecture

Zudocs is one AWS account, three regions, three host shapes, one AirPrompter organization. The prompts
are the product's brain and none of them are in this repository.

```
                     AirPrompter (api.airprompter.com, the CDN edge)
                        ▲ heartbeat · manifest · telemetry grants        ▲ pointer, root.json
                        │                                                │
   us-east-1            │              eu-west-1                         │           ap-southeast-1
   ┌────────────────────┴───┐          ┌──────────────────────────┐      │    ┌──────────────────────────┐
   │ desk API (Lambda)      │          │ t4g.micro, no inbound    │      └────┤ puller (Lambda, schedule)│
   │  SDK on_invoke, auto   │          │  airprompterd (daemon)   │           │  pointer-first pull      │
   │  KMS store key         │          │  Node worker (Luna, wrap)│           │  → releases table        │
   │  key from SSM at start │          │  Python worker (LiteLLM) │           │  → exchange bucket (S3)  │
   │  tee sink → AP + EMF   │          │  unlock_required, file_key│          └────────────┬─────────────┘
   │  approvals: desk grants  │
   └──────────┬─────────────┘          │  imports airgap exports  │                        │ S3/DynamoDB gateway endpoints
              │                        └──────────────────────────┘           ┌────────────▼─────────────┐
   CloudFront ▼ landing (S3)                                                  │ air-gapped t4g.micro      │
   desk.zudocs.com (React) · Cognito                                          │  offline, vendored bundle │
   status table · events table (DynamoDB, every host writes)                  │  keypair born on the host │
                                                                              │  export-telemetry → bucket│
                                                                              └───────────────────────────┘
```

Phase 1: the hosted zone and mail records, the landing page, sign-in, the budget, the trail, the CI deploy role.
Phase 2: the prompts in AirPrompter (`PROMPTS.md`), the local registry seed and the laptop smoke.
Phase 3: the us-east-1 host and the desk (`DESK.md`) — the API, its tables and key, the app, the Budgets action.
Phase 4: the eu-west-1 host (`EU-WEST.md`) — `airprompterd` with a Node and a Python worker attached, the approvals
table and page, the wire function and its restore rule; the reply and escalation slots re-pinned to Nova 2 Lite
while Luna is gated (generation 2 on dev, the first change that reached every host).
The full plan, its reviewers' findings and the demo script live with the AirPrompter team; the phases land here
one pull request at a time.

## Invariants

- Only public packages, the released CLI, the public root key, keys from the console.
- Keys travel by environment or SSM SecureString, read at cold start; never argv, never git, never logs.
- Nothing on the desk is invented: every value comes from the SDK's `Rendered`, `observe`, `checks`,
  `healthz` and `status`. At a spend cap the desk refuses visibly.
- No prompt text in git; `prompts/` is seeded and ignored.
- No inbound port on any host; hosts push their status to a table and the desk reads the table.
- The console stages; the customer activates. Under `unlock_required` a release goes live only through the desk's
  Approvals page (the owner) or an operator's `unlock` on the host — never through AirPrompter.
- Reset means advance: generations are monotonic, a rollback is a forced downgrade held back until something newer
  is promoted, a tightened policy is loosened only on the host.
