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
6. PartyKit room is created with the gist_id as the room name

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
┌─────────────┐       WebSocket         ┌──────────────────┐
│   Browser    │◄─────────────────────► │   PartyKit Room  │
│              │   (y-partykit/provider)│   (per Gist ID)  │
│  CodeMirror  │                        │                  │
│  + Yjs doc   │                        │  Yjs CRDT state  │
│  + Awareness │                        │  + persistence   │
└─────────────┘                         └────────┬─────────┘
                                                 │
                                          load() │ callback()
                                                 │
                                        ┌────────▼─────────┐
                                        │  GitHub Gist API │
                                        │  (source of truth)│
                                        └──────────────────┘
```

### PartyKit Server (per room / per Gist)

Each Gist ID maps to a PartyKit room. The server:

- **On first connection (`load`)**: Fetches the Gist content from the GitHub API and hydrates the Yjs document
- **On edits (`callback.handler`)**: Debounces and writes the current document state back to the Gist via the API (every ~30 seconds, or ~5 seconds after last keystroke if idle). Also flushes on last client disconnect.
- **Persistence**: Uses `persist: { mode: "snapshot" }` so the Yjs state survives between sessions without hitting GitHub on every reconnect
- **Staleness detection**: Before each PATCH, the server checks the Gist's `updated_at` timestamp (or ETag) against the last known value. If the Gist was modified externally, autosync pauses and a "Remote changed" warning is surfaced to connected clients. The owner can then choose to merge or overwrite.
- **Conflict resolution on load**: If the Gist was edited externally (e.g., via `gh` CLI) and no room is active, the next `load()` merges the external changes into the CRDT

### Client

- **Editor**: CodeMirror 6 with `y-codemirror.next` binding for Yjs integration
- **Provider**: `y-partykit/provider` connecting to the room named after the Gist ID
- **Awareness**: Shows collaborator cursors, selections, and names (pulled from GitHub profile)
- **Markdown preview**: Optional split-pane rendered preview using `markdown-it` or similar

## Tech Stack

| Component        | Technology                          |
| ---------------- | ----------------------------------- |
| Framework        | Vite + React                        |
| Editor           | CodeMirror 6                        |
| CRDT             | Yjs + y-codemirror.next             |
| Realtime server  | PartyKit (y-partykit)               |
| Auth             | GitHub OAuth 2.0                    |
| Storage          | GitHub Gists API                    |
| Session cache    | PartyKit room storage (snapshots)   |
| Markdown render  | markdown-it (for read-only view)    |
| Deployment       | PartyKit (server) + Vercel (client) |

## API Routes

These are handled by the PartyKit server or a lightweight API layer:

| Route                        | Method | Description                                |
| ---------------------------- | ------ | ------------------------------------------ |
| `/api/auth/github`           | GET    | Initiates GitHub OAuth flow                |
| `/api/auth/github/callback`  | GET    | OAuth callback, sets session               |
| `/api/gists`                 | POST   | Creates a new Gist, returns `{ gist_id, edit_token }` |
| `/api/gists/:id`             | GET    | Returns Gist metadata                      |
| `/api/gists/:id/edit-token`  | POST   | Revokes current edit token, generates a new one (owner only) |
| `/:gist_id`                  | GET    | Serves editor (if valid edit token) or viewer |
| `/:gist_id/raw`              | GET    | Returns raw markdown as `text/plain`       |

## Data Flow: Edit → Save

1. User types in CodeMirror
2. `y-codemirror.next` applies the edit to the local Yjs document
3. Yjs syncs the update to the PartyKit room via WebSocket
4. PartyKit broadcasts the update to all other connected clients
5. PartyKit's `callback.handler` fires after debounce (30s, or 5s after last keystroke if idle)
6. If the owner is not connected: the room marks the snapshot as "pending sync" (flushed when the owner reconnects). Skip to step 10.
7. Server checks the Gist's `updated_at` against the last known value
8. If stale (external edit detected): autosync pauses, clients are notified with a "Remote changed" warning. Owner chooses to merge or overwrite.
9. If not stale: handler calls `PATCH /gists/:id` on the GitHub API with the full document content, stores the new `updated_at`
10. PartyKit room storage is updated with the latest snapshot

## Data Flow: Load

1. Client connects to PartyKit room for Gist ID `abc123`
2. If room has persisted snapshot → load from PartyKit storage (fast)
3. If no snapshot → `load()` fetches from GitHub Gist API, returns Yjs doc
4. Client receives the Yjs state and renders in CodeMirror

## Auth Model

- **GitHub OAuth** with `gist` scope (read/write Gists), using PKCE + `state` parameter
- Access token stored server-side only (HTTP-only cookie references the session; token never sent to the client or stored in localStorage)
- **GitHub sync requires the owner to be connected**: the PartyKit server uses the owner's token (provided via their active WebSocket connection) to write back to the Gist. If the owner disconnects, edits accumulate in the PartyKit snapshot as "pending sync" and flush when the owner reconnects.
- Collaborators authenticate to get cursor identity but do not need `gist` scope — only the owner's token is used for GitHub writes

## Edit Permissions

Edit access is controlled via **capability-based edit tokens**, not by authentication alone.

- When a Gist owner creates or imports a document, the server generates a random edit token (cryptographically random, URL-safe, 32+ chars)
- The token hash (SHA-256) is stored in PartyKit room storage alongside the Gist metadata
- The owner receives the edit link: `gist.party/<gist_id>?edit=<token>`
- **Server-side enforcement**: the PartyKit room validates the edit token on WebSocket connection. Connections without a valid token are admitted as **read-only** — incoming Yjs updates from those connections are silently dropped.
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
4. ~~**Stale sessions**: If a PartyKit room has a persisted snapshot but the Gist was edited externally, how aggressively should we check for staleness?~~ **Resolved**: Check `updated_at` / ETag before every PATCH. On `load()`, always validate the snapshot against GitHub if it's older than 5 minutes. If stale, merge external changes into the CRDT before serving.
5. **Deployment topology**: Deploy client and server together on PartyKit (it can serve static assets), or split across PartyKit + Vercel?
