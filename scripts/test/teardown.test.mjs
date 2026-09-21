import assert from "node:assert/strict";
import { test } from "node:test";
import { BOOTSTRAP_REGIONS, TEARDOWN_ORDER, emptyVersionedBucketCommands, leftovers, renderPlan } from "../lib/teardown.mjs";

const index = (stack) => TEARDOWN_ORDER.findIndex((s) => s.stack === stack);

test("the order: every stack once, the importers before what they import, the namers before what they name, the air-gapped host first (optional), the CI role last", () => {
  assert.deepEqual(TEARDOWN_ORDER.map((s) => s.stack), ["ZudocsAirgap", "ZudocsDesk", "ZudocsFleet", "ZudocsSharedHost", "ZudocsSite", "ZudocsDns", "ZudocsCi"]);
  assert.ok(index("ZudocsDesk") < index("ZudocsSite"), "the desk imports the site's certificate and pool");
  assert.ok(index("ZudocsSite") < index("ZudocsDns"), "the site imports the zone");
  assert.ok(index("ZudocsDesk") < index("ZudocsSharedHost") && index("ZudocsDesk") < index("ZudocsFleet"), "the desk names the host's role, the functions and the queue");
  assert.ok(index("ZudocsAirgap") < index("ZudocsFleet"), "the air-gapped host reads the fleet's bucket and table");
  assert.equal(TEARDOWN_ORDER.at(-1).stack, "ZudocsCi");
  assert.deepEqual(TEARDOWN_ORDER.filter((s) => s.optional).map((s) => s.stack), ["ZudocsAirgap"], "only the on-demand stack may be absent without remark");
  assert.deepEqual(TEARDOWN_ORDER.map((s) => s.region), ["ap-southeast-1", "us-east-1", "ap-southeast-1", "eu-west-1", "us-east-1", "us-east-1", "us-east-1"]);
  for (const s of TEARDOWN_ORDER) assert.ok(s.why.length > 20, `${s.stack} says why`);
  assert.ok(!TEARDOWN_ORDER.some((s) => s.stack === "CDKToolkit"), "the bootstrap is listed among the leftovers, never deleted by the script");
});

test("the leftovers: every retained or hand-made thing with a command, filled from the stacks' outputs when known and a placeholder when not; the regions are right; nothing key-shaped", () => {
  const left = leftovers({ account: "111122223333", outputs: { ZudocsDns: { ZoneId: "Z0123" }, ZudocsSite: { UserPoolId: "us-east-1_abc", TrailBucketName: "zudocssite-trailbucket-x" }, ZudocsFleet: { ExchangeBucketName: "zudocs-exchange-111122223333" }, ZudocsDesk: { KeyAlias: "alias/zudocs-desk" } } });
  const whats = left.map((l) => l.what);
  for (const needle of ["hosted zone", "user pool", "exchange bucket", "trail bucket", "SSM SecureStrings", "KMS key", "log groups", "CDK bootstrap", "OIDC provider", "registrar", "laptop"]) assert.ok(whats.some((w) => w.toLowerCase().includes(needle.toLowerCase())), `lists the ${needle}`);
  for (const l of left) {
    assert.ok(l.commands.length > 0, `${l.what} has a command`);
    assert.ok(l.why.length > 20, `${l.what} says why`);
    for (const c of l.commands) assert.ok(!/apa_|apr_|AKIA/.test(c));
  }
  const zone = left.find((l) => l.what.includes("hosted zone"));
  assert.ok(zone.commands.some((c) => c.includes("delete-hosted-zone --id Z0123")), "the zone by its id");
  assert.ok(zone.commands.some((c) => c.includes("change-resource-record-sets --hosted-zone-id Z0123") && c.includes("DELETE")), "the certificate's validation CNAMEs are deleted first: CloudFormation leaves them and the zone delete is refused with them there");
  assert.ok(zone.why.includes("validation CNAME"), "and the why says so");
  const pool = left.find((l) => l.what.includes("user pool"));
  assert.ok(pool.commands.some((c) => c.includes("--deletion-protection INACTIVE")), "deletion protection is on; the command turns it off first");
  assert.ok(pool.commands.some((c) => c.includes("delete-user-pool --region us-east-1 --user-pool-id us-east-1_abc")));
  const exchange = left.find((l) => l.what.includes("exchange bucket"));
  assert.ok(exchange.commands.every((c) => c.includes("--region ap-southeast-1")), "the exchange is in the fleet's region");
  assert.ok(exchange.commands.some((c) => c.includes("list-object-versions")) && exchange.commands.some((c) => c.includes("DeleteMarkers")), "versioned: every version and delete marker");
  const ssm = left.find((l) => l.what.includes("SecureStrings"));
  assert.deepEqual(ssm.commands.filter((c) => c.startsWith("aws")).map((c) => c.match(/--region (\S+) --name (\S+)/).slice(1)), [["us-east-1", "/zudocs/dev/agent-key"], ["eu-west-1", "/zudocs/dev/agent-key"], ["ap-southeast-1", "/zudocs/dev/agent-key"], ["us-east-1", "/zudocs/staging/run-key"]]);
  assert.ok(ssm.commands.some((c) => /revoke/.test(c)), "and the keys are revoked in the console");
  const bootstrap = left.find((l) => l.what.includes("CDK bootstrap"));
  for (const r of BOOTSTRAP_REGIONS) assert.ok(bootstrap.commands.some((c) => c.includes(`cdk-hnb659fds-assets-111122223333-${r}`)) && bootstrap.commands.some((c) => c.includes(`delete-stack --region ${r} --stack-name CDKToolkit`)), r);
  const bare = leftovers({ account: "111122223333" });
  assert.ok(bare.find((l) => l.what.includes("hosted zone")).commands[0].includes("<zone id"), "no outputs: a placeholder that says how to find the id");
  assert.ok(bare.find((l) => l.what.includes("exchange bucket")).commands[0].includes("zudocs-exchange-111122223333"), "the exchange bucket's name is derivable from the account");
  assert.deepEqual(emptyVersionedBucketCommands("b", "eu-west-1").map((c) => c.split(" ")[0]), ["aws", "jq", "aws"], "list, delete when non-empty, remove the bucket");
});

test("the plan: a dry run says so, names what is present and absent, and prints every leftover with its commands", () => {
  const left = leftovers({ account: "111122223333" });
  const text = renderPlan({ account: "111122223333", found: { ZudocsDesk: { status: "UPDATE_COMPLETE" }, ZudocsCi: { status: "CREATE_COMPLETE" } }, leftovers: left, dryRun: true });
  assert.match(text, /DRY RUN: nothing is deleted/);
  assert.match(text, /ZudocsAirgap {7}ap-southeast-1 {3}absent \(on demand; skipped\)/);
  assert.match(text, /ZudocsDesk {9}us-east-1 {8}UPDATE_COMPLETE/);
  assert.match(text, /ZudocsFleet {8}ap-southeast-1 {3}absent \(skipped\)/);
  for (const l of left) for (const c of l.commands) assert.ok(text.includes(c), `the plan carries: ${c.slice(0, 40)}`);
  assert.ok(text.indexOf("ZudocsDesk") < text.indexOf("ZudocsSite") && text.indexOf("ZudocsSite") < text.indexOf("ZudocsDns"), "printed in deletion order");
  const live = renderPlan({ account: "111122223333", found: {}, leftovers: left, dryRun: false });
  assert.match(live, /LIVE: every stack below is deleted in this order/);
});
