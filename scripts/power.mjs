#!/usr/bin/env node
/**
 * The eu-west host's power and the demo-mode switch from the owner's profile — the same acts the desk's presenter
 * panel offers, for a terminal, the proofs and the reset's checklist: `sleep`, `wake` and `status` invoke the
 * eu-west power function (`services/eu-host/src/power.ts`) and print its answer; `wake --wait` then reads the
 * host's status row until the workers have written it since the start (the daemon re-reads its key, the workers
 * re-attach: about three minutes); `demo-mode on|off` writes the eu-west demo-mode parameter (on lapses on its own
 * after four hours — the same document the desk writes, `services/desk-api/src/demoMode.ts`). No key is involved
 * anywhere here.
 *
 * @example
 * ```sh
 * AWS_PROFILE=zudocs npm run host:status
 * AWS_PROFILE=zudocs npm run host:sleep
 * AWS_PROFILE=zudocs npm run host:wake -- --wait        # returns when the eu-west row is fresh and both workers report
 * AWS_PROFILE=zudocs npm run demo:mode -- on            # the workers run a ticket every two minutes for four hours
 * ```
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { readConfig } from "./lib/config.mjs";

const hostRegion = process.env.ZUDOCS_HOST_REGION ?? "eu-west-1";
const tablesRegion = process.env.ZUDOCS_TABLES_REGION ?? "us-east-1";
const HOST_ID = `${hostRegion}/ec2`;
const POWER_FUNCTION = "zudocs-power";
const STATUS_TABLE = "zudocs-desk-status";
/** The desk's rule (`demoMode.ts` › DEMO_MODE_MAX_HOURS): a switch lives at most four hours. */
const DEMO_MODE_MAX_HOURS = 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest);

async function invokePower(action) {
  const out = await new LambdaClient({ region: hostRegion }).send(new InvokeCommand({ FunctionName: POWER_FUNCTION, Payload: Buffer.from(JSON.stringify({ action, by: "the owner (scripts/power.mjs)" })) }));
  const answer = JSON.parse(Buffer.from(out.Payload ?? new Uint8Array()).toString("utf8") || "{}");
  if (out.FunctionError) throw new Error(`${POWER_FUNCTION}: ${answer.errorMessage ?? out.FunctionError}`);
  return answer;
}

async function statusRow() {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: tablesRegion }));
  return (await ddb.send(new GetCommand({ TableName: STATUS_TABLE, Key: { hostId: HOST_ID } }))).Item ?? null;
}

const print = (answer) => {
  const m = answer.marker;
  console.log(`${answer.hostId}: ${answer.state ?? "no instance"}${answer.instanceId ? ` (${answer.instanceId})` : ""}${answer.refusal ? ` — refused: ${answer.refusal}` : answer.changed ? " — changed" : ""}`);
  if (m) console.log(`  marker: ${m.state} since ${m.since} by ${m.by}`);
  console.log(`  ${answer.message}`);
};

async function waitAwake(since) {
  const started = Date.now();
  process.stdout.write("waiting for the workers' rows");
  for (;;) {
    const row = await statusRow();
    const fresh = row?.writtenAt && Date.parse(row.writtenAt) > Date.parse(since);
    const node = row?.worker?.attached === true;
    const python = row?.python?.writtenAt && Date.parse(row.python.writtenAt) > Date.parse(since) && row.python.attached === true;
    if (fresh && node && python) {
      process.stdout.write("\n");
      console.log(`awake: row written ${row.writtenAt}, generation ${row.status?.generation}, node worker attached, python worker attached (${Math.round((Date.now() - started) / 1000)} s after the start)`);
      return;
    }
    if (Date.now() - started > 8 * 60_000) {
      process.stdout.write("\n");
      throw new Error(`the host did not report within eight minutes (row ${row?.writtenAt ?? "absent"}, node ${node ? "attached" : "not attached"}, python ${python ? "attached" : "not attached"})`);
    }
    process.stdout.write(".");
    await sleep(10_000);
  }
}

async function main() {
  switch (command) {
    case "status": {
      const answer = await invokePower("status");
      print(answer);
      const row = await statusRow();
      if (row) console.log(`  status row written ${row.writtenAt} · generation ${row.status?.generation ?? "—"} · node ${row.worker?.attached ? "attached" : "detached"} · python ${row.python?.attached ? "attached" : "not reporting"} · cadence ${row.cadence ? `${row.cadence.ticketIntervalSeconds}s (demo ${row.cadence.demoMode})` : "—"}`);
      return;
    }
    case "sleep": {
      print(await invokePower("sleep"));
      return;
    }
    case "wake": {
      const answer = await invokePower("wake");
      print(answer);
      if (answer.refusal) process.exitCode = 2;
      else if (flags.has("--wait")) await waitAwake(answer.marker?.since ?? new Date().toISOString());
      return;
    }
    case "demo-mode": {
      const mode = rest.find((a) => a === "on" || a === "off");
      const config = readConfig();
      const name = process.env.ZUDOCS_DEMO_MODE_PARAMETER ?? `/zudocs/${config.environment}/demo-mode`;
      const ssm = new SSMClient({ region: hostRegion });
      if (!mode) {
        const current = (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value ?? "";
        console.log(`${name}: ${current}`);
        return;
      }
      const now = Date.now();
      const doc = mode === "on" ? { mode, until: new Date(now + DEMO_MODE_MAX_HOURS * 3_600_000).toISOString(), by: "the owner (scripts/power.mjs)", at: new Date(now).toISOString() } : { mode, by: "the owner (scripts/power.mjs)", at: new Date(now).toISOString() };
      await ssm.send(new PutParameterCommand({ Name: name, Value: JSON.stringify(doc), Type: "String", Overwrite: true }));
      console.log(`${name} ← ${JSON.stringify(doc)}`);
      console.log(mode === "on" ? "the eu-west workers pick it up within a minute: a ticket every two minutes (Python: five) until it lapses; the nightly sleep skips the host while it is on" : "the eu-west workers return to a ticket an hour (Python: two) at their next read");
      return;
    }
    default:
      console.error("usage: node scripts/power.mjs status | sleep | wake [--wait] | demo-mode [on|off]");
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`power: ${error.name}: ${error.message}`);
  process.exitCode = 1;
});
