<!-- label: wayfinder:map -->

# Map: Firefox DevTools MCP Bridge

> **STATUS: DESTINATION REACHED.** All tickets closed. Implementation-ready spec at
> [`SPEC.md`](../../SPEC.md). A build session can code from it without further decisions.

## Destination

An **implementation-ready spec** for a Firefox DevTools extension + Node MCP server pair
that lets an MCP client (Claude Code, etc.) read Network-tab + Inspector data and take
screenshots of the inspected localhost dev page. The map is done when a build session can
take the spec and code it without further decisions.

## Notes

- **Domain:** WebExtension (MV3) + MCP server, TypeScript monorepo, official
  `@modelcontextprotocol/sdk` (stdio toward client).
- **Skills every session should consult:** `/grilling`, `/domain-modeling`. All decision
  tickets closed; only ticket 06 (spec assembly, HITL review) remains.
- **Planning-first:** produce decisions, not deliverables. Ticket 06 is the assembly of
  the spec itself (the destination), not a build.
- **One resolution per session.** Frontier tickets may be run in parallel by separate
  sessions; expect concurrent edits.

### Locked architecture decisions (from grilling + research)

| Decision | Answer |
|---|---|
| Destination | Implementation-ready spec |
| Transport | Standalone Node MCP server (stdio to client); extension dials **out** via WebSocket to `ws://localhost:<port>` |
| Push vs poll | WebSocket push (extension can't be dialed; REST would force polling) |
| Network source | `devtools.network` — devtools-open is the accepted mode (dev-assist tool) |
| Tab targeting | Single tab — the active devtools connection |
| Inspector tools | Both: selector-driven (`get_element`, computed styles, `$0`) + depth-limited subtree dump |
| Screenshots | Inline MCP image content |
| Stack | TypeScript monorepo, shared protocol types both sides |
| Manifest | **MV3** — devtools-page's open runtime port to background keeps the event page alive while devtools is open (exactly when needed) |
| Distribution | Dev-mode v1 (`web-ext run` / temporary add-on) |

## Decisions so far

<!-- index: one line per closed ticket; zoom the link for detail -->

- [Research devtools.network capabilities](tickets/01-research-devtools-network.md) —
  full HAR entries via `getHAR()` + per-request `onRequestFinished`; response bodies lazy
  via `getContent()` → `[content, mimeType]`; capture gated on the Network panel being
  activated at least once.
- [Research screenshot mechanics](tickets/02-research-screenshots.md) —
  `captureTab(inspectedWindow.tabId)` viewport capture routed through the background
  script; element shots = `getBoundingClientRect` + `scrollIntoView` + canvas rect-crop
  (devicePixelRatio-scaled); full-page deferred. Background is capture executor + socket
  owner.
- [Research bridge lifecycle + eval limits](tickets/03-research-bridge-lifecycle.md) —
  **MV3**; background owns the WebSocket (dials out) + `captureTab`; devtools page owns
  `devtools.network` + `inspectedWindow.eval` and holds an open runtime port to background
  (keeps event page alive while devtools open). DOM tools = `eval` with page-side JSON
  serialization, **main frame only** (Firefox ignores the `options` param).
- [Spec the MCP tool surface](tickets/04-spec-mcp-tool-surface.md) — 9 tools
  (`list_requests`, `get_request`, `get_element`, `get_selected_element`,
  `get_computed_styles`, `dump_subtree`, `screenshot_viewport`, `screenshot_element`,
  `screenshot_selected_element`); synthetic monotonic request ids; retention mirrors the
  Network monitor via `getHAR()` reconciliation on nav; typed `isError` codes; per-tool
  truncation caps with paging.
- [Design the bridge protocol](tickets/05-design-bridge-protocol.md) — JSON-RPC 2.0
  end-to-end (WS + runtime port); **thin extension** exposing primitives (`dom.eval`,
  `network.getContent`, `capture.tab`) with the server mapping the 9 tools onto them;
  network pushed via `network.requestFinished` events (server buffers); **devtools-minted
  compound request id `<sessionId>.<counter>`** (uuid session guards teardown/reconnect,
  counter survives page reloads); server builds all eval strings (`JSON.stringify` in);
  error split — conn-level server-side (`NO_TAB_CONNECTED`, `NETWORK_INACTIVE`,
  **`STALE_SESSION`**), exec-level in command response.
- [Assemble the implementation-ready spec](tickets/06-assemble-spec.md) — **destination**;
  `SPEC.md` at repo root (10 sections). Repo layout locked in review: **npm workspaces**,
  `packages/{protocol,server,extension}`, shared types as workspace package
  **`@bridge/protocol`**, extension bundled with **esbuild**.

## Not yet specified

<!-- in-scope fog: graduates as the frontier advances -->

- Full-page (scroll-and-stitch) screenshot tool.
- Screenshot save-to-file option (alongside inline image).
- Image downscale / token-cap policy specifics (default max dimension, jpeg fallback
  thresholds).
- Multi-tab addressing (currently single active tab).
- Devtools-open-on-two-tabs edge case (which connection wins).
- AMO signing / persistent install (MV3 already chosen, eases this).
- **Empirical build-time checks** (verify, don't decide): MV3 `connect-src` CSP for `ws:`;
  Firefox event-page keepalive-via-open-port; `getHAR()` reconciliation timing race after
  `onNavigated`; `getContent()` staleness on persisted-but-old entries; binary-body base64
  detection heuristics; devicePixelRatio crop correctness on HiDPI.

## Out of scope

<!-- ruled beyond the destination; never graduates -->

- Page interaction / automation (clicks, navigation, form fill).
- Console / debugger access.
- Cross-origin iframe DOM (`inspectedWindow.eval` is main-frame only in Firefox).
- Chrome / other-browser support.
