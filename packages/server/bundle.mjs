import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

// Single self-contained file so consumers (e.g. a Nix package) only need node.
await build({
  entryPoints: [resolve(here, "src/index.ts")],
  outfile: resolve(here, "bundle/bridge-server.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // ws loads these optional native addons inside try/catch
  external: ["bufferutil", "utf-8-validate"],
  // bundled CJS deps (ws) call require() on node builtins, which ESM lacks
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  logLevel: "info",
});
