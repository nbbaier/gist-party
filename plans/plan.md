# gist.party — MVP Implementation Plan (Consensus)

## Overview

The MVP is structured into 7 phases. Phase 0 is sequential scaffolding. Phases 1, 3, and 5 each contain independent tracks that can be developed in parallel. The critical path runs through scaffolding → auth + DO → collab + API → GitHub sync → conflict resolution. Shared interface contracts are defined before Phase 1 tracks diverge.

### Phase Summary

| Phase | Name | Tracks | Depends On |
|-------|------|--------|------------|
| 0 | Scaffolding | 1 (sequential) | — |
| 1 | Core Verticals | 3 (parallel) | Phase 0 |
| 2 | Integration | 2 (parallel) | Phase 1 |
| 3 | GitHub Sync, Permissions, Views | 3 (parallel) | Phase 2 |
| 4 | Conflict Resolution + Status UX | 2 (parallel) | Phase 3A |
| 5 | Security Hardening | 6 (parallel) | Phase 3 |
| 6 | End-to-End Validation | 1 (sequential) | Phase 4 + 5 |

---

## Shared Interface Contracts

Define these before Phase 1 tracks diverge. This takes ~1 session and eliminates integration friction later.

| Interface | Producer | Consumers | Notes |
|---|---|---|---|
| JWT sign/verify module | Track 1A | Track 1C (DO), Track 2B (API) | Pure WebCrypto, no Node deps. Payload: `{ userId, login, avatarUrl }`. Claims: `exp`, `aud`, `iss`. |
| Token encryption module | Track 1A | Track 1C (DO), Track 2B (API) | AES-GCM via WebCrypto. Versioned key prefix (`v1:<iv>:<ciphertext>`). On read, select decryption key by version; re-encrypt under current key on next write. |
| DO SQLite schema | Track 1C | Track 2B (API), Track 3A/B | Columns: `gistId`, `filename`, `etag`, `updatedAt`, `editTokenHash`, `lastSavedAt`, `pendingSync`, `pendingSince`, `initialized`, `ownerUserId`, `lastCanonicalMarkdown`, plus Yjs snapshot blob. |
| Edit capability cookie format | Track 3B | Track 1C (DO `isReadOnly`) | Cookie name, path scope (`/parties/gist-room/:gist_id`), HttpOnly, Secure, SameSite=Strict, 24h TTL, validation logic. |
| Custom message protocol | Track 1C (DO) | Track 2A (collab), Track 4B (status UI) | Message type enum + payload shapes (see below). |
| Markdown serialization protocol | Track 1C (DO) | Track 2A (collab) | DO-requested, client-side serialization. The DO never parses or generates markdown. See protocol details below. |
| Sync status state machine | Track 3A | Track 4B (status UI) | States: Saved → Saving → Saved / Error / Remote Changed / Pending Sync. Transitions triggered by DO events. |

### Custom Message Protocol

All markdown serialization happens client-side. The DO requests canonical markdown from connected authorized clients when needed. Message types:

| Type | Direction | Payload | Trigger |
|---|---|---|---|
| `request-markdown` | DO → client | `{ requestId }` | `onSave()` fires and owner is connected. DO selects one authorized client to respond. |
| `canonical-markdown` | Client → DO | `{ requestId, markdown }` | Client receives `request-markdown`, calls `getMarkdown()`, sends result. |
| `needs-init` | DO → client | `{ gistId, filename }` | `onLoad()` finds no Yjs snapshot for an initialized room. Client fetches content via API, loads as `defaultValue`. |
| `reload-remote` | DO → client | `{ markdown }` | Staleness check finds remote is newer and no pending sync. Client resets editor with this markdown as `defaultValue`. |
| `remote-changed` | DO → client | `{ remoteMarkdown }` | GitHub PATCH returns 412. Includes remote content for diff display. |
| `sync-status` | DO → client | `{ state, detail? }` | State transitions: `saved`, `saving`, `error-retrying`, `pending-sync`, `conflict`. |
| `error-retrying` | DO → client | `{ attempt, nextRetryAt }` | GitHub API 403/429/5xx. Includes backoff info. |
| `conflict` | DO → client | `{ localMarkdown, remoteMarkdown }` | Conflict detected. Owner must choose `push_local` or `discard_local`. |
| `push_local` | Client → DO | `{}` | Owner chooses to force-push local state to GitHub. Restricted to owner connection. |
| `discard_local` | Client → DO | `{}` | Owner chooses to discard local and reload remote. Restricted to owner connection. |

