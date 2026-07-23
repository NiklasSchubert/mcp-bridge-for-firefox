<!-- label: wayfinder:research -->
<!-- status: closed -->
<!-- assignee: niklas -->
<!-- blocked-by: none -->

# Research screenshot mechanics from devtools context

## Question

How can the extension capture the inspected page — full viewport, a single element, and
(maybe) full page — from the devtools context, and deliver it as MCP image content?

## Resolution

**Capture primitives (Firefox):**

- **`tabs.captureVisibleTab(windowId?, opts?)`** — visible viewport of the active tab →
  data URL. Viewport-only. Needs `activeTab` (FF 126+) or `<all_urls>` (FF ≤125).
- **`tabs.captureTab(tabId, opts?)`** — Firefox-specific; captures a **specified** tab by
  id. Preferred: our capture is triggered by an MCP call, not a user click, so target the
  inspected tab explicitly.

**Wiring:** devtools page supplies `devtools.inspectedWindow.tabId`; capture runs in the
**background script** (`runtime.sendMessage` → `captureTab(tabId)` → data URL back).
Background is the capture executor (and socket owner — see ticket 03).

**Three tools — feasibility:**

1. **Viewport** — direct `captureTab(tabId)`. Solved.
2. **Element** — no native element capture. Compose: `getBoundingClientRect` (via
   `inspectedWindow.eval`) → `scrollIntoView` if needed → `captureTab` → **canvas rect-crop**
   (`drawImage` source rect) → re-export data URL. Must scale rect by **devicePixelRatio**
   (CSS px → device px). Feasible.
3. **Full page** — viewport APIs can't; `:screenshot --fullpage` devtools command isn't
   exposed to WebExtensions. Scroll-and-stitch works but is janky (sticky elements). →
   **Deferred / fog.**

**Delivery:** data URL → strip prefix → base64 + mimeType → MCP image block. No filesystem.

**Consequences fed forward:** background script confirmed as capture executor + WebSocket
owner (→ ticket 03); `format`/`quality` + max-dimension downscale params (→ ticket 04).

**Fog raised:** devicePixelRatio/HiDPI crop correctness; full-page scroll-stitch as its own
ticket if wanted; image downscale/token-cap policy; `captureTab` vs `captureVisibleTab`
min-Firefox-version tradeoff.
