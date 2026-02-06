# Phase 4A — Staleness & Conflict Resolution

> **Goal**: Owner can resolve conflicts between local and remote state. The DO handles conflict resolution actions, force-pushes or discards local state, and manages pending sync lifecycle with durability guarantees.

---

## Prerequisites

- **Phase 3A (GitHub Sync)** is complete: `onSave()` PATCHes GitHub with `If-Match: <etag>`, 412 handling pauses autosync, `remote-changed` custom message is sent to clients, `pendingSync` / `pendingSince` are tracked in DO SQLite.
- **Phase 2A (Collab)** is complete: `request-markdown` / `canonical-markdown` protocol is wired, `provider.sendMessage()` and `provider.on("custom-message", ...)` are functional.
- **Custom message protocol** types `push_local`, `discard_local`, `reload-remote`, `conflict`, `sync-status`, and `request-markdown` are defined in the shared protocol.
- **DO SQLite schema** includes: `etag`, `lastCanonicalMarkdown`, `pendingSync`, `pendingSince`, `ownerUserId`, `initialized`.

## Depends On / Produces

| Depends On | What It Provides |
|---|---|
| Phase 3A — GitHub Sync | 412 detection, `remote-changed` broadcast, `pendingSync` flag, etag tracking |
| Phase 2A — Collab | `request-markdown` / `canonical-markdown` client protocol, `reload-remote` handling |
| Phase 1C — GistRoom DO | `onCustomMessage()` hook, `isReadOnly()`, DO SQLite storage, owner connection tracking |

| Produces | Consumed By |
|---|---|
| `push_local` / `discard_local` message handling | Phase 4B (Conflict resolution modal triggers these) |
| `sync-status` state transitions (`conflict` → `saving` → `saved`) | Phase 4B (Status bar, conflict modal) |
| Pending sync expiry logic | Phase 4B (Pending sync banner with expiry date) |
| Reconnect-triggered sync attempt | Phase 4B (Status bar shows transition on reconnect) |

---

## Tasks

### Task 1: `onCustomMessage()` Conflict Resolution Handler

**Description**: Extend the existing `onCustomMessage()` handler in `GistRoom` to accept `push_local` and `discard_local` action messages from the owner. All action messages must be restricted to the owner connection — reject with an error if the sender is not the owner.

**Implementation Details**:

- In `GistRoom.onCustomMessage(connection, message)`, parse the incoming message and match on `type`:
  - `push_local`: Validate sender is the owner (compare `connection` user identity against stored `ownerUserId`). If not owner, send an error custom message back and return.
  - `discard_local`: Same owner validation.
- Owner identification: Extract `userId` from the JWT in the connection's cookie (the JWT verification module from Phase 1A). Compare against `ownerUserId` stored in DO SQLite.
- If the DO is not in a conflict state (i.e., autosync is not paused due to 412), reject the action with a `{ type: "error", detail: "no-conflict" }` message.
- Track conflict state with an in-memory flag `this.conflictState: { paused: boolean, remoteMarkdown: string | null }`. This flag is set by the 412 handler in Phase 3A and cleared by resolution actions.

**Files to Create/Modify**:

- `src/server/gist-room.ts` — Extend `onCustomMessage()` with `push_local` and `discard_local` cases, add owner validation helper, add conflict state tracking.

**Verification**:

- [ ] Send a `push_local` message from a non-owner connection → receive an error response, no state change.
- [ ] Send a `push_local` message when no conflict exists → receive a `{ type: "error", detail: "no-conflict" }` response.
- [ ] Send a `push_local` message from owner connection while in conflict state → handler is invoked (Task 2 covers the actual logic).
- [ ] Send a `discard_local` message from owner connection while in conflict state → handler is invoked (Task 3 covers the actual logic).

---

### Task 2: Push Local to Remote

**Description**: When the owner chooses "Push local to remote", the DO requests the current canonical markdown from the client, force-patches GitHub (without `If-Match` to overwrite unconditionally), updates the stored etag, resumes autosync, and broadcasts success to all clients.

**Implementation Details**:

1. On receiving `push_local` (validated in Task 1):
   - Send `request-markdown` custom message to the owner's connection (with a unique `requestId`).
   - Wait for the `canonical-markdown` response (reuse the existing timeout logic from `onSave()` — 5 second timeout). If timeout, send `{ type: "error", detail: "markdown-request-timeout" }` and remain in conflict state.
2. On receiving `canonical-markdown` with matching `requestId`:
   - Read the owner's GitHub token from KV (or in-memory cache).
   - Call `PATCH /gists/:id` with the markdown content. **Do not send `If-Match` header** — this is an unconditional overwrite.
   - On success (200): Extract `etag` from response headers. Store new `etag` and `updated_at` in DO SQLite. Store the markdown as `lastCanonicalMarkdown`. Set `pendingSync = false`, clear `pendingSince`.
   - On failure (403/429/5xx): Send `error-retrying` message, enter error state with backoff. Do not clear conflict state.
