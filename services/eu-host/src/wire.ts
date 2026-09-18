/**
 * The wire: the eu-west host's egress, cut and restored at its security group — the "losing the wire" drill.
 *
 * - `cut`: the group's open egress (`0.0.0.0/0`, all traffic) is replaced by HTTPS to DynamoDB in the desk's region
 *   only (the six published CIDRs from `ip-ranges.json`), so the host keeps writing its status row while AirPrompter,
 *   Bedrock and everything else are unreachable — the desk shows `sync_failing` live; the group is tagged with the
 *   instant of the cut.
 * - `restore`: the open rule back, the DynamoDB rules and the tag gone.
 * - `tick` (an EventBridge rule every five minutes): restores when a cut is older than `WIRE_CUT_MAX_MINUTES`, so a
 *   drill nobody finished cannot strand the host — and writes the restore to the desk's timeline.
 *
 * Every step is idempotent (the group is described first; a rule that exists is not added twice, one that is gone
 * is not revoked) and the answer says what state the wire is in. No inbound rule exists on this group, ever.
 *
 * @example
 * ```ts
 * export const handler = async (event: { action: "cut" | "restore" | "tick" | "status"; by?: string }) => ...;
 * // aws lambda invoke --function-name zudocs-wire --payload '{"action":"status"}' /dev/stdout
 * ```
 */
import { AuthorizeSecurityGroupEgressCommand, CreateTagsCommand, DeleteTagsCommand, DescribeSecurityGroupsCommand, EC2Client, RevokeSecurityGroupEgressCommand, type IpPermission, type SecurityGroup } from "@aws-sdk/client-ec2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

export const CUT_TAG = "zudocs:wire-cut-at";
export type WireState = "connected" | "cut";

export interface WireEvent {
  action?: "cut" | "restore" | "tick" | "status";
  by?: string;
}

export interface WireAnswer {
  action: string;
  hostId: string;
  state: WireState;
  changed: boolean;
  cutAt: string | null;
  /** When the tick will restore a cut on its own. */
  restoreBy: string | null;
  egress: string[];
}

interface Env {
  securityGroupId: string;
  hostId: string;
  dynamoRegion: string;
  eventsTable: string;
  maxCutMinutes: number;
  ipRangesUrl: string;
}

const readEnv = (env: NodeJS.ProcessEnv): Env => {
  const need = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`wire: ${name} is missing`);
    return value;
  };
  const max = Number(env.WIRE_CUT_MAX_MINUTES ?? "15");
  return { securityGroupId: need("SECURITY_GROUP_ID"), hostId: need("HOST_ID"), dynamoRegion: need("DYNAMODB_REGION"), eventsTable: need("EVENTS_TABLE"), maxCutMinutes: Number.isFinite(max) && max >= 1 ? max : 15, ipRangesUrl: env.IP_RANGES_URL?.trim() || "https://ip-ranges.amazonaws.com/ip-ranges.json" };
};

/** The published CIDRs of DynamoDB in one region, from ip-ranges.json (IPv4). Pure over the document. */
export function dynamoCidrsOf(ipRanges: { prefixes: Array<{ ip_prefix: string; region: string; service: string }> }, region: string): string[] {
  return [...new Set(ipRanges.prefixes.filter((p) => p.service === "DYNAMODB" && p.region === region).map((p) => p.ip_prefix))].sort();
}

const isOpenAll = (p: IpPermission): boolean => p.IpProtocol === "-1" && (p.IpRanges ?? []).some((r) => r.CidrIp === "0.0.0.0/0");
const isDynamoHttps = (p: IpPermission): boolean => p.IpProtocol === "tcp" && p.FromPort === 443 && p.ToPort === 443 && (p.IpRanges ?? []).some((r) => r.Description === "zudocs wire cut: DynamoDB only");

/** What the group's egress says: connected when the open rule is present, cut otherwise. Pure. */
export function stateOf(group: Pick<SecurityGroup, "IpPermissionsEgress" | "Tags">): { state: WireState; cutAt: string | null; egress: string[] } {
  const egress = (group.IpPermissionsEgress ?? []).flatMap((p) => (p.IpRanges ?? []).map((r) => `${p.IpProtocol === "-1" ? "all" : `${p.IpProtocol}/${p.FromPort ?? ""}`} → ${r.CidrIp}`));
  const open = (group.IpPermissionsEgress ?? []).some(isOpenAll);
  const cutAt = group.Tags?.find((t) => t.Key === CUT_TAG)?.Value ?? null;
  return { state: open ? "connected" : "cut", cutAt: open ? null : cutAt, egress };
}

/** Whether a tick should restore: a cut older than the limit. Pure. */
export function shouldRestore(cutAt: string | null, nowMs: number, maxCutMinutes: number): boolean {
  if (!cutAt) return false;
  const at = Date.parse(cutAt);
  if (!Number.isFinite(at)) return true;
  return nowMs - at >= maxCutMinutes * 60_000;
}

export interface WirePorts {
  env: Env;
  ec2: Pick<EC2Client, "send">;
  fetchImpl: typeof fetch;
  appendEvent: (event: Record<string, unknown>) => Promise<void>;
  now: () => number;
}

