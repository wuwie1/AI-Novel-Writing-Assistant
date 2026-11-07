import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
// Node adapters are intentionally shared by dev and static production hosts.
// @ts-expect-error Node ESM transport has runtime tests rather than TS declarations.
import { createMacProxyHandler } from "../infrastructure/transport/proxy.mjs";
// @ts-expect-error Node ESM configuration is validated at its boundary.
import { loadConfig } from "../infrastructure/processes/config.mjs";

const rendererRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rendererRoot, "../..");
const appVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "desktop/package.json"), "utf8")).version;
export default defineConfig({
  root: rendererRoot,
  plugins: [react(), {
    name: "mac-api-transport",
    async configureServer(server) {
      const mode = process.env.MAC_APP_MODE === "remote" ? "remote" : "local";
      const config = await loadConfig({ repoRoot, env: process.env });
      const handler = createMacProxyHandler({
        apiTarget: process.env.MAC_API_TARGET || `http://127.0.0.1:${mode === "remote" ? config.tunnelPort : config.localApiPort}`,
        appVersion, mode, isDevelopment: true,
      });
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? "/";
        if (/^\/(?:api(?:\/|\?|$)|__mac(?:\/|\?|$)|runtime\.js(?:\?|$))/.test(url)) handler(request, response, next);
        else next();
      });
    },
  }],
  resolve: {
    alias: {
      "@": path.join(repoRoot, "client/src"),
      "@mac": path.join(rendererRoot, "src"),
      "@ai-novel/shared": path.join(repoRoot, "shared"),
    },
    dedupe: ["react", "react-dom"],
  },
  define: { "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion) },
  css: { postcss: path.join(rendererRoot, "postcss.config.cjs") },
  server: { host: "127.0.0.1", port: 15174, strictPort: true, fs: { allow: [repoRoot] } },
  build: {
    outDir: process.env.MAC_RENDERER_OUT_DIR || path.join(repoRoot, "desktop_mac/dist/renderer"),
    emptyOutDir: false,
    chunkSizeWarningLimit: 1600,
  },
});
