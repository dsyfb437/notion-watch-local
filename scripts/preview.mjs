import { createServer } from "node:http";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { build } from "esbuild";
await mkdir("preview", { recursive: true });
await build({
  entryPoints: ["src/dashboard.ts"],
  outfile: "preview/dashboard.js",
  bundle: true,
  format: "esm",
  target: "chrome120",
});
await copyFile("dashboard.css", "preview/dashboard.css");
const html = (await readFile("dashboard.html", "utf8")).replace(
  '<script type="module"',
  '<script src="preview-data.js"></script><script type="module"',
);
await import("node:fs/promises").then((fs) =>
  fs.writeFile("preview/index.html", html),
);
const types = {
  "index.html": "text/html; charset=utf-8",
  "dashboard.css": "text/css",
  "dashboard.js": "text/javascript",
  "preview-data.js": "text/javascript",
};
const server = createServer(async (req, res) => {
  const name = req.url === "/" ? "index.html" : req.url?.slice(1);
  if (!Object.hasOwn(types, name)) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    res.writeHead(200, {
      "Content-Type": types[name],
      "Cache-Control": "no-store",
    });
    res.end(await readFile(`preview/${name}`));
  } catch {
    res.writeHead(500);
    res.end("Preview asset unavailable");
  }
});
server.listen(Number(process.env.PORT) || 8974, "127.0.0.1", () =>
  console.log(`Synthetic demo only: http://127.0.0.1:${server.address().port}`),
);
