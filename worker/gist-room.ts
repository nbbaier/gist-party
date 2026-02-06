import { YServer } from "y-partyserver";
import type { Connection, ConnectionContext } from "partyserver";
import * as Y from "yjs";
import {
  MessageTypeRequestMarkdown,
  MessageTypeNeedsInit,
  MessageTypeCanonicalMarkdown,
  MessageTypePushLocal,
  MessageTypeDiscardLocal,
  type CustomMessage,
  type CanonicalMarkdownPayload,
  encodeMessage,
  decodeMessage,
} from "./shared/messages";

// Pending markdown request tracking
interface PendingMarkdownRequest {
  resolve: (markdown: string | null) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class GistRoom extends YServer {
  // Enable hibernation for cost efficiency
  static options = {
    hibernate: true,
  };

  // Configure debounced save behavior
  static callbackOptions = {
    debounceWait: 30000, // 30 seconds
    debounceMaxWait: 60000, // Max 60 seconds
  };

  // Connection and rate limits
  static MAX_CONNECTIONS = 50; // Max concurrent connections per room
  static MAX_MESSAGE_SIZE = 2 * 1024 * 1024; // 2MB max message size
  static MESSAGE_RATE_WINDOW = 60000; // 1 minute window
  static MAX_MESSAGES_PER_WINDOW = 100; // Max messages per connection per minute

  // In-memory state (cleared on hibernation)
  private pendingMarkdownRequests = new Map<string, PendingMarkdownRequest>();
  private needsInit = false;
  private messageCounts = new Map<string, number[]>(); // connectionId -> timestamps

  // ============================================================================
  // Lifecycle Methods
  // ============================================================================

  /**
   * Called once when the DO starts (after onLoad completes)
   */
  async onStart(): Promise<void> {
    console.log(`[GistRoom ${this.name}] Server started`);
  }

  /**
   * Called once on first client connect - load persisted state
   */
  async onLoad(): Promise<void> {
    console.log(`[GistRoom ${this.name}] Loading...`);

    // Clear any stale in-memory state from previous hibernation
    this.pendingMarkdownRequests.clear();
    this.messageCounts.clear();
    this.needsInit = false;

    // Ensure database schema exists
    this.ensureSchema();

    // Load Yjs snapshot if exists
    const snapshot = this.loadSnapshot();
    if (snapshot) {
      console.log(`[GistRoom ${this.name}] Restored from snapshot`);
      Y.applyUpdate(this.document, snapshot);
      return;
    }

    // Check if room is initialized but has no snapshot
    const initialized = this.getMeta("initialized");
    if (initialized === "true") {
      console.log(`[GistRoom ${this.name}] Initialized but no snapshot - needs init content`);
      this.needsInit = true;
    }
  }

  /**
   * Called periodically after document edits (debounced)
   */
  async onSave(): Promise<void> {
    console.log(`[GistRoom ${this.name}] Saving snapshot...`);

    // Save Yjs state as snapshot
    const snapshot = Y.encodeStateAsUpdate(this.document);
    this.saveSnapshot(snapshot);

    // Request canonical markdown from a client
    await this.requestCanonicalMarkdown();
  }

  /**
   * Called when a new WebSocket connection is established
   */
  async onConnect(connection: Connection, _ctx: ConnectionContext): Promise<void> {
    // Enforce connection count limit
    const currentConnections = Array.from(this.getConnections()).length;
    if (currentConnections >= GistRoom.MAX_CONNECTIONS) {
      console.log(`[GistRoom ${this.name}] Rejecting connection - max connections (${GistRoom.MAX_CONNECTIONS}) reached`);
      connection.close(4005, "Room is at capacity");
      return;
    }

    console.log(`[GistRoom ${this.name}] Connection ${connection.id} joined (${currentConnections + 1}/${GistRoom.MAX_CONNECTIONS})`);

    // Check if room is initialized
    const initialized = this.getMeta("initialized");
    if (initialized !== "true") {
      console.log(`[GistRoom ${this.name}] Rejecting connection - room not initialized`);
      connection.close(4004, "Room not initialized");
      return;
    }

    // TODO: Verify JWT session cookie (stub until Track 1A delivers)
    // const user = await verifyJWT(cookie, secret);
    // connection.setState({ user });

    // Initialize message tracking for this connection
    this.messageCounts.set(connection.id, []);

    // If room needs init content, send needs-init to first client
    if (this.needsInit) {
      const gistId = this.getMeta("gistId");
      const filename = this.getMeta("filename");

      if (gistId && filename) {
        const message: CustomMessage = {
          type: MessageTypeNeedsInit,
          payload: { gistId, filename },
        };
        this.sendCustomMessage(connection, encodeMessage(message));
        this.needsInit = false; // Only send to first client
        console.log(`[GistRoom ${this.name}] Sent needs-init to ${connection.id}`);
      }
    }
  }

  /**
   * Called when a connection closes
   */
  onClose(
    connection: Connection,
    code: number,
    reason: string,
    _wasClean: boolean
  ): void {
    console.log(
      `[GistRoom ${this.name}] Connection ${connection.id} left (code: ${code}, reason: ${reason})`
    );
    
    // Clean up message tracking for this connection
    this.messageCounts.delete(connection.id);
  }

  /**
   * Called when a message is received from a connection
   * Enforces message size and rate limits
   */
  async onMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
    // Check message size (convert to bytes for size check)
    const messageBytes = typeof message === 'string' 
      ? new TextEncoder().encode(message).length 
      : message.byteLength;
    
    if (messageBytes > GistRoom.MAX_MESSAGE_SIZE) {
      console.log(`[GistRoom ${this.name}] Message from ${connection.id} exceeds size limit (${messageBytes} > ${GistRoom.MAX_MESSAGE_SIZE})`);
      connection.close(4009, "Message too large");
      return;
    }

    // Check rate limit
    const now = Date.now();
    const timestamps = this.messageCounts.get(connection.id) || [];
    
    // Remove timestamps outside the window
    const windowStart = now - GistRoom.MESSAGE_RATE_WINDOW;
    const recentTimestamps = timestamps.filter(ts => ts > windowStart);
    
    if (recentTimestamps.length >= GistRoom.MAX_MESSAGES_PER_WINDOW) {
      console.log(`[GistRoom ${this.name}] Rate limit exceeded for ${connection.id}`);
      connection.close(4008, "Rate limit exceeded");
      return;
    }
    
    // Record this message
    recentTimestamps.push(now);
    this.messageCounts.set(connection.id, recentTimestamps);

    // Process the message via parent class (handles Yjs updates)
    await super.onMessage(connection, message);
  }

