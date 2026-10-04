import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, createApi } from "../src/api";

test("a temporary read refusal recovers, while a model action is never retried", async () => {
  let calls = 0;
  const api = createApi("https://example.invalid", async () => "fixture-token", async () => {
    calls += 1;
    return calls === 1 ? new Response("Service Unavailable", { status: 503 }) : Response.json({ tickets: [] });
  });
  assert.deepEqual(await api.tickets(), { tickets: [] });
  assert.equal(calls, 2);
  let posts = 0;
  const refused = createApi("https://example.invalid", async () => "fixture-token", async () => {
    posts += 1;
    return new Response("Service Unavailable", { status: 503 });
  });
  await assert.rejects(refused.runTicket("T-1052"), (error: unknown) => error instanceof ApiError && error.status === 503);
  assert.equal(posts, 1);
});

test("read fanout stays below the host limit and releases permits after failures", async () => {
  let active = 0;
  let peak = 0;
  const api = createApi("https://example.invalid", async () => "fixture-token", async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return new Response("Refused", { status: 401 });
  });
  const answers = await Promise.allSettled(Array.from({ length: 12 }, () => api.tickets()));
  assert.equal(peak, 3);
  assert.ok(answers.every((answer) => answer.status === "rejected"));
  await assert.rejects(api.tickets(), (error: unknown) => error instanceof ApiError && error.status === 401);
  assert.equal(active, 0);
});
