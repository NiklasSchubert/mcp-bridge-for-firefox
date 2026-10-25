# Firefox DevTools MCP Bridge — Implementation Spec

A Firefox DevTools extension + Node MCP server pair that lets an MCP client (Claude Code,
etc.) read the inspected page's **Network-tab** and **Inspector/DOM** data and take
**screenshots** of a localhost dev page.

This document is the implementation-ready spec. A build session should be able to code from
it without further product decisions. Items explicitly deferred are in
[§9 Known limitations](#9-known-limitations); empirical checks to validate (not decide) are
in [§10 Build-time checks](#10-build-time-checks-verify-dont-decide).

---

## 1. Architecture

Two processes joined by a WebSocket.

```
 MCP client (Claude Code)
        │  stdio (MCP / JSON-RPC)
        ▼
 ┌─────────────────────────┐        ws://localhost:<port>        ┌──────────────────────────────┐
 │      Node MCP server     │◄────────── JSON-RPC 2.0 ──────────►│   Firefox extension (MV3)      │
 │  - @modelcontextprotocol │                                    │                                │
 │    /sdk (stdio→client)   │   server→ext: commands (id)        │  background (event page):      │
 │  - WS *server* (listens) │   ext→server: notifications        │   - WS *client* (dials out)    │
 │  - request buffer        │                                    │   - tabs.captureTab            │
 │  - session state machine │                                    │   - runtime-port router        │
 │  - tool→primitive mapping│                                    │        │ runtime port           │
 │  - builds eval strings   │                                    │        ▼                       │
 └─────────────────────────┘                                    │  devtools page (ephemeral):    │
                                                                 │   - devtools.network (HAR)     │
                                                                 │   - inspectedWindow.eval       │
                                                                 │   - mints request ids          │
                                                                 └──────────────────────────────┘
```

- **The extension dials out** to `ws://localhost:<port>`; it cannot be a listening server.
  The MCP server is the WS *server* and pushes commands down the socket.
- **Split forced by API availability:**
  - **devtools page** (torn down when devtools closes) owns `devtools.network` (HAR buffer)
    and `inspectedWindow.eval`.
  - **background** (non-persistent MV3 event page, see [§8](#8-mv3-keepalive-rationale))
    owns the WebSocket and `tabs.captureTab`.
  - **internal bridge:** a `runtime` port between them; the devtools page's open port keeps
    the MV3 event page alive exactly while devtools is open.
- **Single tab** — the one tab whose devtools is connected. No multi-tab addressing (v1).

---

## 2. Repo layout

TypeScript monorepo, **npm workspaces**.

```
firefox-mcp-bridge/
├── packages/
│   ├── shared/          # plain folder — shared JSON-RPC methods, param/result types, error codes
│   ├── server/          # @bridge/server   — Node MCP server (stdio→client, WS server→extension)
│   └── extension/       # @bridge/extension — MV3 WebExtension (background + devtools page + panel)
├── package.json         # workspace root: "workspaces": ["packages/server", "packages/extension"]
└── SPEC.md
```

- **`packages/shared/`** is imported by relative path from both `server` and `extension` —
  one source of truth for the wire contract (method names, envelope types, the 7 error
  codes, tool param/result shapes, WS port). No package, no build step: both sides bundle it.
- **`@bridge/server`** depends on `@modelcontextprotocol/sdk` and a WS library (e.g. `ws`).
- Both packages are bundled with **esbuild**, which inlines `shared/`. The server becomes
  one self-contained `.mjs`; `web-ext` loads the extension's background / devtools-page
  bundles.

---

## 3. The 9 MCP tools

All tools return `isError: true` + a typed `code` on failure (see [§6](#6-error-model)).
All body/HTML-bearing responses carry `{ truncated, totalBytes }` and accept
`maxBytes` / `offset` paging. Cap numbers below are tunable defaults.

### Network (2)

**`list_requests(filters?)`** → `{ entries: LeanEntry[], matchCount }`

- `LeanEntry = { id, method, url, status, resourceType, mimeType, size, durationMs, startedDateTime }`.
- `id` = the devtools-minted compound id `<sessionId>.<counter>` (see [§5.3](#53-request-identity)).
- `size` = encoded transfer size of the response body (HAR `response.bodySize`; `-1` if unknown).
- `filters?`: `{ urlContains?, method?, status?, resourceType?, limit? }`.
- Headers are **not** inline — drill in with `get_request`.
- Reads the server-side buffer (no round-trip to the extension).

**`get_request(id)`** → `{ requestHeaders, responseHeaders, requestBody, responseBody, mimeType, truncated, totalBytes }`

- Body fetched lazily via the `network.getContent(id)` primitive.
- Binary bodies base64-encoded (`mimeType` disambiguates).
- Stale id from a dead session → `STALE_SESSION`; body evicted/unavailable → `BODY_UNAVAILABLE`.

### DOM (4)

All DOM tools run through `inspectedWindow.eval`, serialize page-side to JSON, target the
**main frame only**, and return the **first match** plus a `matchCount`. Zero matches →
`NO_MATCH` (typed error, not a soft-empty result).

**`get_element(selector)`** → `{ tagName, attributes, textContent, outerHTML, boundingRect }`
(`outerHTML` capped).

**`get_selected_element()`** → same shape, for the Inspector selection `$0`. No selection →
`NO_SELECTION`.

**`get_computed_styles(selector, properties?|all?)`** → curated common-property subset by
default; full computed set only with `all: true`.

**`dump_subtree(selector, depth=3)`** → `{ tag, attributes, children[] }` recursive; text
truncated; `truncated` flagged when depth/size caps hit.

### Screenshots (3)

Inline MCP image content. Params: `format` (`png`|`jpeg`), `quality` (jpeg), max-dimension
downscale. Element shots: a `dom.eval` runs `scrollIntoView` (side effect: scrolls the page —
the one accepted exception to the no-page-interaction rule in [§9](#9-known-limitations))
and returns `getBoundingClientRect()` plus `window.scrollX/Y`; the **server** converts the
viewport-relative rect to **document-relative CSS pixels** and passes it as `capture.tab`'s
`rect` — Firefox's `captureTab` crops natively and handles `devicePixelRatio` (no canvas
cropping).

**`screenshot_viewport()`** · **`screenshot_element(selector)`** (→ `NO_MATCH` if none) ·
**`screenshot_selected_element()`** (→ `NO_SELECTION` if no `$0`).

---

## 4. Network retention

Mirrors the Firefox Network monitor. The **Persist Logs** toggle is not readable via the
API, so it is inferred:

- The extension buffers via `network.requestFinished` push events; the **server** holds the
  authoritative lean-entry buffer and the request ids, while the **devtools page** keeps an
  id → live-HAR-entry map (needed to serve `network.getContent` later, [§5.3](#53-request-identity)).
- On navigation, the extension reconciles `getHAR()` against its pre-nav view:
  pre-nav entries still present ⇒ persist **on** ⇒ keep; buffer reset ⇒ persist **off** ⇒
  flush its entry map. The outcome always travels on the `network.navigated { flushed }`
  notification; the server flushes its buffer iff `flushed: true`.
- **Caps:** both the server buffer and the devtools-side entry map are FIFO-capped (default
  2000 entries, tunable) so Persist Logs can't grow them unboundedly. An evicted entry
  leaves `list_requests`; its body → `BODY_UNAVAILABLE`.

---

## 5. Bridge protocol

### 5.1 Wire format

**JSON-RPC 2.0**, both directions, over **both** the WebSocket (server↔background) and the
internal `runtime` port (background↔devtools page) — one envelope end-to-end.

- **server→ext commands** = requests `{ id, method, params }` → responses `{ id, result | error }`.
- **ext→server events** = notifications (no `id`).
- Concurrent in-flight commands allowed, correlated by the server-generated monotonic JSON-RPC `id`.

### 5.2 Methods

**Commands (server→ext):**

| Method | Params | Result |
|---|---|---|
| `session.ack` | `{ protocolVersion }` | `{}` |
| `dom.eval` | `{ expression }` (opaque, runs verbatim) | `[result, errorInfo]` |
| `network.getContent` | `{ id }` | `[content, mimeType]` |
| `capture.tab` | `{ format, quality?, rect? }` (`rect` in document-relative CSS px) | `{ dataUrl }` |

**Notifications (ext→server):**

| Method | Params |
|---|---|
| `session.hello` | `{ protocolVersion, sessionId, tabId, networkActive }` |
| `session.networkState` | `{ active }` |
| `session.tabDisconnected` | `{}` |
| `network.requestFinished` | `{ id, leanEntry }` |
| `network.navigated` | `{ flushed }` |

The server maps the 9 tools onto these primitives; the extension has **no knowledge of the
tool surface**.

`networkActive` has no direct API: the devtools page infers it heuristically (first
`onRequestFinished` fired, or non-empty `getHAR()`). An idle page can look inactive —
see [§10](#10-build-time-checks-verify-dont-decide).

### 5.3 Request identity

HAR has no stable id, and `getContent()` is a live method on the entry object that lives in
the devtools page — so the **devtools page mints the id** and the server uses it verbatim.
The *server* needs no id↔ref mapping table; the devtools page does keep an id → entry map
(FIFO-capped, [§4](#4-network-retention)) to serve `network.getContent` later.

- **`id = <sessionId>.<counter>`.**
- `sessionId` = **uuid**, minted once per devtools-page connection, announced in `session.hello`.
- `counter` = monotonic, **does not reset on `onNavigated`** → intra-session page reloads
  never remint a live id.
- A new devtools page ⇒ fresh `sessionId` ⇒ a stale id from a dead session can never
  silently rebind; the server rejects it with `STALE_SESSION`.
- *Rejected:* content-hash ids (`method`+`url`+ms-`startedDateTime`) collide on
  polling/retries/parallel-identical requests, lose ordering, and still need a devtools-side map.

### 5.4 Handshake

The extension dials out, so it speaks first: on WS connect it sends the `session.hello`
notification; the server replies with the `session.ack` **command** (a notification can't
be responded to in JSON-RPC, so the ack rides the normal server→ext request channel) and
transitions `handshaking → ready`. `protocolVersion` guards future wire changes.

**Server restart:** on WS reconnect the devtools page re-sends `session.hello` with its
*existing* `sessionId`, then replays its buffered lean entries as `network.requestFinished`
notifications — the restarted (empty) server rebuilds its buffer and old ids stay valid.

### 5.5 Routing (background = dumb multiplexer)

- `capture.tab` → handled locally (`tabs.captureTab`).
- `dom.*` / `network.*` → forwarded **verbatim** over the runtime port to the devtools page.
- Devtools-page port disconnect → background emits `session.tabDisconnected` and drops to
  `no-tab`.

### 5.6 Injection safety

The **server** builds every `dom.eval` expression, `JSON.stringify`-ing all selectors and
params into the string. The extension **never concatenates** — `dom.eval` executes an opaque
string. This keeps sanitization in exactly one place (Node).

### 5.7 State machine

```
disconnected ──connect──► handshaking ──hello/ack──► ready(net:inactive) ⇄ ready(net:active)
     ▲                                                   │            │
     │                                   socket drop ────┘            └── devtools-port drop
     └──── reconnecting(backoff) ◄─────────────┘                              │
                                                                              ▼
                        ready ◄── new session.hello (fresh sessionId) ──── no-tab
```

Two distinct drops:

- **Socket drop** (server gone) → `reconnecting`: **extension-side** exponential backoff
  (it dials): base 500ms → cap 30s, with jitter. Tunable.
- **Devtools-port drop** (devtools closed, `session.tabDisconnected`) → `no-tab`: the WS
  stays connected, **no backoff**. A fresh devtools page's `session.hello` (new `sessionId`)
  returns to `ready`. If the event page then suspends and the socket drops too ([§8](#8-mv3-keepalive-rationale)),
  the server just waits in `disconnected` — there is no tab to serve anyway.

---

## 6. Error model

MCP responses use `isError: true` + a typed `code`. Two origins:

**Connection-level — resolved server-side from tracked session state, no round-trip:**

| Code | Meaning |
|---|---|
| `NO_TAB_CONNECTED` | No extension/devtools session attached. |
| `NETWORK_INACTIVE` | Network panel never activated this session. |
| `STALE_SESSION` | `get_request` id's `sessionId` ≠ current session. |

**Execution-level — returned in the `dom.*` / `network.*` command response:**

| Code | Meaning |
|---|---|
| `NO_MATCH` | Selector matched zero elements. |
| `NO_SELECTION` | No Inspector `$0` selection. |
| `EVAL_EXCEPTION` | Page JS threw inside the eval. |
| `BODY_UNAVAILABLE` | `getContent()` failed / body evicted. |

---

## 7. Dev workflow

1. **Server:** `npm run build -w @bridge/server && npm run start -w @bridge/server` — starts
   the MCP server (stdio) and the WS server on `DEFAULT_WS_PORT` (`8765`).
2. **Extension:** `npm run build -w @bridge/extension` (esbuild bundle) then `web-ext run`
   (or load the temporary add-on via `about:debugging`). Open devtools on the target
   localhost tab and activate the **Network** panel at least once.
3. **MCP client:** point it at the server command over stdio (standard MCP server config
   entry). The extension auto-dials the WS port; `session.hello` establishes the tab.
4. The port is the shared `DEFAULT_WS_PORT` constant; the manifest CSP must allow it.

---

## 8. MV3 keepalive rationale

MV3 event-page suspension is not a hindrance: the model *requires* devtools open (for network
capture), and the devtools page holds an **open runtime port** to the background, which keeps
the event page alive exactly while devtools is open. The socket only drops when devtools
closes — when there is no tab to serve anyway. Reconnect-with-backoff covers server restart.

---

## 9. Known limitations

- **Main frame only** — `inspectedWindow.eval` ignores the frame `options` param in Firefox;
  cross-origin iframe DOM is out of scope.
- **Network-panel activation required** — capture only after the panel is activated once.
- **Screenshots: viewport + element only** — full-page (scroll-and-stitch) deferred.
- **Single active tab** — no multi-tab addressing; two-devtools-tabs edge undefined (deferred).
- Deferred niceties: screenshot save-to-file; explicit image downscale/token-cap policy
  numbers.
- **Out of scope (never):** page interaction/automation (sole exception: `scrollIntoView`
  during element screenshots, [§3](#3-the-9-mcp-tools)), console/debugger access,
  cross-origin iframe DOM, Chrome/other-browser support.

---

## 10. Build-time checks (verify, don't decide)

Prototype-test these early; they validate assumptions rather than open decisions:

- MV3 `connect-src` CSP allowing `ws://localhost:<port>`.
- Firefox event-page keepalive via the open runtime port.
- `getHAR()` reconciliation timing race right after `onNavigated`.
- `getContent()` staleness on persisted-but-old entries.
- Binary-body base64 detection heuristics.
- Network-panel-activation heuristic (first `onRequestFinished` / non-empty `getHAR()`) —
  false-negative behavior on an idle page.
- `captureTab` `rect` cropping: document-relative coordinate handling and `devicePixelRatio`
  correctness on HiDPI displays.
