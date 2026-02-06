# Track 2A — Real-time Collaboration

> **Goal**: Two browser tabs show real-time collaborative editing with cursors. Client handles the markdown serialization protocol.

---

## Prerequisites

| Phase 1 Track | What it provides | Must be complete? |
|---|---|---|
| **Track 1B — Milkdown Editor** | Working Milkdown editor with `getMarkdown()`, `defaultValue` loading, `plugin-listener`, and the read-only rendered view component | Yes |
| **Track 1C — GistRoom Durable Object** | `GistRoom` extending `YServer`, DO SQLite persistence, `onLoad()`/`onSave()` with Yjs snapshot storage, `request-markdown`/`canonical-markdown` protocol (DO side), `needs-init` message sending, hibernation, `initialized` flag enforcement, connection limits | Yes |

---

## Depends On / Produces

### Consumes (from other tracks)

| Contract | Source | How it's used here |
|---|---|---|
| Custom message protocol types | Track 1C (DO) | Client subscribes to and sends messages matching the protocol enum/payload shapes |
| Markdown serialization protocol | Track 1C (DO) | Client-side handler for `request-markdown` → `canonical-markdown` round-trip, `needs-init`, and `reload-remote` |
| DO SQLite schema | Track 1C | Client relies on DO persisting Yjs snapshots (reconnect restores state) and `lastCanonicalMarkdown` |
| Milkdown `getMarkdown()` | Track 1B | Used to serialize ProseMirror state to markdown for `canonical-markdown` responses |
| Milkdown `defaultValue` loading | Track 1B | Used to initialize editor content on `needs-init` and `reload-remote` |

### Produces (for downstream tracks)

| Contract | Consumers | Description |
|---|---|---|
| Wired `YProvider` instance | Track 3B (edit permissions — client-side token exchange connects WS), Track 4B (status UI subscribes to custom messages) | A configured, connected `YProvider` attached to the editor's `Y.Doc` |
| Custom message send/receive hooks | Track 4B (status UI), Track 4A (conflict resolution actions) | `provider.sendMessage()` and `provider.on("custom-message", ...)` wired and available to other components |
| Collab-enabled Milkdown editor | Track 3C (read-only views — routing decides editor vs. viewer) | The editor component with collaboration fully functional |

---

## Tasks

### Task 1: Wire YProvider to Milkdown Editor

**Description**: Create a React hook/component that instantiates a `YProvider` from `y-partyserver/provider`, connects it to the Milkdown editor's `Y.Doc`, and manages the provider lifecycle (connect on mount, disconnect on unmount).

**Implementation details**:

- Create a `useCollabProvider` hook (or similar) that:
  - Creates a `Y.Doc` instance
  - Instantiates `YProvider` with `{ host: window.location.host, party: "gist-room", room: gistId }`
  - Returns `{ doc, provider, awareness }` for use by the editor and other hooks
- The `YProvider` must connect to the path `/parties/gist-room/:gistId` — `routePartykitRequest` in the Worker handles the routing (wired in Phase 0)
- Provider lifecycle: connect when the editor mounts with a valid `gistId`, disconnect and destroy on unmount or when `gistId` changes
- Handle connection states: `connecting`, `connected`, `disconnected` — expose these for UI consumption (Track 4B will use them)
- The `Y.Doc` instance must be shared between the provider and the collab plugin (Task 2) — they must reference the same object

**Files to create/modify**:

- `src/hooks/useCollabProvider.ts` — new hook
- `src/components/Editor.tsx` — modify to accept `gistId` prop and use the hook

**Verification**:

1. Open the editor at `/:gist_id` in the browser
2. Open browser DevTools → Network → WS tab
3. Confirm a WebSocket connection is established to `/parties/gist-room/<gist_id>`
4. Confirm the connection stays open while the editor is mounted
5. Navigate away → confirm the WebSocket closes cleanly
6. Navigate back → confirm a new WebSocket opens
7. Check console for no errors related to provider or Y.Doc

---

### Task 2: Enable Collab Plugin

**Description**: Integrate `@milkdown/plugin-collab` into the Milkdown editor, binding `ySyncPlugin`, `yCursorPlugin`, and `yUndoPlugin` to the shared `Y.Doc` from Task 1.