3. Clear `this.conflictState` — set `paused = false`, `remoteMarkdown = null`.
4. Resume autosync (re-enable the `onSave()` → GitHub PATCH pipeline).
5. Broadcast `{ type: "sync-status", state: "saved" }` to all connected clients.

**Files to Create/Modify**:

- `src/server/gist-room.ts` — Add `handlePushLocal()` method. Modify the `canonical-markdown` handler to check if a push-local request is pending. Add `forcePatchGist()` helper (like existing `patchGist()` but without `If-Match`).
- `src/server/github-api.ts` — Add an optional `skipEtagCheck` parameter to the PATCH function, or create a separate `forcePatchGist()` function.

**Verification**:

- [ ] Trigger a 412 conflict (edit Gist externally, then save from DO) → send `push_local` from owner → verify GitHub Gist content matches local editor content (fetch via GitHub API and compare).
- [ ] After push: verify `pendingSync` is `false` in DO SQLite.
- [ ] After push: verify the stored `etag` matches the one returned by the force PATCH.
- [ ] After push: subsequent edits auto-save to GitHub normally (autosync resumed).
- [ ] All connected clients receive `{ type: "sync-status", state: "saved" }` after successful push.

---

### Task 3: Discard Local, Reload Remote

**Description**: When the owner chooses "Discard local, reload remote", the DO fetches fresh markdown from GitHub, sends it to connected clients as a `reload-remote` message, and the clients reset their editors. The Yjs updates from the editor reset flow back to the DO, replacing the local state.

**Implementation Details**:

1. On receiving `discard_local` (validated in Task 1):
   - Fetch the current Gist content from GitHub API: `GET /gists/:id` → extract the markdown content from the response for the tracked filename.
   - Extract the new `etag` from response headers.
2. Send `{ type: "reload-remote", markdown }` custom message to **all** connected clients (not just the owner — all editors and viewers need the updated content).
3. Client-side (already wired in Phase 2A): On receiving `reload-remote`, the client resets the editor by setting the markdown as `defaultValue`. This triggers Yjs updates that flow back to the DO via the sync protocol.
4. Update DO SQLite: Store new `etag`, `updated_at`, set `pendingSync = false`, clear `pendingSince`. Store the fetched markdown as `lastCanonicalMarkdown`.
5. Clear `this.conflictState`.
6. Resume autosync.
7. Broadcast `{ type: "sync-status", state: "saved" }` to all connected clients.
8. If the GitHub fetch fails (network error, 403, etc.): Send `{ type: "error", detail: "remote-fetch-failed" }` to the owner. Remain in conflict state.

**Files to Create/Modify**:

- `src/server/gist-room.ts` — Add `handleDiscardLocal()` method. Add `fetchGistContent()` helper (may already exist from Phase 3A staleness detection — reuse it).
- `src/server/github-api.ts` — Ensure `fetchGistContent()` returns both the markdown string and the etag.

**Verification**:

- [ ] Trigger a 412 conflict → send `discard_local` from owner → verify editor content matches the remote GitHub Gist content.
- [ ] After discard: verify `pendingSync` is `false` in DO SQLite.
- [ ] After discard: verify `lastCanonicalMarkdown` in DO SQLite matches the remote content.
- [ ] After discard: verify the stored `etag` matches the freshly fetched one.
- [ ] After discard: subsequent edits auto-save to GitHub normally (autosync resumed).
- [ ] All connected clients (including non-owner editors) receive `reload-remote` and update their editors.
- [ ] If GitHub fetch fails during discard: conflict state persists, owner receives error message.

---

### Task 4: Pending Sync Durability (30-Day Expiry)

**Description**: Unsynced state is retained for 30 days. After expiry, the unsynced Yjs snapshot is discarded and the room re-initializes from GitHub on next load.

**Implementation Details**:

1. **Expiry check on `onLoad()`**: When the DO wakes and loads state from SQLite, check if `pendingSync` is `true` and `pendingSince` is older than 30 days:
   - If expired: Clear the Yjs snapshot from DO SQLite. Set `pendingSync = false`, clear `pendingSince`. Set `lastCanonicalMarkdown = null`. The room remains `initialized` — on next client connect, `onLoad()` will find no snapshot and send `needs-init`, triggering a fresh fetch from GitHub.
   - If not expired: Proceed normally (load snapshot, enter pending sync state).
2. **Expiry check on periodic alarm** (optional, defense-in-depth): Set a Durable Object alarm for `pendingSince + 30 days`. When the alarm fires, perform the same expiry cleanup. This handles the case where no client connects during the 30-day window.
   - Use `this.ctx.storage.setAlarm()` to schedule the cleanup.
   - In `alarm()` handler: Check `pendingSync` and `pendingSince`, perform cleanup if expired.
3. **Expose expiry info in `sync-status` messages**: When `pendingSync` is true, include `pendingSince` and `expiresAt` (computed as `pendingSince + 30 days`) in `sync-status` payloads so the UI can display the expiry date.

**Files to Create/Modify**:

- `src/server/gist-room.ts` — Add expiry check in `onLoad()`. Add `alarm()` handler. Modify `pendingSync` setter to schedule/cancel alarms. Extend `sync-status` message payload.
- `src/server/constants.ts` — Add `PENDING_SYNC_TTL_MS = 30 * 24 * 60 * 60 * 1000` constant.

