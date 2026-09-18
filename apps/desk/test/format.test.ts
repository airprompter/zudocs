/**
 * The desk's pure parts: the version badge and labels in the customer's vocabulary, the render segmentation
 * that "Why this text" highlights (fenced values keep their fence, overlaps resolve, nothing invented), the
 * release-bar summary over status rows, PKCE (a challenge is the verifier's S256 digest), the authorize URL,
 * token expiry, and the config reader's refusals.
 *
 * @example
 * ```sh
 * npx tsx --test test/format.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeUrl, challengeOf, claimsOf, logoutUrl, randomVerifier, tokensFrom } from "../src/auth";
import { parseConfig } from "../src/config";
import { ORIGIN_LABELS, TOOLTIPS, armLabel, latency, modelLabel, money, releaseSummary, score, segmentRender, slug, tokens, versionBadge } from "../src/format";

test("vocabulary: the badge says prompt version and release #N; generation/manifest/slot/arm live in tooltips only", () => {
  assert.equal(versionBadge("support.reply", "rev-2", 1), "reply rev-2 · release #1");
  assert.equal(versionBadge("support.escalate.handoff", "rev-2", 3), "escalate handoff rev-2 · release #3");
  assert.equal(versionBadge("support.triage", null, null), "triage — · release #—");
  assert.equal(armLabel("none"), "no experiment");
  assert.equal(armLabel("candidate"), "arm candidate");
  assert.equal(modelLabel("openai.gpt-5-6-luna"), "GPT-5.6 Luna");
  assert.equal(modelLabel("something.else"), "something.else");
  for (const word of ["generation", "manifest", "slot"]) assert.ok(Object.values(TOOLTIPS).some((t) => t.includes(word)), `${word} is explained in a tooltip`);
  assert.deepEqual(Object.values(ORIGIN_LABELS), ["call site", "your source", "default", "unfilled"]);
  assert.equal(slug("Billing / refunds"), "billing-refunds", "a multi-word answer is one class");
  assert.equal(slug(null), "none");
});

test("numbers: latency, tokens with the usage source honoured, money, judge score", () => {
  assert.equal(latency(412), "412 ms");
  assert.equal(latency(2400), "2.4 s");
  assert.equal(latency(null), "—");
  assert.equal(tokens({ input: 300, cachedInput: 20, output: 90 }, "reported"), "320 in · 90 out");
  assert.equal(tokens({ input: 0, output: 0 }, "unavailable"), "usage unavailable");
  assert.equal(money(0.000148), "$0.00015");
  assert.equal(money(0.0123), "$0.0123");
  assert.equal(score({ score: 0.75, taskPass: 3, taskFail: 1, taskUnclear: 0 }), "3/4 · 75%");
  assert.equal(score({ score: null, taskPass: 0, taskFail: 0, taskUnclear: 4 }), "unclear (4 unresolved)");
});

test("segmentation: values highlighted by origin, the fence shown around end-user text, overlaps and empties handled", () => {
  const variables = [
    { name: "tone", trust: "operator" as const, origin: "default" as const, value: "friendly", fenced: false, required: false },
    { name: "customer_tier", trust: "operator" as const, origin: "your_source" as const, value: "team", fenced: false, required: true },
    { name: "ticket", trust: "end_user" as const, origin: "call_site" as const, value: "my team page 404s", fenced: true, required: true },
    { name: "orphan", trust: "operator" as const, origin: "unfilled" as const, value: null, fenced: false, required: true },
  ];
  const text = "Be friendly. Plan: team.\n<ticket>my team page 404s</ticket>\nSign as the team.";
  const segments = segmentRender(text, variables);
  assert.deepEqual(segments.map((s) => [s.text, s.variable?.name ?? null, s.fence ?? null]), [
    ["Be ", null, null],
    ["friendly", "tone", null],
    [". Plan: ", null, null],
    ["team", "customer_tier", null],
    [".\n", null, null],
    ["<ticket>", "ticket", "open"],
    ["my team page 404s", "ticket", null],
    ["</ticket>", "ticket", "close"],
    ["\nSign as the ", null, null],
    ["team", "customer_tier", null],
    [".", null, null],
  ]);
  assert.equal(segments.map((s) => s.text).join(""), text, "the segments are the text, whole");
  assert.deepEqual(segmentRender("nothing here", variables).map((s) => s.text), ["nothing here"]);
});

test("the release bar summarises the fleet's own status rows", () => {
  const row = (generation: number, applyState: string, extra: Record<string, unknown> = {}, health = "ok") => ({ status: { generation, applyState, stagedGeneration: null, lastRefusal: null, ...extra }, healthz: { status: health } });
  assert.deepEqual(releaseSummary([]), { generation: null, activeOn: 0, total: 0, staged: null, refusal: null, failing: 0 });
  assert.deepEqual(releaseSummary([row(3, "active"), row(3, "active"), row(2, "staged", { stagedGeneration: 3 })]), { generation: 3, activeOn: 2, total: 3, staged: 3, refusal: null, failing: 0 });
  assert.deepEqual(releaseSummary([row(3, "refused", { lastRefusal: "disabled" }, "failing")]), { generation: 3, activeOn: 0, total: 1, staged: null, refusal: "disabled", failing: 1 });
});

test("PKCE: the challenge is the S256 digest of the verifier; the authorize URL carries it and the desk client; tokens expire a minute early", async () => {
  const verifier = randomVerifier(new Uint8Array(48));
  assert.equal(verifier, "A".repeat(64), "48 zero bytes encode to 64 A's");
  assert.equal(await challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "RFC 7636's own vector");
  const url = new URL(authorizeUrl({ hostedUi: "https://zudocs-x.auth.us-east-1.amazoncognito.com", clientId: "client" }, "https://desk.zudocs.com/callback", "chal", "st"));
  assert.equal(url.pathname, "/oauth2/authorize");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "openid email");
  assert.equal(url.searchParams.get("redirect_uri"), "https://desk.zudocs.com/callback");
  assert.equal(new URL(logoutUrl({ hostedUi: "https://h", clientId: "c" }, "https://desk.zudocs.com/")).searchParams.get("logout_uri"), "https://desk.zudocs.com/");
  const jwt = `x.${Buffer.from(JSON.stringify({ email: "seth@zudocs.com", exp: 1 })).toString("base64url")}.y`;
  const t = tokensFrom({ id_token: jwt, expires_in: 3600 }, 1_000_000, "keep");
  assert.equal(t.email, "seth@zudocs.com");
  assert.equal(t.expiresAt, 1_000_000 + 3_540_000);
  assert.equal(t.refreshToken, "keep", "a refresh keeps the refresh token it had");
  assert.deepEqual(claimsOf("not a jwt"), {});
});

test("config: every field required, trailing slashes trimmed", () => {
  const raw = { apiUrl: "https://api/", region: "us-east-1", userPoolId: "p", clientId: "c", hostedUi: "https://h/", deskUrl: "https://d", environment: "dev", agentId: "a" };
  assert.equal(parseConfig(raw).apiUrl, "https://api");
  assert.throws(() => parseConfig({ ...raw, clientId: "" }), /clientId is missing/);
});
