# Track 1C — GistRoom Durable Object

> **Goal**: A Durable Object that syncs a Yjs document across WebSocket connections, persists snapshots to SQLite, and requests canonical markdown from connected clients. No GitHub sync yet. The DO never parses or generates markdown.

## Prerequisites

- Phase 0 complete: `partyserver` and `y-partyserver` configured, `wrangler.toml` has the DO binding for `GistRoom`, `routePartykitRequest` is wired in the Worker, `wrangler dev` starts and accepts WebSocket upgrades to `/parties/gist-room/:id`
- Yjs installed (`yjs` package)

## Depends On / Produces

| Contract | Role | Notes |
|---|---|---|
| JWT sign/verify module | **Consumes** | Used in `onConnect` to verify the session cookie on incoming WebSocket connections. Until Track 1A delivers this module, stub with a no-op verifier that always returns a test user. |
| Token encryption module | **Consumes** (later) | Used in Phase 3A to decrypt the owner's GitHub token from KV. Not needed in this track. |
| DO SQLite schema | **Produces** | Defines and creates the schema. Consumed by Track 2B (API routes write `initialized`, `ownerUserId`, etc.) and Track 3A/B. |
| Custom message protocol | **Produces** | Implements `request-markdown`, `canonical-markdown`, `needs-init` message types. Consumed by Track 2A (client-side collab wiring). |
| Markdown serialization protocol | **Produces** | DO side of the protocol: requests markdown from clients, stores response. Client side wired in Track 2A. |
| Edit capability cookie format | **Consumes** (later) | Used in `isReadOnly()` to validate edit capability. Until Track 3B delivers this, stub `isReadOnly()` to return `false` for all authenticated connections (all editors in Phase 1). |

---

## Tasks

### Task 1: GistRoom Class Skeleton

**Description**: Create the `GistRoom` class extending `YServer` from `y-partyserver` with hibernation enabled and the basic lifecycle hooks.

**Implementation Details**:

1. Create `src/server/do/GistRoom.ts`
2. Extend `YServer`:
   ```ts
   import { YServer } from 'y-partyserver'
   import type { Connection, WSMessage } from 'partyserver'

   export class GistRoom extends YServer {
     static options = { hibernate: true }
   }
   ```
   - **Note**: Check the actual import paths and class API of `y-partyserver` and `partyserver`. The `YServer` class may expect specific constructor arguments or have different method signatures. Read the installed package types/source to confirm.
3. Override lifecycle methods (implemented in subsequent tasks):
   - `onLoad()` — Task 3
   - `onSave()` — Task 4
   - `onConnect(connection, ctx)` — Task 7 (auth check stub)
   - `onCustomMessage(connection, message)` — Task 5
4. Ensure the class is exported and registered in `wrangler.toml` as the DO class for the `gist-room` party

**Files to create/modify**:
- Create: `src/server/do/GistRoom.ts`
- Modify: `wrangler.toml` (if DO class export path needs updating)
- Modify: Worker entry point (if DO export needs re-exporting)

**Verification**:
1. Start `wrangler dev`
2. Use `wscat` or a browser-based WebSocket client to connect:
   ```bash
   wscat -c ws://localhost:8787/parties/gist-room/test-room
   ```
3. Connection succeeds (upgrade completes, WebSocket is open)
4. No errors in the `wrangler dev` console
5. Disconnecting and reconnecting works

---

### Task 2: DO SQLite Schema

**Description**: Create the SQLite schema for storing room metadata, Yjs snapshots, and canonical markdown.

**Implementation Details**:

1. In `src/server/do/GistRoom.ts`, create a private method `ensureSchema()`:
   ```ts
   private ensureSchema() {
     this.ctx.storage.sql.exec(`
       CREATE TABLE IF NOT EXISTS room_meta (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )
     `)
     this.ctx.storage.sql.exec(`
       CREATE TABLE IF NOT EXISTS yjs_snapshot (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         data BLOB NOT NULL,
         updated_at TEXT NOT NULL DEFAULT (datetime('now'))
       )
     `)
     this.ctx.storage.sql.exec(`
       CREATE TABLE IF NOT EXISTS canonical_markdown (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         content TEXT NOT NULL,
         updated_at TEXT NOT NULL DEFAULT (datetime('now'))
       )
     `)
   }
   ```
