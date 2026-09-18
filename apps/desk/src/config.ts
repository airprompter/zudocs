/**
 * The desk's runtime configuration: `config.json` beside the app, written by the desk stack at deploy time from
 * its own outputs (the API endpoint, the pool, the desk client, the hosted UI). On a laptop, `public/config.json`
 * (ignored by git) carries the same shape with the deployed values. Identifiers only — never a key.
 *
 * @example
 * ```ts
 * const config = await loadConfig();   // throws with the missing field named
 * config.apiUrl;                       // "https://xxxx.execute-api.us-east-1.amazonaws.com"
 * ```
 */

export interface DeskConfig {
  apiUrl: string;
  region: string;
  userPoolId: string;
  clientId: string;
  hostedUi: string;
  deskUrl: string;
  environment: string;
  agentId: string;
}

const FIELDS: Array<keyof DeskConfig> = ["apiUrl", "region", "userPoolId", "clientId", "hostedUi", "deskUrl", "environment", "agentId"];

export function parseConfig(raw: unknown): DeskConfig {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const config = {} as DeskConfig;
  for (const field of FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || !value.trim()) throw new Error(`config.json: ${field} is missing`);
    config[field] = value.trim().replace(/\/+$/, "");
  }
  return config;
}

export async function loadConfig(fetchImpl: typeof fetch = fetch): Promise<DeskConfig> {
  const response = await fetchImpl("/config.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`config.json answered ${response.status} — on a laptop, write apps/desk/public/config.json (README)`);
  return parseConfig(await response.json());
}
