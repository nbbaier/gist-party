# Phase 4B — Sync Status UI

> **Goal**: Users always know the current sync state of their document. Owners can resolve conflicts through a modal with diff preview, export pending content, and manually retry failed syncs.

---

## Prerequisites

- **Phase 3A (GitHub Sync)** is complete: DO emits `sync-status`, `error-retrying`, `remote-changed`, and `conflict` custom messages over the WebSocket.
- **Phase 4A (Conflict Resolution)** is complete (or in parallel): DO handles `push_local` and `discard_local` action messages. The UI sends these; the DO processes them.
- **Phase 2A (Collab)** is complete: `YProvider` is wired, `provider.on("custom-message", ...)` is functional, `provider.sendMessage()` works.
- **Phase 1B (Editor)** is complete: Milkdown editor renders, `getMarkdown()` from `@milkdown/utils` extracts markdown.
- **Sync status state machine** (defined in shared contracts): States — `saved`, `saving`, `error-retrying`, `pending-sync`, `conflict`. Transitions triggered by DO events.

## Depends On / Produces

| Depends On | What It Provides |
|---|---|
| Phase 3A — GitHub Sync | `sync-status`, `error-retrying`, `remote-changed`, `conflict` custom messages |
| Phase 4A — Conflict Resolution | `push_local` / `discard_local` DO handlers; `sync-status` transitions after resolution |
| Phase 2A — Collab | `YProvider` custom message subscription, `provider.sendMessage()` |
| Phase 1B — Editor | `getMarkdown()` for local markdown in diff preview |

| Produces | Consumed By |
|---|---|
| Complete sync status UI | Phase 6 (End-to-end validation) |
| Conflict resolution modal (sends `push_local` / `discard_local`) | Phase 4A (DO processes these actions) |
| `beforeunload` warning | Browser-native, no downstream dependency |

---

## Tasks

### Task 1: Sync Status Bar Component

**Description**: A reactive status bar component that displays the current sync state. Driven by the sync status state machine — transitions are triggered by custom messages from the DO.

**Implementation Details**:

1. **State machine (client-side)**: Create a `useSyncStatus()` React hook that manages the current sync state. States:
   - `saved` — "Saved" (with a subtle checkmark icon or green dot)
   - `saving` — "Saving..." (with a spinner or pulsing dot)
   - `pending-sync` — "Pending sync (owner offline)" (amber indicator). Includes `pendingSince` and `expiresAt` from the message payload.
   - `conflict` — "Remote changed" (red indicator). Stores `localMarkdown` and `remoteMarkdown` from the `conflict` message payload.
   - `error-retrying` — "Error (retrying...)" (red indicator). Includes `attempt` count and `nextRetryAt` from the message payload.
2. **Custom message listener**: Inside the hook, subscribe to `provider.on("custom-message", ...)`. Parse the message and transition state:
   - `{ type: "sync-status", state: "saved" }` → `saved`
   - `{ type: "sync-status", state: "saving" }` → `saving`
   - `{ type: "sync-status", state: "pending-sync", pendingSince, expiresAt }` → `pending-sync`
   - `{ type: "sync-status", state: "conflict" }` → `conflict` (the actual conflict data comes via the `conflict` message type)
   - `{ type: "conflict", localMarkdown, remoteMarkdown }` → `conflict` (store both markdown strings)
   - `{ type: "error-retrying", attempt, nextRetryAt }` → `error-retrying`
3. **Status bar component**: Render at the bottom of the editor or in the header bar. Display:
   - State label text
   - State-appropriate icon/color
   - Relative timestamp for `saving` ("Saved 2 seconds ago" after transition to `saved`)
4. **Cleanup**: Unsubscribe from custom messages on unmount.

**Files to Create/Modify**:

- `src/client/hooks/use-sync-status.ts` — New file. The `useSyncStatus(provider)` hook. Takes the `YProvider` instance as argument. Returns `{ state, pendingSince, expiresAt, conflictData, errorData }`.
- `src/client/components/sync-status-bar.tsx` — New file. Renders the status indicator. Accepts the sync status hook return value as props (or calls the hook internally).
- `src/client/components/editor-layout.tsx` (or equivalent) — Mount `<SyncStatusBar />` in the editor view.

**Verification**:

- [ ] When DO broadcasts `sync-status: saved` → status bar shows "Saved" with green indicator.
- [ ] When DO broadcasts `sync-status: saving` → status bar shows "Saving..." with spinner.
- [ ] When DO broadcasts `sync-status: pending-sync` → status bar shows "Pending sync (owner offline)" with amber indicator.
- [ ] When DO broadcasts `conflict` → status bar shows "Remote changed" with red indicator.
- [ ] When DO broadcasts `error-retrying` → status bar shows "Error (retrying...)" with retry count.
- [ ] Status bar updates reactively without page reload.
- [ ] On unmount, custom message listener is cleaned up (no memory leak).

