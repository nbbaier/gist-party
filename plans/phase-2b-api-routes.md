# Track 2B — API Routes

> **Goal**: All REST endpoints for gist lifecycle and room initialization. `curl` can create a gist, import a gist, and fetch metadata. DO rooms are initialized with correct ownership.

---

## Prerequisites

| Phase 1 Track | What it provides | Must be complete? |
|---|---|---|
| **Track 1A — Auth System** | JWT sign/verify module (pure WebCrypto), token encryption module (AES-GCM), OAuth flow, session management in Workers KV | Yes |
| **Track 1C — GistRoom Durable Object** | `GistRoom` extending `YServer`, DO SQLite schema with `initialized`, `ownerUserId`, `editTokenHash`, `gistId`, `filename`, etc. Room initialization logic. | Yes |

---

## Depends On / Produces

### Consumes (from other tracks)

| Contract | Source | How it's used here |
|---|---|---|
| JWT sign/verify module | Track 1A | Auth middleware verifies JWT cookies on protected routes, extracts `userId`, `login`, `avatarUrl` |
| Token encryption module | Track 1A | `POST /api/gists` stores the owner's GitHub access token encrypted in Workers KV (for later GitHub sync in Phase 3A) |
| DO SQLite schema | Track 1C | API routes initialize DO rooms by writing `initialized`, `ownerUserId`, `editTokenHash`, `gistId`, `filename` to DO SQLite storage |
| `GistRoom` DO class | Track 1C | API routes obtain a DO stub via `env.GIST_ROOM.get(id)` and call into the DO to initialize room state |

### Produces (for downstream tracks)

| Contract | Consumers | Description |
|---|---|---|
| `POST /api/gists` endpoint | Track 3B (edit permissions — token exchange depends on rooms existing), Track 2A (collab needs initialized rooms) | Creates GitHub Gists and initializes DO rooms |
| `POST /api/gists/:gist_id/import` endpoint | Track 3C (read-only views — imported gists have content to display) | Imports existing Gists and initializes DO rooms |
| `GET /api/gists/:gist_id` endpoint | Track 3C (read-only views — metadata for viewer), Track 4B (status UI — sync status from metadata) | Returns gist metadata including sync status |
| Auth middleware | Track 3B (edit permissions — claim/revoke endpoints), Track 3A (GitHub sync — owner verification) | Reusable Hono middleware for JWT verification |
| Edit token generation utility | Track 3B (edit permissions — token rotation endpoint) | Shared function for generating and hashing edit tokens |

---

## Tasks

### Task 1: Auth Middleware

**Description**: Create a Hono middleware that verifies the JWT session cookie on protected routes, extracts the user payload, and makes it available to downstream handlers.

**Implementation details**:

- Create a Hono middleware function that:
  1. Reads the session JWT from the cookie (cookie name defined in Track 1A — likely `__session` or similar)
  2. Calls the JWT verify function from Track 1A's shared module (`verifyJwt(token, secret)`)
  3. Validates claims: `exp` (not expired), `aud` (matches expected audience), `iss` (matches expected issuer)
  4. If valid, sets the decoded payload on the Hono context: `c.set("user", { userId, login, avatarUrl })`
  5. If invalid or missing, returns `401 Unauthorized` with a JSON error body: `{ error: "unauthorized", message: "..." }`
- Create two middleware variants:
  - `requireAuth` — returns 401 if no valid JWT. Used on `POST /api/gists`, `POST /api/gists/:gist_id/import`
  - `optionalAuth` — sets user on context if JWT is present and valid, otherwise sets `null`. Used on `GET /api/gists/:gist_id`
- TypeScript: extend Hono's context type to include the `user` variable:
  ```ts
  type AuthVariables = {
    user: { userId: string; login: string; avatarUrl: string } | null;
  };
  ```
- The middleware must work with Cloudflare Workers' request model (cookies are in the `Cookie` header, parsed manually or via Hono's cookie helper)

**Files to create/modify**:

- `src/server/middleware/auth.ts` — new file with `requireAuth` and `optionalAuth` middleware
- `src/server/types.ts` — Hono app type with `AuthVariables` bindings (or extend existing type file)

**Verification**:

