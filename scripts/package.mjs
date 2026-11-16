import { readFile, mkdir, writeFile } from "node:fs/promises";
import { zipSync, unzipSync } from "fflate";
await import("../build.mjs");
const files = [
  "manifest.json",
  "worker.js",
  "dashboard.js",
  "dashboard.html",
  "dashboard.css",
  "icon.png",
];
const { version } = JSON.parse(await readFile("manifest.json", "utf8"));
const entries = {};
for (const file of files)
  entries[`notion-watch/${file}`] = new Uint8Array(
    await readFile(`dist/${file}`),
  );
for (const file of ["README.md", "PRIVACY.md", "LICENSE"])
  entries[`notion-watch/${file}`] = new Uint8Array(await readFile(file));
const bytes = zipSync(entries, { level: 9 });
const verified = unzipSync(bytes);
for (const [name, data] of Object.entries(entries))
  if (Buffer.compare(Buffer.from(data), Buffer.from(verified[name])) !== 0)
    throw Error(`Archive mismatch: ${name}`);
await mkdir("release", { recursive: true });
const output = `release/notion-watch-${version}.zip`;
await writeFile(output, bytes);
console.log(output);