---

## Phase 0: Scaffolding

> **Goal**: A deployable skeleton — Vite dev server, Worker, and a single DO all running locally.

### Tasks

1. Initialize Vite + React + TypeScript project
2. Set up Cloudflare Worker with Hono as the HTTP router
3. Configure `partyserver` + `y-partyserver` for Durable Objects
4. Create `wrangler.toml` with all bindings (KV namespace, DO binding, secrets placeholders)
5. Wire `routePartykitRequest(request, env)` in the Worker for `/parties/gist-room/:gist_id`
6. Set up SPA serving via Cloudflare Worker Assets
7. Install all dependencies:
   - Editor: `@milkdown/core`, `@milkdown/react`, `@milkdown/preset-commonmark`, `@milkdown/preset-gfm`, `@milkdown/plugin-collab`, `@milkdown/utils`, `@milkdown/plugin-listener`
   - CRDT: `yjs`, `y-partyserver`
   - Server: `partyserver`, `hono`
   - Rendering: `remark`, `rehype`, `rehype-sanitize`
8. Verify: `wrangler dev` starts, Vite HMR works, a stub DO responds to WebSocket upgrade

### Milestone

`wrangler dev` serves the SPA and a hello-world DO accepts a WebSocket connection.

**No parallelism — this is the foundation for everything.**

---

## Phase 1: Core Verticals (3 parallel tracks)

Three independent tracks with no cross-dependencies. Each can be developed and tested in isolation. Shared interface contracts (above) must be defined before these tracks diverge.

### Track A — Auth System

> **Goal**: A user can sign in with GitHub and receive a verified JWT session cookie. Tokens are encrypted at rest.

#### Tasks

1. **OAuth flow**: `GET /api/auth/github` (generate `state` + PKCE verifier, redirect to GitHub) and `GET /api/auth/github/callback` (exchange code for access token, issue JWT cookie)
2. **JWT module**: Sign/verify JWTs per the shared contract. Must work in both Worker and DO (pure WebCrypto).
3. **Token encryption module**: Per the shared contract. Store encrypted GitHub access tokens in Workers KV keyed by `userId`.
4. **Refresh endpoint**: `POST /api/auth/refresh` — validate existing JWT, look up session in KV, issue new JWT (1-hour TTL).
5. **Logout endpoint**: `POST /api/auth/logout` — clear session cookie, revoke server-side session in KV.

#### Milestone

Click "Sign in" → GitHub OAuth → redirect back → JWT cookie set → `/api/auth/refresh` works → `/api/auth/logout` clears session.

---

### Track B — Milkdown Editor

> **Goal**: A functional markdown WYSIWYG editor with local editing (no collaboration yet).

#### Tasks

1. **Milkdown setup**: `@milkdown/core` + `@milkdown/react` with `preset-commonmark` and `preset-gfm`
2. **Markdown serialization**: `getMarkdown()` from `@milkdown/utils` for extracting markdown. On load, pass markdown as `defaultValue`.
3. **Change listener**: `plugin-listener` for observing document changes (used for save triggers later)
4. **App shell**: React Router (`/` landing page, `/:gist_id` editor/viewer), nav bar with auth state placeholder
5. **Read-only rendered view**: `remark` + `rehype` + `rehype-sanitize` pipeline for rendering markdown when user lacks edit capability (component only — routing logic wired in Phase 3C)

#### Milestone

Editor renders markdown WYSIWYG. User can type, format, and extract the document as a markdown string. Read-only component renders sanitized HTML from markdown. No collab or persistence yet.

---

### Track C — GistRoom Durable Object

> **Goal**: A DO that syncs a Yjs document across WebSocket connections and persists snapshots to SQLite. No GitHub sync yet. The DO never parses or generates markdown — all markdown serialization is client-side.

#### Tasks