2. The `room_meta` table stores key-value pairs for all metadata. Keys:
   | Key | Type | Description |
   |---|---|---|
   | `gistId` | string | GitHub Gist ID |
   | `filename` | string | Gist filename |
   | `etag` | string | Last known GitHub ETag |
   | `updatedAt` | ISO string | Last GitHub update timestamp |
   | `editTokenHash` | string | SHA-256 hash of the edit token |
   | `lastSavedAt` | ISO string | Last successful GitHub save |
   | `pendingSync` | "true"/"false" | Whether there are unsaved changes |
   | `pendingSince` | ISO string | When pending sync started |
   | `initialized` | "true"/"false" | Whether the room has been initialized by an owner |
   | `ownerUserId` | string | GitHub user ID of the room owner |
3. Create helper methods for reading/writing metadata:
   ```ts
   private getMeta(key: string): string | null
   private setMeta(key: string, value: string): void
   ```
4. Create helper methods for Yjs snapshot:
   ```ts
   private loadSnapshot(): Uint8Array | null
   private saveSnapshot(data: Uint8Array): void
   ```
5. Create helper methods for canonical markdown:
   ```ts
   private loadCanonicalMarkdown(): string | null
   private saveCanonicalMarkdown(markdown: string): void
   ```
6. Call `ensureSchema()` at the start of `onLoad()`

**Files to create/modify**:
- Modify: `src/server/do/GistRoom.ts`

**Verification**:
1. Start `wrangler dev`
2. Connect to a room via WebSocket → `onLoad()` fires → schema created without errors
3. In the DO code, add temporary logging:
   - After `ensureSchema()`, run `this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table'")` and log result
   - Verify tables `room_meta`, `yjs_snapshot`, `canonical_markdown` exist
4. Test `setMeta('initialized', 'true')` then `getMeta('initialized')` returns `'true'`
5. Test `saveSnapshot(new Uint8Array([1,2,3]))` then `loadSnapshot()` returns `Uint8Array([1,2,3])`

---

### Task 3: onLoad() — Snapshot Rehydration

**Description**: Implement `onLoad()` to initialize the schema and restore the Yjs document from the SQLite snapshot.

**Implementation Details**:

1. In `GistRoom.onLoad()`:
   ```ts
   async onLoad() {
     this.ensureSchema()
     const snapshot = this.loadSnapshot()
     if (snapshot) {
       Y.applyUpdate(this.document, snapshot)
     }
   }
   ```
   - **Note**: Check how `YServer` exposes the Yjs document. It may be `this.document`, `this.getYDoc()`, `this.doc`, or accessed differently. Read the `y-partyserver` types to confirm the correct property/method.
2. If no snapshot exists AND the room is initialized (`getMeta('initialized') === 'true'`), the DO should send a `needs-init` message to the first authorized client that connects. This is handled in `onConnect()` (Task 7) rather than `onLoad()`, since no clients are connected during `onLoad()`.
3. Track whether the room needs initialization with an in-memory flag:
   ```ts
   private needsInit = false
   ```
   Set this in `onLoad()` when: initialized room but no snapshot.

**Files to create/modify**:
- Modify: `src/server/do/GistRoom.ts`

**Verification**:
1. Connect to a new room → `onLoad()` runs → no snapshot to load → no errors
2. Make some Yjs edits (via `onSave()` in Task 4) → snapshot saved → disconnect
3. Reconnect to the same room → `onLoad()` loads snapshot → `Y.applyUpdate` succeeds → document state is restored
4. Verify by checking: client receives the previously-edited content after reconnecting (Yjs sync protocol sends the restored document to the client)

---

### Task 4: onSave() — Snapshot Persistence and callbackOptions

**Description**: Implement `onSave()` to persist the Yjs snapshot to SQLite, and configure `callbackOptions` for debounced saving.

**Implementation Details**:

1. Configure `callbackOptions` on the `GistRoom` class:
   ```ts
   static callbackOptions = {
     debounceWait: 30000,   // 30 seconds
     debounceMaxWait: 60000, // Max 60 seconds
     // Check y-partyserver docs for exact option names
   }
   ```
   - **Note**: The actual option names and structure depend on `y-partyserver`. Read the package source/types to confirm. There may be options for idle-save and flush-on-disconnect.
