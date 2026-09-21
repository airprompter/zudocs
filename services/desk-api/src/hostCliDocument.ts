/**
 * The allowlist and the Run Command document the desk's one-click CLI goes through — one dependency-free module the
 * desk API (the sender), the eu-west stack (which creates the document in the host's region) and the desk stack
 * (which grants `ssm:SendCommand` on that document's ARN and nothing wider) all read, so the three agree on one list.
 *
 * The document is a Command document of one parameter, `command`, whose `allowedValues` are exactly the commands
 * below — SSM refuses any other value before anything reaches the host — and one fixed shell line,
 * `zudocs-cli {{ command }} --json`. The function's role may send that document and no other: not
 * `AWS-RunShellScript`, which would have been arbitrary root on a host that holds the Agent key (a phase 6 review
 * finding). A new drill is a new entry here, a stack redeploy (a new document version) and a test.
 *
 * @example
 * ```ts
 * HOST_CLI_COMMANDS["policy show"];                        // "zudocs-cli policy show --json" — what the host executes
 * hostCliDocumentContent().parameters.command.allowedValues;   // ["status", "doctor", "policy show", "unlock", "rollback"]
 * HOST_CLI_DOCUMENT_NAME;                                  // "zudocs-desk-host-cli"
 * ```
 */

/** The commands the desk may run, by the name the button carries, to the exact line the host executes. */
export const HOST_CLI_COMMANDS: Readonly<Record<HostCliCommand, string>> = Object.freeze({
  "status": "zudocs-cli status --json",
  "doctor": "zudocs-cli doctor --json",
  "policy show": "zudocs-cli policy show --json",
  "unlock": "zudocs-cli unlock --json",
  "rollback": "zudocs-cli rollback --json",
});

export type HostCliCommand = "status" | "doctor" | "policy show" | "unlock" | "rollback";

export const isHostCliCommand = (value: unknown): value is HostCliCommand => typeof value === "string" && Object.prototype.hasOwnProperty.call(HOST_CLI_COMMANDS, value);

/** The custom SSM Command document's fixed name (in the host's region; the desk stack names its ARN from it). */
export const HOST_CLI_DOCUMENT_NAME = "zudocs-desk-host-cli";

/** The one shell line the document runs; the parameter can only ever be one of the allowlist's names. */
export const HOST_CLI_RUN_COMMAND = "zudocs-cli {{ command }} --json";

export interface HostCliDocumentContent {
  schemaVersion: "2.2";
  description: string;
  parameters: {
    command: { type: "String"; description: string; allowedValues: string[] };
    executionTimeout: { type: "String"; description: string; default: string; allowedPattern: string };
  };
  mainSteps: [{ action: "aws:runShellScript"; name: string; inputs: { timeoutSeconds: string; runCommand: [string] } }];
}

/** The document's content, built from the allowlist so the two cannot drift. Pure. */
export function hostCliDocumentContent(): HostCliDocumentContent {
  return {
    schemaVersion: "2.2",
    description: "Zudocs desk: one allowlisted zudocs-cli command on the eu-west host, as JSON. The parameter's allowed values are the whole allowlist; the shell line is fixed.",
    parameters: {
      command: { type: "String", description: "The zudocs-cli command to run (one of the desk's allowlist).", allowedValues: Object.keys(HOST_CLI_COMMANDS) },
      executionTimeout: { type: "String", description: "Seconds the command may run before Run Command stops it.", default: "90", allowedPattern: "^[1-9][0-9]{0,3}$" },
    },
    mainSteps: [{ action: "aws:runShellScript", name: "zudocsCli", inputs: { timeoutSeconds: "{{ executionTimeout }}", runCommand: [HOST_CLI_RUN_COMMAND] } }],
  };
}
