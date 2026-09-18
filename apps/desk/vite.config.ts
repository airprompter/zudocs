/**
 * Vite for the desk: React, a plain build into `dist/` (hashed assets, no inline script or style — the CloudFront
 * CSP allows `'self'` only), and the dev server on the port the Cognito client's localhost callback names.
 *
 * @example
 * ```sh
 * npm run dev --workspace apps/desk       # http://localhost:5173 with public/config.json (see README)
 * npm run build --workspace apps/desk     # dist/ for the desk stack
 * ```
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { target: "es2022", sourcemap: false, assetsInlineLimit: 0, modulePreload: { polyfill: false } },
});
