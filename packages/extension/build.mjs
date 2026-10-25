import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "dist");
const staticDir = resolve(here, "static");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: {
    background: resolve(here, "src/background.ts"),
    devtools: resolve(here, "src/devtools.ts"),
  },
  outdir: dist,
  bundle: true,
  format: "iife",
  target: "firefox128",
  platform: "browser",
  logLevel: "info",
});

// copy static assets (manifest + html) verbatim
for (const f of ["manifest.json", "devtools.html", "panel.html"]) {
  cpSync(resolve(staticDir, f), resolve(dist, f));
}

console.log("extension built → dist/");