1. **`GistRoom` class** extending `YServer` from `y-partyserver`
2. **DO SQLite schema**: Per the shared contract (includes `lastCanonicalMarkdown` column).
3. **`onLoad()`**: Load Yjs snapshot from DO SQLite → apply to `this.document`. If no snapshot exists and room is initialized, send `needs-init` custom message to the first connecting authorized client. (GitHub-related staleness checks deferred to Phase 3A.)
4. **`onSave()`**: Write Yjs snapshot to DO SQLite. Configure `callbackOptions` with 30s debounce, idle-save, and flush-on-disconnect. (GitHub PATCH deferred to Phase 3A.)
5. **`request-markdown` / `canonical-markdown` protocol**: On `onSave()`, send `request-markdown` to an authorized client, wait for `canonical-markdown` response (with timeout), store result in `lastCanonicalMarkdown`. (GitHub PATCH using this markdown deferred to Phase 3A.)
6. **Hibernation**: `static options = { hibernate: true }`. `onLoad()` handles rehydration from storage on wake.
7. **`initialized` flag and `ownerUserId`**: Stored in DO SQLite. DO refuses to serve content unless room has been initialized.
8. **Limits**: 2 MB max document size on inbound Yjs updates. Per-IP and per-room WebSocket connection limits. Message rate limiting.

#### Milestone

A test client connects via WebSocket, sends Yjs updates, disconnects, reconnects — snapshot is restored from SQLite. Multiple clients see each other's changes broadcast by `YServer`. DO requests and stores canonical markdown from connected clients.

---

## Phase 2: Integration (2 parallel tracks)

Both tracks depend on Phase 1 but are independent of each other.

### Track A — Real-time Collaboration (depends on 1B + 1C)

> **Goal**: Two browser tabs show real-time collaborative editing with cursors. Client handles the markdown serialization protocol.

#### Tasks

1. **YProvider**: Wire `YProvider` from `y-partyserver/provider` to the Milkdown editor. Configure with `party: "gist-room"` and `room: gistId`.
2. **Collab plugin**: Enable `@milkdown/plugin-collab` — binds `ySyncPlugin`, `yCursorPlugin`, `yUndoPlugin` to the shared `Y.Doc`.
3. **Awareness**: Collaborator cursors, selections, and names (from GitHub profile in JWT payload).
4. **Custom messages**: Wire `provider.sendMessage()` and `provider.on("custom-message", ...)` for non-Yjs communication (payloads defined in shared contract).
5. **Markdown serialization protocol (client side)**: Handle `request-markdown` messages from DO by calling `getMarkdown()` and responding with `canonical-markdown`. Handle `needs-init` by fetching Gist content via API and loading it as editor `defaultValue`. Handle `reload-remote` by resetting the editor with the provided markdown. Only one authorized client responds to each `request-markdown` (use `requestId` to deduplicate).

#### Milestone

Two browser tabs connected to the same GistRoom DO show real-time cursors and edits. Changes persist across page reloads via DO SQLite. Client responds to `request-markdown` and DO stores canonical markdown.

---

### Track B — API Routes (depends on 1A + 1C)

> **Goal**: All REST endpoints for gist lifecycle and room initialization.

#### Tasks

1. **Auth middleware**: Verify JWT on protected routes. Extract `userId` and `login` for downstream use.
2. **`POST /api/gists`**: Auth required. Create a new GitHub Gist (single empty `.md` file, secret by default, optional visibility). Generate edit token (crypto-random, 32+ URL-safe chars). Hash with SHA-256. Initialize DO room (`initialized`, `ownerUserId`, `editTokenHash`, `gistId`, `filename`). Return `{ gist_id, edit_token }`.
3. **`POST /api/gists/:gist_id/import`**: Auth required, owner only. Accept gist URL, validate exactly one file (reject multi-file with clear error). Fetch content via GitHub API. Initialize DO room. Generate edit token. Return `{ gist_id, edit_token }`.
4. **`GET /api/gists/:gist_id`**: Return gist metadata (title, filename, visibility, sync status, owner info). Auth optional.

#### Milestone

`curl` can create a gist, import a gist, and fetch metadata. DO rooms are initialized with correct ownership.

---

## Phase 3: GitHub Sync, Permissions, Views (3 parallel tracks)

Three independent tracks. Each depends on Phase 2 but not on each other.

### Track A — GitHub Gist Sync (depends on 2B)

