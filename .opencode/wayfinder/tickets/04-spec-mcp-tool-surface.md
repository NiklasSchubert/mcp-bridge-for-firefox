<!-- label: wayfinder:grilling -->
<!-- status: closed -->
<!-- assignee: niklas -->
<!-- blocked-by: 01, 02, 03 -->

# Spec the MCP tool surface

## Question

Exact tool names, params, response shapes, error model, and truncation policy for the MCP
server, given the research constraints from tickets 01–03.

## Resolution

### Network (2 tools)

- **`list_requests(filters?)`** → array of lean entries
  `{ id, method, url, status, resourceType, mimeType, size, durationMs, startedDateTime }`
  + `matchCount`. `id` = synthetic monotonic (HAR has no stable id). Filters:
  url-substring, method, status, resourceType, limit. Headers **not** inline.
- **`get_request(id)`** → `{ requestHeaders, responseHeaders, requestBody, responseBody,
  mimeType, truncated, totalBytes }`. Lazy `getContent()`; bodies base64 when binary.
  (Full drill-in; renamed from `get_request_body` since it returns headers too.)

**Retention:** mirrors the Network monitor. The Persist Logs toggle is **not readable** via
the API, so infer it: on `onNavigated`, call `getHAR()` and reconcile the buffer — pre-nav
entries still present ⇒ persist on ⇒ keep; reset ⇒ persist off ⇒ flush.

### DOM (4 tools — all `inspectedWindow.eval`, page-side JSON, main frame only, first-match + `matchCount`)

- **`get_element(selector)`** → `{ tagName, attributes, textContent, outerHTML(capped),
  boundingRect }`.
- **`get_selected_element()`** → same shape for `$0`.
- **`get_computed_styles(selector, properties?|all?)`** → curated common subset by default;
  full set only with `all: true`.
- **`dump_subtree(selector, depth=3)`** → `{ tag, attributes, children[] }`, text truncated,
  `truncated` flagged.

### Screenshots (3 tools — inline MCP image; `format` png|jpeg, `quality`; max-dimension downscale)

- **`screenshot_viewport()`**, **`screenshot_element(selector)`**,
  **`screenshot_selected_element()`**.

### Cross-cutting

- **Errors:** MCP `isError: true` + typed code — `NO_TAB_CONNECTED`, `NETWORK_INACTIVE`,
  `NO_MATCH`, `NO_SELECTION`, `EVAL_EXCEPTION`, `BODY_UNAVAILABLE`. Uniform (even zero-match
  is a typed error, not soft-empty).
- **Truncation:** per-tool caps, always signal `{ truncated, totalBytes }`,
  `maxBytes`/`offset` paging; never silently drop. Cap numbers are spec-tunable defaults.

**Fog raised:** `getHAR()` reconciliation timing race; `getContent()` staleness on persisted
entries; exact cap numbers; binary-body base64 detection heuristics.