**Implementation details**:

- Use `collabServiceCtx` from `@milkdown/plugin-collab` to access the `CollabService`
- The `CollabService.bindDoc()` method takes the `Y.Doc` instance from `useCollabProvider`
- Plugin setup order matters:
  1. Add `collab` plugin to Milkdown editor config
  2. After editor is ready (`editor.onStatusChange`), get the `CollabService` via `editor.ctx.get(collabServiceCtx)`
  3. Call `collabService.bindDoc(doc)` with the `Y.Doc` from the provider
  4. Call `collabService.connect()` to activate sync/cursor/undo plugins
- Replace the default undo/redo keybindings — `yUndoPlugin` replaces ProseMirror's built-in undo with Yjs-aware undo (`Y.UndoManager`)
- The editor should NOT set `defaultValue` when collab is active — the initial content comes from the Yjs document state synced via the provider. Exception: `needs-init` flow (Task 5)
- On unmount: call `collabService.disconnect()` before destroying the editor

**Files to create/modify**:

- `src/components/Editor.tsx` — add collab plugin, bind doc after editor ready
- Possibly `src/editor/plugins.ts` — if editor plugin config is factored out

**Verification**:

1. Open two browser tabs to the same `/:gist_id`
2. Type in Tab A → text appears in Tab B within ~100ms
3. Type in Tab B → text appears in Tab A
4. Both tabs show identical content at all times
5. Undo in Tab A only undoes Tab A's changes (Yjs-aware undo)
6. Formatting (bold, headings, lists) syncs correctly between tabs
7. Refresh Tab B → content is restored from DO SQLite snapshot (not lost)

---

### Task 3: Awareness (Collaborative Cursors)

**Description**: Configure Yjs Awareness to show collaborator cursors, selections, and display names derived from the JWT payload (GitHub profile).

**Implementation details**:

- `yCursorPlugin` (included via `@milkdown/plugin-collab`) renders remote cursors and selections automatically using Yjs Awareness
- Set local awareness state with user info from JWT:
  ```ts
  provider.awareness.setLocalStateField("user", {
    name: login,       // GitHub username from JWT
    color: "#...",     // Deterministic color from userId hash
    colorLight: "#..." // Lighter variant for selection background
  })
  ```
- User info (`login`, `userId`, `avatarUrl`) must come from the auth context — read from JWT cookie or auth state provided by the app shell (Track 1A/1B)
- For unauthenticated users viewing read-only (no collab plugin loaded), awareness is not relevant
- Generate deterministic cursor colors from `userId` so the same user always gets the same color across sessions. Use a small palette of distinguishable colors indexed by `hash(userId) % palette.length`
- Cursor labels should show the GitHub username (`login`)

**Files to create/modify**:

- `src/hooks/useCollabProvider.ts` — add awareness state setup
- `src/hooks/useAuth.ts` or `src/contexts/AuthContext.tsx` — consume user info (may already exist from Track 1A)
- `src/utils/cursorColors.ts` — new utility for deterministic color assignment

**Verification**:

1. Sign in as User A in Tab 1, User B in Tab 2 (or use two different browsers/profiles)
2. Both tabs connected to the same `/:gist_id`
3. Place cursor in Tab 1 → a labeled cursor with User A's GitHub username appears in Tab 2
4. Select text in Tab 2 → a colored selection highlight appears in Tab 1 with User B's label
5. Move cursor in Tab 1 → the remote cursor in Tab 2 updates in real-time
6. Close Tab 2 → User B's cursor disappears from Tab 1 within a few seconds
7. Reopen Tab 2 → User B's cursor reappears
8. Verify colors are consistent: same user always gets the same color

---

### Task 4: Custom Message Wiring

**Description**: Set up the client-side infrastructure for sending and receiving non-Yjs messages over the WebSocket via `YProvider`'s custom message API.

**Implementation details**:

- `YProvider` from `y-partyserver/provider` supports custom messages:
  - Send: `provider.sendMessage(type, payload)` — sends a non-Yjs message over the same WebSocket
  - Receive: `provider.on("custom-message", (event) => { ... })` — subscribe to incoming custom messages
