# gist.party — Specification

> Google Docs but for markdown, backed by GitHub Gists.

## Problem

Markdown collaboration is stuck between two bad options:

- **GitHub**: committing is too heavy, no simultaneous editing, the web editor is clunky
- **Notion/Google Docs**: not real markdown, hard to use locally, can't pipe into CLI tools or AI agents

People want to write markdown in a real editor, collaborate in real-time, and have the file live somewhere durable and portable. GitHub Gists are the perfect backend — versioned, API-accessible, universally understood — but there's no good collaborative frontend for them.

## Solution

A web app at `gist.party` that provides real-time collaborative markdown editing with GitHub Gists as the storage layer.

## User Flows

### Creating a New Document

1. User visits `gist.party`
2. Signs in with GitHub (OAuth)
3. Clicks "New Document"
4. A GitHub Gist is created immediately via the API (single POST, empty content)
5. URL updates to `gist.party/<gist_id>` and the editor opens
6. GistRoom Durable Object is created with the gist_id as the room name

### Importing an Existing Gist

1. User pastes a Gist URL (e.g., `https://gist.github.com/user/abc123`)
2. The app extracts the Gist ID, fetches the content via GitHub API
3. Opens the editor with the Gist's markdown content loaded
4. URL becomes `gist.party/abc123`

### Collaborating

1. Gist owner clicks "Share" → generates an **edit link**: `gist.party/<gist_id>#edit=<token>` (token in URL fragment, never sent to the server via Referer)
2. Collaborator opens the edit link
3. Client extracts the edit token from the fragment and POSTs it to `POST /api/gists/:id/claim` to exchange it for a short-lived **edit capability cookie** (HttpOnly, Secure, SameSite=Strict, path-scoped to `/parties/gist-room/:id`)
4. If authenticated + valid edit capability: full edit access, edits saved to GitHub via owner's token (GitHub attributes all writes to the Gist owner, not the collaborator)
5. If authenticated but no edit capability: read-only rendered view (same as anonymous)
6. If unauthenticated: read-only rendered view of the markdown
7. Multiple authorized editors see each other's cursors and edits in real-time

### Viewing / Sharing

1. `gist.party/<gist_id>` — if not signed in, shows a beautifully rendered read-only markdown view
2. `gist.party/<gist_id>/raw` — returns the raw markdown (useful for `curl`, AI agents, scripts)

## Architecture

```bash
┌─────────────────┐      WebSocket       ┌───────────────────────┐
│   Browser        │◄──────────────────► │  GistRoom DO          │
│                  │  (y-partyserver)    │  (extends YServer)    │
│  CodeMirror      │                     │                       │
│  + Yjs doc       │                     │  Yjs CRDT sync/aware  │
│  + YProvider     │                     │  + DO SQLite storage  │
│  + Awareness     │                     │  + onLoad / onSave    │
└─────────────────┘                      └──────────┬────────────┘
       │                                            │
       │ HTTP                                fetch/patch
       ▼                                            │
┌─────────────────┐                        ┌────────▼─────────┐
│ Cloudflare      │                        │  GitHub Gist API │
│ Worker (Hono)   │                        │ (eventual persist)│
│                 │                        └──────────────────┘
│ OAuth, API,     │
│ SPA serving     │
│ routePartykitRequest → DO │
└─────────────────┘
```

### GistRoom (extends YServer from y-partyserver)

Each Gist ID maps to a PartyServer Durable Object. The `GistRoom` class extends `YServer` (from `y-partyserver`), which provides the Yjs sync protocol, awareness, broadcasting, and persistence callbacks out of the box.

The GistRoom:

