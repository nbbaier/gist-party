import type { Connection, ConnectionContext } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";
import { decrypt } from "../src/shared/encryption";
import { verifyEditCookie } from "../src/shared/edit-cookie";
import { verifyJwt } from "./shared/jwt";
import {
	type CanonicalMarkdownPayload,
	type CustomMessage,
	type SyncState,
	decodeMessage,
	encodeMessage,
	MessageTypeCanonicalMarkdown,
	MessageTypeDiscardLocal,
	MessageTypeErrorRetrying,
	MessageTypeNeedsInit,
	MessageTypePushLocal,
	MessageTypeReloadRemote,
	MessageTypeRemoteChanged,
	MessageTypeRequestMarkdown,
	MessageTypeSyncStatus,
} from "./shared/messages";

interface PendingMarkdownRequest {
	resolve: (markdown: string | null) => void;
	timeout: ReturnType<typeof setTimeout>;
}

interface WorkerEnv {
	GIST_ROOM: DurableObjectNamespace;
	SESSION_KV: KVNamespace;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	JWT_SECRET: string;
	ENCRYPTION_KEY_V1: string;
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000;
const MAX_RETRY_BACKOFF_MS = 300_000;

export class GistRoom extends YServer<WorkerEnv> {
	static options = {
		hibernate: true,
	};

	static callbackOptions = {
		debounceWait: 30000,
		debounceMaxWait: 60000,
	};

	static MAX_CONNECTIONS = 50;
	static MAX_MESSAGE_SIZE = 2 * 1024 * 1024;
	static MESSAGE_RATE_WINDOW = 60000;
	static MAX_MESSAGES_PER_WINDOW = 100;

	private pendingMarkdownRequests = new Map<string, PendingMarkdownRequest>();
	private needsInit = false;
	private messageCounts = new Map<string, number[]>();
	private connectionCapabilities = new Map<
		string,
		{ canEdit: boolean; isOwner: boolean }
	>();

	private ownerToken: string | null = null;
	private syncState: SyncState = "saved";
	private retryAttempt = 0;
	private retryTimeout: ReturnType<typeof setTimeout> | null = null;
	private autoSyncPaused = false;
	private snapshotUpdatedAt: string | null = null;

	// ============================================================================
	// Lifecycle Methods
	// ============================================================================

	async onStart(): Promise<void> {
		console.log(`[GistRoom ${this.name}] Server started`);
	}

	async onLoad(): Promise<void> {
		console.log(`[GistRoom ${this.name}] Loading...`);

		this.pendingMarkdownRequests.clear();
		this.messageCounts.clear();
		this.connectionCapabilities.clear();
		this.needsInit = false;
		this.ownerToken = null;
		this.syncState = "saved";
		this.retryAttempt = 0;
		this.retryTimeout = null;
		this.autoSyncPaused = false;
		this.snapshotUpdatedAt = null;

		this.ensureSchema();

		const snapshot = this.loadSnapshot();
		if (snapshot) {
			console.log(`[GistRoom ${this.name}] Restored from snapshot`);
			Y.applyUpdate(this.document, snapshot.data);
			this.snapshotUpdatedAt = snapshot.updatedAt;
			return;
		}

		const initialized = this.getMeta("initialized");
		if (initialized === "true") {
			console.log(
				`[GistRoom ${this.name}] Initialized but no snapshot - needs init content`,
			);
			this.needsInit = true;
		}
	}

	async onSave(): Promise<void> {
		console.log(`[GistRoom ${this.name}] Saving snapshot...`);

		const snapshot = Y.encodeStateAsUpdate(this.document);
		this.saveSnapshot(snapshot);

		const markdown = await this.requestCanonicalMarkdown();

		if (markdown && this.ownerToken && !this.autoSyncPaused) {
			await this.syncToGitHub(markdown);
		}
	}

