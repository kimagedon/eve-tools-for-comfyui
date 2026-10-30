import { fileURLToPath, URL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, loadEnv, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sampleExport } from "./scripts/sample-export-plugin";

// ONNX Runtime is loaded at run time from public/ort (lib/depth.ts). In dev,
// Vite tags that dynamic import with ?import and then refuses to serve a
// public file as a module; strip the tag so the file is served as-is.
const ortRaw: Plugin = {
  name: "ort-raw",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      // Under a sub-path base (GitHub Pages) the URL is /<base>/ort/…, so match the segment.
      if (req.url?.includes("/ort/")) req.url = req.url.replace(/\?import$/, "");
      next();
    });
  },
};

const CLOUD = "https://cloud.comfy.org/api";

/**
 * Comfy Cloud through the dev/preview server: the browser calls /cloud/*, the
 * key stays here (COMFY_CLOUD_API_KEY in .env) and Cloud's CORS never applies.
 * /view answers with a redirect to signed storage; it is followed here
 * without the key so the key never reaches the storage host.
 */
function comfyCloud(envKey: string | undefined): Plugin {
  const handle: Connect.NextHandleFunction = async (req: IncomingMessage, res: ServerResponse, next) => {
    if (!req.url?.startsWith("/cloud/")) return next();
    // The key-bearing proxy answers this app only: same-origin requests, never another site or tab.
    const site = req.headers["sec-fetch-site"], origin = req.headers.origin;
    let foreign = !!site && site !== "same-origin";
    try { if (origin && new URL(origin).host !== req.headers.host) foreign = true; } catch { foreign = true; }
    if (foreign) { res.statusCode = 403; res.end("same-origin only"); return; }
    // The app asks whether the proxy is here and whether it holds a key of its own (never the key).
    if (req.url === "/cloud/__status") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ proxy: true, serverKey: !!envKey })); return; }
    // The visitor's own key (kept in their browser) wins over the server's; neither is ever logged.
    const own = req.headers["x-comfy-cloud-key"];
    const key = (Array.isArray(own) ? own[0] : own) || envKey;
    if (!key) {
      res.statusCode = 503;
      res.end("No Comfy Cloud key: add one in the app, or COMFY_CLOUD_API_KEY in .env");
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers: Record<string, string> = { "X-API-Key": key };
      if (req.headers["content-type"]) headers["Content-Type"] = String(req.headers["content-type"]);
      const target = CLOUD + req.url.slice("/cloud".length);
      let upstream = await fetch(target, {
        method: req.method,
        headers,
        body: chunks.length && req.method !== "GET" ? Buffer.concat(chunks) : undefined,
        redirect: "manual",
      });
      const location = upstream.headers.get("location");
      if (upstream.status >= 300 && upstream.status < 400 && location) upstream = await fetch(location);
      res.statusCode = upstream.status;
      const type = upstream.headers.get("content-type");
      if (type) res.setHeader("Content-Type", type);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      res.statusCode = 502;
      res.end(`Comfy Cloud unreachable: ${(e as Error).message}`);
    }
  };
  return {
    name: "comfy-cloud",
    configureServer: (server) => void server.middlewares.use(handle),
    configurePreviewServer: (server) => void server.middlewares.use(handle),
  };
}

/** GitHub Pages serves the project site from /<repo>/. */
const PAGES_BASE = "/eve-tools-for-comfyui/";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // `--mode pages` (npm run build:pages / preview:pages): the static "try it"
  // build. VITE_BASE overrides the sub-path (and --base overrides both).
  const pages = mode === "pages";
  return {
    base: process.env.VITE_BASE || (pages ? PAGES_BASE : "/"),
    // The public build reads no .env file, so a private server address in
    // .env.local (VITE_COMFY_URL) is never baked into it.
    envDir: pages ? false : undefined,
    // The hosted page reaches Comfy Cloud through the public relay (Cloud blocks other sites' browser calls).
    define: pages ? { "import.meta.env.VITE_CLOUD_RELAY": JSON.stringify("https://oktabrj.com/comfy-cloud") } : {},
    plugins: [ortRaw, comfyCloud(env.COMFY_CLOUD_API_KEY), sampleExport(), react(), tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  };
});
