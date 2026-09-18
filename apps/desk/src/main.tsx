/**
 * The desk's entry: read `config.json`, finish a sign-in callback when this is one, then mount the app signed in
 * or show the sign-in card. Errors on the way (a missing config, a callback with a foreign state) are shown, not
 * swallowed.
 *
 * @example
 * ```html
 * <script type="module" src="/src/main.tsx"></script>
 * ```
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createApi } from "./api";
import { createAuth } from "./auth";
import { loadConfig } from "./config";
import { SignIn } from "./components/SignIn";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

async function boot(): Promise<void> {
  try {
    const config = await loadConfig();
    const auth = createAuth(config);
    if (location.pathname === "/callback") await auth.completeSignIn(new URL(location.href));
    const token = await auth.idToken();
    if (!token) {
      root.render(<StrictMode><SignIn onSignIn={() => void auth.beginSignIn()} environment={config.environment} /></StrictMode>);
      return;
    }
    const api = createApi(config.apiUrl, () => auth.idToken());
    root.render(<StrictMode><App api={api} config={config} who={auth.tokens()?.email ?? "signed in"} onSignOut={() => auth.signOut()} /></StrictMode>);
  } catch (error) {
    root.render(<StrictMode><SignIn onSignIn={() => location.assign("/")} environment="" problem={(error as Error).message} /></StrictMode>);
  }
}

void boot();
