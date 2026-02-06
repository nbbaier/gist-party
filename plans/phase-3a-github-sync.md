# Track 3A — GitHub Gist Sync

> **Goal**: Edits auto-save to GitHub with conflict detection. All markdown comes from connected clients via the serialization protocol — the DO never parses or generates markdown.

---

## Prerequisites

- Phase 1C complete: `GistRoom` DO extends `YServer`, `onLoad()`/`onSave()` persist Yjs snapshots to DO SQLite, `request-markdown`/`canonical-markdown` protocol operational, `lastCanonicalMarkdown` stored on each save cycle
- Phase 1A complete: Token encryption module (AES-GCM, versioned key prefix `v1:<iv>:<ciphertext>`), JWT sign/verify module
- Phase 2B complete: `POST /api/gists` and `POST /api/gists/:gist_id/import` initialize DO rooms with `gistId`, `filename`, `etag`, `ownerUserId` in SQLite
- Phase 2A complete: Client handles `request-markdown`, `canonical-markdown`, `needs-init`, `reload-remote` custom messages
- Workers KV binding configured in `wrangler.toml` with encrypted owner tokens stored by `userId`

## Depends On / Produces

| Depends On | What It Provides |
|---|---|
| Phase 1C — GistRoom DO (`onSave()` stub, `request-markdown` protocol) | GitHub PATCH integration inside `onSave()` |
| Phase 1A — Token encryption module | Decryption of owner tokens from KV |
| Phase 2B — API routes (room initialization with `etag`, `gistId`, `filename`) | Stored metadata for conditional writes |
| Phase 2A — Client custom message handling | Client responds to `request-markdown`, handles `reload-remote`, `remote-changed` |

| Produces | Consumed By |
|---|---|
| `sync-status` custom messages (`saved`, `saving`, `error-retrying`, `pending-sync`, `conflict`) | Phase 4B — Sync Status UI |
| `remote-changed` custom message with remote markdown | Phase 4A — Conflict Resolution, Phase 4B — Conflict Modal |
| `conflict` custom message with `localMarkdown` + `remoteMarkdown` | Phase 4A — Conflict Resolution |
| `pendingSync` / `pendingSince` state in DO SQLite | Phase 4A — Pending sync reconnect, Phase 4B — Pending sync banner |
| Sync status state machine (transitions) | Phase 4B — Status bar component |

---

## Tasks

### Task 1: `onSave()` GitHub PATCH

**Description**: Extend the existing `onSave()` in `GistRoom` to PATCH the Gist on GitHub after receiving canonical markdown from a client. This is the core auto-save path.

**Implementation Details**:

- After `onSave()` receives the `canonical-markdown` response (already wired in Phase 1C) and stores it in `lastCanonicalMarkdown`:
  1. Check if the owner is connected (look up owner connection by `ownerUserId` from SQLite)
  2. If owner is not connected, set `pendingSync = true`, record `pendingSince = Date.now()` in SQLite, broadcast `sync-status: { state: "pending-sync" }`, and return
  3. If owner is connected, read the owner's encrypted token from KV (`TOKEN:<userId>` key), decrypt using the token encryption module (select decryption key by version prefix), cache the decrypted token in an instance variable `this.ownerTokenCache`
  4. Call `PATCH https://api.github.com/gists/${gistId}` with body `{ files: { [filename]: { content: lastCanonicalMarkdown } } }` and header `If-Match: ${this.storedEtag}`
  5. On 200: extract `etag` from response header (or `response.headers.get("etag")`), extract `updated_at` from response body. Update `etag`, `updatedAt`, `lastSavedAt = Date.now()`, `pendingSync = false`, `pendingSince = null` in DO SQLite. Broadcast `sync-status: { state: "saved" }`
  6. Broadcast `sync-status: { state: "saving" }` before initiating the PATCH

- Use `this.ctx.storage.sql` for all SQLite reads/writes
- GitHub API base URL should be a constant: `https://api.github.com`
- Set `User-Agent: gist-party` header (GitHub requires it)
- Set `Accept: application/vnd.github+json` header
- Set `Authorization: Bearer ${token}` header

**Files to Create/Modify**:

| File | Action | Details |
|---|---|---|
| `src/server/gist-room.ts` | Modify | Add GitHub PATCH logic to `onSave()`, add `ownerTokenCache` instance variable, add `isOwnerConnected()` helper |
| `src/server/github-client.ts` | Create | GitHub API client class with `patchGist(token, gistId, filename, content, etag)` method. Returns `{ etag, updatedAt }` or throws typed errors |
| `src/server/constants.ts` | Modify | Add `GITHUB_API_BASE`, `SAVE_DEBOUNCE_MS`, `GITHUB_USER_AGENT` |

**Verification**:

1. Start `wrangler dev`, create a gist via `POST /api/gists`, open the editor, type content
2. Wait for debounce (30s) — observe in DO logs: `request-markdown` sent, `canonical-markdown` received, PATCH issued
3. Verify on `https://api.github.com/gists/<gist_id>` that the content matches what was typed
4. Verify `etag` and `updatedAt` are updated in DO SQLite:
   ```sh
   # In a test script or wrangler tail:
   # After save, DO should log: "GitHub PATCH success, etag=<value>, updatedAt=<value>"
   ```
5. Verify `sync-status: { state: "saving" }` is received by connected clients before PATCH, and `sync-status: { state: "saved" }` after

---

### Task 2: 412 Conflict Handling

**Description**: When GitHub returns 412 (Precondition Failed), the stored etag no longer matches the remote. Pause autosync and notify clients with the remote content for diff display.

**Implementation Details**:

- In the `patchGist()` method of `github-client.ts`, if the response status is 412:
  1. Throw a typed `EtagConflictError` (not a generic error)
- In `onSave()`, catch `EtagConflictError`:
  1. Set `this.autosyncPaused = true` (instance variable, not persisted — resets on DO wake)
  2. Fetch the current remote gist content: `GET https://api.github.com/gists/${gistId}` with the owner's token
  3. Extract the raw markdown from `response.files[filename].content` — this is plain text, no parsing needed
  4. Store the remote etag from the GET response
  5. Send `remote-changed` custom message to all connected clients: `{ type: "remote-changed", remoteMarkdown: <string> }`
  6. Also send `conflict` custom message to the owner connection: `{ type: "conflict", localMarkdown: this.lastCanonicalMarkdown, remoteMarkdown: <string> }`
  7. Broadcast `sync-status: { state: "conflict" }`

- Add `autosyncPaused` guard at the top of `onSave()` GitHub PATCH logic: if paused, skip PATCH (still persist Yjs snapshot to SQLite)

**Files to Create/Modify**:

| File | Action | Details |
|---|---|---|
| `src/server/github-client.ts` | Modify | Add `getGist(token, gistId)` method. Add `EtagConflictError` class. `patchGist()` throws `EtagConflictError` on 412 |
| `src/server/gist-room.ts` | Modify | Add `autosyncPaused` flag, catch `EtagConflictError` in `onSave()`, fetch remote, send `remote-changed` and `conflict` messages |
| `src/shared/message-types.ts` | Modify | Add `RemoteChangedMessage` and `ConflictMessage` types (if not already defined in Phase 1C) |

**Verification**:

1. Create a gist via the app, make an initial edit, let it save (establishes etag)
2. Edit the gist directly on GitHub (changes the remote etag)
3. Make another edit in the app, wait for save
4. Observe: PATCH returns 412, DO fetches remote, `remote-changed` message sent to clients
5. Verify `autosyncPaused = true` — subsequent `onSave()` calls should skip PATCH but still save Yjs to SQLite
6. Verify client receives `conflict` message with both `localMarkdown` and `remoteMarkdown` fields
7. Verify `sync-status: { state: "conflict" }` is broadcast

---

### Task 3: Error Handling with Exponential Backoff

**Description**: On 403 (forbidden/rate-limited), 429 (rate-limited), or 5xx (server error), pause autosync and retry with exponential backoff. Keep clients informed.

**Implementation Details**:

- In `github-client.ts`, throw typed errors:
  - `GitHubForbiddenError` for 403
  - `GitHubRateLimitError` for 429 (include `retry-after` header value if present)
  - `GitHubServerError` for 5xx
  - All extend a base `GitHubAPIError` class with `status`, `retryable` fields

- In `gist-room.ts`, add a backoff manager:
  - Instance variables: `retryAttempt: number = 0`, `retryTimer: ReturnType<typeof setTimeout> | null = null`, `maxRetryAttempt: number = 8`
  - Backoff formula: `Math.min(1000 * 2 ** retryAttempt, 300_000)` (1s → 2s → 4s → ... → max 5min)
  - For 429 with `retry-after`, use that value instead of calculated backoff
  - On retryable error in `onSave()`:
    1. Set `autosyncPaused = true`
    2. Increment `retryAttempt`
    3. Calculate `nextRetryAt = Date.now() + backoffMs`
    4. Broadcast `error-retrying: { attempt: retryAttempt, nextRetryAt }`
    5. Broadcast `sync-status: { state: "error-retrying", detail: { attempt, nextRetryAt } }`
    6. Schedule retry via `setTimeout` — on retry, call `this.attemptGitHubSync()` (extracted from `onSave()`)
  - On successful retry: reset `retryAttempt = 0`, `autosyncPaused = false`, broadcast `sync-status: { state: "saved" }`

- Manual retry: Add a `manual-retry` custom message type (client → DO, owner only). When received, cancel pending retry timer and immediately call `attemptGitHubSync()`