  /**
   * Handle custom messages from clients (non-Yjs messages)
   */
  onCustomMessage(connection: Connection, message: string): void {
    try {
      const parsed = decodeMessage(message);

      switch (parsed.type) {
        case MessageTypeCanonicalMarkdown:
          this.handleCanonicalMarkdown(
            connection,
            parsed.payload as CanonicalMarkdownPayload
          );
          break;

        case MessageTypePushLocal:
        case MessageTypeDiscardLocal:
          // Handled in Phase 4A (conflict resolution)
          console.log(`[GistRoom ${this.name}] Received ${parsed.type} (not yet implemented)`);
          break;

        default:
          console.log(`[GistRoom ${this.name}] Unknown message type: ${parsed.type}`);
      }
    } catch (error) {
      console.error(`[GistRoom ${this.name}] Error handling custom message:`, error);
    }
  }

  /**
   * Check if a connection is read-only
   * Stub: returns false for all authenticated connections (Phase 1)
   * In Phase 3B, this will check edit capability cookie
   */
  isReadOnly(_connection: Connection): boolean {
    // TODO: Check edit capability cookie (Track 3B)
    // For Phase 1, all authenticated connections can edit
    return false;
  }

  // ============================================================================
  // HTTP Request Handler (for DO RPC)
  // ============================================================================