> **Goal**: Edits auto-save to GitHub with conflict detection. All markdown comes from connected clients via the serialization protocol — the DO never parses or generates markdown.

#### Tasks

1. **`onSave()` GitHub PATCH**: After receiving `canonical-markdown` from a client (protocol wired in Phase 1C/2A), if the owner is connected, read token from KV (or in-memory cache), call `PATCH /gists/:id` using the stored `lastCanonicalMarkdown` with `If-Match: <etag>`. Store new `etag` and `updated_at` from response.
2. **412 handling**: If GitHub returns 412 (Precondition Failed), pause autosync, fetch remote markdown from GitHub (raw text — no parsing needed), send `remote-changed` custom message to clients with the remote markdown for diff display.
3. **Error handling**: On 403/429/5xx, pause autosync with exponential backoff. Send `error-retrying` custom message. Allow owner to trigger manual retry.
4. **Owner token lifecycle**: Cache owner's decrypted token in memory while connected. Drop cache on disconnect. Set `pendingSync = true` and record `pendingSince` when owner disconnects with unsaved changes.
5. **Staleness detection on load**: If snapshot is older than 5 minutes and an authorized client connects, validate stored etag against GitHub. If `pendingSync` is true, enter conflict state (do not overwrite local). If `pendingSync` is false and remote is newer, send `reload-remote` custom message with fresh markdown to the client — client resets editor, Yjs updates flow back to DO.

#### Milestone

Create a doc → edit → changes auto-save to a real GitHub Gist. Edit the Gist externally → DO detects conflict on next save.

---

### Track B — Edit Permissions (depends on 2B)

> **Goal**: Capability-based edit tokens control who can write.

#### Tasks

1. **`POST /api/gists/:gist_id/claim`**: Auth required. Accept `{ token }` in body. Hash and compare against DO-stored `editTokenHash`. If valid, set edit capability cookie per the shared contract. Return 200.
2. **`POST /api/gists/:gist_id/edit-token`**: Auth required, owner only. Revoke current token (clear hash in DO, kick existing editor WebSocket connections). Generate new token. Return `{ edit_token }`.
3. **`isReadOnly(connection)`**: Validate edit capability cookie on WebSocket connection. Connections without a valid cookie are read-only — `YServer` silently drops incoming Yjs updates. Awareness updates from read-only connections are also rejected.
4. **Client-side token exchange**: On opening an edit link (`gist.party/<gist_id>#edit=<token>`), extract token from URL fragment, POST to `/claim`, then connect WebSocket with the capability cookie.
5. **Revocation UX**: Owner clicks "Revoke" → existing editors are disconnected and must re-claim with a new link.

#### Milestone

Share edit link → collaborator claims token → edits are accepted. Revoke token → collaborator is kicked. Connections without valid capability are read-only.

---

### Track C — Read-only Views (depends on 2A)

> **Goal**: Anonymous users and users without edit capability see rendered markdown.

#### Tasks

1. **View routing**: Detect auth state + edit capability. If authorized editor → load Milkdown editor. If not → load read-only rendered view (component built in Phase 1B).
2. **Raw endpoint**: `GET /:gist_id/raw` returns `lastCanonicalMarkdown` from DO SQLite as `text/plain; charset=utf-8`. Headers: `X-Content-Type-Options: nosniff`, `Cache-Control: no-cache`. Content may lag behind live Yjs state by up to one save debounce interval.
3. **Read-only rendered view data source**: The read-only rendered view also sources from `lastCanonicalMarkdown` in DO SQLite, rendered through the `remark` + `rehype` + `rehype-sanitize` pipeline.
4. **Uninitialized room 404**: If the room is not initialized, serve a "Not hosted on gist.party" page for both `/:gist_id` and `/:gist_id/raw`.

#### Milestone

Anonymous user visits `gist.party/<gist_id>` → sees rendered markdown. `curl gist.party/<gist_id>/raw` → gets raw text. Uninitialized room → 404 page.

---

## Phase 4: Conflict Resolution + Status UX (2 parallel tracks)

Depends on Phase 3A (GitHub sync must be working for conflict states to exist). Track 4B also depends on Phase 2A (collab/provider must be wired for custom message subscription).