	async onConnect(
		connection: Connection,
		ctx: ConnectionContext,
	): Promise<void> {
		const currentConnections = Array.from(this.getConnections()).length;
		if (currentConnections >= GistRoom.MAX_CONNECTIONS) {
			console.log(
				`[GistRoom ${this.name}] Rejecting connection - max connections (${GistRoom.MAX_CONNECTIONS}) reached`,
			);
			connection.close(4005, "Room is at capacity");
			return;
		}

		console.log(
			`[GistRoom ${this.name}] Connection ${connection.id} joined (${currentConnections + 1}/${GistRoom.MAX_CONNECTIONS})`,
		);

		const initialized = this.getMeta("initialized");
		if (initialized !== "true") {
			console.log(
				`[GistRoom ${this.name}] Rejecting connection - room not initialized`,
			);
			connection.close(4004, "Room not initialized");
			return;
		}

		this.messageCounts.set(connection.id, []);

		const [canEdit, isOwner] = await Promise.all([
			this.checkEditCapability(ctx),
			this.checkOwner(ctx),
		]);
		this.connectionCapabilities.set(connection.id, { canEdit, isOwner });

		if (this.needsInit) {
			const gistId = this.getMeta("gistId");
			const filename = this.getMeta("filename");

			if (gistId && filename) {
				const message: CustomMessage = {
					type: MessageTypeNeedsInit,
					payload: { gistId, filename },
				};
				this.sendCustomMessage(connection, encodeMessage(message));
				this.needsInit = false;
				console.log(
					`[GistRoom ${this.name}] Sent needs-init to ${connection.id}`,
				);
			}
		}

		await this.tryLoadOwnerToken(connection);
		await this.checkStaleness();
	}

	onClose(
		connection: Connection,
		code: number,
		reason: string,
		_wasClean: boolean,
	): void {
		console.log(
			`[GistRoom ${this.name}] Connection ${connection.id} left (code: ${code}, reason: ${reason})`,
		);

		this.messageCounts.delete(connection.id);
		this.connectionCapabilities.delete(connection.id);

		if (this.ownerToken && this.isOwnerConnection(connection)) {
			const hasOtherOwnerConnection = this.findOwnerConnection(connection.id) !== null;
			if (!hasOtherOwnerConnection) {
				this.ownerToken = null;
				const pendingSync = this.getMeta("pendingSync");
				if (pendingSync === "true") {
					this.setMeta("pendingSince", new Date().toISOString());
				}
				console.log(
					`[GistRoom ${this.name}] Owner disconnected, cleared token`,
				);
			}
		}
	}

	async onMessage(
		connection: Connection,
		message: string | ArrayBuffer,
	): Promise<void> {
		const messageBytes =
			typeof message === "string"
				? new TextEncoder().encode(message).length
				: message.byteLength;

		if (messageBytes > GistRoom.MAX_MESSAGE_SIZE) {
			console.log(
				`[GistRoom ${this.name}] Message from ${connection.id} exceeds size limit (${messageBytes} > ${GistRoom.MAX_MESSAGE_SIZE})`,
			);
			connection.close(4009, "Message too large");
			return;
		}

		const now = Date.now();
		const timestamps = this.messageCounts.get(connection.id) || [];
		const windowStart = now - GistRoom.MESSAGE_RATE_WINDOW;
		const recentTimestamps = timestamps.filter((ts) => ts > windowStart);

		if (recentTimestamps.length >= GistRoom.MAX_MESSAGES_PER_WINDOW) {
			console.log(
				`[GistRoom ${this.name}] Rate limit exceeded for ${connection.id}`,
			);
			connection.close(4008, "Rate limit exceeded");
			return;
		}

		recentTimestamps.push(now);
		this.messageCounts.set(connection.id, recentTimestamps);

		await super.onMessage(connection, message);
	}

	onCustomMessage(connection: Connection, message: string): void {
		try {
			const parsed = decodeMessage(message);

			switch (parsed.type) {
				case MessageTypeCanonicalMarkdown:
					this.handleCanonicalMarkdown(
						connection,
						parsed.payload as CanonicalMarkdownPayload,
					);
					break;

				case MessageTypePushLocal:
					this.handlePushLocal(connection);
					break;

				case MessageTypeDiscardLocal:
					this.handleDiscardLocal(connection);
					break;

				default:
					console.log(
						`[GistRoom ${this.name}] Unknown message type: ${parsed.type}`,
					);
			}
		} catch (error) {
			console.error(
				`[GistRoom ${this.name}] Error handling custom message:`,
				error,
			);
		}
	}

	isReadOnly(connection: Connection): boolean {
		const cap = this.connectionCapabilities.get(connection.id);
		return !cap?.canEdit;
	}

