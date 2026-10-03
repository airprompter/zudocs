/**
 * The two guards on the direct providers (phase 9): a **kill switch** the owner can throw without a deploy, and a
 * **daily cap per provider**, separate from and additional to the host's own run cap. Both exist because the budget's
 * circuit-breaker cannot reach these doors: it denies `bedrock:*` through IAM, and a call to the OpenAI or Claude API
 * is plain HTTPS egress with no action to deny — so the host has to refuse for itself, and refuse visibly.
 *
 * The switch is an SSM String parameter in this region (`/zudocs/<environment>/providers`) holding a small document:
 *
 *     {"openai":"on","anthropic":"off","by":"seth@zudocs.com","at":"2026-09-22T10:00:00.000Z"}
 *
 * It is read **fail-closed**: a provider is open only when the document parses and names it `on`. An absent parameter,
 * an unparseable one, an unlisted provider or any other value all read as *closed*, with the reason, so the desk says
 * why rather than guessing. The stack creates the parameter with both doors open, so "absent" means something was
 * deleted — and a deleted switch closing the doors is the safe direction. The Bedrock route is never gated by this:
 * the release's own model in this account is the demo's floor and stays reachable however these two read.
 *
 * @example
 * ```ts
 * parseProviderSwitch('{"openai":"on"}').openai;      // { open: true, reason: null }
 * parseProviderSwitch('{"openai":"on"}').anthropic;   // { open: false, reason: "unlisted" }
 * parseProviderSwitch(null).openai;                   // { open: false, reason: "absent" }
 * providerSwitchDocument({ openai: "on", anthropic: "off" }, "seth@zudocs.com", Date.now());
 * ```
 */
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DIRECT_PROVIDERS, type DirectProvider } from "./providers.js";

/** How long a container holds the switch before reading it again: a kill switch takes effect within this. */
export const SWITCH_CACHE_SECONDS = 30;

export type SwitchState = "on" | "off";

export interface DoorState {
  open: boolean;
  /** Why a door is closed: absent, unparseable, unlisted, off — null when the document said `on`. */
  reason: string | null;
}

export type ProviderSwitch = Readonly<Record<DirectProvider, DoorState>>;

const closed = (reason: string): DoorState => Object.freeze({ open: false, reason });

/** Every door closed for the same reason. Pure. */
const allClosed = (reason: string): ProviderSwitch => Object.freeze(Object.fromEntries(DIRECT_PROVIDERS.map((p) => [p, closed(reason)])) as Record<DirectProvider, DoorState>);

/** The parameter's text as every reader takes it: a door is open only when the document says so. Pure. */
export function parseProviderSwitch(text: string | null | undefined): ProviderSwitch {
  if (text === null || text === undefined || !text.trim()) return allClosed("absent");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return allClosed("unparseable");
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return allClosed("unparseable");
  const d = doc as Record<string, unknown>;
  return Object.freeze(Object.fromEntries(DIRECT_PROVIDERS.map((p): [DirectProvider, DoorState] => {
    const value = d[p];
    if (value === undefined) return [p, closed("unlisted")];
    if (value === "on") return [p, Object.freeze({ open: true, reason: null })];
    return [p, closed("off")];
  })) as Record<DirectProvider, DoorState>);
}

/** The document the desk writes: every door named, so a reader never has to guess at an omission. Pure. */
export function providerSwitchDocument(doors: Record<DirectProvider, SwitchState>, by: string, nowMs: number): string {
  return JSON.stringify({ ...Object.fromEntries(DIRECT_PROVIDERS.map((p) => [p, doors[p] === "on" ? "on" : "off"])), by, at: new Date(nowMs).toISOString() });
}

/** The doors as they read now, with one flipped: what the desk writes when the owner closes or opens one. Pure. */
export function withDoor(current: ProviderSwitch, provider: DirectProvider, state: SwitchState): Record<DirectProvider, SwitchState> {
  return Object.fromEntries(DIRECT_PROVIDERS.map((p) => [p, p === provider ? state : current[p].open ? "on" : "off"])) as Record<DirectProvider, SwitchState>;
}

export interface ProviderSwitchPorts {
  /** The switch as it reads now (cached for `SWITCH_CACHE_SECONDS`), and the parameter it came from. */
  read(): Promise<ProviderSwitch & { parameter: string }>;
  /** Flip one door and write the whole document; the answer is the switch as written. */
  write(provider: DirectProvider, state: SwitchState, by: string): Promise<ProviderSwitch & { parameter: string }>;
  readonly parameter: string;
}

/** Enough of the SSM client for the switch: the two commands it sends. */
export interface SwitchClient {
  send(command: unknown): Promise<unknown>;
}

/** The switch over SSM, with the same short cache the demo-mode switch uses; the client is injectable for tests. */
export function createProviderSwitchPorts(region: string, parameter: string, now: () => number = Date.now, client?: SwitchClient): ProviderSwitchPorts {
  const ssm: SwitchClient = client ?? new SSMClient({ region });
  let cached: { text: string | null; at: number } | null = null;
  const fetchText = async (): Promise<string | null> => {
    try {
      return ((await ssm.send(new GetParameterCommand({ Name: parameter }))) as { Parameter?: { Value?: string } })?.Parameter?.Value ?? null;
    } catch (error) {
      if ((error as Error).name === "ParameterNotFound") return null;
      throw error;
    }
  };
  return {
    parameter,
    async read() {
      if (!cached || now() - cached.at > SWITCH_CACHE_SECONDS * 1000) cached = { text: await fetchText(), at: now() };
      return { ...parseProviderSwitch(cached.text), parameter };
    },
    async write(provider, state, by) {
      if (!cached || now() - cached.at > SWITCH_CACHE_SECONDS * 1000) cached = { text: await fetchText(), at: now() };
      const text = providerSwitchDocument(withDoor(parseProviderSwitch(cached.text), provider, state), by, now());
      await ssm.send(new PutParameterCommand({ Name: parameter, Value: text, Type: "String", Overwrite: true }));
      cached = { text, at: now() };
      return { ...parseProviderSwitch(text), parameter };
    },
  };
}