1. `curl -X POST http://localhost:8787/api/gists` (no cookie) → `401 { "error": "unauthorized" }`
2. `curl -X POST http://localhost:8787/api/gists -H "Cookie: __session=<valid-jwt>"` → passes middleware (may fail at handler, but not at auth)
3. `curl -X POST http://localhost:8787/api/gists -H "Cookie: __session=<expired-jwt>"` → `401`
4. `curl -X POST http://localhost:8787/api/gists -H "Cookie: __session=<malformed>"` → `401`
5. `curl http://localhost:8787/api/gists/some-id` (no cookie, `optionalAuth`) → passes middleware with `user = null`, returns metadata (or 404 if room doesn't exist)
6. Verify the `user` object is correctly populated in downstream handlers (add a temporary debug log)

---

### Task 2: `POST /api/gists` — Create New Gist

**Description**: Authenticated endpoint that creates a new GitHub Gist, generates an edit token, initializes the DO room, and returns the gist ID and edit token.

**Implementation details**:

- Route: `POST /api/gists`
- Middleware: `requireAuth`
- Request body (JSON):
  ```ts
  {
    visibility?: "secret" | "public";  // default: "secret"
    filename?: string;                  // default: "document.md"
  }
  ```
- Handler steps:
  1. Read user info from context: `c.get("user")`
  2. Read the owner's GitHub access token from Workers KV:
     - Key: `github_token:<userId>` (or whatever scheme Track 1A uses)
     - Decrypt using the token encryption module from Track 1A
  3. Create a GitHub Gist via the API:
     ```
     POST https://api.github.com/gists
     Authorization: Bearer <github_token>
     {
       "description": "",
       "public": visibility === "public",
       "files": { "<filename>": { "content": " " } }
     }
     ```
     - Note: GitHub requires at least a space character for file content; empty string is rejected
  4. Extract `gist_id` from the GitHub API response (`response.id`)
  5. Generate an edit token:
     - Use `crypto.getRandomValues()` to generate 32 bytes
     - Base64url-encode to get a URL-safe string (43+ chars)
     - Hash with SHA-256: `await crypto.subtle.digest("SHA-256", encoder.encode(token))`
     - Store the hash (hex-encoded) — never store the raw token
  6. Initialize the DO room:
     - Get the DO stub: `const id = env.GIST_ROOM.idFromName(gist_id); const stub = env.GIST_ROOM.get(id);`
     - Call the DO to initialize via an internal HTTP request or RPC:
       ```
       await stub.fetch(new Request("https://do/init", {
         method: "POST",
         body: JSON.stringify({
           gistId: gist_id,
           filename,
           ownerUserId: user.userId,
           editTokenHash: hash,
           etag: response.headers.get("ETag"),
         })
       }))
       ```
     - The DO's init handler writes to SQLite: `initialized = true`, `ownerUserId`, `editTokenHash`, `gistId`, `filename`, `etag`, `pendingSync = false`
  7. Return response:
     ```json
     { "gist_id": "<id>", "edit_token": "<raw-token>" }
     ```
     - Status: `201 Created`

- Error handling:
  - GitHub API failure (401 — token invalid/expired): return `502 { "error": "github_error", "message": "Failed to create Gist. Your GitHub authorization may have expired." }`
  - GitHub API failure (rate limit 403/429): return `502` with rate limit info
  - DO initialization failure: return `500 { "error": "internal", "message": "Failed to initialize room" }`
  - Missing/invalid body: return `400 { "error": "bad_request", "message": "..." }`

**Files to create/modify**:

- `src/server/routes/gists.ts` — new file with the Hono route handler
- `src/server/utils/editToken.ts` — new utility for generating and hashing edit tokens
- `src/server/utils/github.ts` — GitHub API client utility (reusable for import and Phase 3A)
- `src/server/index.ts` (or wherever the Hono app is composed) — mount the gists router

**Verification**:

1. Sign in via OAuth to get a valid JWT cookie
2. Create a gist:
   ```bash
   curl -X POST http://localhost:8787/api/gists \
     -H "Cookie: __session=<jwt>" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```
   Expected: `201 { "gist_id": "abc123...", "edit_token": "..." }`
3. Verify the Gist exists on GitHub:
   ```bash
   curl https://api.github.com/gists/<gist_id> \
     -H "Authorization: Bearer <github_token>"
   ```
   Expected: Gist exists with a single `document.md` file, visibility is secret
4. Verify DO is initialized:
   - Connect via WebSocket to `/parties/gist-room/<gist_id>` — should accept the connection (room is initialized)
   - Alternatively, call `GET /api/gists/<gist_id>` (Task 4) — should return metadata
5. Create with custom visibility and filename:
   ```bash
   curl -X POST http://localhost:8787/api/gists \
     -H "Cookie: __session=<jwt>" \
     -H "Content-Type: application/json" \
     -d '{"visibility": "public", "filename": "notes.md"}'
   ```
   Verify on GitHub: Gist is public with `notes.md` file
6. Create without auth: `curl -X POST http://localhost:8787/api/gists` → `401`
7. Verify edit token hash is stored in DO (not the raw token) — inspect DO SQLite storage

---

### Task 3: `POST /api/gists/:gist_id/import` — Import Existing Gist

**Description**: Authenticated, owner-only endpoint that imports an existing GitHub Gist. Validates it has exactly one file, fetches content, initializes the DO room, and returns the gist ID and edit token.

**Implementation details**:

- Route: `POST /api/gists/:gist_id/import`
- Middleware: `requireAuth`
- Request body (JSON):
  ```ts
  {
    gist_url?: string;  // optional, for convenience — gist_id is already in the URL
  }
  ```
- Handler steps:
  1. Extract `gist_id` from the URL parameter
  2. Read user info: `c.get("user")`
  3. Read and decrypt the owner's GitHub access token from Workers KV
  4. Fetch the Gist from GitHub:
     ```
     GET https://api.github.com/gists/:gist_id
     Authorization: Bearer <github_token>
     ```
  5. Validate the Gist:
     - Must exist (404 from GitHub → `404 { "error": "not_found", "message": "Gist not found" }`)
     - Must have exactly one file. If it has multiple files:
       ```json
       {
         "error": "multi_file",
         "message": "This Gist has multiple files. gist.party only supports single-file Gists.",
         "files": ["file1.md", "file2.md"]
       }
       ```
       Status: `422 Unprocessable Entity`
     - Must have zero files error: `422` (edge case — empty gist)
  6. Extract the single filename and its content from the response
  7. Verify ownership: the authenticated user must be the Gist owner (`gist.owner.id` matches `user.userId`). If not:
     ```json
     { "error": "forbidden", "message": "You can only import Gists you own" }
     ```
     Status: `403`
  8. Check if DO room is already initialized for this `gist_id`. If yes:
     ```json
     { "error": "already_initialized", "message": "This Gist is already hosted on gist.party" }
     ```
     Status: `409 Conflict`
  9. Generate edit token (same logic as Task 2, use shared utility)
  10. Initialize the DO room (same as Task 2, with additional fields):
      - `gistId`, `filename`, `ownerUserId`, `editTokenHash`
      - `etag` from the GitHub response headers
      - `initialized = true`, `pendingSync = false`
      - Note: the Gist content is NOT loaded into the Yjs document here — that happens via the `needs-init` protocol when the first client connects (Track 2A, Task 5b). The DO stores the metadata but not the content at import time.
  11. Return:
      ```json
      { "gist_id": "<id>", "edit_token": "<raw-token>" }
      ```
      Status: `201 Created`

**Files to create/modify**:

- `src/server/routes/gists.ts` — add the import route handler
- `src/server/utils/github.ts` — add `fetchGist(gistId, token)` function
- `src/server/utils/editToken.ts` — reuse from Task 2

**Verification**:

1. Create a single-file Gist on GitHub manually (e.g., via `gh gist create`)
2. Import it:
   ```bash
   curl -X POST http://localhost:8787/api/gists/<gist_id>/import \
     -H "Cookie: __session=<jwt>" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```
   Expected: `201 { "gist_id": "...", "edit_token": "..." }`
3. Verify DO is initialized: `GET /api/gists/<gist_id>` returns metadata with correct filename
4. Open the editor at `/:gist_id` → client receives `needs-init` → fetches content → editor shows the Gist's markdown (this verifies the integration with Track 2A)
5. Attempt to import a multi-file Gist:
   ```bash
   curl -X POST http://localhost:8787/api/gists/<multi-file-gist-id>/import \
     -H "Cookie: __session=<jwt>" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```
   Expected: `422 { "error": "multi_file", "message": "...", "files": [...] }`
6. Attempt to import a Gist owned by another user:
   ```bash
   curl -X POST http://localhost:8787/api/gists/<other-users-gist-id>/import \
     -H "Cookie: __session=<jwt>" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```
   Expected: `403 { "error": "forbidden" }`
7. Attempt to import the same Gist twice:
   ```bash
   # First import succeeds (201)
   # Second import:
   curl -X POST http://localhost:8787/api/gists/<gist_id>/import ...
   ```
   Expected: `409 { "error": "already_initialized" }`
8. Import without auth: `401`

---

### Task 4: `GET /api/gists/:gist_id` — Fetch Gist Metadata

**Description**: Returns metadata about a gist.party-hosted Gist. Auth is optional — authenticated users get additional info.

**Implementation details**:

- Route: `GET /api/gists/:gist_id`
- Middleware: `optionalAuth`
- Handler steps:
  1. Extract `gist_id` from URL parameter
  2. Get the DO stub: `env.GIST_ROOM.idFromName(gist_id)`
  3. Fetch metadata from the DO via internal request:
     ```
     GET https://do/metadata
     ```
     The DO responds with its SQLite-stored metadata
  4. If the room is not initialized: return `404 { "error": "not_found", "message": "This Gist is not hosted on gist.party" }`
  5. Build the response:
     ```ts
     {
       gist_id: string;
       filename: string;
       owner: {
         login: string;
         avatar_url: string;
       };
       visibility: "secret" | "public";  // from GitHub metadata if stored, or omit
       sync_status: "saved" | "saving" | "pending_sync" | "error" | "conflict";
       last_saved_at: string | null;     // ISO timestamp
       pending_since: string | null;     // ISO timestamp, if pendingSync
       is_owner: boolean;                // true if authenticated user === ownerUserId
     }
     ```
  6. `is_owner` is computed: `user?.userId === metadata.ownerUserId`
  7. `sync_status` reflects the current DO state

- Note: this endpoint does NOT return the Gist content (markdown). Content is served via the read-only view (`/:gist_id`) or raw endpoint (`/:gist_id/raw`) in Track 3C.

**Files to create/modify**:

- `src/server/routes/gists.ts` — add the GET route handler
- `src/server/gist-room.ts` (or wherever `GistRoom` is defined) — add a `/metadata` internal HTTP handler to the DO that reads from SQLite and returns JSON

**Verification**:

1. Create a gist via `POST /api/gists` first, then:
   ```bash
   curl http://localhost:8787/api/gists/<gist_id>
   ```
   Expected: `200` with metadata JSON including `filename`, `owner`, `sync_status`
2. Same request with auth cookie:
   ```bash
   curl http://localhost:8787/api/gists/<gist_id> \
     -H "Cookie: __session=<owner-jwt>"
   ```
   Expected: response includes `"is_owner": true`
3. With a different user's JWT:
   ```bash
   curl http://localhost:8787/api/gists/<gist_id> \
     -H "Cookie: __session=<other-user-jwt>"
   ```
   Expected: `"is_owner": false`
4. Non-existent / uninitialized room:
   ```bash
   curl http://localhost:8787/api/gists/nonexistent-id
   ```
   Expected: `404 { "error": "not_found" }`
5. Verify `sync_status` reflects reality:
   - After creation: `"saved"` (no pending changes)
   - After editing with owner connected: `"saving"` or `"saved"` depending on timing
   - After owner disconnects with pending changes: `"pending_sync"`

---

## Track Complete

### Overall Milestone Verification

> `curl` can create a gist, import a gist, and fetch metadata. DO rooms are initialized with correct ownership.

**End-to-end test procedure**:

1. **Start the dev server**: `wrangler dev`
2. **Sign in**: Complete the OAuth flow in a browser to get a valid JWT cookie. Copy the cookie value for curl commands.
3. **Create a gist**:
   ```bash
   COOKIE="__session=<your-jwt>"

   curl -s -X POST http://localhost:8787/api/gists \
     -H "Cookie: $COOKIE" \
     -H "Content-Type: application/json" \
     -d '{"filename": "notes.md"}' | jq .
   ```
   - Save the returned `gist_id` and `edit_token`
   - Verify on GitHub: `curl https://api.github.com/gists/<gist_id>` → Gist exists with `notes.md`
4. **Fetch metadata**:
   ```bash
   curl -s http://localhost:8787/api/gists/<gist_id> \
     -H "Cookie: $COOKIE" | jq .
   ```
   - Verify: `filename` is `notes.md`, `is_owner` is `true`, `sync_status` is `saved`
5. **Import a gist**:
   ```bash
   # Create a gist on GitHub first:
   echo "# Hello" | gh gist create -f test.md
   # Copy the gist ID, then:

   curl -s -X POST http://localhost:8787/api/gists/<new-gist-id>/import \
     -H "Cookie: $COOKIE" \
     -H "Content-Type: application/json" \
     -d '{}' | jq .
   ```
   - Verify: `201` with `gist_id` and `edit_token`
   - Fetch metadata: `GET /api/gists/<new-gist-id>` → `filename` matches the Gist's file
6. **Error cases**:
   ```bash
   # No auth
   curl -s -X POST http://localhost:8787/api/gists | jq .
   # → 401

   # Multi-file gist import
   curl -s -X POST http://localhost:8787/api/gists/<multi-file-id>/import \
     -H "Cookie: $COOKIE" \
     -H "Content-Type: application/json" \
     -d '{}' | jq .
   # → 422 with file list

   # Non-existent gist metadata
   curl -s http://localhost:8787/api/gists/does-not-exist | jq .
   # → 404
   ```
7. **DO state verification**: After creating and importing, verify the DO rooms have correct SQLite state:
   - `initialized = true`
   - `ownerUserId` matches the authenticated user
   - `editTokenHash` is a SHA-256 hex string (not the raw token)
   - `gistId` and `filename` are correct

**What is NOT verified in this track** (deferred to later phases):

- Edit token claim/exchange flow (`POST /api/gists/:gist_id/claim`) — Phase 3B
- Edit token revocation (`POST /api/gists/:gist_id/edit-token`) — Phase 3B
- GitHub Gist sync (PATCH on save) — Phase 3A
- CSRF protection — Phase 5
- Rate limiting — Phase 5