- Extract the GitHub PATCH + error handling into a private `attemptGitHubSync()` method to avoid duplicating logic between `onSave()` and manual retry

**Files to Create/Modify**:

| File | Action | Details |
|---|---|---|
| `src/server/github-client.ts` | Modify | Add `GitHubAPIError` base class, `GitHubForbiddenError`, `GitHubRateLimitError`, `GitHubServerError` |
| `src/server/gist-room.ts` | Modify | Add `retryAttempt`, `retryTimer`, `maxRetryAttempt`. Extract `attemptGitHubSync()`. Add backoff scheduling. Handle `manual-retry` in `onCustomMessage()` |
| `src/shared/message-types.ts` | Modify | Add `ErrorRetryingMessage`, `ManualRetryMessage` types |

**Verification**:

1. **Simulate 5xx**: Temporarily stub `github-client.ts` to return 500, or use a mock GitHub URL
2. Make an edit, wait for save → observe `error-retrying` message with `attempt: 1`
3. Verify retry timer fires after ~1s → second attempt fails → `error-retrying` with `attempt: 2`
4. Verify backoff doubles each time: 1s, 2s, 4s, 8s...
5. Restore real GitHub API → next retry succeeds → `sync-status: { state: "saved" }`, `retryAttempt` resets to 0
6. **Manual retry**: While in error state, send `manual-retry` from owner client → verify immediate sync attempt
7. **429 handling**: Stub a 429 response with `retry-after: 10` → verify backoff uses 10s, not calculated value
8. Verify non-owner connections sending `manual-retry` are rejected (no-op)

---

### Task 4: Owner Token Lifecycle

**Description**: Cache the owner's decrypted GitHub token in memory while connected. Drop cache on disconnect. Track pending sync state when the owner leaves with unsaved changes.

**Implementation Details**:

- Instance variable: `ownerTokenCache: string | null = null`
- On owner WebSocket connect (detect via `connection.userId === this.ownerUserId` from JWT):
  1. Read encrypted token from KV: `await this.env.TOKEN_KV.get(\`TOKEN:${this.ownerUserId}\`)`
  2. Decrypt using the token encryption module (import from shared contract)
  3. Store in `this.ownerTokenCache`
  4. If `pendingSync === true`, immediately trigger `attemptGitHubSync()` (but check for staleness first — see Task 5)