---

### Task 2: Pending Sync Banner

**Description**: A persistent, non-dismissable banner displayed when `pendingSync` is true. Shows the expiry date and includes a one-click markdown export button.

**Implementation Details**:

1. **Banner component**: Rendered above the editor when `state === "pending-sync"`. Not dismissable — it stays until sync completes or expires.
   - Display: "Changes are pending sync. Owner must reconnect before [expiry date] or changes will be lost."
   - Show `expiresAt` as a human-readable date (e.g., "March 7, 2026").
   - Show relative time remaining (e.g., "23 days remaining").
2. **Export button**: "Download .md" button in the banner.
   - On click: Call `getMarkdown()` from the Milkdown editor to get the current document content.
   - Create a Blob with `type: "text/markdown"`, generate a download URL via `URL.createObjectURL()`, trigger download with a dynamically created `<a>` element.
   - Filename: `{gistId}.md` or the stored filename if available.
3. **Conditional rendering**: Only show when `useSyncStatus()` returns `state === "pending-sync"`. The banner should render for all users (not just the owner) since all collaborators need to know the sync state.

**Files to Create/Modify**:

- `src/client/components/pending-sync-banner.tsx` — New file. The banner component. Props: `{ expiresAt: string, onExport: () => void }`.
- `src/client/hooks/use-markdown-export.ts` — New file. A `useMarkdownExport(editorRef)` hook that returns an `exportMarkdown()` function. Uses `getMarkdown()` + Blob download.
- `src/client/components/editor-layout.tsx` — Mount `<PendingSyncBanner />` conditionally based on sync status.

**Verification**:

- [ ] When `pendingSync` is true: banner is visible above the editor with expiry date.
- [ ] Expiry date is calculated correctly as `pendingSince + 30 days`.
- [ ] Click "Download .md" → browser downloads a `.md` file containing the current editor content.
- [ ] Downloaded file content matches `getMarkdown()` output exactly.
- [ ] Banner disappears when sync completes (status transitions to `saved`).
- [ ] Banner is visible to all connected users, not just the owner.
- [ ] Banner is not dismissable (no close button).

---

### Task 3: Conflict Resolution Modal (Owner Only)

**Description**: A modal dialog with two resolution options and a side-by-side markdown diff preview. Only the owner sees the modal; other users see the "Remote changed" status but cannot take action.

**Implementation Details**:

1. **Modal trigger**: When `useSyncStatus()` returns `state === "conflict"`, render the modal for the owner only. Determine owner status from the auth context (compare `userId` from JWT with `ownerUserId` from gist metadata, available via `GET /api/gists/:gist_id` or passed through provider connection metadata).
2. **Diff preview**:
   - Local content: Call `getMarkdown()` from the Milkdown editor.
   - Remote content: From `conflictData.remoteMarkdown` (received in the `conflict` custom message).
   - Render a unified or side-by-side diff. Use a lightweight diff library — check if one is already in the dependency tree. If not, use `diff` (npm package) to compute the diff and render it as styled HTML. Alternatively, render both versions in scrollable panes with line-by-line highlighting.
   - The diff should be readable but does not need to be a full-featured diff editor. Simple line-level diff with additions (green) and deletions (red) is sufficient.
3. **Action buttons**:
   - "Push local to remote" → sends `{ type: "push_local" }` via `provider.sendMessage()`.
   - "Discard local, reload remote" → sends `{ type: "discard_local" }` via `provider.sendMessage()`.
   - Both buttons should show a loading state after click until the DO responds with a `sync-status` transition.
4. **Non-owner behavior**: Non-owner users in conflict state see the status bar indicator ("Remote changed") but do NOT see the modal. They cannot resolve conflicts.
5. **Modal UX**:
   - Modal is not dismissable without choosing an action (no backdrop click dismiss, no X button). The conflict must be resolved.
   - Clear, unambiguous labels. "Push local" should be clearly described as overwriting the remote. "Discard local" should warn that local changes will be lost.
   - Show a brief description of what each action does above the buttons.

**Files to Create/Modify**:

- `src/client/components/conflict-modal.tsx` — New file. The modal component. Props: `{ localMarkdown: string, remoteMarkdown: string, onPushLocal: () => void, onDiscardLocal: () => void }`.
- `src/client/components/markdown-diff.tsx` — New file. A diff renderer. Takes two markdown strings, computes and renders the diff.
- `src/client/hooks/use-sync-status.ts` — Extend to expose `conflictData` and a `sendResolution(action)` method.
- `src/client/components/editor-layout.tsx` — Mount `<ConflictModal />` conditionally for owner when in conflict state.
- `package.json` — Add `diff` package if not already present (verify first).

**Verification**:

- [ ] Trigger 412 conflict → owner sees modal with diff preview showing local vs remote content.
- [ ] Diff correctly highlights added and removed lines between local and remote markdown.
- [ ] Click "Push local to remote" → `push_local` message is sent → modal closes on `sync-status: saved` → status bar shows "Saved".
- [ ] Click "Discard local, reload remote" → `discard_local` message is sent → modal closes on `sync-status: saved` → editor content updates to remote version.
- [ ] Non-owner user in the same room during conflict: sees "Remote changed" in status bar, does NOT see the modal.
- [ ] Modal cannot be dismissed without choosing an action (no escape key, no backdrop click).
- [ ] Both buttons show loading state between click and resolution.

---

### Task 4: Manual Retry Button

**Description**: When in error state (`error-retrying`), the owner can trigger a manual sync retry instead of waiting for the exponential backoff timer.

**Implementation Details**:

1. **Retry button**: Render in the status bar (or as an inline action next to the error message) when `state === "error-retrying"` and the user is the owner.
   - Label: "Retry now"
   - Show current attempt count and next automatic retry time: "Attempt 3 — next retry in 45s — [Retry now]"
2. **Retry action**: On click, send `{ type: "manual-retry" }` via `provider.sendMessage()`.
   - The DO should handle this in `onCustomMessage()`: reset the backoff timer, immediately attempt the GitHub PATCH. (This requires a small addition to the Phase 3A error handling — add a `manual-retry` message type to the protocol.)
   - Show loading state on the button until the DO responds with either `sync-status: saved` or another `error-retrying`.
3. **Non-owner behavior**: Non-owner users see the error status but do NOT see the retry button. They cannot trigger retries.

**Files to Create/Modify**:

- `src/client/components/sync-status-bar.tsx` — Add retry button rendering when in error state and user is owner.
- `src/server/gist-room.ts` — Add `manual-retry` case in `onCustomMessage()`. Reset backoff, call the existing sync method.
- Update custom message protocol types to include `manual-retry` (client → DO).

**Verification**:

- [ ] Simulate GitHub API 5xx → status bar shows "Error (retrying...)" with attempt count and next retry time.
- [ ] Owner clicks "Retry now" → DO immediately attempts sync → on success, status shows "Saved".
- [ ] Owner clicks "Retry now" → sync fails again → status shows updated attempt count, backoff timer resets.
- [ ] Non-owner user sees error status but NOT the retry button.
- [ ] Retry button shows loading state during the sync attempt.

---

### Task 5: Warn on Exit (`beforeunload`)

**Description**: If `pendingSync` is true, show a browser-native `beforeunload` warning when the user tries to navigate away or close the tab.

**Implementation Details**:

1. **`useWarnOnExit()` hook**: Create a hook that registers a `beforeunload` event listener when `pendingSync` is true and removes it when `pendingSync` is false.
   - Use `event.preventDefault()` and set `event.returnValue = ""` (the browser shows its own generic message — custom messages are ignored by modern browsers).
2. **Integration**: Call `useWarnOnExit(syncStatus.state === "pending-sync")` in the editor layout component.
3. **Also warn in conflict state**: Extend to also warn when `state === "conflict"`, since leaving during a conflict means unresolved changes.
4. **Cleanup**: Remove the event listener on unmount and when the state transitions away from `pending-sync` / `conflict`.

**Files to Create/Modify**:

- `src/client/hooks/use-warn-on-exit.ts` — New file. `useWarnOnExit(shouldWarn: boolean)` hook.
- `src/client/components/editor-layout.tsx` — Call the hook with the appropriate condition.

**Verification**:

- [ ] With `pendingSync` true: attempt to close the tab → browser shows "Leave site?" confirmation dialog.
- [ ] With `state === "conflict"`: attempt to close the tab → browser shows confirmation dialog.
- [ ] With `state === "saved"`: close the tab → no confirmation dialog.
- [ ] Navigate away within the SPA while `pendingSync` is true → warning fires (if using client-side routing with `beforeunload`; note: `beforeunload` only fires on tab close/hard navigation, not SPA transitions. If SPA route transitions should also warn, add a React Router `useBlocker()` / `usePrompt()` equivalent).
- [ ] After sync completes (transition to `saved`): close the tab → no confirmation dialog (listener removed).