**Verification**:

- [ ] Set `pendingSince` to 31 days ago in DO SQLite (via test helper or direct SQL) → trigger `onLoad()` → verify Yjs snapshot is cleared, `pendingSync` is `false`, `lastCanonicalMarkdown` is `null`.
- [ ] Set `pendingSince` to 29 days ago → trigger `onLoad()` → verify snapshot is preserved, `pendingSync` remains `true`.
- [ ] After expiry cleanup: connect a client → verify `needs-init` is sent (room re-fetches from GitHub).
- [ ] Verify `sync-status` messages include `pendingSince` and `expiresAt` when `pendingSync` is `true`.
- [ ] Verify alarm is scheduled when `pendingSync` is set to `true`, and cancelled when `pendingSync` is set to `false`.

---

### Task 5: Pending Sync on Owner Reconnect

**Description**: When the owner reconnects to a room with `pendingSync = true`, the DO immediately attempts to sync to GitHub. If a conflict is detected (etag mismatch / 412), the DO enters conflict state rather than silently overwriting.

**Implementation Details**:

1. **Detect owner reconnect**: In the connection handler (e.g., `onConnect()` or the first message after WebSocket upgrade), check if the connecting user is the owner (`userId === ownerUserId`).
2. **If `pendingSync` is true**:
   - Read the owner's GitHub token from KV.
   - Send `request-markdown` to the owner's connection to get current canonical markdown.
   - On receiving `canonical-markdown`: Attempt `PATCH /gists/:id` with `If-Match: <stored_etag>`.
   - **If 200 (success)**: Sync succeeded. Update `etag`, set `pendingSync = false`, clear `pendingSince`. Broadcast `{ type: "sync-status", state: "saved" }`. Cancel any pending expiry alarm.
   - **If 412 (conflict)**: Remote was modified while owner was offline. Fetch remote markdown. Enter conflict state: set `this.conflictState = { paused: true, remoteMarkdown }`. Send `{ type: "conflict", localMarkdown: <from canonical-markdown response>, remoteMarkdown }` to the owner. Broadcast `{ type: "sync-status", state: "conflict" }` to all clients.
   - **If 403/429/5xx**: Enter error state with backoff. Send `error-retrying` to owner.
3. **If `pendingSync` is false**: No special action. Normal `onLoad()` staleness check (from Phase 3A) handles the case where the remote has changed while no local edits were pending.
4. **Timing**: The reconnect sync should happen after the Yjs sync handshake completes (so the client has the full document state before `getMarkdown()` is called). Add a short delay (e.g., 1-2 seconds) or wait for the Yjs sync to complete before sending `request-markdown`.

**Files to Create/Modify**:

- `src/server/gist-room.ts` — Add reconnect sync logic in the connection handler. Add a method `attemptPendingSync(connection)` that orchestrates the flow. Coordinate with existing `onLoad()` staleness check to avoid duplicate validation.

**Verification**:

- [ ] Owner edits → disconnects → reconnects → verify sync attempt fires automatically.
- [ ] Owner edits → disconnects → Gist is NOT edited externally → owner reconnects → verify `pendingSync` clears, content is saved to GitHub.
- [ ] Owner edits → disconnects → Gist IS edited externally → owner reconnects → verify conflict state is entered, owner receives `conflict` message with both local and remote markdown.
- [ ] After conflict on reconnect: owner can use `push_local` or `discard_local` to resolve (Tasks 2/3).
- [ ] Verify `request-markdown` is sent only after Yjs sync handshake completes (editor has full doc state).
- [ ] Verify GitHub API errors during reconnect sync result in error state with backoff, not a crash.

---

## Track Complete

### Milestone Verification

> Edit Gist externally → DO detects conflict → owner sees resolution options → chooses push or discard → state resolves cleanly.

**End-to-end test sequence**:

1. Create a document, make edits, verify auto-save to GitHub works.
2. Edit the Gist directly on github.com (changing the markdown content).
3. Make another edit in gist.party → DO attempts `PATCH` with `If-Match` → receives 412.
4. Verify DO enters conflict state: `sync-status` broadcasts `conflict`, owner receives `conflict` message with both local and remote markdown.
5. **Test push**: Owner sends `push_local` → verify GitHub Gist now matches local content → verify `pendingSync` is `false` → verify subsequent edits auto-save normally.
6. Repeat steps 2-4 to re-enter conflict.
7. **Test discard**: Owner sends `discard_local` → verify editor content resets to remote markdown → verify `pendingSync` is `false` → verify subsequent edits auto-save normally.
8. **Test pending sync lifecycle**: Owner edits → disconnects → verify `pendingSync` is `true` → reconnects → verify sync attempt → verify resolution.
9. **Test expiry**: Set `pendingSince` to 31 days ago → verify snapshot is cleaned up → verify room re-initializes from GitHub on next connect.

All 9 steps must pass. Non-owner connections must be rejected for all conflict resolution actions.