- **`onLoad()`**: Called once when the DO starts or wakes from hibernation. Loads the Yjs snapshot from DO SQLite storage. If no snapshot exists, fetches the Gist content from the GitHub API and applies it to `this.document` (the Yjs `Y.Doc` provided by `YServer`).
- **`onSave()`**: Called by `YServer` after edits (debounced via `callbackOptions`). Writes the Yjs snapshot to DO SQLite storage. If the owner is connected, also PATCHes the Gist via the GitHub API (with conditional write). If the owner is not connected, marks the document as "pending sync".
- **`isReadOnly(connection)`**: Returns `true` for connections without a valid edit capability cookie — `YServer` silently drops incoming Yjs updates from read-only connections. Awareness updates from read-only connections are also rejected to prevent cursor spoofing.
- **`onCustomMessage(connection, message)`**: Handles non-Yjs messages over the same WebSocket (sync status, staleness warnings). Action messages (merge/overwrite decisions) are restricted to the owner connection only.
- **Hibernation**: Enabled via `static options = { hibernate: true }`. The DO is evicted from memory when idle; `onLoad()` rehydrates state from storage on wake.
- **Staleness detection**: Before each GitHub PATCH in `onSave()`, uses a **conditional write** with `If-Match: <etag>`. If the API returns 412 (Precondition Failed), autosync pauses and a "Remote changed" custom message is sent to connected clients.
- **Conflict resolution on load**: If the stored snapshot is older than 5 minutes, `onLoad()` validates against GitHub. If `pendingSync` is true, the DO **does not overwrite local Yjs state** — it enters a conflict state and requires an explicit owner decision ("push local to remote" vs "discard local, reload remote"). If `pendingSync` is false and the remote is newer, the external markdown content is applied to the Yjs doc.
- **Owner token handling**: The owner's GitHub access token is stored **encrypted at rest in Workers KV** (AES-GCM via WebCrypto, keyed by a Workers secret). The DO reads the token from KV when it needs to write to GitHub and caches it in memory while the owner is connected. If the owner disconnects, the in-memory cache is dropped and `pendingSync` is set; saves resume when the owner reconnects and the token is re-read from KV.
- **Initialized room**: The DO refuses to fetch from GitHub for arbitrary `gist_id` values unless the room has been initialized by an authenticated owner action (create or import). The `initialized` flag and `ownerUserId` are stored in DO SQLite.
- **Persistence**: Uses DO SQLite storage (`this.ctx.storage.sql`) for the Yjs snapshot and metadata (`gistId`, `filename`, `etag`/`updatedAt`, `editTokenHash`, `lastSavedAt`, `pendingSync`, `pendingSince`, `initialized`, `ownerUserId`).
- **Limits**: Maximum document size of 2 MB enforced on inbound Yjs updates. Per-IP and per-room WebSocket connection limits enforced to prevent resource exhaustion. Message rate limiting applied to all connections.

### Cloudflare Worker (Hono + routePartykitRequest)

The Worker handles all HTTP traffic. WebSocket upgrades are routed to the GistRoom DO automatically via `routePartykitRequest()` from `partyserver`.

- **Static assets**: Serves the Vite-built SPA (via Cloudflare Worker Assets)
- **OAuth**: Handles the GitHub OAuth flow (`/api/auth/github`, `/api/auth/github/callback`), issues signed JWT session cookies
- **API routes**: Gist CRUD, edit token management
- **WebSocket routing**: `routePartykitRequest(request, env)` handles the `/parties/gist-room/:gist_id` path automatically, forwarding WebSocket upgrades to the correct DO instance
- **Session verification**: Issues and verifies signed JWT cookies containing `{ userId, login, avatarUrl }` — verifiable by both the Worker and the DO without network hops

### Client

- **Editor**: CodeMirror 6 with `y-codemirror.next` binding for Yjs integration
- **Provider**: `YProvider` from `y-partyserver/provider` connecting to the GistRoom DO. Configured with `party: "gist-room"` and `room: gistId`.
- **Awareness**: Shows collaborator cursors, selections, and names (pulled from GitHub profile via JWT)
- **Custom messages**: Uses `provider.sendMessage()` and `provider.on("custom-message", ...)` for non-Yjs communication (sync status, staleness warnings)
- **Markdown preview**: Optional split-pane rendered preview using `markdown-it` or similar

## Tech Stack

| Component         | Technology                                     |
| ----------------- | ---------------------------------------------- |
| Framework         | Vite + React                                   |
| Editor            | CodeMirror 6                                   |
| CRDT              | Yjs + y-codemirror.next                        |
| Realtime server   | PartyServer (`partyserver`) on Cloudflare DOs  |
| Yjs integration   | `y-partyserver` (YServer + YProvider)          |
| HTTP router       | Hono                                           |
| Auth              | GitHub OAuth 2.0 (PKCE + state)                |
| Session           | Signed JWT cookies (verified in Worker + DO)   |
| Session store     | Workers KV                                     |
| Token encryption  | AES-GCM via WebCrypto (Workers secret key)     |
| Storage           | GitHub Gists API (eventual persistence)        |
| DO persistence    | Durable Object SQLite storage (snapshots)      |
| Markdown render   | markdown-it (for read-only view)               |
| Deployment        | Cloudflare Workers + Durable Objects           |

## API Routes

These are handled by the Cloudflare Worker (Hono router). WebSocket routing is handled by `routePartykitRequest()`.

