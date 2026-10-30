// Copies the ONNX Runtime Web files EVE loads at run time (lib/depth.ts)
// into public/ort, so they ship inside the app instead of coming from a CDN.
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const from = join(import.meta.dirname, "..", "node_modules", "onnxruntime-web", "dist");
const to = join(import.meta.dirname, "..", "public", "ort");
const files = ["ort.min.mjs", "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];
mkdirSync(to, { recursive: true });
for (const f of files) {
  const src = join(from, f), dst = join(to, f);
  if (existsSync(dst) && statSync(dst).size === statSync(src).size && statSync(dst).mtimeMs >= statSync(src).mtimeMs) continue;
  copyFileSync(src, dst);
}