2. Implement `onSave()`:
   ```ts
   async onSave() {
     const snapshot = Y.encodeStateAsUpdate(this.document)
     this.saveSnapshot(snapshot)
     await this.requestCanonicalMarkdown()
   }
   ```
3. The `requestCanonicalMarkdown()` method is implemented in Task 5.

**Files to create/modify**:
- Modify: `src/server/do/GistRoom.ts`

**Verification**:
1. Connect to a room, send Yjs updates (type in an editor or use a Yjs test client)
2. Wait 30 seconds (debounce period) → check `wrangler dev` logs for `onSave()` execution
3. Verify `yjs_snapshot` table has a row with blob data
4. Disconnect → reconnect → document state is restored from the snapshot
5. Send rapid updates → verify `onSave()` only fires once per debounce window (not on every update)
6. Disconnect while updates are pending → verify `onSave()` fires on disconnect (flush-on-disconnect)

---

### Task 5: request-markdown / canonical-markdown Protocol

**Description**: Implement the custom message protocol where the DO requests canonical markdown from a connected authorized client and stores the response.

**Implementation Details**:

1. Define message types in a shared module `src/shared/messages.ts`:
   ```ts
   export type DOToClientMessage =
     | { type: 'request-markdown'; requestId: string }
     | { type: 'needs-init'; gistId: string; filename: string }
     | { type: 'reload-remote'; markdown: string }
     | { type: 'remote-changed'; remoteMarkdown: string }
     | { type: 'sync-status'; state: SyncState; detail?: string }
     | { type: 'error-retrying'; attempt: number; nextRetryAt: string }
     | { type: 'conflict'; localMarkdown: string; remoteMarkdown: string }

   export type ClientToDOMessage =
     | { type: 'canonical-markdown'; requestId: string; markdown: string }
     | { type: 'push_local' }
     | { type: 'discard_local' }

   export type SyncState = 'saved' | 'saving' | 'error-retrying' | 'pending-sync' | 'conflict'
   ```

2. In `GistRoom`, implement `requestCanonicalMarkdown()`:
   ```ts
   private async requestCanonicalMarkdown(): Promise<string | null> {
     const authorizedConnection = this.getAuthorizedConnection()
     if (!authorizedConnection) return null

     const requestId = crypto.randomUUID()
     authorizedConnection.send(JSON.stringify({
       type: 'request-markdown',
       requestId
     }))

     // Wait for response with timeout
     return new Promise<string | null>((resolve) => {
       const timeout = setTimeout(() => {
         this.pendingMarkdownRequests.delete(requestId)
         resolve(null)
       }, 5000) // 5 second timeout

       this.pendingMarkdownRequests.set(requestId, { resolve, timeout })
     })
   }
   ```

3. In `onCustomMessage(connection, message)`:
   ```ts
   onCustomMessage(connection: Connection, message: string) {
     const parsed = JSON.parse(message) as ClientToDOMessage
     switch (parsed.type) {
       case 'canonical-markdown': {
         const pending = this.pendingMarkdownRequests.get(parsed.requestId)
         if (pending) {
           clearTimeout(pending.timeout)
           this.pendingMarkdownRequests.delete(parsed.requestId)
           this.saveCanonicalMarkdown(parsed.markdown)
           pending.resolve(parsed.markdown)
         }
         break
       }
       // push_local and discard_local handled in Phase 4A
     }
   }
   ```

4. Track pending requests in memory:
   ```ts
   private pendingMarkdownRequests = new Map<string, {
     resolve: (md: string | null) => void
     timeout: ReturnType<typeof setTimeout>
   }>()
   ```

5. Helper to find an authorized connection:
   ```ts
   private getAuthorizedConnection(): Connection | null {
     // For Phase 1, return any connected client
     // In Phase 3B, this checks edit capability
     for (const connection of this.getConnections()) {
       return connection
     }
     return null
   }
   ```
   - **Note**: Check how `YServer` exposes connections. It may be `this.getConnections()`, `this.connections`, or another API. Read the `y-partyserver`/`partyserver` types.