- Create a `useCustomMessages` hook that:
  - Takes the `provider` from `useCollabProvider`
  - Exposes `sendMessage(type: string, payload: object)` — wraps `provider.sendMessage()`
  - Exposes `onMessage(type: string, handler: (payload) => void)` — filtered subscription for a specific message type
  - Handles cleanup (remove listeners on unmount)
- Define TypeScript types matching the shared contract message protocol:
  ```ts
  type CustomMessageType =
    | "request-markdown"
    | "canonical-markdown"
    | "needs-init"
    | "reload-remote"
    | "remote-changed"
    | "sync-status"
    | "error-retrying"
    | "conflict"
    | "push_local"
    | "discard_local";
  ```
- Payload types for each message (matching the shared contract table in `plan.md`):
  - `request-markdown`: `{ requestId: string }`
  - `canonical-markdown`: `{ requestId: string, markdown: string }`
  - `needs-init`: `{ gistId: string, filename: string }`
  - `reload-remote`: `{ markdown: string }`
  - `remote-changed`: `{ remoteMarkdown: string }`
  - `sync-status`: `{ state: "saved" | "saving" | "error-retrying" | "pending-sync" | "conflict", detail?: string }`
  - `error-retrying`: `{ attempt: number, nextRetryAt: string }`
  - `conflict`: `{ localMarkdown: string, remoteMarkdown: string }`
  - `push_local`: `{}`
  - `discard_local`: `{}`
- Message encoding: JSON-stringify the `{ type, payload }` envelope. Both DO and client must agree on the envelope format. Verify this matches what Track 1C's `onCustomMessage` expects.

**Files to create/modify**:

- `src/types/messages.ts` — new file with all message type definitions and payload interfaces
- `src/hooks/useCustomMessages.ts` — new hook for send/receive
- `src/hooks/useCollabProvider.ts` — expose `provider` reference for the custom messages hook

**Verification**:

1. Add a temporary test: on editor mount, send a test custom message via `provider.sendMessage()`
2. Check DO logs (via `wrangler tail` or console) — the message arrives at `onCustomMessage()`
3. Have the DO echo a test message back → verify the client `on("custom-message")` handler fires
4. Verify TypeScript compilation: all message types and payloads are correctly typed, no `any` types
5. Verify cleanup: navigate away from editor → confirm no lingering event listeners (check for memory leaks in DevTools)

---

### Task 5: Markdown Serialization Protocol (Client Side)

**Description**: Implement the client-side handlers for the three markdown serialization protocol messages: `request-markdown`, `needs-init`, and `reload-remote`. This is the critical protocol that allows the DO to persist canonical markdown without ever parsing or generating markdown itself.

**Implementation details**:

#### 5a: Handle `request-markdown`

- When the client receives a `request-markdown` message from the DO (containing `{ requestId }`):
  1. Check if this client should respond (deduplication — see below)
  2. Call `getMarkdown()` from `@milkdown/utils` to extract the current ProseMirror state as markdown
  3. Send a `canonical-markdown` message back: `{ requestId, markdown }`
- **Deduplication**: The DO sends `request-markdown` to one authorized client, but if multiple authorized clients are connected, only one should respond. Strategy:
  - The DO selects one client (server-side, in Track 1C). The `request-markdown` message is sent only to that specific connection, not broadcast. So the client that receives it always responds — no client-side deduplication logic needed.
  - However, as a safety measure, the client should track the last `requestId` it responded to and skip duplicates.
- `getMarkdown()` must be called synchronously after receiving the message (the DO has a 5-second timeout waiting for the response)

#### 5b: Handle `needs-init`