  /**
   * Handle HTTP requests to the DO
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Initialize room
    if (url.pathname.endsWith("/initialize") && request.method === "POST") {
      try {
        const body = await request.json<{
          gistId: string;
          filename: string;
          ownerUserId: string;
          editTokenHash: string;
        }>();
        await this.initializeRoom(
          body.gistId,
          body.filename,
          body.ownerUserId,
          body.editTokenHash
        );
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ ok: false, error: String(error) }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Get room metadata
    if (url.pathname.endsWith("/meta") && request.method === "GET") {
      return new Response(
        JSON.stringify({
          initialized: this.getMeta("initialized") === "true",
          gistId: this.getMeta("gistId"),
          filename: this.getMeta("filename"),
          ownerUserId: this.getMeta("ownerUserId"),
          pendingSync: this.getMeta("pendingSync") === "true",
          lastCanonicalMarkdown: this.loadCanonicalMarkdown(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not found", { status: 404 });
  }

  // ============================================================================
  // SQLite Schema and Helper Methods
  // ============================================================================

  private ensureSchema(): void {
    // Room metadata table
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Yjs snapshot table (single row, id = 1)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS yjs_snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data BLOB NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Canonical markdown table (single row, id = 1)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS canonical_markdown (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  // ---------------------------------------------------------------------------
  // Metadata Helpers
  // ---------------------------------------------------------------------------

  private getMeta(key: string): string | null {
    try {
      const result = this.ctx.storage.sql.exec(
        `SELECT value FROM room_meta WHERE key = ?`,
        key
      );
      const row = result.one() as { value: string } | null;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO room_meta (key, value) VALUES (?, ?)`,
      key,
      value
    );
  }

  // ---------------------------------------------------------------------------
  // Yjs Snapshot Helpers
  // ---------------------------------------------------------------------------

  private loadSnapshot(): Uint8Array | null {
    try {
      const result = this.ctx.storage.sql.exec(
        `SELECT data FROM yjs_snapshot WHERE id = 1`
      );
      const row = result.one() as { data: ArrayBuffer } | null;
      if (row?.data) {
        return new Uint8Array(row.data);
      }
      return null;
    } catch {
      return null;
    }
  }

  private saveSnapshot(data: Uint8Array): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO yjs_snapshot (id, data, updated_at) 
       VALUES (1, ?, datetime('now'))`,
      data
    );
  }

  // ---------------------------------------------------------------------------
  // Canonical Markdown Helpers
  // ---------------------------------------------------------------------------

  private loadCanonicalMarkdown(): string | null {
    try {
      const result = this.ctx.storage.sql.exec(
        `SELECT content FROM canonical_markdown WHERE id = 1`
      );
      const row = result.one() as { content: string } | null;
      return row?.content ?? null;
    } catch {
      return null;
    }
  }

  private saveCanonicalMarkdown(markdown: string): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO canonical_markdown (id, content, updated_at) 
       VALUES (1, ?, datetime('now'))`,
      markdown
    );
  }

  // ============================================================================
  // Room Initialization
  // ============================================================================

  async initializeRoom(
    gistId: string,
    filename: string,
    ownerUserId: string,
    editTokenHash: string
  ): Promise<void> {
    this.setMeta("initialized", "true");
    this.setMeta("gistId", gistId);
    this.setMeta("filename", filename);
    this.setMeta("ownerUserId", ownerUserId);
    this.setMeta("editTokenHash", editTokenHash);
    this.setMeta("pendingSync", "false");
    console.log(`[GistRoom ${this.name}] Room initialized for gist ${gistId}`);
  }

  // ============================================================================
  // Markdown Protocol
  // ============================================================================

  /**
   * Request canonical markdown from an authorized client
   */
  private async requestCanonicalMarkdown(): Promise<string | null> {
    const authorizedConnection = this.getAuthorizedConnection();
    if (!authorizedConnection) {
      console.log(`[GistRoom ${this.name}] No authorized connection for markdown request`);
      return null;
    }

    const requestId = crypto.randomUUID();
    const message: CustomMessage = {
      type: MessageTypeRequestMarkdown,
      payload: { requestId },
    };

    this.sendCustomMessage(authorizedConnection, encodeMessage(message));
    console.log(`[GistRoom ${this.name}] Requested markdown (requestId: ${requestId})`);

    // Wait for response with timeout
    return new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => {
        console.log(`[GistRoom ${this.name}] Markdown request timeout (requestId: ${requestId})`);
        this.pendingMarkdownRequests.delete(requestId);
        resolve(null);
      }, 5000); // 5 second timeout

      this.pendingMarkdownRequests.set(requestId, { resolve, timeout });
    });
  }

  /**
   * Handle canonical markdown response from client
   */
  private handleCanonicalMarkdown(
    _connection: Connection,
    payload: CanonicalMarkdownPayload
  ): void {
    const pending = this.pendingMarkdownRequests.get(payload.requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingMarkdownRequests.delete(payload.requestId);
      this.saveCanonicalMarkdown(payload.markdown);
      console.log(`[GistRoom ${this.name}] Saved canonical markdown (${payload.markdown.length} chars)`);
      pending.resolve(payload.markdown);
    } else {
      console.log(`[GistRoom ${this.name}] Received markdown for unknown/expired requestId: ${payload.requestId}`);
    }
  }

  /**
   * Get an authorized connection for making requests
   * For Phase 1, returns any connected client
   */
  private getAuthorizedConnection(): Connection | null {
    // For Phase 1, return the first connected client
    // In Phase 3B, this will check edit capability
    for (const connection of this.getConnections()) {
      return connection;
    }
    return null;
  }
}
