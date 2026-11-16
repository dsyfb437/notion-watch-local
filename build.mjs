import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
const out = process.env.OUT_DIR || "dist";
await mkdir(out, { recursive: true });
await build({
  entryPoints: ["src/worker.ts", "src/dashboard.ts"],
  outdir: out,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  legalComments: "none",
});
for (const name of [
  "manifest.json",
  "dashboard.html",
  "dashboard.css",
  "icon.png",
])
  await copyFile(name, `${out}/${name}`);
