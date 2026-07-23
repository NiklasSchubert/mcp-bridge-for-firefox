<!-- label: wayfinder:task -->
<!-- status: closed -->
<!-- assignee: niklas -->
<!-- blocked-by: 04, 05 -->

# Assemble the implementation-ready spec

## Question

Assemble the locked decisions + resolved tickets into a single implementation-ready spec
document a build session can code from without further decisions. **This is the map's
destination.**

Must contain:

- **Architecture** — MV3 extension (devtools page: `devtools.network` + `inspectedWindow.eval`;
  background: WebSocket + `tabs.captureTab`; internal runtime port) + Node MCP server
  (stdio to client, WebSocket server to extension).
- **Repo layout** — TypeScript monorepo: `server/`, `extension/`, shared protocol-types
  package.
- **Tool reference** — the 9 tools from ticket 04 (names, params, response shapes, error
  codes, truncation).
- **Protocol reference** — the envelope, correlation, handshake, and state machine from
  ticket 05.
- **Dev workflow** — `web-ext run` / temporary add-on load; how to point an MCP client at
  the server; port config.
- **Known limitations** — main-frame only, Network-panel-activation requirement,
  viewport/element screenshots only (full-page deferred), plus the empirical build-time
  checks listed in the map's fog.

HITL review of the assembled spec. Blocked by tickets 04 and 05.

## Resolution

**Destination reached.** Spec assembled at repo-root [`SPEC.md`](../../../SPEC.md) — 10
sections: architecture, repo layout, the 9 tools, network retention, bridge protocol, error
model, dev workflow, MV3 keepalive, known limitations, build-time checks. HITL-reviewed.

Repo layout locked in review (previously unspecified in the map): **npm workspaces**,
`packages/{protocol,server,extension}`, shared types as real workspace package
**`@bridge/protocol`**, extension bundled with **esbuild** (inlines `@bridge/protocol`;
`web-ext` loads output).

A build session can now code from `SPEC.md` without further product decisions. Remaining
open items are the deferred features (§9) and empirical verify-don't-decide checks (§10),
not blockers.