export async function wire(event: WireEvent, ports: WirePorts): Promise<WireAnswer> {
  const { env, ec2, now } = ports;
  const action = event.action ?? "status";
  const describe = async (): Promise<SecurityGroup> => {
    const out = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [env.securityGroupId] }));
    const group = out.SecurityGroups?.[0];
    if (!group) throw new Error(`wire: security group ${env.securityGroupId} not found`);
    if ((group.IpPermissions ?? []).length > 0) throw new Error(`wire: ${env.securityGroupId} has inbound rules; this host has none, refusing to touch it`);
    return group;
  };
  const answer = (group: SecurityGroup, changed: boolean): WireAnswer => {
    const s = stateOf(group);
    return { action, hostId: env.hostId, state: s.state, changed, cutAt: s.cutAt, restoreBy: s.cutAt ? new Date(Date.parse(s.cutAt) + env.maxCutMinutes * 60_000).toISOString() : null, egress: s.egress };
  };
  const restore = async (group: SecurityGroup, by: string): Promise<WireAnswer> => {
    const current = stateOf(group);
    let changed = false;
    if (current.state === "cut") {
      await ec2.send(new AuthorizeSecurityGroupEgressCommand({ GroupId: env.securityGroupId, IpPermissions: [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "zudocs: outbound to AirPrompter, Bedrock and the desk's tables" }] }] }));
      changed = true;
    }
    const dynamoRules = (group.IpPermissionsEgress ?? []).filter(isDynamoHttps);
    if (dynamoRules.length > 0) {
      await ec2.send(new RevokeSecurityGroupEgressCommand({ GroupId: env.securityGroupId, IpPermissions: dynamoRules.map((p) => ({ IpProtocol: p.IpProtocol, FromPort: p.FromPort, ToPort: p.ToPort, IpRanges: p.IpRanges?.map((r) => ({ CidrIp: r.CidrIp })) })) }));
      changed = true;
    }
    if (group.Tags?.some((t) => t.Key === CUT_TAG)) await ec2.send(new DeleteTagsCommand({ Resources: [env.securityGroupId], Tags: [{ Key: CUT_TAG }] }));
    const after = await describe();
    if (changed) await ports.appendEvent({ at: new Date(now()).toISOString(), kind: "wire", host: env.hostId, action: "restore", by, forHost: env.hostId, state: "connected", cutAt: current.cutAt }).catch(() => undefined);
    return answer(after, changed);
  };

  const group = await describe();
  switch (action) {
    case "status":
      return answer(group, false);
    case "restore":
      return restore(group, event.by ?? "presenter");
    case "tick": {
      const s = stateOf(group);
      if (s.state === "cut" && shouldRestore(s.cutAt, now(), env.maxCutMinutes)) return restore(group, `the rule (cut older than ${env.maxCutMinutes} min)`);
      return answer(group, false);
    }
    case "cut": {
      const s = stateOf(group);
      if (s.state === "cut") return answer(group, false);
      const response = await ports.fetchImpl(env.ipRangesUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`wire: ip-ranges.json answered ${response.status}; not cutting a wire that could not be re-opened for the tables`);
      const cidrs = dynamoCidrsOf((await response.json()) as { prefixes: Array<{ ip_prefix: string; region: string; service: string }> }, env.dynamoRegion);
      if (cidrs.length === 0 || cidrs.length > 20) throw new Error(`wire: ${cidrs.length} DynamoDB CIDRs for ${env.dynamoRegion}; expected a handful`);
      const cutAt = new Date(now()).toISOString();
      // Order: the narrow rules first, then the open one goes — the status writer never loses the tables.
      await ec2.send(new AuthorizeSecurityGroupEgressCommand({ GroupId: env.securityGroupId, IpPermissions: [{ IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: cidrs.map((CidrIp) => ({ CidrIp, Description: "zudocs wire cut: DynamoDB only" })) }] }));
      await ec2.send(new CreateTagsCommand({ Resources: [env.securityGroupId], Tags: [{ Key: CUT_TAG, Value: cutAt }] }));
      const open = (group.IpPermissionsEgress ?? []).filter(isOpenAll);
      await ec2.send(new RevokeSecurityGroupEgressCommand({ GroupId: env.securityGroupId, IpPermissions: open.map((p) => ({ IpProtocol: "-1", IpRanges: p.IpRanges?.filter((r) => r.CidrIp === "0.0.0.0/0").map((r) => ({ CidrIp: r.CidrIp })) })) }));
      const after = await describe();
      await ports.appendEvent({ at: cutAt, kind: "wire", host: env.hostId, action: "cut", by: event.by ?? "presenter", forHost: env.hostId, state: "cut", restoreBy: new Date(Date.parse(cutAt) + env.maxCutMinutes * 60_000).toISOString(), cidrs: cidrs.length }).catch(() => undefined);
      return answer(after, true);
    }
    default:
      throw new Error(`wire: unknown action ${String(action)}`);
  }
}

/** The Lambda entry: real clients, the desk's events table across regions. */
export const handler = async (event: WireEvent): Promise<WireAnswer> => {
  const env = readEnv(process.env);
  const ec2 = new EC2Client({});
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.dynamoRegion }), { marshallOptions: { removeUndefinedValues: true } });
  const appendEvent = async (e: Record<string, unknown>): Promise<void> => {
    const at = String(e.at);
    const day = at.slice(0, 10);
    const sk = `${at}#${Math.random().toString(36).slice(2, 8)}`;
    const expiresAt = Math.floor(Date.parse(at) / 1000) + 14 * 86_400;
    await ddb.send(new PutCommand({ TableName: env.eventsTable, Item: { day, sk, expiresAt, ...e } }));
  };
  const answer = await wire(event, { env, ec2, fetchImpl: fetch, appendEvent, now: Date.now });
  console.log(JSON.stringify({ source: "zudocs-wire", ...answer }));
  return answer;
};
