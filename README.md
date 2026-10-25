# Firefox DevTools MCP Bridge

A Firefox DevTools extension paired with a Node MCP server. It lets an MCP client
(opencode, Claude Code, etc.) read the inspected page's **Network** and **DOM/Inspector**
data and take **screenshots** of a localhost dev page.

Two processes joined by a WebSocket:

- **Node MCP server** — talks MCP/JSON-RPC over stdio to the client, and runs a WebSocket
  *server* the extension dials into.
- **Firefox extension (MV3)** — its devtools page owns `devtools.network` (HAR) and
  `inspectedWindow.eval`; its background page owns the WebSocket and `tabs.captureTab`.

The extension dials out to `ws://127.0.0.1:8765`; the server pushes commands down the socket.
Only the single tab whose devtools is open is served. See [SPEC.md](./SPEC.md) for the full
design.

## Tools

| Category | Tools |
|---|---|
| Network | `list_requests`, `get_request` |
| DOM | `get_element`, `get_selected_element`, `get_computed_styles`, `dump_subtree` |
| Screenshots | `screenshot_viewport`, `screenshot_element`, `screenshot_selected_element` |

## Requirements

- **Node.js** ≥ 22
- **Firefox** ≥ 140

## Install & build

```sh
npm install
npm run build      # builds server and extension
```

Individual packages:

```sh
npm run build -w @bridge/server      # esbuild bundle → packages/server/bundle/bridge-server.mjs
npm run build -w @bridge/extension   # esbuild bundle → packages/extension/dist/
```

## 1. Start the MCP server

The server speaks MCP over **stdio** and listens for the extension on
`ws://127.0.0.1:8765`.

```sh
npm run build -w @bridge/server && npm run start -w @bridge/server
```

> Note: stdout is the MCP channel — all logs go to stderr.

## 2. Load the extension in Firefox

Build first (`npm run build -w @bridge/extension`), then either:

**Via web-ext (auto-reloads):**

```sh
npm run run -w @bridge/extension          # web-ext run --source-dir dist
```

**Manually via about:debugging:**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `packages/extension/dist/manifest.json`.

Then, in the tab you want to inspect (a `http://localhost/*` or `http://127.0.0.1/*` page):

1. Open DevTools (`F12`).
2. Open the **Network** panel and let at least one request land — network capture only
   arms after the panel is activated once.

The extension auto-dials the server; `session.hello` establishes the tab. Watch the server's
stderr for `extension connected`.

### Changing the port

The port is defined once in `packages/shared/methods.ts` (`DEFAULT_WS_PORT = 8765`) and
whitelisted in the manifest CSP (`packages/extension/static/manifest.json`, `connect-src`).
Update both, then rebuild server and extension.

## 3. Integrate with opencode

Register the server as a **local (stdio) MCP server** in your opencode config
(`opencode.json` in the project, or `~/.config/opencode/opencode.json` for global). Point
it at the built server entry:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "firefox-bridge": {
      "type": "local",
      "command": ["node", "/absolute/path/to/firefox-mcp-bridge/packages/server/bundle/bridge-server.mjs"],
      "enabled": true
    }
  }
}
```

Requires `npm run build -w @bridge/server` first so the bundle exists.

opencode launches the server itself over stdio — don't also run it manually. Load the
extension and open DevTools (steps 1–2) so a tab is attached before invoking the tools;
otherwise calls return `NO_TAB_CONNECTED`.

## Development

```sh
npm run typecheck    # tsc across shared, server, extension
npm test             # vitest
```

## Release

Pushing a `v*` tag runs `.github/workflows/release.yml`. It signs the extension on AMO as
**unlisted** (never published on addons.mozilla.org) and attaches two assets to a GitHub
Release:

- `firefox-mcp-bridge-<version>.xpi` — signed extension, installable in release Firefox
- `bridge-server-<version>.mjs` — self-contained server bundle, run with `node`

Requires the repository secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` (AMO Developer Hub →
Manage API Keys).

1. Bump `version` in `package.json` and `packages/extension/static/manifest.json`. AMO
   rejects a version it has already signed, so every attempt needs a fresh one.
2. `git tag vX.Y.Z && git push --tags`

Build the server bundle locally with `npm run build -w @bridge/server` →
`packages/server/bundle/bridge-server.mjs`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `NO_TAB_CONNECTED` | DevTools not open on a served tab, or extension not connected. |
| `NETWORK_INACTIVE` | Network panel never activated this session — open it once. |
| `NO_MATCH` / `NO_SELECTION` | Selector matched nothing / no Inspector `$0` selection. |
| Extension won't connect | Port mismatch (`DEFAULT_WS_PORT` vs manifest CSP), or page isn't `localhost`/`127.0.0.1`. |

## Limitations

Main frame only; network capture requires the Network panel activated once; screenshots are
viewport + element only (no full-page stitch); single active tab. No page interaction beyond
`scrollIntoView` for element screenshots. See [SPEC.md §9](./SPEC.md#9-known-limitations).
