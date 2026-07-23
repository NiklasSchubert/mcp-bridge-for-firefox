<!-- label: wayfinder:research -->
<!-- status: closed -->
<!-- assignee: niklas -->
<!-- blocked-by: none -->

# Research devtools.network capabilities

## Question

What does the Firefox `devtools.network` API actually give us — HAR shape, response
bodies, capture lifecycle, and quirks — so the network tools can be specified?

## Resolution

`devtools.network` (mirrors `chrome.devtools.network`; only available in the
`devtools_page` document) provides:

- **`getHAR()`** — full HAR log for the current tab (bulk snapshot of captured entries).
- **`onRequestFinished`** — fires per finished request; listener gets a single **HAR entry
  object** augmented with async **`getContent()`** → `Promise<[content: string, mimeType:
  string]>` for the response body.
- **`onNavigated`** — fires on navigation of the inspected window.

**Key constraints:**

1. **Response bodies are lazy** — only via `getContent()` per entry, not baked into the
   entry. Design: fetch bodies on demand, keyed to a stored entry; never eagerly pull every
   body (binary/large blows token budget).
2. **Capture is gated** — listeners fire only **after the user has activated the Network
   panel at least once**; `getHAR()` likewise only returns what the monitor captured.
   Requests before activation are invisible. Tools must surface a distinct
   "network capture inactive" state.
3. **Entry = HAR 1.2 entry** — `request` (method/url/headers/queryString/postData),
   `response` (status/headers/content metadata/bodySize), `timings`, `serverIPAddress`,
   `startedDateTime`. Bodies via `getContent()` only.

**Consequences fed forward:** eager-buffer entries via `onRequestFinished` + lazy body
fetch (→ ticket 04 two-tool split); `onNavigated` drives retention (→ ticket 04 monitor
mirroring).

**Fog raised:** exact Firefox HAR field fidelity (WebSocket frames, cached responses,
redirects); binary/base64 body encoding from `getContent()`; body size caps — all verified
empirically at build.