**Files to create/modify**:
- Create: `src/shared/messages.ts`
- Modify: `src/server/do/GistRoom.ts`

**Verification**:
1. Create a test WebSocket client (Node.js script or browser page) that:
   a. Connects to the GistRoom
   b. Listens for `request-markdown` messages
   c. Responds with `canonical-markdown` containing a test markdown string
2. Trigger `onSave()` (send Yjs updates and wait for debounce)
3. Verify the client receives `{ type: "request-markdown", requestId: "<uuid>" }`
4. Client sends `{ type: "canonical-markdown", requestId: "<uuid>", markdown: "# Test" }`
5. Verify `canonical_markdown` table has a row with `content = "# Test"`
6. Test timeout: connect a client that does NOT respond to `request-markdown` → after 5 seconds, `onSave()` completes without storing markdown (no error, just `null` return)

---

### Task 6: Hibernation Support

**Description**: Ensure the DO correctly hibernates and rehydrates. `static options = { hibernate: true }` is already set; this task verifies the full cycle.

**Implementation Details**:

1. Hibernation is enabled via `static options = { hibernate: true }` (set in Task 1)
2. When the DO hibernates (all connections close, idle timeout), all in-memory state is lost
3. On wake (new connection arrives), `onLoad()` is called again → schema ensured, snapshot loaded
4. Ensure all in-memory state is either:
   - Reconstructible from SQLite (snapshot, metadata, canonical markdown)
   - Acceptable to lose (pending markdown requests — clients will reconnect and new requests will be sent)
5. Clear in-memory caches in `onLoad()` to prevent stale state from a previous lifecycle:
   ```ts
   async onLoad() {
     this.pendingMarkdownRequests.clear()
     this.needsInit = false
     this.ensureSchema()
     // ... rest of onLoad
   }
   ```

**Files to create/modify**:
- Modify: `src/server/do/GistRoom.ts` (minor — ensure `onLoad()` resets in-memory state)

**Verification**:
1. Connect to a room → make edits → wait for `onSave()` → disconnect all clients
2. Wait for hibernation (in local dev, this may be immediate or require a timeout — check `wrangler dev` behavior)
3. Reconnect to the same room
4. Verify `onLoad()` runs again (add logging)
5. Verify document state is restored from SQLite (client receives previous edits)
6. Verify `pendingMarkdownRequests` map is empty after wake (no stale promises)

---

### Task 7: initialized Flag, ownerUserId, and Connection Auth

**Description**: Implement the `initialized` and `ownerUserId` metadata, the `onConnect` auth check, and the `needs-init` message.

**Implementation Details**:

1. The `initialized` and `ownerUserId` values are written to `room_meta` by the API routes (Track 2B) when a room is created or imported. This track only reads them.

2. Expose methods for the API layer to call (via DO RPC or HTTP):
   ```ts
   async initializeRoom(gistId: string, filename: string, ownerUserId: string, editTokenHash: string) {
     this.setMeta('initialized', 'true')
     this.setMeta('gistId', gistId)
     this.setMeta('filename', filename)
     this.setMeta('ownerUserId', ownerUserId)
     this.setMeta('editTokenHash', editTokenHash)
     this.setMeta('pendingSync', 'false')
   }
   ```
   - **Note**: Check how `partyserver` DOs handle HTTP requests. There may be an `onRequest(request)` method for handling fetch calls to the DO. The API routes in Track 2B will call `env.GIST_ROOM.get(id).fetch(...)` to initialize the room.

3. In `onConnect(connection, ctx)`:
   ```ts
   async onConnect(connection: Connection, ctx: ConnectionContext) {
     // Check if room is initialized
     const initialized = this.getMeta('initialized')
     if (initialized !== 'true') {
       connection.close(4004, 'Room not initialized')
       return
     }

     // Verify JWT session cookie (stub until Track 1A delivers)
     // const user = await verifyJWT(cookie, secret)
     // connection.setState({ user })

     // If room needs init content (initialized but no snapshot)
     if (this.needsInit) {
       const gistId = this.getMeta('gistId')
       const filename = this.getMeta('filename')
       connection.send(JSON.stringify({
         type: 'needs-init',
         gistId,
         filename
       }))
       this.needsInit = false  // Only send to first client
     }
   }
   ```
   - **Note**: Check `partyserver`'s `onConnect` signature. The second argument may provide request headers (including cookies) for auth verification.