---

### Task 6: Custom Message Wiring

**Description**: Subscribe to all relevant custom messages from the `YProvider` and route them to the appropriate UI state handlers. This is the glue between the DO's messages and the client-side state machine.

**Implementation Details**:

1. **Central message dispatcher**: Inside `useSyncStatus()`, the `provider.on("custom-message", callback)` listener should parse each incoming message and dispatch to the correct state transition:

   | Message Type | Action |
   |---|---|
   | `sync-status` | Update state to `message.state`. Store `pendingSince` and `expiresAt` if `pending-sync`. |
   | `conflict` | Set state to `conflict`. Store `localMarkdown` and `remoteMarkdown` in `conflictData`. |
   | `error-retrying` | Set state to `error-retrying`. Store `attempt` and `nextRetryAt` in `errorData`. |
   | `reload-remote` | State transitions to `saved` after the editor resets (handled by the collab layer). No direct state action here — wait for the subsequent `sync-status: saved`. |
   | `remote-changed` | Treated as a precursor to `conflict` — the `conflict` message follows with full data. |

2. **Message parsing**: All custom messages are JSON-encoded. Parse with `JSON.parse()`, validate the `type` field, and extract payload fields. Log and ignore unknown message types (forward compatibility).
3. **Provider lifecycle**: The `useSyncStatus()` hook should handle provider reconnection — re-subscribe to custom messages if the provider disconnects and reconnects. Use the provider's connection status events if available, or re-attach the listener on provider state changes.
4. **Outbound messages**: The hook should expose `sendResolution(action: "push_local" | "discard_local")` and `sendRetry()` methods that call `provider.sendMessage(JSON.stringify({ type: action }))`.
5. **Type definitions**: Define TypeScript types for all custom message payloads.

**Files to Create/Modify**:

- `src/shared/message-types.ts` — New file. TypeScript type definitions for all custom message payloads (inbound and outbound). Shared between client and server.
- `src/client/hooks/use-sync-status.ts` — Extend with the full message dispatcher, outbound action methods, and provider lifecycle handling.

**Verification**:

- [ ] DO sends `sync-status: saving` → `useSyncStatus()` returns `{ state: "saving" }`.
- [ ] DO sends `conflict` with markdown payloads → `useSyncStatus()` returns `{ state: "conflict", conflictData: { localMarkdown, remoteMarkdown } }`.
- [ ] DO sends `error-retrying` → `useSyncStatus()` returns `{ state: "error-retrying", errorData: { attempt, nextRetryAt } }`.
- [ ] Call `sendResolution("push_local")` → verify `provider.sendMessage()` is called with correct JSON payload.
- [ ] Call `sendRetry()` → verify `provider.sendMessage()` is called with `{ type: "manual-retry" }`.
- [ ] Provider disconnects and reconnects → custom message listener is re-attached, state continues to update.
- [ ] Unknown message types are silently ignored (no crash, logged to console in dev).
- [ ] All message payloads match the TypeScript type definitions in `message-types.ts`.

---

## Track Complete

### Milestone Verification

> Full sync status lifecycle visible in UI. Conflict modal works end-to-end with diff preview. Pending sync banner shows with export.

**End-to-end test sequence**:

1. **Saved state**: Create a document, make edits → status bar shows "Saving..." → then "Saved". Verify transition timing.
2. **Conflict flow**: Edit Gist on github.com → make an edit in gist.party → DO detects 412 → status bar shows "Remote changed" → owner sees conflict modal with diff → choose "Push local" → modal closes, status shows "Saved" → verify GitHub Gist content matches local.
3. **Conflict discard flow**: Repeat conflict setup → choose "Discard local" → editor resets to remote content → status shows "Saved" → verify editor content matches GitHub.
4. **Pending sync flow**: Owner edits → disconnects → status shows "Pending sync (owner offline)" → banner shows with expiry date → click "Download .md" → verify downloaded file matches editor content → owner reconnects → sync completes → banner disappears, status shows "Saved".
5. **Error retry flow**: Simulate GitHub API failure → status shows "Error (retrying...)" with attempt count → owner clicks "Retry now" → sync reattempts → on success, status shows "Saved".
6. **Warn on exit**: With `pendingSync` true, attempt to close tab → browser shows confirmation. After sync completes, close tab → no confirmation.
7. **Non-owner view**: Non-owner collaborator sees status bar transitions but does NOT see conflict modal or retry button.

All 7 sequences must pass. The sync status state machine states (`saved` → `saving` → `saved` / `error-retrying` / `pending-sync` / `conflict`) must all be reachable and visually distinct.
