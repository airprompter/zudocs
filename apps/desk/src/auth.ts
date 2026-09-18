/**
 * Sign-in with the Cognito hosted UI over PKCE, no library: a verifier and its S256 challenge, the authorize URL,
 * the code-for-tokens exchange at the pool's token endpoint, a refresh, and sign-out. Tokens live in
 * `sessionStorage` for the tab's life (an hour-long id token, a day-long refresh token); nothing else stores them.
 * The pure parts (challenge, URLs, expiry) are testable without a browser.
 *
 * @example
 * ```ts
 * const auth = createAuth(config);
 * if (location.pathname === "/callback") await auth.completeSignIn(new URL(location.href));
 * const token = await auth.idToken();           // null when signed out → auth.beginSignIn()
 * ```
 */
import type { DeskConfig } from "./config";

export interface Tokens {
  idToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds when the id token stops being accepted. */
  expiresAt: number;
  email: string | null;
}

const STORAGE = "zudocs.desk.tokens";
const PKCE = "zudocs.desk.pkce";

const base64url = (bytes: ArrayBuffer | Uint8Array): string => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function randomVerifier(bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(48))): string {
  return base64url(bytes);
}

export async function challengeOf(verifier: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export function authorizeUrl(config: Pick<DeskConfig, "hostedUi" | "clientId">, redirectUri: string, challenge: string, state: string): string {
  const url = new URL(`${config.hostedUi}/oauth2/authorize`);
  url.search = new URLSearchParams({ client_id: config.clientId, response_type: "code", scope: "openid email", redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state }).toString();
  return url.href;
}

export function logoutUrl(config: Pick<DeskConfig, "hostedUi" | "clientId">, logoutUri: string): string {
  const url = new URL(`${config.hostedUi}/logout`);
  url.search = new URLSearchParams({ client_id: config.clientId, logout_uri: logoutUri }).toString();
  return url.href;
}

/** The claims of a JWT without verifying it (the API verifies; the app only reads the e-mail and the expiry). */
export function claimsOf(jwt: string): Record<string, unknown> {
  try {
    const payload = jwt.split(".")[1] ?? "";
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function tokensFrom(response: { id_token: string; refresh_token?: string; expires_in: number }, now = Date.now(), previousRefresh: string | null = null): Tokens {
  const claims = claimsOf(response.id_token);
  return { idToken: response.id_token, refreshToken: response.refresh_token ?? previousRefresh, expiresAt: now + response.expires_in * 1000 - 60_000, email: typeof claims.email === "string" ? claims.email : null };
}

export interface Auth {
  tokens(): Tokens | null;
  /** A valid id token, refreshed when needed; null when signed out. */
  idToken(): Promise<string | null>;
  beginSignIn(): Promise<void>;
  completeSignIn(url: URL): Promise<void>;
  signOut(): void;
}

export function createAuth(config: DeskConfig, storage: Storage = sessionStorage, fetchImpl: typeof fetch = fetch): Auth {
  const redirectUri = `${location.origin}/callback`;
  const read = (): Tokens | null => {
    try {
      const raw = storage.getItem(STORAGE);
      return raw ? (JSON.parse(raw) as Tokens) : null;
    } catch {
      return null;
    }
  };
  const write = (tokens: Tokens | null) => (tokens ? storage.setItem(STORAGE, JSON.stringify(tokens)) : storage.removeItem(STORAGE));
  const exchange = async (body: Record<string, string>): Promise<{ id_token: string; refresh_token?: string; expires_in: number }> => {
    const response = await fetchImpl(`${config.hostedUi}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
    if (!response.ok) throw new Error(`token endpoint answered ${response.status}`);
    return (await response.json()) as { id_token: string; refresh_token?: string; expires_in: number };
  };
  return {
    tokens: read,
    async idToken() {
      const tokens = read();
      if (!tokens) return null;
      if (tokens.expiresAt > Date.now()) return tokens.idToken;
      if (!tokens.refreshToken) {
        write(null);
        return null;
      }
      try {
        const refreshed = tokensFrom(await exchange({ grant_type: "refresh_token", client_id: config.clientId, refresh_token: tokens.refreshToken }), Date.now(), tokens.refreshToken);
        write(refreshed);
        return refreshed.idToken;
      } catch {
        write(null);
        return null;
      }
    },
    async beginSignIn() {
      const verifier = randomVerifier();
      const state = randomVerifier(crypto.getRandomValues(new Uint8Array(16)));
      storage.setItem(PKCE, JSON.stringify({ verifier, state }));
      location.assign(authorizeUrl(config, redirectUri, await challengeOf(verifier), state));
    },
    async completeSignIn(url) {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const pending = JSON.parse(storage.getItem(PKCE) ?? "null") as { verifier: string; state: string } | null;
      storage.removeItem(PKCE);
      if (!code || !pending || pending.state !== state) throw new Error("sign-in did not complete: the callback carried no code, or a state this tab did not start");
      write(tokensFrom(await exchange({ grant_type: "authorization_code", client_id: config.clientId, code, redirect_uri: redirectUri, code_verifier: pending.verifier })));
      history.replaceState(null, "", "/");
    },
    signOut() {
      write(null);
      location.assign(logoutUrl(config, `${location.origin}/`));
    },
  };
}