| Route                              | Method | Description                                |
| ---------------------------------- | ------ | ------------------------------------------ |
| `/api/auth/github`                 | GET    | Initiates GitHub OAuth flow                |
| `/api/auth/github/callback`        | GET    | OAuth callback, sets session               |
| `/api/gists`                       | POST   | Creates a new Gist, returns `{ gist_id, edit_token }` |
| `/api/gists/:id`                   | GET    | Returns Gist metadata                      |
| `/api/gists/:id/import`            | POST   | Imports an existing Gist, initializes room (owner only) |
| `/api/gists/:id/claim`             | POST   | Exchanges edit token (from URL fragment) for a short-lived edit capability cookie |
| `/api/gists/:id/edit-token`        | POST   | Revokes current edit token, kicks existing editor sockets, generates a new one (owner only) |
| `/parties/gist-room/:gist_id`      | GET    | WebSocket upgrade (handled by `routePartykitRequest`) |
| `/:gist_id`                        | GET    | Serves editor (if valid edit token) or viewer |
| `/:gist_id/raw`                    | GET    | Returns raw markdown as `text/plain`       |

## Data Flow: Edit → Save

1. User types in CodeMirror
2. `y-codemirror.next` applies the edit to the local Yjs document
3. `YProvider` syncs the update to the GistRoom DO via WebSocket
4. `YServer` broadcasts the update to all other connected clients automatically
5. `YServer` calls `onSave()` after the debounce period (configured via `callbackOptions`)
6. `onSave()` writes the snapshot to DO SQLite storage
7. If the owner is not connected: `onSave()` sets `pendingSync = true` and records `pendingSince` timestamp. Done.
8. If the owner is connected: `onSave()` reads the owner's GitHub token from KV (or in-memory cache) and calls `PATCH /gists/:id` with `If-Match: <etag>` (conditional write)
9. If 412 (Precondition Failed — external edit detected): autosync pauses, clients are notified with a "Remote changed" custom message. Owner chooses to push local or discard and reload remote.
10. If success: `onSave()` stores the new `etag` and `updated_at` from the response

## Data Flow: Load

1. Client creates a `YProvider` with `party: "gist-room"` and `room: gistId`; `routePartykitRequest` routes the WebSocket to the GistRoom DO
2. `YServer` calls `onLoad()` — if DO SQLite has a snapshot, apply it to `this.document`
3. If no snapshot → `onLoad()` fetches from GitHub Gist API, applies content to `this.document`
4. `YServer` runs the Yjs sync handshake with the client automatically; client receives the Yjs state and renders in CodeMirror

## Auth Model

- **GitHub OAuth** with `gist` scope (read/write Gists), using PKCE + `state` parameter
- Access token stored **server-side only, encrypted at rest** in Workers KV (AES-GCM via WebCrypto, keyed by a Workers secret). The token is never sent to the client or stored in localStorage. The HTTP-only JWT session cookie references the session; the DO reads the encrypted token from KV on demand.
- **GitHub sync requires the owner to be connected** (policy decision, not a technical constraint): the DO caches the owner's token in memory while connected. If the owner disconnects, the in-memory cache is dropped and `pendingSync` is set; saves resume when the owner reconnects and the token is re-read from KV.
- Collaborators authenticate to get cursor identity but do not need `gist` scope — only the owner's token is used for GitHub writes. **All GitHub Gist writes are attributed to the Gist owner**, regardless of which collaborator made the edit.
- **JWT cookies** must include `exp` (expiration), `aud` (audience), `iss` (issuer), and use a strong signing key. Rotation strategy: short-lived JWTs (e.g., 1 hour) with silent refresh via the session in KV.

## Edit Permissions

Edit access is controlled via **capability-based edit tokens**, not by authentication alone.

- When a Gist owner creates or imports a document, the server generates a random edit token (cryptographically random, URL-safe, 32+ chars)
- The token hash (SHA-256) is stored in Durable Object storage alongside the Gist metadata
- The owner receives the edit link: `gist.party/<gist_id>#edit=<token>` (token in URL fragment to prevent leakage via Referer headers, server logs, and browser history sync)
- **Token exchange flow**: the client extracts the token from the URL fragment and POSTs it to `/api/gists/:id/claim`. The server validates the hash against DO storage and issues a short-lived **edit capability cookie** (HttpOnly, Secure, SameSite=Strict, path-scoped).
- **Server-side enforcement**: the Durable Object validates the edit capability cookie on WebSocket connection. Connections without a valid capability are admitted as **read-only** — incoming Yjs updates and awareness updates from those connections are silently dropped.
- The owner can revoke an edit token and generate a new one at any time. **Revocation kicks existing editor WebSocket connections** that were using the old token, forcing them to re-claim.