### Track A — Staleness & Conflict Resolution

> **Goal**: Owner can resolve conflicts between local and remote state.

#### Tasks

1. **`onCustomMessage()` handler**: Receive conflict resolution actions from owner (`push_local`, `discard_local`). Restrict to owner connection only.
2. **Push local**: Owner chooses "Push local to remote" → DO sends `request-markdown` to get current canonical markdown from client, then force-patches GitHub (no `If-Match`) using that markdown, updates stored etag, resumes autosync, broadcasts success to all clients.
3. **Discard local**: Owner chooses "Discard local, reload remote" → DO fetches fresh markdown from GitHub (raw text), sends `reload-remote` custom message to connected clients with the markdown. Client resets editor with this content as `defaultValue`, Yjs updates flow back to DO replacing local state. DO updates stored etag, resumes autosync.
4. **Pending sync durability**: Retain unsynced state for 30 days. Track `pendingSince` timestamp. After 30 days, discard the unsynced snapshot.
5. **Pending sync on reconnect**: When owner reconnects with `pendingSync = true`, attempt to sync immediately. If conflict detected (etag mismatch), enter conflict state rather than overwriting.

#### Milestone

Edit Gist externally → DO detects conflict → owner sees resolution options → chooses push or discard → state resolves cleanly.

---

### Track B — Sync Status UI

> **Goal**: Users always know the current sync state of their document.

#### Tasks

1. **Status bar**: Reactive component driven by the sync status state machine. States: "Saved" / "Saving..." / "Pending sync (owner offline)" / "Remote changed" / "Error (retrying)".
2. **Pending sync banner**: Persistent banner when `pendingSync` is true. Shows expiry date (`pendingSince` + 30 days). Includes "Download .md" one-click export button.
3. **Conflict resolution modal** (owner only): Two options — "Push local to remote" vs "Discard local, reload remote". Includes a markdown diff preview of local (from `getMarkdown()`) vs remote (from `conflict` custom message payload) content.
4. **Manual retry button**: When in error state, owner can trigger a manual GitHub sync attempt.
5. **Warn on exit**: If `pendingSync` is true, show a `beforeunload` warning that changes are not yet synced to GitHub.
6. **Custom message wiring**: Subscribe to provider custom messages per the shared protocol and update UI state accordingly.

#### Milestone

Full sync status lifecycle visible in UI. Conflict modal works end-to-end with diff preview. Pending sync banner shows with export.

---

## Phase 5: Security Hardening (6 parallel tasks)

All tasks are independent. Each can be implemented and tested in isolation. Depends on Phase 3 (all features must exist before hardening).

### Task 1 — Content Security Policy

- Restrictive CSP on all HTML responses: no inline scripts, restricted `img-src` and `frame-src`
- Verify Milkdown editor and remark rendering work within the policy

### Task 2 — CSRF Protection

- Set `__csrf` non-HttpOnly cookie on auth responses (login callback and refresh)
- SPA reads cookie value, sends it as `X-CSRF-Token` header on all POST requests
- Server middleware validates header matches cookie on all state-changing routes: `/api/gists`, `/api/gists/:id/import`, `/api/gists/:id/claim`, `/api/gists/:id/edit-token`, `/api/auth/logout`
- `SameSite=Strict` on session cookie provides primary protection; double-submit is defense-in-depth

### Task 3 — Response Headers