4. Add an `onRequest(request)` handler for room initialization via HTTP:
   ```ts
   async onRequest(request: Request): Promise<Response> {
     const url = new URL(request.url)
     if (url.pathname.endsWith('/initialize') && request.method === 'POST') {
       const body = await request.json()
       await this.initializeRoom(body.gistId, body.filename, body.ownerUserId, body.editTokenHash)
       return new Response(JSON.stringify({ ok: true }), { status: 200 })
     }

     if (url.pathname.endsWith('/meta') && request.method === 'GET') {
       return new Response(JSON.stringify({
         initialized: this.getMeta('initialized') === 'true',
         gistId: this.getMeta('gistId'),
         filename: this.getMeta('filename'),
         ownerUserId: this.getMeta('ownerUserId'),
         pendingSync: this.getMeta('pendingSync') === 'true',
         lastCanonicalMarkdown: this.loadCanonicalMarkdown(),
       }), { status: 200 })
     }

     return new Response('Not found', { status: 404 })
   }
   ```

**Files to create/modify**:
- Modify: `src/server/do/GistRoom.ts`

**Verification**:
1. **Uninitialized room**: Connect via WebSocket to a fresh room → connection is closed with code `4004` and reason "Room not initialized"
   ```bash
   wscat -c ws://localhost:8787/parties/gist-room/new-room
   # Should see: error: Unexpected server response: ... or close with 4004
   ```
2. **Initialize room**: Call the DO's HTTP endpoint:
   ```bash
   curl -X POST http://localhost:8787/parties/gist-room/test-room/initialize \
     -H "Content-Type: application/json" \
     -d '{"gistId":"abc123","filename":"doc.md","ownerUserId":"12345","editTokenHash":"sha256hash"}'
   ```
   Response: `{ "ok": true }`
3. **Initialized room**: Connect via WebSocket to the same room → connection succeeds
   ```bash
   wscat -c ws://localhost:8787/parties/gist-room/test-room
   # Connection stays open
   ```
4. **needs-init message**: Since the room is initialized but has no snapshot, the first connecting client receives:
   ```json
   { "type": "needs-init", "gistId": "abc123", "filename": "doc.md" }
   ```
5. **Meta endpoint**:
   ```bash
   curl http://localhost:8787/parties/gist-room/test-room/meta
   ```
   Returns JSON with `initialized: true`, `gistId: "abc123"`, etc.

---

### Task 8: Connection Limits and Rate Limiting

**Description**: Enforce per-IP and per-room WebSocket connection limits, message rate limiting, and a 2 MB document size limit on inbound Yjs updates.

**Implementation Details**:

1. **Per-room connection limit**: Maximum 50 concurrent connections per room (configurable constant)
   ```ts
   private static MAX_CONNECTIONS_PER_ROOM = 50
   ```
   In `onConnect()`, check `this.getConnections().length` (or equivalent). If at limit, close with `4029` ("Too many connections").

2. **Per-IP connection limit**: Maximum 5 connections per IP per room
   - Track IP → connection count in an in-memory `Map<string, number>`
   - Extract IP from the connection context/request headers (`CF-Connecting-IP` or `X-Forwarded-For`)
   - Decrement on `onClose(connection)`
   - In `onConnect()`, check count. If at limit, close with `4029`.

3. **Message rate limiting**: Maximum 100 messages per 10 seconds per connection
   - Use a simple sliding window counter per connection (stored in connection state or a Map)
   - In `onMessage(connection, message)` (or the appropriate hook), check rate. If exceeded, send an error message and close the connection with `4029`.
   - **Note**: Check how `YServer` processes messages. There may be a hook to intercept before Yjs processing, or you may need to override `onMessage`.

4. **Document size limit**: 2 MB max on inbound Yjs updates
   - In the message handler, check `message.byteLength` (for binary) or `message.length` (for string)
   - If the message exceeds 2 MB, reject it (send error, close connection)
   - Also check the total document size after applying an update: `Y.encodeStateAsUpdate(this.document).byteLength`
   - **Note**: Checking individual message size is a first-pass guard. The total document size check catches incremental bloat.

