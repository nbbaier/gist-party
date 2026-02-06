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

1. Gist owner clicks "Share" → generates an **edit link**: `gist.party/<gist_id>?edit=<token>`
2. Collaborator opens the edit link
3. If authenticated + valid edit token: full edit access, changes attributed to their GitHub identity
4. If authenticated but no edit token: read-only rendered view (same as anonymous)
5. If unauthenticated: read-only rendered view of the markdown
6. Multiple authorized editors see each other's cursors and edits in real-time

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
│ Worker (Hono)   │                        │  (source of truth)│
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
- **`onSave()`**: Called by `YServer` after edits (debounced via `callbackOptions`). Writes the Yjs snapshot to DO SQLite storage. If the owner is connected, also PATCHes the Gist via the GitHub API (with staleness check). If the owner is not connected, marks the document as "pending sync".
- **`isReadOnly(connection)`**: Returns `true` for connections without a valid edit token — `YServer` silently drops incoming Yjs updates from read-only connections.
- **`onCustomMessage(connection, message)`**: Handles non-Yjs messages over the same WebSocket (sync status, staleness warnings, merge/overwrite decisions).
- **Hibernation**: Enabled via `static options = { hibernate: true }`. The DO is evicted from memory when idle; `onLoad()` rehydrates state from storage on wake. Supports up to 32k concurrent connections.
- **Staleness detection**: Before each GitHub PATCH in `onSave()`, checks the Gist's `updated_at` / ETag against the stored value. If stale (external edit detected), autosync pauses and a "Remote changed" custom message is sent to connected clients.
- **Conflict resolution on load**: If the stored snapshot is older than 5 minutes, `onLoad()` validates against GitHub. If stale, the external markdown content is applied to the Yjs doc (overwrite with warning for MVP; diff-based merge deferred to post-MVP).
- **Owner token handling**: The owner's GitHub access token is held **in memory only**, associated with the owner's active WebSocket connection. If the owner disconnects, the token is dropped and `pendingSync` is set; saves resume when the owner reconnects.
- **Persistence**: Uses DO SQLite storage (`this.ctx.storage.sql`) for the Yjs snapshot and metadata (`gistId`, `filename`, `etag`/`updatedAt`, `editTokenHash`, `lastSavedAt`, `pendingSync`).

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
| Storage           | GitHub Gists API                               |
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
| `/api/gists/:id/edit-token`        | POST   | Revokes current edit token, generates a new one (owner only) |
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
7. If the owner is not connected: `onSave()` sets `pendingSync = true` (flushed when the owner reconnects). Done.
8. If the owner is connected: `onSave()` checks the Gist's `updated_at` against the last known value
9. If stale (external edit detected): autosync pauses, clients are notified with a "Remote changed" custom message. Owner chooses to merge or overwrite.
10. If not stale: `onSave()` calls `PATCH /gists/:id` on the GitHub API with the full document content, stores the new `updated_at`

## Data Flow: Load

1. Client creates a `YProvider` with `party: "gist-room"` and `room: gistId`; `routePartykitRequest` routes the WebSocket to the GistRoom DO
2. `YServer` calls `onLoad()` — if DO SQLite has a snapshot, apply it to `this.document`
3. If no snapshot → `onLoad()` fetches from GitHub Gist API, applies content to `this.document`
4. `YServer` runs the Yjs sync handshake with the client automatically; client receives the Yjs state and renders in CodeMirror

## Auth Model

- **GitHub OAuth** with `gist` scope (read/write Gists), using PKCE + `state` parameter
- Access token stored server-side only (HTTP-only cookie references the session; token never sent to the client or stored in localStorage)
- **GitHub sync requires the owner to be connected**: the Durable Object uses the owner's token (provided via their active WebSocket connection) to write back to the Gist. If the owner disconnects, edits accumulate in DO storage as "pending sync" and flush when the owner reconnects.
- Collaborators authenticate to get cursor identity but do not need `gist` scope — only the owner's token is used for GitHub writes