- All responses: `Referrer-Policy: strict-origin` (defense-in-depth for edit token leakage — token is in URL fragment, not sent in Referer)
- Raw endpoint: `Content-Type: text/plain; charset=utf-8`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-cache`

### Task 4 — Rate Limiting

- IP-based rate limiting on anonymous viewer requests (`/:gist_id`, `/:gist_id/raw`) to prevent gist_id enumeration
- Rate limiting on auth endpoints to prevent abuse

### Task 5 — WebSocket Hardening

- Per-IP and per-room connection limits
- Message rate limiting on all connections
- 2 MB maximum document size enforced on inbound Yjs updates
- Read-only connections cannot send awareness updates (prevents cursor spoofing)

### Task 6 — Raw Endpoint Headers

- `Content-Type: text/plain; charset=utf-8`
- `X-Content-Type-Options: nosniff`
- `Cache-Control: no-cache` (allow conditional requests via ETag/If-None-Match)

---

## Phase 6: End-to-End Validation

> **Goal**: Verify all user flows work correctly across the integrated system.

Depends on Phase 4 + Phase 5 (all features built and hardened).

### User Flows to Validate

1. **Happy path**: Sign in → create doc → edit → auto-save to GitHub → verify on github.com
2. **Collaboration**: Owner creates doc → shares edit link → collaborator claims → both edit in real-time with cursors → changes persist
3. **Anonymous viewing**: Unauthenticated user visits `/:gist_id` → sees rendered markdown → visits `/:gist_id/raw` → gets plain text
4. **Import flow**: Sign in → import existing single-file gist → content loads in editor → edits sync back
5. **Disconnect/reconnect**: Owner edits → disconnects → `pendingSync` banner appears → reconnects → sync resumes automatically
6. **Conflict resolution**: Owner edits in app → someone edits same gist on github.com → owner saves → 412 detected → conflict modal appears → owner pushes local OR discards → state resolves
7. **Token revocation**: Owner shares edit link → collaborator edits → owner revokes token → collaborator is kicked → new link required
8. **Error recovery**: Simulate GitHub API 5xx → verify exponential backoff → verify "Error (retrying)" status → verify manual retry button works
9. **Auth refresh failure**: JWT expires → refresh fails → user sees re-auth prompt → falls back to read-only gracefully
10. **Uninitialized room**: Visit `/:gist_id` for a gist not hosted on gist.party → 404 page
11. **Pending sync expiry**: `pendingSync` older than 30 days → snapshot discarded → banner reflects expiry
12. **Multi-file gist rejection**: Attempt to import a multi-file gist → clear error message, no room initialized

### Security Checks

- All security headers present on responses (CSP, Referrer-Policy, nosniff)
- CSRF token required on all state-changing POST routes
- Rate limits enforced on anonymous viewer and auth endpoints
- WebSocket connection limits enforced
- Read-only connections cannot modify document or send awareness
- Edit capability cookie is path-scoped, HttpOnly, Secure, SameSite=Strict

### Milestone

All 12 user flows pass. All security checks verified. Ready for first deploy.

---

## Dependency Graph

```
Phase 0 (scaffolding)
  │
  ├── Track 1A (auth) ──────────┐
  │                             ├── Track 2B (API routes) ──┐
  ├── Track 1C (GistRoom DO) ───┤                           ├── Track 3A (GitHub sync) ──► Phase 4 (conflicts + status UX)
  │                             ├── Track 2A (collab) ──────┤
  ├── Track 1B (editor) ────────┘                           ├── Track 3B (edit permissions)
  │                                                         │
  │                                                         ├── Track 3C (read-only views)
  │                                                         │
  │                                                         └── Phase 5 (security hardening)
  │
  Phase 4 + Phase 5 ──► Phase 6 (end-to-end validation)
```

### Critical Path

```
Phase 0 → Track 1A + 1C → Track 2B → Track 3A → Phase 4A (conflicts) → Phase 6
```

This is the longest chain. Everything else can be developed in parallel alongside it.

---

## Parallelization Summary

| Phase | Max Parallel Tracks | Solo Dev Approach | 2-3 Dev Approach |
|-------|--------------------:|-------------------|------------------|
| 0 | 1 | Sequential | Sequential |
| 1 | 3 | Auth → DO → Editor | One each |
| 2 | 2 | API → Collab | One each |
| 3 | 3 | Sync → Permissions → Views | One each |
| 4 | 2 | Conflicts → Status UI | One each |
| 5 | 6 | Any order | Split evenly |
| 6 | 1 | Sequential | Sequential (all hands) |

**Solo dev note**: Even without parallelism, the phased structure keeps each unit small and testable before integrating. Follow the critical path first, then fill in parallel tracks. The thin-layer approach (e.g., DO without GitHub sync in Phase 1, GitHub sync added in Phase 3) means you get a working collab editor early and layer on GitHub integration once the foundation is proven.

**Team note**: The biggest parallelism wins are Phase 1 (3 tracks), Phase 3 (3 tracks), and Phase 5 (6 tasks). A 3-person team can nearly halve the timeline by splitting these phases.
