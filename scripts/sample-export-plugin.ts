/**
 * Dev/preview-server endpoint that writes a sample bundle to
 * public/samples/<id>/. The page's `window.__eveExportProject(id)`
 * (src/samples.ts) posts the files here; scripts/export-sample.mjs drives it.
 *
 *   POST /__eve/sample/<id>/begin        an existing bundle is moved aside to
 *                                        .smoke/samples-old/<id>-<time>/ (never deleted)
 *   POST /__eve/sample/<id>/<file>       raw body → public/samples/<id>/<file>
 *
 * Only on the local dev/preview server (never part of a build) and only from
 * the loopback interface.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin } from "vite";

const ROUTE = "/__eve/sample/";
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(json|jpg|png|mp4|webm)$/;
/** The largest single file accepted (an LTX clip is ~0.5–2 MB). */
const MAX_BYTES = 64 * 1024 * 1024;

const loopback = (req: IncomingMessage) => /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress ?? "");

function stamp() {
  const d = new Date(), p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function sampleExport(root = process.cwd()): Plugin {
  const samples = resolve(root, "public", "samples");
  const attic = resolve(root, ".smoke", "samples-old");
  const handle: Connect.NextHandleFunction = async (req: IncomingMessage, res: ServerResponse, next) => {
    const at = req.url?.indexOf(ROUTE) ?? -1;
    if (at < 0) return next();
    const reply = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST") return reply(405, { error: "POST only" });
    if (!loopback(req)) return reply(403, { error: "loopback only" });
    // Loopback is not enough against a page in another tab: same-origin only (Node scripts send no sec-fetch-site).
    const site = req.headers["sec-fetch-site"], o = req.headers.origin;
    if (site && site !== "same-origin") return reply(403, { error: "same-origin only" });
    try { if (o && new URL(o).host !== req.headers.host) return reply(403, { error: "same-origin only" }); } catch { return reply(403, { error: "same-origin only" }); }
    const [id, file] = req.url!.slice(at + ROUTE.length).split("?")[0].split("/");
    if (!id || !ID.test(id)) return reply(400, { error: "bad sample id" });
    const dir = join(samples, id);
    try {
      if (file === "begin") {
        let moved: string | null = null;
        if (existsSync(dir)) {
          mkdirSync(attic, { recursive: true });
          moved = join(attic, `${id}-${stamp()}`);
          renameSync(dir, moved);
        }
        mkdirSync(dir, { recursive: true });
        return reply(200, { ok: true, dir, moved });
      }
      if (!file || !FILE.test(file)) return reply(400, { error: "bad file name" });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_BYTES) return reply(413, { error: "file too large" });
        chunks.push(c as Buffer);
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), Buffer.concat(chunks));
      return reply(200, { ok: true, file: join(dir, file), bytes: size });
    } catch (e) {
      return reply(500, { error: (e as Error).message });
    }
  };
  return {
    name: "eve-sample-export",
    apply: "serve",
    configureServer: (server) => void server.middlewares.use(handle),
    configurePreviewServer: (server) => void server.middlewares.use(handle),
  };
}