## Edit Permissions

Edit access is controlled via **capability-based edit tokens**, not by authentication alone.

- When a Gist owner creates or imports a document, the server generates a random edit token (cryptographically random, URL-safe, 32+ chars)
- The token hash (SHA-256) is stored in Durable Object storage alongside the Gist metadata
- The owner receives the edit link: `gist.party/<gist_id>?edit=<token>`
- **Server-side enforcement**: the Durable Object validates the edit token on WebSocket connection. Connections without a valid token are admitted as **read-only** — incoming Yjs updates from those connections are silently dropped.
- The owner can revoke an edit token and generate a new one at any time

| User                          | Can view | Can edit (CRDT) | Changes saved to Gist |
| ----------------------------- | -------- | --------------- | --------------------- |
| Gist owner                    | Yes      | Yes             | Yes (their token)     |
| Authed user + valid edit link | Yes      | Yes             | Yes (owner's token)   |
| Authed user, no edit link     | Yes      | No              | N/A                   |
| Anonymous                     | Yes      | No              | N/A                   |

## Security

### Markdown Rendering

- markdown-it configured with `html: false` to prevent raw HTML injection
- All rendered output served with a restrictive Content Security Policy: no inline scripts, restricted `img-src` and `frame-src`

### Raw Endpoint

- `/:gist_id/raw` responds with `Content-Type: text/plain; charset=utf-8`
- `X-Content-Type-Options: nosniff` header to prevent browser content sniffing

### Gist Content Access

- The read-only viewer and raw endpoint only serve content for the Gist associated with the room — they do not act as a general-purpose GitHub API proxy
- Anonymous viewer requests are rate-limited by IP to prevent gist_id enumeration
- The server does not fetch or serve content for Gists it has never been used with (no arbitrary gist_id fetching without an authenticated owner having first created or imported the document)

## MVP Scope

### In Scope

- GitHub OAuth sign-in (PKCE + `state`)
- Create a new Gist from the editor
- Import an existing Gist by URL
- Capability-based edit tokens with server-side WebSocket enforcement
- Real-time collaborative editing with cursors (authorized editors only)
- Auto-save back to Gist (debounced, owner-connected only, with pending-sync fallback)
- Staleness detection before each GitHub PATCH (check `updated_at` / ETag, pause + warn on conflict)
- Sync status UI: "Saved", "Saving…", "Pending sync (owner offline)", "Remote changed", "Error (retrying)"
- Read-only rendered view for anonymous users and users without edit token
- Raw markdown endpoint
- Security hardening: XSS-safe markdown rendering (`html: false`, CSP), `nosniff` on raw endpoint, IP rate-limiting on anonymous views

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
- Encrypted token-at-rest for owner-offline GitHub sync

## Open Questions

1. ~~**Rate limits**: GitHub API allows 5,000 requests/hour per authenticated user. With 5s debounce saves, a single active editor generates ~720 writes/hour. Should we increase the debounce window or batch?~~ **Resolved**: 30s debounce + idle-save + flush-on-disconnect keeps writes under ~120/hour per active doc.
2. **Multi-file Gists**: GitHub Gists can contain multiple files. MVP targets single-file Gists. How should multi-file Gists be handled later?
3. **Gist visibility**: Should new Gists be created as public or secret? Configurable per-document?
4. ~~**Stale sessions**: If a GistRoom DO has a persisted snapshot but the Gist was edited externally, how aggressively should we check for staleness?~~ **Resolved**: Check `updated_at` / ETag before every PATCH. In `onLoad()`, always validate the snapshot against GitHub if it's older than 5 minutes. If stale, merge external changes into the CRDT before serving.
5. ~~**Deployment topology**: Deploy client and server together on PartyKit (it can serve static assets), or split across PartyKit + Vercel?~~ **Resolved**: Single Cloudflare deployment — Worker serves the SPA and API, Durable Objects handle real-time collaboration.