	// ============================================================================
	// HTTP Request Handler (for DO RPC)
	// ============================================================================

	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);

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
					body.editTokenHash,
				);
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			} catch (error) {
				return new Response(
					JSON.stringify({ ok: false, error: String(error) }),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				);
			}
		}

		if (url.pathname.endsWith("/meta") && request.method === "GET") {
			return new Response(
				JSON.stringify({
					initialized: this.getMeta("initialized") === "true",
					gistId: this.getMeta("gistId"),
					filename: this.getMeta("filename"),
					ownerUserId: this.getMeta("ownerUserId"),
					pendingSync: this.getMeta("pendingSync") === "true",
					etag: this.getMeta("etag"),
					snapshotUpdatedAt: this.snapshotUpdatedAt,
					syncState: this.syncState,
					lastCanonicalMarkdown: this.loadCanonicalMarkdown(),
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		if (url.pathname.endsWith("/verify-token") && request.method === "POST") {
			try {
				const body = await request.json<{ tokenHash: string }>();
				const storedHash = this.getMeta("editTokenHash");
				const valid = storedHash !== null && storedHash === body.tokenHash;
				return new Response(JSON.stringify({ valid }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			} catch {
				return new Response(
					JSON.stringify({ valid: false }),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}
		}

		if (url.pathname.endsWith("/update-token") && request.method === "POST") {
			try {
				const body = await request.json<{ editTokenHash: string }>();
				this.setMeta("editTokenHash", body.editTokenHash);

				for (const conn of this.getConnections()) {
					const cap = this.connectionCapabilities.get(conn.id);
					if (cap?.canEdit) {
						conn.close(4010, "Edit token revoked");
					}
				}

				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			} catch (error) {
				return new Response(
					JSON.stringify({ ok: false, error: String(error) }),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				);
			}
		}

		return new Response("Not found", { status: 404 });
	}

	// ============================================================================
	// GitHub Sync
	// ============================================================================

	private async syncToGitHub(
		markdown: string,
		options?: { force?: boolean },
	): Promise<void> {
		const gistId = this.getMeta("gistId");
		const filename = this.getMeta("filename");
		const storedEtag = this.getMeta("etag");

		if (!gistId || !filename || !this.ownerToken) return;

		this.broadcastSyncStatus("saving");

		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.ownerToken}`,
			Accept: "application/vnd.github.v3+json",
			"User-Agent": "gist-party",
			"Content-Type": "application/json",
		};
		if (storedEtag && !options?.force) {
			headers["If-Match"] = storedEtag;
		}

		try {
			const response = await fetch(
				`https://api.github.com/gists/${gistId}`,
				{
					method: "PATCH",
					headers,
					body: JSON.stringify({
						files: { [filename]: { content: markdown } },
					}),
				},
			);

			if (response.ok) {
				const etag = response.headers.get("ETag");
				if (etag) {
					this.setMeta("etag", etag);
				}
				this.setMeta("updatedAt", new Date().toISOString());
				this.setMeta("pendingSync", "false");
				this.retryAttempt = 0;
				this.broadcastSyncStatus("saved");
				console.log(
					`[GistRoom ${this.name}] Synced to GitHub successfully`,
				);
			} else if (response.status === 412) {
				await this.handle412Conflict();
			} else {
				await this.handleSyncError(response.status);
			}
		} catch (error) {
			console.error(
				`[GistRoom ${this.name}] GitHub sync fetch error:`,
				error,
			);
			await this.handleSyncError(0);
		}
	}

	private async handle412Conflict(): Promise<void> {
		this.autoSyncPaused = true;

		console.log(`[GistRoom ${this.name}] 412 conflict detected`);

		const remote = await this.fetchRemoteGist();
		if (!remote) return;

		const filename = this.getMeta("filename");
		if (!filename) return;

		const remoteFile = remote.files?.[filename];
		const remoteMarkdown = remoteFile?.content ?? "";

		const message: CustomMessage = {
			type: MessageTypeRemoteChanged,
			payload: { remoteMarkdown },
		};
		this.broadcastCustomMessage(encodeMessage(message));
		this.broadcastSyncStatus("conflict");
	}

	private async handleSyncError(statusCode: number): Promise<void> {
		this.autoSyncPaused = true;
		this.retryAttempt++;

		const backoff = Math.min(
			1000 * Math.pow(2, this.retryAttempt),
			MAX_RETRY_BACKOFF_MS,
		);

		console.log(
			`[GistRoom ${this.name}] Sync error (status: ${statusCode}), retry #${this.retryAttempt} in ${backoff}ms`,
		);

		const message: CustomMessage = {
			type: MessageTypeErrorRetrying,
			payload: {
				attempt: this.retryAttempt,
				nextRetryAt: Date.now() + backoff,
			},
		};
		this.broadcastCustomMessage(encodeMessage(message));
		this.broadcastSyncStatus("error-retrying");

		if (this.retryTimeout) {
			clearTimeout(this.retryTimeout);
		}
		this.retryTimeout = setTimeout(() => {
			this.retryTimeout = null;
			this.retrySyncToGitHub();
		}, backoff);
	}

	private async retrySyncToGitHub(): Promise<void> {
		this.autoSyncPaused = false;

		const markdown = this.loadCanonicalMarkdown();
		if (!markdown || !this.ownerToken) {
			console.log(
				`[GistRoom ${this.name}] Retry aborted - no markdown or owner token`,
			);
			return;
		}

		await this.syncToGitHub(markdown);
	}

	private async fetchRemoteGist(): Promise<GitHubGistResponse | null> {
		const gistId = this.getMeta("gistId");
		if (!gistId || !this.ownerToken) return null;

		try {
			const response = await fetch(
				`https://api.github.com/gists/${gistId}`,
				{
					headers: {
						Authorization: `Bearer ${this.ownerToken}`,
						Accept: "application/vnd.github.v3+json",
						"User-Agent": "gist-party",
					},
				},
			);

			if (!response.ok) {
				console.error(
					`[GistRoom ${this.name}] Failed to fetch remote gist: ${response.status}`,
				);
				return null;
			}

			const etag = response.headers.get("ETag");
			if (etag) {
				this.setMeta("etag", etag);
			}

			return (await response.json()) as GitHubGistResponse;
		} catch (error) {
			console.error(
				`[GistRoom ${this.name}] Fetch remote gist error:`,
				error,
			);
			return null;
		}
	}

	private broadcastSyncStatus(state: SyncState, detail?: string): void {
		this.syncState = state;
		const message: CustomMessage = {
			type: MessageTypeSyncStatus,
			payload: { state, detail },
		};
		this.broadcastCustomMessage(encodeMessage(message));
	}

	// ============================================================================
	// Owner Token Lifecycle
	// ============================================================================

	private async tryLoadOwnerToken(connection: Connection): Promise<void> {
		if (this.ownerToken) return;

		const ownerUserId = this.getMeta("ownerUserId");
		if (!ownerUserId) return;

		if (!this.isOwnerConnection(connection)) return;

		try {
			const sessionData = await this.env.SESSION_KV.get(
				`session:${ownerUserId}`,
			);
			if (!sessionData) {
				console.log(
					`[GistRoom ${this.name}] No session found for owner ${ownerUserId}`,
				);
				return;
			}

			const session = JSON.parse(sessionData) as {
				encryptedToken: string;
			};

			this.ownerToken = await decrypt(session.encryptedToken, {
				currentKey: {
					version: 1,
					rawKey: this.env.ENCRYPTION_KEY_V1,
				},
				previousKeys: [],
			});

			console.log(
				`[GistRoom ${this.name}] Owner token loaded for ${ownerUserId}`,
			);
		} catch (error) {
			console.error(
				`[GistRoom ${this.name}] Failed to load owner token:`,
				error,
			);
		}
	}

	private isOwnerConnection(connection: Connection): boolean {
		const cap = this.connectionCapabilities.get(connection.id);
		return cap?.isOwner === true;
	}

	private findOwnerConnection(
		excludeId?: string,
	): Connection | null {
		for (const conn of this.getConnections()) {
			if (excludeId && conn.id === excludeId) continue;
			if (this.isOwnerConnection(conn)) return conn;
		}
		return null;
	}

	// ============================================================================
	// Staleness Detection
	// ============================================================================

	private async checkStaleness(): Promise<void> {
		if (!this.snapshotUpdatedAt || !this.ownerToken) return;

		const initialized = this.getMeta("initialized");
		if (initialized !== "true") return;

		const snapshotAge =
			Date.now() - new Date(this.snapshotUpdatedAt).getTime();
		if (snapshotAge <= STALE_THRESHOLD_MS) return;

		const pendingSync = this.getMeta("pendingSync");
		if (pendingSync === "true") {
			this.autoSyncPaused = true;
			this.broadcastSyncStatus("conflict");
			console.log(
				`[GistRoom ${this.name}] Stale snapshot with pending sync - conflict`,
			);
			return;
		}

		const gistId = this.getMeta("gistId");
		const storedEtag = this.getMeta("etag");
		if (!gistId || !storedEtag) return;

		try {
			const response = await fetch(
				`https://api.github.com/gists/${gistId}`,
				{
					headers: {
						Authorization: `Bearer ${this.ownerToken}`,
						Accept: "application/vnd.github.v3+json",
						"User-Agent": "gist-party",
						"If-None-Match": storedEtag,
					},
				},
			);

			if (response.status === 304) {
				console.log(
					`[GistRoom ${this.name}] Remote unchanged (304), snapshot is stale but current`,
				);
				return;
			}

			if (response.ok) {
				const data = (await response.json()) as GitHubGistResponse;
				const filename = this.getMeta("filename");
				if (!filename) return;

				const remoteFile = data.files?.[filename];
				const remoteMarkdown = remoteFile?.content ?? "";

				const etag = response.headers.get("ETag");
				if (etag) {
					this.setMeta("etag", etag);
				}

				const message: CustomMessage = {
					type: MessageTypeReloadRemote,
					payload: { markdown: remoteMarkdown },
				};
				this.broadcastCustomMessage(encodeMessage(message));

				console.log(
					`[GistRoom ${this.name}] Remote is newer, sent reload-remote`,
				);
			}
		} catch (error) {
			console.error(
				`[GistRoom ${this.name}] Staleness check error:`,
				error,
			);
		}
	}

	// ============================================================================
	// Conflict Resolution Handlers
	// ============================================================================

	private async handlePushLocal(connection: Connection): Promise<void> {
		if (!this.isOwnerConnection(connection)) {
			console.log(
				`[GistRoom ${this.name}] Ignoring push-local from non-owner ${connection.id}`,
			);
			return;
		}

		this.autoSyncPaused = false;
		this.retryAttempt = 0;

		const ownerConnection = this.getOwnerConnection();
		if (!ownerConnection) {
			console.log(
				`[GistRoom ${this.name}] No owner connection available for push-local`,
			);
			return;
		}

		const markdown = await this.requestCanonicalMarkdownFromConnection(
			ownerConnection,
		);
		if (markdown && this.ownerToken) {
			await this.syncToGitHub(markdown, { force: true });
		}
	}

	private async handleDiscardLocal(connection: Connection): Promise<void> {
		if (!this.isOwnerConnection(connection)) {
			console.log(
				`[GistRoom ${this.name}] Ignoring discard-local from non-owner ${connection.id}`,
			);
			return;
		}

		this.autoSyncPaused = false;
		this.retryAttempt = 0;

		const remote = await this.fetchRemoteGist();
		if (!remote) return;

		const filename = this.getMeta("filename");
		if (!filename) return;

		const remoteFile = remote.files?.[filename];
		const remoteMarkdown = remoteFile?.content ?? "";

		const message: CustomMessage = {
			type: MessageTypeReloadRemote,
			payload: { markdown: remoteMarkdown },
		};
		this.broadcastCustomMessage(encodeMessage(message));
		this.setMeta("pendingSync", "false");
		this.broadcastSyncStatus("saved");
	}

	// ============================================================================
	// SQLite Schema and Helper Methods
	// ============================================================================

	private ensureSchema(): void {
		this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

		this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS yjs_snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data BLOB NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

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
				key,
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
			value,
		);
	}

	// ---------------------------------------------------------------------------
	// Yjs Snapshot Helpers
	// ---------------------------------------------------------------------------

	private loadSnapshot(): { data: Uint8Array; updatedAt: string } | null {
		try {
			const result = this.ctx.storage.sql.exec(
				`SELECT data, updated_at FROM yjs_snapshot WHERE id = 1`,
			);
			const row = result.one() as {
				data: ArrayBuffer;
				updated_at: string;
			} | null;
			if (row?.data) {
				return {
					data: new Uint8Array(row.data),
					updatedAt: row.updated_at,
				};
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
			data,
		);
		this.snapshotUpdatedAt = new Date().toISOString();
	}

	// ---------------------------------------------------------------------------
	// Canonical Markdown Helpers
	// ---------------------------------------------------------------------------

	private loadCanonicalMarkdown(): string | null {
		try {
			const result = this.ctx.storage.sql.exec(
				`SELECT content FROM canonical_markdown WHERE id = 1`,
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
			markdown,
		);
	}

	// ============================================================================
	// Room Initialization
	// ============================================================================

	async initializeRoom(
		gistId: string,
		filename: string,
		ownerUserId: string,
		editTokenHash: string,
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

	private async requestCanonicalMarkdown(): Promise<string | null> {
		const authorizedConnection = this.getAuthorizedConnection();
		if (!authorizedConnection) {
			console.log(
				`[GistRoom ${this.name}] No authorized connection for markdown request`,
			);
			return null;
		}

		const requestId = crypto.randomUUID();
		const message: CustomMessage = {
			type: MessageTypeRequestMarkdown,
			payload: { requestId },
		};

		this.sendCustomMessage(authorizedConnection, encodeMessage(message));
		console.log(
			`[GistRoom ${this.name}] Requested markdown (requestId: ${requestId})`,
		);

		return new Promise<string | null>((resolve) => {
			const timeout = setTimeout(() => {
				console.log(
					`[GistRoom ${this.name}] Markdown request timeout (requestId: ${requestId})`,
				);
				this.pendingMarkdownRequests.delete(requestId);
				resolve(null);
			}, 5000);

			this.pendingMarkdownRequests.set(requestId, { resolve, timeout });
		});
	}

	private handleCanonicalMarkdown(
		_connection: Connection,
		payload: CanonicalMarkdownPayload,
	): void {
		const pending = this.pendingMarkdownRequests.get(payload.requestId);
		if (pending) {
			clearTimeout(pending.timeout);
			this.pendingMarkdownRequests.delete(payload.requestId);
			this.saveCanonicalMarkdown(payload.markdown);
			console.log(
				`[GistRoom ${this.name}] Saved canonical markdown (${payload.markdown.length} chars)`,
			);
			pending.resolve(payload.markdown);
		} else {
			console.log(
				`[GistRoom ${this.name}] Received markdown for unknown/expired requestId: ${payload.requestId}`,
			);
		}
	}

	private getAuthorizedConnection(): Connection | null {
		for (const connection of this.getConnections()) {
			const cap = this.connectionCapabilities.get(connection.id);
			if (cap?.canEdit) return connection;
		}
		return null;
	}

	private getOwnerConnection(): Connection | null {
		for (const connection of this.getConnections()) {
			if (this.isOwnerConnection(connection)) return connection;
		}
		return null;
	}

	// ============================================================================
	// Edit Capability
	// ============================================================================

	private async checkEditCapability(ctx: ConnectionContext): Promise<boolean> {
		const cookieHeader = ctx.request.headers.get("cookie");
		if (!cookieHeader) return false;

		const match = cookieHeader.match(/gp_edit_cap=([^;]+)/);
		if (!match) return false;

		const gistId = this.getMeta("gistId");
		if (!gistId) return false;

		const payload = await verifyEditCookie(
			match[1],
			gistId,
			this.env.JWT_SECRET,
		);
		return payload !== null;
	}

	private async checkOwner(ctx: ConnectionContext): Promise<boolean> {
		const cookieHeader = ctx.request.headers.get("cookie");
		if (!cookieHeader) return false;

		const sessionMatch = cookieHeader.match(/__session=([^;]+)/);
		if (!sessionMatch) return false;

		const ownerUserId = this.getMeta("ownerUserId");
		if (!ownerUserId) return false;

		try {
			const claims = await verifyJwt(sessionMatch[1], {
				secret: this.env.JWT_SECRET,
				expiresInSeconds: 3600,
				audience: "gist.party",
				issuer: "gist.party",
			});
			return claims.userId === ownerUserId;
		} catch {
			return false;
		}
	}

	private async requestCanonicalMarkdownFromConnection(
		connection: Connection,
	): Promise<string | null> {
		const requestId = crypto.randomUUID();
		const message: CustomMessage = {
			type: MessageTypeRequestMarkdown,
			payload: { requestId },
		};

		this.sendCustomMessage(connection, encodeMessage(message));
		console.log(
			`[GistRoom ${this.name}] Requested markdown from ${connection.id} (requestId: ${requestId})`,
		);

		return new Promise<string | null>((resolve) => {
			const timeout = setTimeout(() => {
				console.log(
					`[GistRoom ${this.name}] Markdown request timeout (requestId: ${requestId})`,
				);
				this.pendingMarkdownRequests.delete(requestId);
				resolve(null);
			}, 5000);

			this.pendingMarkdownRequests.set(requestId, { resolve, timeout });
		});
	}
}

interface GitHubGistFile {
	filename: string;
	content: string;
}

interface GitHubGistResponse {
	files: Record<string, GitHubGistFile>;
	updated_at: string;
}