**Files to create/modify**:
- Modify: `src/server/do/GistRoom.ts`
- Create: `src/server/do/rate-limiter.ts` (simple sliding window rate limiter class)

**Verification**:
1. **Per-room limit**: Open 51 WebSocket connections to the same room → 51st is rejected with close code `4029`
   ```bash
   # Script that opens N connections
   for i in $(seq 1 51); do
     wscat -c ws://localhost:8787/parties/gist-room/limit-test &
   done
   # 51st connection should be closed immediately
   ```
2. **Per-IP limit**: Open 6 connections from the same IP to the same room → 6th is rejected
3. **Message rate limit**: Send 101 messages in rapid succession from one connection → connection is closed after exceeding the limit
   ```js
   // Browser console test
   const ws = new WebSocket('ws://localhost:8787/parties/gist-room/rate-test')
   ws.onopen = () => {
     for (let i = 0; i < 110; i++) ws.send('test')
   }
   ws.onclose = (e) => console.log('closed', e.code, e.reason)
   ```
4. **Document size limit**: Send a Yjs update larger than 2 MB → connection is closed or message is rejected
   ```js
   // Create a large Yjs update
   const doc = new Y.Doc()
   const text = doc.getText('content')
   text.insert(0, 'x'.repeat(3_000_000))  // 3 MB of text
   const update = Y.encodeStateAsUpdate(doc)
   ws.send(update)  // Should be rejected
   ```

---

## Track Complete

### Overall Milestone Verification

Perform this end-to-end sequence:

1. **Start**: `wrangler dev` running

2. **Uninitialized room**:
   ```bash
   wscat -c ws://localhost:8787/parties/gist-room/fresh-room
   ```
   → Connection closed with code `4004` ("Room not initialized")

3. **Initialize room**:
   ```bash
   curl -X POST http://localhost:8787/parties/gist-room/my-room/initialize \
     -H "Content-Type: application/json" \
     -d '{"gistId":"g123","filename":"readme.md","ownerUserId":"u456","editTokenHash":"hash789"}'
   ```
   → `{ "ok": true }`

4. **Connect client A**: Open a test page or use `wscat`:
   ```bash
   wscat -c ws://localhost:8787/parties/gist-room/my-room
   ```
   → Connection succeeds. Client receives `needs-init` message (since no snapshot exists yet).

5. **Send Yjs updates from client A**: Use a browser-based test client that creates a `Y.Doc`, connects via `YProvider`, and types text. Alternatively, use a script that encodes Yjs updates and sends them over the WebSocket.

6. **Connect client B**: Open a second connection to the same room.
   → Client B receives client A's edits via `YServer` broadcast (Yjs sync protocol).

7. **Verify real-time sync**: Client A sends an update → client B receives it. Client B sends an update → client A receives it.

8. **Wait for onSave()** (30 seconds debounce): Verify in logs that `onSave()` fires. Client A receives a `request-markdown` message.

9. **Respond with canonical markdown**: Client A sends:
   ```json
   { "type": "canonical-markdown", "requestId": "<from request>", "markdown": "# Hello\n\nThis is a test." }
   ```
   → Verify `canonical_markdown` table is updated.

10. **Verify snapshot persistence**: Check the `yjs_snapshot` table has a blob.

11. **Disconnect all clients**. Wait for hibernation.

12. **Reconnect client A**: Connect again to the same room.
    → `onLoad()` runs, snapshot is loaded. Client receives the previously-edited document state via Yjs sync. No `needs-init` message (snapshot exists).

13. **Check metadata**:
    ```bash
    curl http://localhost:8787/parties/gist-room/my-room/meta
    ```
    → Returns `initialized: true`, `gistId: "g123"`, `lastCanonicalMarkdown: "# Hello\n\nThis is a test."`

14. **Connection limits**: Open 51 connections → 51st is rejected. Open 6 from same IP → 6th is rejected.

All steps must pass. The DO persists Yjs state, broadcasts updates, requests canonical markdown from clients, and enforces connection limits.
