/**
 * Writes apps/desk/src/snippets.ts from brace-matched slices of the host source.
 *
 * @example
 * ```sh
 * npx tsx apps/desk/scripts/write-snippets.ts
 * ```
 */
import { readFileSync, writeFileSync } from "node:fs";
import { extractBalanced, extractLine } from "../src/excerpt";

const read = (p: string) => readFileSync(p, "utf8");
const runtime = read("services/desk-api/src/runtime.ts");
const run = read("services/desk-api/src/run.ts");
const api = read("apps/desk/src/api.ts");
const worker = read("services/eu-host/src/worker.ts");
const unit = read("services/eu-host/host/units/airprompterd.service");
const airgap = read("services/airgap/src/runtime.ts");
const presenter = read("apps/desk/src/components/Presenter.tsx");

const enqueueCall = 'onAction("enqueue", { ticketId: selectedTicketId, host: hostId })';
if (!presenter.includes(enqueueCall)) throw new Error("enqueue call missing from Presenter.tsx");

const snippets: Array<[string, { id: string; file: string; caption: string; text: string; marks: Array<{ needle: string; kind: "write" | "host" }> }]> = [
  ["LAMBDA_START", { id: "lambda-start", file: "services/desk-api/src/runtime.ts", caption: "What this host adds", text: extractBalanced(runtime, "const ap = await AirPrompterAgent.start({"), marks: [{ needle: "apiKey,", kind: "host" }, { needle: 'storageProtection: "kms"', kind: "host" }, { needle: 'mode: "on_invoke"', kind: "host" }, { needle: "teeFetch", kind: "host" }] }],
  ["RUN_STEP", { id: "run-step", file: "services/desk-api/src/run.ts", caption: "What you write", text: extractBalanced(run, "const runStep = async"), marks: [{ needle: "ap.prompt(", kind: "write" }, { needle: "handle.renderAsync", kind: "write" }, { needle: "ap.checks(", kind: "write" }, { needle: "ap.judge(", kind: "write" }] }],
  ["CLIENT_RUN", { id: "client-run", file: "apps/desk/src/api.ts", caption: "This page", text: extractLine(api, "runTicket:"), marks: [] }],
  ["DAEMON_CONNECT", { id: "daemon-connect", file: "services/eu-host/src/worker.ts", caption: "What you write", text: extractBalanced(worker, "DaemonClient.connect({"), marks: [{ needle: "DaemonClient.connect", kind: "write" }] }],
  ["DAEMON_START", { id: "daemon-start", file: "services/eu-host/src/worker.ts", caption: "What you write", text: extractBalanced(worker, "const agent = await AirPrompterAgent.start({"), marks: [{ needle: 'mode: "daemon"', kind: "write" }] }],
  ["DAEMON_GUARD", { id: "daemon-guard", file: "services/eu-host/src/worker.ts", caption: "What you write", text: extractBalanced(worker, 'if (agent.status().source !== "daemon")'), marks: [{ needle: 'source !== "daemon"', kind: "write" }] }],
  ["POLICY_LINE", { id: "policy-line", file: "services/eu-host/host/units/airprompterd.service", caption: "What this host adds", text: extractLine(unit, "--apply-policy unlock_required"), marks: [{ needle: "--apply-policy unlock_required", kind: "host" }] }],
  ["AIRGAP_START", { id: "airgap-start", file: "services/airgap/src/runtime.ts", caption: "A host with no route out", text: extractBalanced(airgap, "const agent = await AirPrompterAgent.start({"), marks: [{ needle: 'mode: "offline"', kind: "host" }] }],
  ["ENQUEUE_CALL", { id: "enqueue-call", file: "apps/desk/src/components/Presenter.tsx", caption: "This page", text: enqueueCall, marks: [] }],
];

const exports = snippets.map(([name, value]) => `export const ${name}: Snippet = ${JSON.stringify(value, null, 2)};`).join("\n\n");
const file = `/**
 * The code the drawer shows. Each string is a brace-matched or single-line slice of a source file.
 * apps/desk/test/snippets.test.ts fails when a slice no longer matches that file.
 *
 * @example
 * \`\`\`ts
 * LAMBDA_START.text.includes("on_invoke");
 * \`\`\`
 */

import type { Mark } from "./excerpt";

export interface Snippet {
  id: string;
  file: string;
  caption: string;
  text: string;
  marks: readonly Mark[];
}

${exports}
`;
writeFileSync("apps/desk/src/snippets.ts", file);
for (const [name, value] of snippets) console.log(name, value.text.length);
