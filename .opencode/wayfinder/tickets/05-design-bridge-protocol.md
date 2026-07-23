<!-- label: wayfinder:grilling -->
<!-- status: closed -->
<!-- assignee: niklas -->
<!-- blocked-by: 03 -->

# Design the bridge protocol

## Question

Define the WebSocket protocol between the Node MCP server and the extension background
script: message envelope, request/response correlation, handshake/registration, the
connection-lifecycle state machine, and selector/eval injection safety.

Must cover:

- **Envelope** — message shape for server→extension commands and extension→server
  responses/events; how tool name + params + result/error ride.
- **Correlation** — request ids so concurrent tool calls don't cross wires.
- **Handshake** — devtools page registers `inspectedWindow.tabId` with background on load,
  deregisters on unload; background reports readiness to server.
- **State machine** — `no tab connected` · `network capture inactive` · `tab disconnected`
  · `reconnecting` (backoff); how each maps to the typed error codes from ticket 04.
- **Injection safety** — CSS selectors and eval expressions must be JSON-stringified into
  the `inspectedWindow.eval` string, never concatenated.
- **Internal bridge** — `runtime` port shape between devtools page (network/eval) and
  background (socket/capture).

Consult `/grilling` and `/domain-modeling`. Blocked by ticket 03 (lifecycle findings).

## Resolution

### Wire format

JSON-RPC 2.0 both directions, over **both** the WebSocket (server↔background) **and** the
internal `runtime` port (background↔devtools page) — one envelope end-to-end. Server→ext
messages are requests (`{id, method, params}`) → responses (`{id, result|error}`);
ext→server messages are notifications (no `id`) for events.

### Bridge granularity — thin extension, primitive commands

Extension does **not** know the 9 tools. It exposes capability primitives; the MCP server
maps tools onto them:

- **`dom.eval(expression)`** → `[result, errorInfo]` (opaque string, runs verbatim).
- **`network.getContent(id)`** → `[content, mimeType]` (lazy body fetch by request id).
- **`capture.tab(opts)`** → dataURL.

Ext→server notifications:

- **`session.hello({ protocolVersion, sessionId, tabId, networkActive })`** — handshake.
- **`session.networkState(active)`** · **`session.tabDisconnected`** — state changes.
- **`network.requestFinished({ id, leanEntry })`** — per-request push.
- **`network.navigated`** — reset signal.

### Correlation & concurrency

Server-generated monotonic int = JSON-RPC `id` on commands. Events are notifications (no
`id`). Concurrent in-flight commands allowed, keyed by `id`.

### Request identity — devtools-minted compound id

HAR has no stable id, and `getContent()` is a live method on the entry object living in the
devtools page. So the **devtools page mints the id**; the server uses it verbatim (no
`id↔ref` mapping table).

- **`id = <sessionId>.<counter>`**. `sessionId` = uuid minted once per devtools-page
  connection, sent in `session.hello`. `counter` monotonic across the devtools-page
  lifetime.
- **Counter does not reset on `onNavigated`** — kills intra-session page-reload collisions
  without any session check.
- **`sessionId` guards the teardown/reconnect boundary** — a new devtools page mints a
  fresh uuid, so a stale id from a dead session can never silently rebind to a new entry.
- Rejected content-hash ids: `method`+`url`+ms-`startedDateTime` collide on polling /
  retries / parallel-identical requests, lose ordering, and still need a devtools-side map.

### Handshake

Extension dials out, so it speaks first: `session.hello` on connect; server acks. State
transitions ride as later notifications. `protocolVersion` field for cheap future-proofing.

### Routing (background = dumb multiplexer)

`capture.tab` handled locally (background owns `tabs.captureTab`); `dom.*` / `network.*`
forwarded verbatim over the `runtime` port to the devtools page. Devtools-page port
disconnect → background emits `session.tabDisconnected`, transitions to `no-tab`.

### Injection safety

Server builds every eval string, `JSON.stringify`-ing all selectors/params into it.
Extension never concatenates — `dom.eval` runs an opaque string.

### State machine + error split

States: `disconnected → handshaking → ready(net:inactive) ⇄ ready(net:active)`; socket/port
drop → `tab-disconnected` | `reconnecting(backoff)`.

- **Conn-level codes — server-side, no round-trip** (from tracked session state):
  `NO_TAB_CONNECTED`, `NETWORK_INACTIVE`, and **`STALE_SESSION`** (7th code — `get_request`
  whose `sessionId` ≠ current; clean error instead of silent rebind).
- **Exec-level codes — in the command response** from the extension: `NO_MATCH`,
  `NO_SELECTION`, `EVAL_EXCEPTION`, `BODY_UNAVAILABLE`.

### Reconnect

Extension-side exponential backoff (it dials): base 500ms → cap 30s, jitter. Spec-tunable.

**Fog raised:** `getContent()` staleness on persisted-but-old entries; `ws:` `connect-src`
CSP unproven; event-page keepalive-via-open-port unproven (both prototype-tested early at
build).
