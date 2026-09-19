/**
 * The operator's CLI on the eu-west host, one click from the desk: a fixed list of `zudocs-cli` commands (the host's
 * wrapper around the released `airprompter` binary, scoped to the daemon's agent and environment) run through
 * Session Manager's Run Command, targeted by the instance's Name tag — the desk never learns an instance id and
 * never opens a shell. The command's own JSON document comes back as the CLI printed it; the CLI prints no key at
 * any verbosity (its own rule), and the allowlist takes no arguments from the request beyond the command's name,
 * so nothing typed on the desk reaches a shell. `policy set` is the one command with a value, and it is one of two.
 *
 * What the drills use: `policy show` ("the console says auto, this host says pinned: unlock_required"), `policy set`
 * (the operator's loosening — the only way a pin loosens), `rollback` (a forced downgrade the fleet page reports),
 * `unlock` (the operator's activation), `status` and `doctor` (what the host says about itself, `file_key` and all).
 * `apply --force` needs a bundle file on the host and is a laptop drill in `docs/strips/` instead.
 *
 * @example
 * ```ts
 * const out = await runHostCli(ports, "policy show");   // { status: "Success", document: { via: "daemon", applyPolicy: {…} }, stdout, stderr }
 * HOST_CLI_COMMANDS["policy show"];                      // "zudocs-cli policy show --json"
 * ```
 */
import { GetCommandInvocationCommand, ListCommandInvocationsCommand, SSMClient, SendCommandCommand } from "@aws-sdk/client-ssm";

/** The commands the desk may run, by the name the button carries, to the exact line the host executes. */
export const HOST_CLI_COMMANDS: Readonly<Record<HostCliCommand, string>> = Object.freeze({
  "status": "zudocs-cli status --json",
  "doctor": "zudocs-cli doctor --json",
  "policy show": "zudocs-cli policy show --json",
  "policy set auto": "zudocs-cli policy set auto --by desk --json",
  "policy set unlock_required": "zudocs-cli policy set unlock_required --by desk --json",
  "unlock": "zudocs-cli unlock --json",
  "rollback": "zudocs-cli rollback --json",
});

export type HostCliCommand = "status" | "doctor" | "policy show" | "policy set auto" | "policy set unlock_required" | "unlock" | "rollback";

export const isHostCliCommand = (value: unknown): value is HostCliCommand => typeof value === "string" && Object.prototype.hasOwnProperty.call(HOST_CLI_COMMANDS, value);

export interface HostCliResult {
  command: HostCliCommand;
  line: string;
  status: "Success" | "Failed" | "TimedOut" | "Cancelled" | "NoInstance";
  instanceId: string | null;
  /** The CLI's JSON document (the last stdout line), when it printed one. */
  document: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface HostCliPorts {
  region: string;
  nameTag: string;
  send?: (input: { command: string; timeoutSeconds: number }) => Promise<{ commandId: string }>;
  poll?: (commandId: string) => Promise<{ status: string; instanceId: string; stdout: string; stderr: string } | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The last stdout line as JSON — what `--json` promises — or null when there was none. */
export function documentOf(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split("\n").filter((l) => l.trim());
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    const parsed = JSON.parse(last) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function ssmPorts(region: string, nameTag: string): Required<Pick<HostCliPorts, "send" | "poll">> {
  const ssm = new SSMClient({ region });
  return {
    async send({ command, timeoutSeconds }) {
      const out = await ssm.send(new SendCommandCommand({ Targets: [{ Key: "tag:Name", Values: [nameTag] }], DocumentName: "AWS-RunShellScript", Parameters: { commands: [command], executionTimeout: [String(timeoutSeconds)] }, Comment: "zudocs desk: presenter host-cli", TimeoutSeconds: 60 }));
      const commandId = out.Command?.CommandId;
      if (!commandId) throw new Error("Run Command returned no command id");
      return { commandId };
    },
    async poll(commandId) {
      // The list names the instance the tag resolved to; the invocation read carries the full output (the list's is capped).
      const out = await ssm.send(new ListCommandInvocationsCommand({ CommandId: commandId }));
      const invocation = out.CommandInvocations?.[0];
      if (!invocation?.InstanceId) return null;
      const status = invocation.Status ?? "Pending";
      if (!["Success", "Failed", "TimedOut", "Cancelled"].includes(status)) return { status, instanceId: invocation.InstanceId, stdout: "", stderr: "" };
      const detail = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: invocation.InstanceId }));
      return { status: detail.Status ?? status, instanceId: invocation.InstanceId, stdout: detail.StandardOutputContent ?? "", stderr: detail.StandardErrorContent ?? "" };
    },
  };
}

/** Run one allowlisted command on the host; waits up to `timeoutSeconds` (+ the dispatch), never throws on the CLI's own refusal (that is the document). */
export async function runHostCli(ports: HostCliPorts, command: HostCliCommand, timeoutSeconds = 90): Promise<HostCliResult> {
  const line = HOST_CLI_COMMANDS[command]!;
  const io = { ...ssmPorts(ports.region, ports.nameTag), ...(ports.send ? { send: ports.send } : {}), ...(ports.poll ? { poll: ports.poll } : {}) };
  const sleep = ports.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = ports.now ?? Date.now;
  const started = now();
  const { commandId } = await io.send({ command: line, timeoutSeconds });
  let last: { status: string; instanceId: string; stdout: string; stderr: string } | null = null;
  const deadline = started + (timeoutSeconds + 30) * 1000;
  while (now() < deadline) {
    await sleep(2000);
    last = await io.poll(commandId);
    if (last && ["Success", "Failed", "TimedOut", "Cancelled"].includes(last.status)) break;
  }
  if (!last) return { command, line, status: "NoInstance", instanceId: null, document: null, stdout: "", stderr: "no instance carries the Name tag (the eu-west host is not running)", durationMs: now() - started };
  const status = (["Success", "Failed", "TimedOut", "Cancelled"].includes(last.status) ? last.status : "TimedOut") as HostCliResult["status"];
  return { command, line, status, instanceId: last.instanceId || null, document: documentOf(last.stdout), stdout: last.stdout.slice(0, 6000), stderr: last.stderr.slice(0, 2000), durationMs: now() - started };
}
