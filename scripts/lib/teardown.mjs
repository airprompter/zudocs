/**
 * The teardown's plan, pure: the stacks in the order they can be deleted (the reverse of what they reference —
 * CloudFormation exports first, then the fixed names), and what `cdk destroy` leaves behind in the account, each
 * with the exact commands that remove it and why it was left. `scripts/teardown.mjs` reads the account, prints
 * this, and (never in a dry run) deletes the stacks in this order. The tests pin the order and that every leftover
 * carries a command.
 *
 * Why this order: `ZudocsDesk` imports the site's certificate and user pool (real exports — the site cannot go
 * first) and names the eu-west host's role, the wire and power functions and the fleet's queue by fixed name (the
 * thing that names them goes before the things it names); `ZudocsAirgap` reads the fleet's bucket and table;
 * `ZudocsSite` imports the zone; `ZudocsCi` is the role that deploys the rest and goes last; the three `CDKToolkit`
 * bootstrap stacks are not Zudocs's and are listed, not deleted.
 *
 * @example
 * ```js
 * TEARDOWN_ORDER.map((s) => `${s.stack} (${s.region})`);   // ["ZudocsAirgap (ap-southeast-1)", "ZudocsDesk (us-east-1)", …, "ZudocsCi (us-east-1)"]
 * leftovers({ account: "111122223333", outputs: { ZudocsDns: { ZoneId: "Z123" } } });   // [{ what, why, commands: ["aws route53 …"] }, …]
 * renderPlan({ account, found, leftovers, dryRun: true });
 * ```
 */

/** The stacks, in deletion order, with the region each lives in and why it is where it is. */
export const TEARDOWN_ORDER = Object.freeze([
  { stack: "ZudocsAirgap", region: "ap-southeast-1", optional: true, why: "the air-gapped host (on demand; usually absent) reads the fleet's bucket and table" },
  { stack: "ZudocsDesk", region: "us-east-1", optional: false, why: "imports the site's certificate and user pool; names the eu-west role, the wire and power functions and the nudge queue" },
  { stack: "ZudocsFleet", region: "ap-southeast-1", optional: false, why: "the puller, the releases table, the nudge queue; the exchange bucket is retained" },
  { stack: "ZudocsSharedHost", region: "eu-west-1", optional: false, why: "the eu-west host (terminated, its volume with it), the wire and power functions, the nightly schedule, the demo-mode parameter" },
  { stack: "ZudocsSite", region: "us-east-1", optional: false, why: "imports the zone; the user pool and the trail bucket are retained" },
  { stack: "ZudocsDns", region: "us-east-1", optional: false, why: "the zone is retained (the registrar still points at it until repointed)" },
  { stack: "ZudocsCi", region: "us-east-1", optional: false, why: "the deploy role: last, so nothing that used it is left half-deleted" },
]);

/** The regions Zudocs bootstrapped CDK in (the `CDKToolkit` stacks and their asset buckets are listed, not deleted). */
export const BOOTSTRAP_REGIONS = Object.freeze(["us-east-1", "eu-west-1", "ap-southeast-1"]);

const or = (value, placeholder) => (value && String(value).trim() ? String(value) : placeholder);

/** The S3 pipeline that empties a versioned bucket (every version and every delete marker), then removes it. */
export function emptyVersionedBucketCommands(bucket, region) {
  const b = or(bucket, "<bucket>");
  return [
    `aws s3api list-object-versions --region ${region} --bucket ${b} --output json --query '{Objects: [Versions[].{Key:Key,VersionId:VersionId}, DeleteMarkers[].{Key:Key,VersionId:VersionId}][] | [0:1000]}' > /tmp/zudocs-versions.json   # a thousand at a time`,
    `jq -e '.Objects | length > 0' /tmp/zudocs-versions.json && aws s3api delete-objects --region ${region} --bucket ${b} --delete file:///tmp/zudocs-versions.json   # repeat both lines until Objects is [] (delete-objects refuses an empty list)`,
    `aws s3api delete-bucket --region ${region} --bucket ${b}`,
  ];
}

