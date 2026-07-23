<!-- label: wayfinder:research -->
<!-- status: closed -->
<!-- assignee: niklas -->
<!-- blocked-by: none -->

# Research bridge lifecycle + inspectedWindow.eval limits

## Question

How does the extension hold a WebSocket to a localhost MCP server across the devtools
lifecycle, and what can `inspectedWindow.eval` do/not do for the DOM tools?

## Resolution

### `inspectedWindow.eval` (DOM tool engine)

- Runs JS in the inspected page's **main-world** context (sees page-script mutations,
  unlike isolated content scripts). Provides devtools helpers **`$0`** (Inspector
  selection) and `inspect()`.
- Returns `Promise<[result, errorInfo]>`; errors split into `isException` (page JS, has
  `value`) vs `isError` (devtools, has `code`).

**Hard limits shaping the tools:**

1. **Result must be JSON-serializable** — no live nodes/functions. Every DOM tool must
   serialize page-side inside the eval string (outerHTML string, attribute maps,
   `getComputedStyle` → plain object, `getBoundingClientRect` → plain object).
2. **Main frame only** — Firefox ignores the `options` param, so no `frameURL` /
   `useContentScriptContext`. Iframes unreachable → cross-origin iframe DOM is **out of
   scope**.
3. No privileged pages (`about:*`); `file://` needs file-scheme access (FF 153+) —
   localhost dev is `http://`, non-issue.

### WebSocket lifecycle

- **Extension dials out** to `ws://localhost:<port>` (it can't be a listening server); the
  MCP server pushes commands down the socket (push > poll for interactive tools).
- **Split forced by API availability:**
  - **Devtools page** (ephemeral, torn down when devtools closes): owns `devtools.network`
    HAR buffer + `inspectedWindow.eval`.
  - **Background** (persistent): owns the WebSocket + `tabs.captureTab`.
  - **Internal bridge:** `runtime` port between them.
- **MV3 event-page suspension is not a real hindrance:** our model *requires* devtools open
  (network capture), and the devtools page holds an **open runtime port to background**,
  which keeps the event page alive exactly while devtools is open. Socket only drops when
  devtools is closed — when there's no tab to serve anyway. Reconnect-with-backoff handles
  server restart / wake. → **MV3 chosen.**

### Lifecycle states (fed to ticket 05)

`no tab connected` · `network capture inactive` (panel never activated) ·
`tab disconnected` (devtools closed) · `reconnecting` (server absent/restart).

**Fog raised:** MV3 `connect-src` CSP for `ws:`; Firefox keepalive-via-open-port behavior —
both prototype-tested early at build.
