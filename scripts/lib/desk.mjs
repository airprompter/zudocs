/**
 * The desk API from a script, the way the proofs reach it: the deployed stacks' outputs (CloudFormation, the owner's
 * profile), a sign-in as the proof user through the `proof` client (password from `ZUDOCS_PROOF_PASSWORD` in the
 * environment, never argv), and a small client over the routes the desk app calls — plus the waiters every drill
 * needs: a host row that says something, a timeline row of a kind, an approval that is pending, the fleet agreeing
 * on a generation. Nothing here prints a token or a password.
 *
 * @example
 * ```js
 * const desk = await connectDesk();                                      // { api, outputs, hostRow, eventsSince, waitFor, … }
 * const state = await desk.api("GET", "/state");
 * const row = await desk.waitFor("eu-west staged", async () => (await desk.hostRow("eu-west-1/ec2"))?.status?.stagedGeneration === 7, { timeoutMs: 120_000 });
 * ```
 */
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { AdminInitiateAuthCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { secretFromEnv } from "./config.mjs";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The repository root (for a driver that spawns a script by path). */
export const repoRootOf = () => new URL("../..", import.meta.url).pathname;
export const ago = (iso) => (iso ? `${Math.round((Date.now() - Date.parse(iso)) / 1000)}s ago` : "never");

export async function stackOutputs(region, stackName) {
  try {
    const out = await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: stackName }));
    return Object.fromEntries((out.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
  } catch (error) {
    if (/does not exist/.test(String(error.message))) return null;
    throw error;
  }
}

export async function connectDesk({ region = process.env.AWS_REGION ?? "us-east-1", proofEmail = process.env.ZUDOCS_PROOF_EMAIL ?? "proof@zudocs.com", log = console.log } = {}) {
  const password = secretFromEnv("ZUDOCS_PROOF_PASSWORD", "the proof user's password (scripts/cognito-users.sh proof)");
  const site = await stackOutputs(region, "ZudocsSite");
  const desk = await stackOutputs(region, "ZudocsDesk");
  if (!site || !desk) throw new Error("ZudocsSite and ZudocsDesk must be deployed");
  const cognito = new CognitoIdentityProviderClient({ region });
  const auth = await cognito.send(new AdminInitiateAuthCommand({ UserPoolId: site.UserPoolId, ClientId: site.ProofClientId, AuthFlow: "ADMIN_USER_PASSWORD_AUTH", AuthParameters: { USERNAME: proofEmail, PASSWORD: password } }));
  const idToken = auth.AuthenticationResult?.IdToken;
  if (!idToken) throw new Error(`sign-in as ${proofEmail} did not yield tokens (challenge: ${auth.ChallengeName ?? "none"})`);
  const api = async (method, path, body) => {
    const response = await fetch(`${desk.ApiUrl}${path}`, { method, headers: { authorization: `Bearer ${idToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { text: text.slice(0, 300) }; }
    return { status: response.status, json };
  };
  const state = async () => (await api("GET", "/state")).json;
  const hostRow = async (hostId) => (await state()).hosts?.find((h) => h.hostId === hostId) ?? null;
  const eventsSince = async (since) => (await api("GET", `/events${since ? `?since=${encodeURIComponent(since)}` : ""}`)).json.events ?? [];
  const approvals = async () => (await api("GET", "/approvals")).json.approvals ?? [];
  /** Poll until `check` answers a truthy value; that value comes back. Throws with `what` on the deadline. */
  const waitFor = async (what, check, { timeoutMs = 120_000, everyMs = 5_000 } = {}) => {
    const started = Date.now();
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
      await sleep(everyMs);
    }
  };
  log(`desk: api ${desk.ApiUrl} · ${desk.DeskUrl} · signed in as ${proofEmail} (id token ${idToken.length} chars)`);
  return { region, outputs: { site, desk }, api, state, hostRow, eventsSince, approvals, waitFor, proofEmail };
}