/**
 * What the stacks leave behind, with the command that removes each. `outputs` is `{ [stackName]: { [outputKey]: value } }`
 * from DescribeStacks (missing stacks or keys become placeholders in angle brackets).
 */
export function leftovers({ account, outputs = {}, region = "us-east-1", environment = "dev" }) {
  const acct = or(account, "<account>");
  const zoneId = or(outputs.ZudocsDns?.ZoneId, "<zone id: aws route53 list-hosted-zones-by-name --dns-name zudocs.com>");
  const poolId = or(outputs.ZudocsSite?.UserPoolId, "<user pool id: aws cognito-idp list-user-pools --max-results 10>");
  const trailBucket = or(outputs.ZudocsSite?.TrailBucketName, `<trail bucket: aws s3 ls | grep zudocssite-trailbucket>`);
  const exchange = or(outputs.ZudocsFleet?.ExchangeBucketName, `zudocs-exchange-${acct}`);
  const keyAlias = or(outputs.ZudocsDesk?.KeyAlias, "alias/zudocs-desk");
  return [
    {
      what: "The hosted zone (ZudocsDns, RETAIN)",
      why: "the registrar points at its name servers (deleting it while the registrar does is an outage on zudocs.com — repoint first); the site's certificate validated through DNS and CloudFormation leaves its validation CNAMEs (_xxx.zudocs.com, _xxx.www…, _xxx.desk…) in the zone, so the delete is refused until they are gone",
      commands: [
        `aws route53 list-resource-record-sets --hosted-zone-id ${zoneId} --output json --query "ResourceRecordSets[?Type!='NS' && Type!='SOA']" > /tmp/zudocs-records.json   # the ACM validation CNAMEs and anything else left`,
        `jq -e 'length > 0' /tmp/zudocs-records.json >/dev/null && aws route53 change-resource-record-sets --hosted-zone-id ${zoneId} --change-batch "$(jq '{Changes: map({Action: "DELETE", ResourceRecordSet: .})}' /tmp/zudocs-records.json)"   # one batch; skipped when the zone is already bare`,
        `aws route53 delete-hosted-zone --id ${zoneId}   # refused until only the NS and SOA records remain`,
      ],
    },
    {
      what: "The Cognito user pool (ZudocsSite, RETAIN, deletion protection on)",
      why: "the owner's and the proof user's sign-ins; the hosted-UI domain goes with the stack, the pool does not",
      commands: [
        `aws cognito-idp update-user-pool --region ${region} --user-pool-id ${poolId} --deletion-protection INACTIVE`,
        `aws cognito-idp delete-user-pool --region ${region} --user-pool-id ${poolId}`,
      ],
    },
    {
      what: "The exchange bucket (ZudocsFleet, RETAIN, versioned)",
      why: "the sealed bundles, the air-gapped host's status and exports, the import ledger — kept on purpose across `airgap:down`",
      commands: emptyVersionedBucketCommands(exchange, "ap-southeast-1"),
    },
    {
      what: "The trail bucket (ZudocsSite, RETAIN)",
      why: "the management-events trail's objects (90-day expiry under AWSLogs/) and the monthly cost documents under cost/ (kept)",
      commands: [`aws s3 rm --region ${region} s3://${trailBucket} --recursive`, `aws s3api delete-bucket --region ${region} --bucket ${trailBucket}`],
    },
    {
      what: "The SSM SecureStrings the owner wrote by hand",
      why: "the Agent key in three regions and the staging run key; the stacks name them and never own them (the demo-mode String goes with ZudocsSharedHost)",
      commands: [
        `aws ssm delete-parameter --region us-east-1 --name /zudocs/${environment}/agent-key`,
        `aws ssm delete-parameter --region eu-west-1 --name /zudocs/${environment}/agent-key`,
        `aws ssm delete-parameter --region ap-southeast-1 --name /zudocs/${environment}/agent-key`,
        `aws ssm delete-parameter --region us-east-1 --name /zudocs/staging/run-key`,
        "# then revoke both keys in the AirPrompter console (Settings › Keys)",
      ],
    },
    {
      what: `The KMS key ${keyAlias} (ZudocsDesk)`,
      why: "scheduled for deletion by the stack (a 30-day window, billed $1/month until then); nothing to do unless it should be kept",
      commands: [
        `aws kms describe-key --region ${region} --key-id ${keyAlias}   # KeyState: PendingDeletion, DeletionDate   (the alias is gone with the stack; use the key id if this refuses)`,
        `aws kms cancel-key-deletion --region ${region} --key-id <key id>   # only to keep it`,
      ],
    },
    {
      what: "CloudWatch log groups the stacks did not own",
      why: "the custom-resource providers (bucket deployments, auto-delete) create their groups on first invoke; the stacks' own groups are deleted with them",
      commands: BOOTSTRAP_REGIONS.map((r) => `aws logs describe-log-groups --region ${r} --log-group-name-prefix /aws/lambda/Zudocs --query 'logGroups[].logGroupName' --output text | xargs -n1 -I{} aws logs delete-log-group --region ${r} --log-group-name {}`),
    },
    {
      what: "The CDK bootstrap (CDKToolkit) in three regions",
      why: "not Zudocs's own; the deploy role assumes its roles and the assets live in its buckets — delete only when the account is being emptied",
      commands: BOOTSTRAP_REGIONS.flatMap((r) => [...emptyVersionedBucketCommands(`cdk-hnb659fds-assets-${acct}-${r}`, r), `aws ecr delete-repository --region ${r} --repository-name cdk-hnb659fds-container-assets-${acct}-${r} --force`, `aws cloudformation delete-stack --region ${r} --stack-name CDKToolkit`]),
    },
    {
      what: "The GitHub OIDC provider",
      why: "created by ZudocsCi unless `--context githubOidcProviderArn` imported one that already existed; in that case it is someone else's",
      commands: [`aws iam list-open-id-connect-providers`, `aws iam delete-open-id-connect-provider --open-id-connect-provider-arn arn:aws:iam::${acct}:oidc-provider/token.actions.githubusercontent.com   # only if ZudocsCi created it`],
    },
    {
      what: "The registrar and the management account",
      why: "outside this account: the domain's name servers still point at the retained zone, the SES forwarder for the root mailbox lives in the management account, and the delegation record there names this zone",
      commands: [
        "# registrar: set the zudocs.com name servers back to the management account's zone (or the parked set)",
        "# management account: delete the SES receipt rule / forwarder for zudocs.com and the NS delegation record for zudocs.com in its zone",
        "# management account: the Organizations account itself (close it) — Budgets, Cost Explorer preferences and the anomaly monitor died with ZudocsSite",
      ],
    },
    {
      what: "Bedrock model agreements and the owner's laptop",
      why: "agreements cost nothing and need no action; the laptop holds the env files and the caches",
      commands: ["rm -f ~/.config/zudocs/dev.env ~/.config/zudocs/proof.env ~/.config/zudocs/ci.env", "rm -rf ~/.cache/zudocs"],
    },
  ];
}

const line = (s) => `${s}\n`;

/** The plan as printed: the stacks found (and not), the order, the leftovers with their commands. */
export function renderPlan({ account, found, leftovers: left, dryRun }) {
  let out = "";
  out += line(`Zudocs teardown — account ${account} — ${dryRun ? "DRY RUN: nothing is deleted" : "LIVE: every stack below is deleted in this order"}`);
  out += line("");
  out += line("Stacks, in deletion order:");
  for (const step of TEARDOWN_ORDER) {
    const f = found[step.stack];
    const state = f ? `${f.status}` : step.optional ? "absent (on demand; skipped)" : "absent (skipped)";
    out += line(`  ${step.stack.padEnd(18)} ${step.region.padEnd(16)} ${state.padEnd(30)} ${step.why}`);
  }
  out += line("");
  out += line("What `cdk destroy` leaves, and the commands that remove each (run by hand, in this order, after the stacks are gone):");
  for (const item of left) {
    out += line("");
    out += line(`  ${item.what}`);
    out += line(`    why: ${item.why}`);
    for (const c of item.commands) out += line(`    ${c}`);
  }
  out += line("");
  return out;
}
