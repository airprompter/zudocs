/**
 * The desk's routes: callback stays exact, a trailing slash is the page, `/` is the inbox,
 * and a ticket query survives the path.
 *
 * @example
 * ```sh
 * npx tsx --test test/route.test.ts
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PAGE_LABEL, deskHref, isSignInCallback, litPath, mismatchRoute, newestHost, parseDeskRoute, releaseHostId, supportHostSnapshot, ticketParam } from "../src/route";
import type { HostStatus, State } from "../src/api";

test("callback is exact, and the pages ignore one trailing slash and the query", () => {
  assert.equal(isSignInCallback("/callback"), true);
  assert.equal(isSignInCallback("/callback/"), false);
  assert.equal(parseDeskRoute("/callback"), "agent", "the callback is not a desk page; boot checks it first");
  assert.equal(parseDeskRoute("/"), "agent");
  assert.equal(parseDeskRoute("/agent/"), "agent");
  assert.equal(parseDeskRoute("/fleet"), "architecture");
  assert.equal(parseDeskRoute("/daemon/"), "daemon");
  assert.equal(parseDeskRoute("/operate/"), "operate");
  assert.equal(parseDeskRoute("/no-such-page"), "agent");
  assert.equal(ticketParam("?ticket=T-1041"), "T-1041");
  assert.equal(ticketParam(""), null);
  assert.equal(deskHref("agent", "T-1041"), "/?ticket=T-1041");
  assert.equal(deskHref("architecture", null), "/system");
  assert.equal(deskHref("daemon", "T-1052"), "/daemon?ticket=T-1052");
  assert.equal(PAGE_LABEL.architecture, "System");
  assert.equal(PAGE_LABEL.agent, "Inbox");
  assert.equal(PAGE_LABEL.daemon, "Europe");
});

test("the lit path follows the newest run's host, and a mismatch names the other page", () => {
  assert.equal(litPath("agent", "us-east-1/lambda", "us-east-1/lambda", "eu-west-1/ec2"), "sdk");
  assert.equal(litPath("agent", "eu-west-1/ec2", "us-east-1/lambda", "eu-west-1/ec2"), "none");
  assert.equal(litPath("daemon", "eu-west-1/ec2", "us-east-1/lambda", "eu-west-1/ec2"), "daemon");
  assert.equal(litPath("daemon", null, "us-east-1/lambda", "eu-west-1/ec2"), "none");
  assert.equal(mismatchRoute("agent", "eu-west-1/ec2", "us-east-1/lambda", "eu-west-1/ec2"), "daemon");
  assert.equal(mismatchRoute("daemon", "us-east-1/lambda", "us-east-1/lambda", "eu-west-1/ec2"), "agent");
  assert.equal(mismatchRoute("agent", "us-east-1/lambda", "us-east-1/lambda", "eu-west-1/ec2"), null);
  assert.equal(newestHost([{ host: "a", at: "2026-01-01T00:00:00Z" }, { host: "b", at: "2026-01-02T00:00:00Z" }]), "b");
});

test("release path follows the visible Inbox reply but the Europe page stays with its daemon", () => {
  assert.equal(releaseHostId("agent", "eu-west-1/ec2", "us-east-1/lambda", "eu-west-1/ec2"), "eu-west-1/ec2");
  assert.equal(releaseHostId("agent", "us-east-1/lambda", "us-east-1/lambda", "eu-west-1/ec2"), "us-east-1/lambda");
  assert.equal(releaseHostId("agent", "unknown", "us-east-1/lambda", "eu-west-1/ec2"), "us-east-1/lambda");
  assert.equal(releaseHostId("daemon", "us-east-1/lambda", "us-east-1/lambda", "eu-west-1/ec2"), "eu-west-1/ec2");
});

test("the Inbox uses the fresh SDK check while Europe retains its own database report", () => {
  const checkedAt = "2026-10-04T02:00:00Z";
  const live: State["host"] = { hostId: "us-east-1/lambda", region: "us-east-1", sdk: "agent-sdk-ts/0.3.0", instanceId: "new", startedAt: checkedAt, coldStart: false, invocations: 1, status: { generation: 87, lastSyncAt: checkedAt, ramps: [] }, healthz: {}, models: [], stateDir: "/tmp" };
  const saved = (hostId: string): HostStatus => ({ hostId, region: hostId.split("/")[0]!, kind: "daemon", sdk: "sdk", writtenAt: "2026-10-04T01:00:00Z", status: { generation: 86 }, healthz: {}, container: { instanceId: "old", coldStart: false, startedAt: checkedAt, invocations: 0 } });
  const europe = saved("eu-west-1/ec2");
  const state = { host: live, hosts: [saved(live.hostId), europe] };
  const inbox = supportHostSnapshot(state, live.hostId)!;
  assert.equal(inbox.status.generation, 87);
  assert.equal(inbox.reportSource, "live");
  assert.equal(inbox.writtenAt, checkedAt);
  assert.equal(inbox.container.instanceId, "new");
  assert.equal(supportHostSnapshot(state, europe.hostId), europe);
  assert.equal(supportHostSnapshot(state, "unknown"), null);
});

// Canonical navigation and legacy URLs must reach the same functional view.
test("database and system pages retain selected tickets and accept existing bookmarks", () => {
  for (const [legacy, current, route] of [["/fleet", "/system", "architecture"], ["/operate", "/system/controls", "operate"]] as const) {
    assert.equal(parseDeskRoute(legacy), route);
    assert.equal(parseDeskRoute(current), route);
    assert.equal(deskHref(route, "T-1052"), `${current}?ticket=T-1052`);
  }
  assert.equal(parseDeskRoute("/database/"), "database");
  assert.equal(parseDeskRoute("/system/experiments"), "experiments");
  assert.equal(parseDeskRoute("/database/compare/"), "compare");
  assert.equal(parseDeskRoute("/system/metrics"), "metrics");
  assert.equal(deskHref("compare", "T-1052"), "/database/compare?ticket=T-1052");
  assert.equal(deskHref("metrics", "T-1052"), "/system/metrics?ticket=T-1052");
  assert.equal(deskHref("database", "T-1052"), "/database?ticket=T-1052");
});
