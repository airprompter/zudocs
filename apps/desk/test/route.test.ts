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
import { PAGE_LABEL, deskHref, isSignInCallback, litPath, mismatchRoute, newestHost, parseDeskRoute, releaseHostId, ticketParam } from "../src/route";

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
  assert.equal(deskHref("architecture", null), "/fleet");
  assert.equal(deskHref("daemon", "T-1052"), "/daemon?ticket=T-1052");
  assert.equal(PAGE_LABEL.architecture, "Hosts");
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