- When the client receives a `needs-init` message (containing `{ gistId, filename }`):
  1. Fetch the Gist content via the GitHub API: `GET https://api.github.com/gists/:gistId` (using the user's auth token from the session)
  2. Extract the content of the specified `filename` from the response
  3. Load the markdown into the Milkdown editor as `defaultValue` — this triggers ProseMirror to parse it via the remark pipeline, which produces Yjs updates that flow back to the DO naturally
  4. The DO will then persist these Yjs updates on the next `onSave()` cycle
- Edge case: if fetching fails (network error, 404, auth issue), show an error state in the editor and notify the user
- Only the first connecting authorized client receives `needs-init` (DO sends it once). If the client fails, the DO should be able to retry with the next connecting client (but that's a DO concern, not a client concern)

#### 5c: Handle `reload-remote`

- When the client receives a `reload-remote` message (containing `{ markdown }`):
  1. Reset the Milkdown editor content with the provided markdown as `defaultValue`
  2. This replaces the current ProseMirror/Yjs state entirely — the remark pipeline parses the markdown into ProseMirror nodes, which are applied as Yjs updates
  3. The resulting Yjs updates flow back to the DO, replacing its stored state
- This is triggered when the DO detects the remote Gist is newer than the local snapshot and there's no pending sync conflict
- The user should see a brief notification that the document was updated from GitHub

**Files to create/modify**:

- `src/hooks/useMarkdownProtocol.ts` — new hook that orchestrates all three handlers
- `src/components/Editor.tsx` — integrate the protocol hook, provide access to `getMarkdown()` and editor reset
- `src/api/github.ts` — utility function to fetch Gist content (for `needs-init`)
- `src/types/messages.ts` — ensure all payload types are defined (from Task 4)

**Verification**:

#### Verify `request-markdown`:

1. Open two tabs to the same `/:gist_id`
2. Type content in Tab A
3. Wait for the DO's `onSave()` debounce (30 seconds) to fire
4. Check DO logs: confirm `request-markdown` was sent to one client
5. Check DO logs: confirm `canonical-markdown` was received with the correct markdown string
6. Check DO SQLite (via `wrangler d1` or DO inspection): confirm `lastCanonicalMarkdown` is populated and matches the editor content

#### Verify `needs-init`:

1. Initialize a DO room via the API (Track 2B must be available, or mock it): set `initialized = true` with a valid `gistId` but no Yjs snapshot
2. Create a real GitHub Gist with some markdown content
3. Open the editor at `/:gist_id`
4. The client should receive `needs-init`, fetch the Gist content, and load it into the editor
5. Verify the editor displays the Gist's markdown content
6. Wait for `onSave()` → confirm the Yjs snapshot is now persisted in DO SQLite
7. Refresh the page → content loads from the snapshot (not from GitHub again)

#### Verify `reload-remote`:

1. Connect to a room that has existing content
2. Simulate a `reload-remote` message (either via a test DO method or by triggering the staleness check — Phase 3A concern, but can be tested with a mock)
3. Verify the editor content is replaced with the new markdown
4. Verify the Yjs state is updated (check that the other tab, if connected, also sees the new content)

---

## Track Complete

### Overall Milestone Verification

> Two browser tabs connected to the same GistRoom DO show real-time cursors and edits. Changes persist across page reloads via DO SQLite. Client responds to `request-markdown` and DO stores canonical markdown.

**End-to-end test procedure**:

1. Start `wrangler dev`
2. Open `http://localhost:8787/<test-gist-id>` in two browser tabs (the room must be initialized — either via Track 2B API or by manually setting `initialized = true` in the DO)
3. **Cursors**: Place cursor in Tab A → labeled cursor appears in Tab B with correct username and color. Select text in Tab B → selection highlight appears in Tab A.
4. **Real-time sync**: Type "Hello from Tab A" in Tab A → text appears in Tab B within ~100ms. Type "Hello from Tab B" in Tab B → text appears in Tab A. Apply formatting (bold, heading) → formatting syncs.
5. **Persistence**: Wait 30+ seconds for `onSave()` to fire. Refresh Tab B → content is restored from DO SQLite. Close both tabs. Reopen one tab → content is restored.
6. **Canonical markdown**: After `onSave()` fires, check DO storage → `lastCanonicalMarkdown` contains a valid markdown representation of the editor content.
7. **Undo isolation**: In Tab A, type "AAA". In Tab B, type "BBB". Undo in Tab A → only "AAA" is removed; "BBB" remains.
8. **Provider cleanup**: Navigate away from the editor → WebSocket closes. No console errors. Navigate back → new WebSocket opens, content syncs.

**What is NOT verified in this track** (deferred to later phases):

- GitHub Gist sync (Phase 3A)
- Edit permissions / read-only enforcement (Phase 3B)
- Sync status UI (Phase 4B)
- Conflict resolution UI (Phase 4A/4B)