- On owner WebSocket disconnect (in `onClose()` or `onDisconnect()`):
  1. Set `this.ownerTokenCache = null`
  2. If there are unsaved changes since last successful GitHub PATCH (`lastCanonicalMarkdown` differs from last PATCH'd content, or `onSave()` has been called without a successful PATCH):
     - Set `pendingSync = true` and `pendingSince = Date.now()` in DO SQLite
     - Broadcast `sync-status: { state: "pending-sync" }` to remaining clients

- Detecting "unsaved changes": Track a boolean `hasDirtySinceLastPatch` — set to `true` when `onSave()` writes new canonical markdown to SQLite, set to `false` after successful GitHub PATCH

- The token cache is purely in-memory — on hibernation wake, the cache is null and will be re-read from KV on next owner connect

**Files to Create/Modify**:

| File | Action | Details |
|---|---|---|
| `src/server/gist-room.ts` | Modify | Add `ownerTokenCache`, `hasDirtySinceLastPatch`. Wire connect/disconnect handlers. Add `getOwnerToken()` helper that returns cache or reads from KV |
| `src/server/token-encryption.ts` | Import | Use the decrypt function from the shared token encryption module (Phase 1A) |

**Verification**:

1. Sign in as the owner, open the editor → verify in DO logs that token is decrypted and cached
2. Open a second tab (same owner) → verify token is served from cache (no second KV read)
3. Close all owner tabs → verify `ownerTokenCache` is set to `null`
4. With unsaved edits: close owner tab → verify `pendingSync = true` in SQLite, `sync-status: { state: "pending-sync" }` broadcast
5. Without unsaved edits: close owner tab → verify `pendingSync` remains `false`
6. Reopen owner tab → verify token is re-read from KV, cache is populated
7. Reopen owner tab with `pendingSync = true` → verify immediate sync attempt
8. Verify DO hibernation: wake DO after idle → `ownerTokenCache` is null → owner reconnects → token re-read from KV

---

### Task 5: Staleness Detection on Load

**Description**: When an authorized client connects and the snapshot is stale (>5 minutes), validate the stored etag against GitHub. Handle both pending-sync and non-pending-sync cases.

**Implementation Details**:

- Add staleness check logic, triggered when an authorized client connects and `lastSavedAt` is more than 5 minutes ago:
  1. Call `GET https://api.github.com/gists/${gistId}` with the owner's token (from cache or KV) — only need headers, but GitHub doesn't support HEAD on this endpoint, so use a full GET
  2. Compare the response `etag` against `this.storedEtag`

- **Case A: `pendingSync === true` and etags differ** (conflict — local has unsent changes and remote also changed):
  1. Do NOT overwrite local Yjs state
  2. Extract remote markdown from `response.files[filename].content`
  3. Send `conflict` to the owner: `{ type: "conflict", localMarkdown: this.lastCanonicalMarkdown, remoteMarkdown }`
  4. Broadcast `sync-status: { state: "conflict" }`
  5. Set `autosyncPaused = true`

- **Case B: `pendingSync === true` and etags match** (local has unsent changes, but remote hasn't changed):
  1. Immediately trigger `attemptGitHubSync()` to push pending changes

- **Case C: `pendingSync === false` and remote is newer** (etags differ):
  1. Extract remote markdown from `response.files[filename].content`
  2. Send `reload-remote` to the connecting client: `{ type: "reload-remote", markdown }`
  3. Client resets editor with this markdown as `defaultValue`, resulting Yjs updates flow back to DO
  4. Update stored `etag` and `updatedAt` from response

- **Case D: `pendingSync === false` and etags match** (everything is in sync):
  1. No action needed

- The staleness check should run asynchronously — don't block the WebSocket handshake. The Yjs sync proceeds with the cached snapshot, and the staleness check runs in parallel. If a reload is needed, the client will get the `reload-remote` message after initial sync.

- Only run the staleness check once per DO wake — use an instance flag `stalenessChecked: boolean = false` to avoid redundant checks on subsequent connections

**Files to Create/Modify**:

| File | Action | Details |
|---|---|---|
| `src/server/gist-room.ts` | Modify | Add `stalenessChecked` flag. Add `checkStaleness()` method. Call from `onConnect()` or equivalent connection handler |
| `src/server/github-client.ts` | Modify | Ensure `getGist()` returns `{ etag, content, updatedAt }` |
| `src/server/constants.ts` | Modify | Add `STALENESS_THRESHOLD_MS = 5 * 60 * 1000` |

**Verification**:

1. **Case C (remote newer, no pending)**: Create gist → save → edit on GitHub → wait >5 min → reconnect → verify `reload-remote` message received → editor shows remote content
2. **Case A (conflict with pending sync)**:
   - Create gist → save → disconnect owner → DO sets `pendingSync = true`
   - Edit gist on GitHub (changes remote etag)
   - Wait >5 min → reconnect owner
   - Verify `conflict` message received with both `localMarkdown` and `remoteMarkdown`
   - Verify autosync is paused
3. **Case B (pending sync, remote unchanged)**:
   - Create gist → save → disconnect owner → `pendingSync = true`
   - Wait >5 min → reconnect owner (do NOT edit on GitHub)
   - Verify immediate sync attempt (PATCH issued)
4. **Case D (in sync)**: Create gist → save → wait >5 min → reconnect → no messages, no action
5. **Staleness skip**: Connect a second client within the same DO wake → verify no second staleness check (flag prevents redundant checks)
6. **Fresh snapshot**: Connect within 5 min of last save → verify no staleness check runs at all

---

## Track Complete

### Overall Milestone

Create a document → edit in the app → changes auto-save to a real GitHub Gist within 30 seconds. Edit the Gist externally on github.com → DO detects conflict on next save attempt → clients receive conflict notification with both versions.

### Verification Checklist

| # | Scenario | Expected Outcome | How to Verify |
|---|---|---|---|
| 1 | Normal save flow | Content appears on GitHub, etag stored | Check `https://api.github.com/gists/<id>`, inspect DO SQLite |
| 2 | Multiple saves | Each PATCH uses previous response's etag | Observe sequential etag updates in DO logs |
| 3 | External edit → app save | 412 → conflict state, clients notified | Edit on GitHub, then edit in app, observe `conflict` message |
| 4 | GitHub 5xx | Backoff retries, clients see `error-retrying` | Stub 500 response, watch retry timing and client messages |
| 5 | Owner disconnect with dirty state | `pendingSync = true`, token cache cleared | Close owner tab, inspect SQLite, verify remaining clients get `pending-sync` status |
| 6 | Owner reconnect with pending sync | Immediate sync attempt | Reopen owner tab, observe PATCH in network/logs |
| 7 | Stale snapshot, no pending | `reload-remote` sent to client | Wait >5 min, reconnect, verify message and editor content |
| 8 | Stale snapshot with pending | Conflict state entered | Wait >5 min, edit on GitHub, reconnect, verify `conflict` message |
| 9 | Manual retry | Owner sends `manual-retry`, immediate PATCH attempt | Click retry button (or send message manually), observe PATCH |
| 10 | 429 with retry-after | Backoff respects `retry-after` header | Stub 429 with header, verify timing |
