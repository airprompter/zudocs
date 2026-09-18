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

// A laptop that cannot present as http://localhost:5173 (another server holds it) sets ZUDOCS_API_PROXY to the API
// URL and `apiUrl: "/api"` in public/config.json: the dev server forwards same-origin, so the API's CORS is not in play.
const proxy = process.env.ZUDOCS_API_PROXY;

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, ...(proxy ? { proxy: { "/api": { target: proxy, changeOrigin: true, rewrite: (path) => path.replace(/^\/api/, "") } } } : {}) },
  build: { target: "es2022", sourcemap: false, assetsInlineLimit: 0, modulePreload: { polyfill: false } },
});