| User                          | Can view | Can edit (CRDT) | Changes saved to Gist          |
| ----------------------------- | -------- | --------------- | ------------------------------ |
| Gist owner                    | Yes      | Yes             | Yes (their token)              |
| Authed user + valid edit link | Yes      | Yes             | Yes (via owner's token on GitHub) |
| Authed user, no edit link     | Yes      | No              | N/A                            |
| Anonymous                     | Yes      | No              | N/A                            |

## Security

### Markdown Rendering

- markdown-it configured with `html: false` to prevent raw HTML injection
- All rendered output served with a restrictive Content Security Policy: no inline scripts, restricted `img-src` and `frame-src`

### Raw Endpoint

- `/:gist_id/raw` responds with `Content-Type: text/plain; charset=utf-8`
- `X-Content-Type-Options: nosniff` header to prevent browser content sniffing

### Gist Content Access

- The read-only viewer and raw endpoint only serve content for initialized rooms — the DO refuses to fetch from GitHub for arbitrary `gist_id` values without a prior owner create/import action
- Anonymous viewer requests are rate-limited by IP to prevent gist_id enumeration

### CSRF Protection

- All state-changing POST endpoints (`/api/gists`, `/api/gists/:id/import`, `/api/gists/:id/claim`, `/api/gists/:id/edit-token`) are protected with SameSite cookies + double-submit cookie CSRF tokens

### Referrer Policy

- All responses include `Referrer-Policy: strict-origin` to prevent edit token leakage via Referer headers (defense-in-depth; the token is already in the URL fragment)

### WebSocket Security

- Per-IP and per-room connection limits to prevent resource exhaustion
- Message rate limiting on all WebSocket connections
- Read-only connections cannot send awareness updates (prevents cursor spoofing)
- Maximum document size of 2 MB enforced on inbound Yjs updates

## MVP Scope

### In Scope

- GitHub OAuth sign-in (PKCE + `state`)
- Create a new Gist from the editor
- Import an existing Gist by URL
- Capability-based edit tokens (URL fragment + cookie exchange) with server-side WebSocket enforcement
- Real-time collaborative editing with cursors (authorized editors only)
- Auto-save back to Gist (debounced, owner-connected only, with pending-sync fallback)
- Conditional writes to GitHub (`If-Match: <etag>`), pause + warn on conflict
- Conflict-safe load: pending local edits block automatic overwrite from remote
- Sync status UI: "Saved", "Saving…", "Pending sync (owner offline)", "Remote changed — push or discard?", "Error (retrying)"
- Encrypted GitHub token storage (AES-GCM in Workers KV)
- Read-only rendered view for anonymous users and users without edit capability
- Raw markdown endpoint
- Security hardening: XSS-safe markdown rendering (`html: false`, CSP), `nosniff` on raw endpoint, `Referrer-Policy: strict-origin`, CSRF protection, IP rate-limiting on anonymous views, WebSocket rate limiting, 2 MB document size limit

### Out of Scope (Future)

- Multiple files per Gist
- Offline support / service worker
- Comments / annotations
- Markdown preview pane in editor
- Gist history / version browsing
- Custom domains for individual docs
- Granular per-document permission controls (beyond edit link)
- Syntax highlighting in preview for code blocks
- Export to PDF

## Open Questions

1. ~~**Rate limits**: GitHub API allows 5,000 requests/hour per authenticated user. With 5s debounce saves, a single active editor generates ~720 writes/hour. Should we increase the debounce window or batch?~~ **Resolved**: 30s debounce + idle-save + flush-on-disconnect keeps writes under ~120/hour per active doc.
2. **Multi-file Gists**: GitHub Gists can contain multiple files. MVP targets single-file Gists. How should multi-file Gists be handled later?
3. **Gist visibility**: Should new Gists be created as public or secret? Configurable per-document?
4. ~~**Stale sessions**: If a GistRoom DO has a persisted snapshot but the Gist was edited externally, how aggressively should we check for staleness?~~ **Resolved**: Use `If-Match: <etag>` conditional writes on every PATCH. In `onLoad()`, validate the snapshot against GitHub if it's older than 5 minutes. If stale and `pendingSync` is true, enter conflict state (owner decides). If stale and no pending edits, apply remote content.
5. ~~**Deployment topology**: Deploy client and server together on PartyKit (it can serve static assets), or split across PartyKit + Vercel?~~ **Resolved**: Single Cloudflare deployment — Worker serves the SPA and API, Durable Objects handle real-time collaboration.
