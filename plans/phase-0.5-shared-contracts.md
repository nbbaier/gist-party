# Phase 0.5: Shared Interface Contracts

> **Prerequisite for all Phase 1 work.** These contracts define the type-level boundaries between tracks so that Phase 1 tracks (1A Auth, 1B Editor, 1C GistRoom DO) can diverge and develop independently without integration friction.

Every module in this phase is a **pure type/utility definition** — no business logic, no side effects, no framework coupling. Each must compile cleanly and be importable from both Worker and DO code.

---

## Goal

Produce a set of shared TypeScript modules under `src/shared/` that define:

1. All cross-track data shapes (JWT payloads, message envelopes, DB rows, cookie formats)
2. Reusable crypto primitives (JWT sign/verify, AES-GCM encrypt/decrypt)
3. State machine definitions (sync status)

Phase 1 tracks import these modules and never redefine the shapes locally.

---

## Contract 1: JWT Sign/Verify Module

### Description

A pure WebCrypto JWT module that signs and verifies session tokens. Must run in both the Cloudflare Worker and Durable Object runtimes (no Node.js `crypto` module, no `jsonwebtoken` library). Uses HMAC-SHA256 (`HS256`) for signing.

- **Producer**: Track 1A (Auth System)
- **Consumers**: Track 1C (GistRoom DO — verifies session on WebSocket connection), Track 2B (API routes — auth middleware)

### File: `src/shared/jwt.ts`

```typescript
export interface JwtPayload {
  userId: string;
  login: string;
  avatarUrl: string;
}

export interface JwtClaims extends JwtPayload {
  exp: number;  // Expiration (Unix seconds)
  aud: string;  // Audience — "gist.party"
  iss: string;  // Issuer — "gist.party"
  iat: number;  // Issued at (Unix seconds)
}

export interface JwtOptions {
  secret: string;        // HMAC-SHA256 signing key (Workers secret)
  expiresInSeconds: number;  // TTL for new tokens (e.g., 3600 for 1 hour)
  audience: string;      // Expected `aud` claim
  issuer: string;        // Expected `iss` claim
}

/**
 * Sign a JWT with the given payload and options.
 * Returns the compact JWS string (header.payload.signature).
 */
export function signJwt(payload: JwtPayload, options: JwtOptions): Promise<string>;

/**
 * Verify and decode a JWT.
 * Throws on invalid signature, expired token, or mismatched aud/iss.
 */
export function verifyJwt(token: string, options: JwtOptions): Promise<JwtClaims>;
```

### Verification

- [ ] `tsc --noEmit` passes with no errors
- [ ] Module can be imported from a Worker entry point (`src/worker/index.ts`)
- [ ] Module can be imported from a DO entry point (`src/server/gist-room.ts`)
- [ ] Unit tests: sign → verify round-trip succeeds
- [ ] Unit tests: expired token throws
- [ ] Unit tests: wrong secret throws
- [ ] Unit tests: mismatched `aud` or `iss` throws
- [ ] No `import` of `node:crypto`, `jsonwebtoken`, or any Node-only module

---

## Contract 2: Token Encryption Module

### Description

AES-GCM encryption/decryption for GitHub access tokens stored in Workers KV. Uses WebCrypto exclusively. Supports versioned key prefixes so encryption keys can be rotated without invalidating existing ciphertexts.

Format: `v<version>:<base64url-iv>:<base64url-ciphertext>`

On read, the version prefix selects the correct decryption key. On write, always encrypt under the current key version. Callers implement the "re-encrypt on next write" logic — this module just provides the primitives.

- **Producer**: Track 1A (Auth System)
- **Consumers**: Track 1C (GistRoom DO — decrypts owner token to call GitHub API), Track 2B (API routes — encrypts token on OAuth callback)

### File: `src/shared/encryption.ts`

```typescript
export interface EncryptionKey {
  version: number;     // e.g., 1
  rawKey: string;      // Base64-encoded 256-bit AES key (Workers secret)
}

export interface EncryptionConfig {
  currentKey: EncryptionKey;
  previousKeys: EncryptionKey[];  // For decrypting old versions during rotation
}

export interface EncryptedBlob {
  version: number;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * Encrypt a plaintext string under the current key version.
 * Returns the formatted string: `v<version>:<base64url-iv>:<base64url-ciphertext>`
 */
export function encrypt(plaintext: string, config: EncryptionConfig): Promise<string>;

/**
 * Decrypt a formatted encrypted string.
 * Parses the version prefix, selects the correct key, and decrypts.
 * Throws if the version is unknown or decryption fails.
 */
export function decrypt(encrypted: string, config: EncryptionConfig): Promise<string>;

/**
 * Parse a formatted encrypted string into its components.
 * Useful for checking if re-encryption is needed (version < currentKey.version).
 */
export function parseEncryptedBlob(encrypted: string): EncryptedBlob;

/**
 * Check whether an encrypted blob needs re-encryption under the current key.
 */
export function needsReEncryption(encrypted: string, config: EncryptionConfig): boolean;
```

### Verification

- [ ] `tsc --noEmit` passes with no errors
- [ ] Module can be imported from both Worker and DO code
- [ ] Unit tests: encrypt → decrypt round-trip succeeds
- [ ] Unit tests: decrypt with previous key version succeeds
- [ ] Unit tests: decrypt with unknown version throws
- [ ] Unit tests: `needsReEncryption` returns `true` for old versions
- [ ] Unit tests: `parseEncryptedBlob` correctly extracts version, IV, ciphertext
- [ ] No Node-only imports

---

## Contract 3: DO SQLite Schema

### Description

Defines the SQLite table schema for GistRoom Durable Object storage, plus TypeScript row types for type-safe queries. The schema covers room metadata, sync state, and the Yjs snapshot blob.

- **Producer**: Track 1C (GistRoom DO — creates tables, writes rows)
- **Consumers**: Track 2B (API routes — reads metadata via DO RPC or stub), Track 3A (GitHub sync — reads/writes sync state), Track 3B (edit permissions — reads `editTokenHash`)

### File: `src/shared/schema.ts`

```typescript
/**
 * SQL DDL for the GistRoom DO SQLite database.
 * Execute via `this.ctx.storage.sql.exec()` in the DO constructor or onStart().
 */
export const GIST_ROOM_SCHEMA = `
  CREATE TABLE IF NOT EXISTS room_meta (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    gist_id      TEXT NOT NULL,
    filename     TEXT NOT NULL,
    etag         TEXT,
    updated_at   TEXT,
    edit_token_hash TEXT,
    last_saved_at TEXT,
    pending_sync  INTEGER NOT NULL DEFAULT 0,
    pending_since TEXT,
    initialized   INTEGER NOT NULL DEFAULT 0,
    owner_user_id TEXT NOT NULL,
    last_canonical_markdown TEXT
  );

  CREATE TABLE IF NOT EXISTS yjs_snapshot (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    snapshot BLOB NOT NULL,
    saved_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

/** TypeScript representation of a `room_meta` row. */
export interface RoomMeta {
  id: 1;
  gist_id: string;
  filename: string;
  etag: string | null;
  updated_at: string | null;
  edit_token_hash: string | null;
  last_saved_at: string | null;
  pending_sync: 0 | 1;
  pending_since: string | null;
  initialized: 0 | 1;
  owner_user_id: string;
  last_canonical_markdown: string | null;
}

/** TypeScript representation of a `yjs_snapshot` row. */
export interface YjsSnapshot {
  id: 1;
  snapshot: ArrayBuffer;
  saved_at: string;
}
```

### Verification

- [ ] `tsc --noEmit` passes with no errors
- [ ] Schema SQL is valid SQLite (test with a local SQLite driver or Miniflare)
- [ ] `RoomMeta` fields match the SQL columns 1:1
- [ ] `YjsSnapshot.snapshot` typed as `ArrayBuffer` (compatible with DO SQLite blob handling)
- [ ] Single-row constraint (`CHECK (id = 1)`) is present on both tables

---

## Contract 4: Edit Capability Cookie Format

### Description

Defines the cookie name, attributes, validation logic, and TypeScript types for the edit capability cookie. This cookie is issued by `POST /api/gists/:gist_id/claim` and validated by the GistRoom DO's `isReadOnly()` method.

- **Producer**: Track 3B (Edit Permissions — issues cookie on claim)
- **Consumers**: Track 1C (GistRoom DO — `isReadOnly()` reads and validates the cookie)

### File: `src/shared/edit-cookie.ts`

```typescript
/**
 * Cookie name for the edit capability token.
 * Path-scoped to the specific gist room to prevent cross-room leakage.
 */
export const EDIT_COOKIE_NAME = "gp_edit_cap";

export interface EditCookieOptions {
  gistId: string;
}

export interface EditCookieAttributes {
  name: typeof EDIT_COOKIE_NAME;
  path: string;       // `/parties/gist-room/${gistId}`
  httpOnly: true;
  secure: true;
  sameSite: "Strict";
  maxAge: number;      // 86400 (24 hours in seconds)
}

/**
 * Build the cookie attributes for a given gist ID.
 */
export function buildEditCookieAttributes(options: EditCookieOptions): EditCookieAttributes;

/**
 * Build the cookie path for a given gist ID.
 */
export function editCookiePath(gistId: string): string;

/**
 * The cookie value is a signed token (JWT or HMAC-signed payload)
 * containing the gist ID and an expiration. This type represents
 * the decoded payload.
 */
export interface EditCookiePayload {
  gistId: string;
  expiresAt: number;  // Unix seconds
}

/**
 * Create a signed edit capability cookie value.
 */
export function signEditCookie(payload: EditCookiePayload, secret: string): Promise<string>;

/**
 * Verify and decode an edit capability cookie value.
 * Returns null if invalid or expired (does not throw).
 */
export function verifyEditCookie(
  cookieValue: string,
  gistId: string,
  secret: string
): Promise<EditCookiePayload | null>;

/** 24 hours in seconds */
export const EDIT_COOKIE_TTL = 86400;
```

### Verification

- [ ] `tsc --noEmit` passes with no errors
- [ ] `editCookiePath("abc123")` returns `"/parties/gist-room/abc123"`
- [ ] `buildEditCookieAttributes` returns correct attribute object
- [ ] Unit tests: sign → verify round-trip succeeds
- [ ] Unit tests: expired cookie returns `null`
- [ ] Unit tests: cookie for wrong `gistId` returns `null`
- [ ] Unit tests: tampered cookie returns `null`
- [ ] Cookie attributes enforce HttpOnly, Secure, SameSite=Strict

---

## Contract 5: Custom Message Protocol

### Description

Defines the message type enum, payload shapes, and type-safe encode/decode functions for all non-Yjs messages sent over the WebSocket connection between clients and the GistRoom DO. Messages are serialized as JSON.

- **Producer**: Track 1C (GistRoom DO — sends DO→client messages)
- **Consumers**: Track 2A (collab — client handles messages), Track 4B (status UI — reacts to sync status)

### File: `src/shared/messages.ts`

```typescript
/** All custom message types in the protocol. */
export enum MessageType {
  /** DO → client: Request canonical markdown from an authorized client. */
  RequestMarkdown = "request-markdown",
  /** Client → DO: Response with canonical markdown string. */
  CanonicalMarkdown = "canonical-markdown",
  /** DO → client: Room is initialized but has no Yjs snapshot; client should fetch and load content. */
  NeedsInit = "needs-init",
  /** DO → client: Remote is newer and no pending sync; client should reset editor. */
  ReloadRemote = "reload-remote",
  /** DO → client: GitHub PATCH returned 412; includes remote content for diff. */
  RemoteChanged = "remote-changed",
  /** DO → client: Sync status update. */
  SyncStatus = "sync-status",
  /** DO → client: GitHub API error with backoff info. */
  ErrorRetrying = "error-retrying",
  /** DO → client: Conflict detected; includes both versions for resolution. */
  Conflict = "conflict",
  /** Client → DO: Owner chooses to force-push local state to GitHub. */
  PushLocal = "push-local",
  /** Client → DO: Owner chooses to discard local and reload remote. */
  DiscardLocal = "discard-local",
}

// --- Payload shapes ---

export interface RequestMarkdownPayload {
  requestId: string;
}

export interface CanonicalMarkdownPayload {
  requestId: string;
  markdown: string;
}

export interface NeedsInitPayload {
  gistId: string;
  filename: string;
}

export interface ReloadRemotePayload {
  markdown: string;
}

export interface RemoteChangedPayload {
  remoteMarkdown: string;
}

export type SyncState =
  | "saved"
  | "saving"
  | "error-retrying"
  | "pending-sync"
  | "conflict";

export interface SyncStatusPayload {
  state: SyncState;
  detail?: string;
}

export interface ErrorRetryingPayload {
  attempt: number;
  nextRetryAt: number;  // Unix milliseconds
}

export interface ConflictPayload {
  localMarkdown: string;
  remoteMarkdown: string;
}

// PushLocal and DiscardLocal have empty payloads
export type PushLocalPayload = Record<string, never>;
export type DiscardLocalPayload = Record<string, never>;

// --- Discriminated union of all messages ---

export type CustomMessage =
  | { type: MessageType.RequestMarkdown; payload: RequestMarkdownPayload }
  | { type: MessageType.CanonicalMarkdown; payload: CanonicalMarkdownPayload }
  | { type: MessageType.NeedsInit; payload: NeedsInitPayload }
  | { type: MessageType.ReloadRemote; payload: ReloadRemotePayload }
  | { type: MessageType.RemoteChanged; payload: RemoteChangedPayload }
  | { type: MessageType.SyncStatus; payload: SyncStatusPayload }
  | { type: MessageType.ErrorRetrying; payload: ErrorRetryingPayload }
  | { type: MessageType.Conflict; payload: ConflictPayload }
  | { type: MessageType.PushLocal; payload: PushLocalPayload }
  | { type: MessageType.DiscardLocal; payload: DiscardLocalPayload };

/** Message direction for documentation/runtime validation. */
export type MessageDirection = "do-to-client" | "client-to-do";

export const MESSAGE_DIRECTION: Record<MessageType, MessageDirection> = {
  [MessageType.RequestMarkdown]: "do-to-client",
  [MessageType.CanonicalMarkdown]: "client-to-do",
  [MessageType.NeedsInit]: "do-to-client",
  [MessageType.ReloadRemote]: "do-to-client",
  [MessageType.RemoteChanged]: "do-to-client",
  [MessageType.SyncStatus]: "do-to-client",
  [MessageType.ErrorRetrying]: "do-to-client",
  [MessageType.Conflict]: "do-to-client",
  [MessageType.PushLocal]: "client-to-do",
  [MessageType.DiscardLocal]: "client-to-do",
};

/**
 * Encode a custom message to a JSON string for sending over WebSocket.
 */
export function encodeMessage(message: CustomMessage): string;

/**
 * Decode a JSON string into a typed CustomMessage.
 * Throws if the message is malformed or has an unknown type.
 */
export function decodeMessage(data: string): CustomMessage;

/**
 * Type guard: is this a client-to-DO message?
 */
export function isClientMessage(message: CustomMessage): boolean;

/**
 * Type guard: is this a DO-to-client message?
 */
export function isDOMessage(message: CustomMessage): boolean;
```

### Verification

- [ ] `tsc --noEmit` passes with no errors
- [ ] `encodeMessage` → `decodeMessage` round-trip preserves type and payload
- [ ] `decodeMessage` throws on unknown message types
- [ ] `decodeMessage` throws on malformed JSON
- [ ] `MESSAGE_DIRECTION` covers all `MessageType` values (enforced by `Record<MessageType, ...>`)
- [ ] Discriminated union allows exhaustive `switch` on `message.type`
- [ ] No runtime dependencies beyond JSON

---

## Contract 6: Markdown Serialization Protocol

### Description

Documents the markdown serialization protocol as a type-level contract. This is not a standalone module with runtime logic — it's a specification codified in types that the DO and client both import. The key invariant: **the DO never parses or generates markdown**. All markdown flows through connected authorized clients.

- **Producer**: Track 1C (GistRoom DO — initiates the request)
- **Consumers**: Track 2A (collab — client fulfills the request)

### File: `src/shared/markdown-protocol.ts`

```typescript
import type {
  RequestMarkdownPayload,
  CanonicalMarkdownPayload,
  NeedsInitPayload,
  ReloadRemotePayload,
} from "./messages";

/**
 * The markdown serialization protocol.
 *
 * Lifecycle:
 *
 * 1. DO `onSave()` fires (debounced, 30s).
 * 2. If owner is connected, DO sends `request-markdown` with a unique `requestId`
 *    to ONE authorized client.
 * 3. Client calls `getMarkdown()` on the Milkdown editor and responds with
 *    `canonical-markdown` containing the `requestId` and markdown string.
 * 4. DO stores the markdown in `last_canonical_markdown` and proceeds to
 *    PATCH GitHub (if applicable).
 * 5. If no response within `MARKDOWN_REQUEST_TIMEOUT_MS`, DO skips the
 *    GitHub PATCH for this cycle.
 *
 * On initialization:
 *
 * 1. DO `onLoad()` finds no Yjs snapshot for an initialized room.
 * 2. DO sends `needs-init` to the first connecting authorized client.
 * 3. Client fetches the Gist content via API, loads it as `defaultValue`.
 * 4. Yjs updates flow back to the DO naturally.
 *
 * On reload-remote:
 *
 * 1. Staleness check finds remote is newer and no pending sync.
 * 2. DO sends `reload-remote` with the fresh markdown.
 * 3. Client resets the editor with this markdown as `defaultValue`.
 * 4. Yjs updates flow back to the DO, replacing the old state.
 */

/** Timeout for waiting on a `canonical-markdown` response. */
export const MARKDOWN_REQUEST_TIMEOUT_MS = 5000;

/**
 * Re-export the relevant message payloads so consumers of this protocol
 * only need to import from one place.
 */
export type {
  RequestMarkdownPayload,
  CanonicalMarkdownPayload,
  NeedsInitPayload,
  ReloadRemotePayload,
};
```

### Verification

- [ ] `tsc --noEmit` passes with no errors
- [ ] Re-exports resolve correctly (no circular dependencies)
- [ ] `MARKDOWN_REQUEST_TIMEOUT_MS` is exported as a const (5000)
- [ ] Protocol documentation in JSDoc is accurate per the spec

---

## Contract 7: Sync Status State Machine

### Description

Defines the sync status state machine as a pure data structure with states, transitions, and the events that trigger them. The DO emits events via custom messages; the client UI consumes them to render the status bar, banners, and modals.

- **Producer**: Track 3A (GitHub Sync — triggers transitions via DO events)
- **Consumers**: Track 4B (Status UI — renders state)

### File: `src/shared/sync-state.ts`

```typescript
import type { SyncState } from "./messages";

/** Events that trigger state transitions. */
export type SyncEvent =
  | { type: "save-started" }
  | { type: "save-succeeded" }
  | { type: "save-failed"; attempt: number; nextRetryAt: number }
  | { type: "owner-disconnected" }
  | { type: "owner-reconnected" }
  | { type: "remote-changed"; remoteMarkdown: string }
  | { type: "conflict-detected"; localMarkdown: string; remoteMarkdown: string }
  | { type: "conflict-resolved" }
  | { type: "manual-retry" };

/**
 * State machine transition table.
 *
 * ```
 *                    save-started
 *   ┌──── Saved ──────────────────► Saving
 *   │       ▲                        │
 *   │       │ save-succeeded         │ save-failed
 *   │       │                        ▼
 *   │       │                    Error Retrying
 *   │       │                        │
 *   │       │ manual-retry /         │ save-succeeded
 *   │       │ save-succeeded         │
 *   │       └────────────────────────┘
 *   │
 *   │  owner-disconnected (from Saving)
 *   │       │
 *   │       ▼
 *   │  Pending Sync
 *   │       │
 *   │       │ owner-reconnected → Saving
 *   │
 *   │  remote-changed (from any save state)
 *   │       │
 *   │       ▼
 *   │  Remote Changed ──► conflict-detected ──► Conflict
 *   │                                              │
 *   │                        conflict-resolved     │
 *   └──────────────────────────────────────────────┘
 * ```
 */
export interface SyncTransition {
  from: SyncState;
  event: SyncEvent["type"];
  to: SyncState;
}

export const SYNC_TRANSITIONS: SyncTransition[] = [
  { from: "saved", event: "save-started", to: "saving" },
  { from: "saving", event: "save-succeeded", to: "saved" },
  { from: "saving", event: "save-failed", to: "error-retrying" },
  { from: "saving", event: "owner-disconnected", to: "pending-sync" },
  { from: "saving", event: "remote-changed", to: "conflict" },
  { from: "error-retrying", event: "save-succeeded", to: "saved" },
  { from: "error-retrying", event: "manual-retry", to: "saving" },
  { from: "error-retrying", event: "save-failed", to: "error-retrying" },
  { from: "pending-sync", event: "owner-reconnected", to: "saving" },
  { from: "pending-sync", event: "remote-changed", to: "conflict" },
  { from: "conflict", event: "conflict-resolved", to: "saving" },
];

/** Initial state for a freshly initialized room. */
export const INITIAL_SYNC_STATE: SyncState = "saved";

/**
 * Pure state machine reducer.
 * Returns the new state, or the current state if the transition is invalid.
 */
export function nextSyncState(current: SyncState, event: SyncEvent): SyncState;

/**
 * Pending sync durability: max age before unsynced snapshot is discarded.
 */
export const PENDING_SYNC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
```

### Verification

- [ ] `tsc --noEmit` passes with no errors
- [ ] `nextSyncState` handles all defined transitions
- [ ] `nextSyncState` returns current state for undefined transitions (no-op)
- [ ] Unit tests: walk through full happy path (`saved → saving → saved`)
- [ ] Unit tests: walk through error path (`saving → error-retrying → saving → saved`)
- [ ] Unit tests: walk through conflict path (`saving → conflict → saving → saved`)
- [ ] Unit tests: walk through pending sync path (`saving → pending-sync → saving → saved`)
- [ ] `SYNC_TRANSITIONS` covers all edges in the state diagram
- [ ] `PENDING_SYNC_MAX_AGE_MS` equals 30 days in milliseconds

---

## Phase Complete

When this phase is done, the following files must exist with the listed exports:

| File | Exports |
|------|---------|
| `src/shared/jwt.ts` | `JwtPayload`, `JwtClaims`, `JwtOptions`, `signJwt`, `verifyJwt` |
| `src/shared/encryption.ts` | `EncryptionKey`, `EncryptionConfig`, `EncryptedBlob`, `encrypt`, `decrypt`, `parseEncryptedBlob`, `needsReEncryption` |
| `src/shared/schema.ts` | `GIST_ROOM_SCHEMA`, `RoomMeta`, `YjsSnapshot` |
| `src/shared/edit-cookie.ts` | `EDIT_COOKIE_NAME`, `EDIT_COOKIE_TTL`, `EditCookieOptions`, `EditCookieAttributes`, `EditCookiePayload`, `buildEditCookieAttributes`, `editCookiePath`, `signEditCookie`, `verifyEditCookie` |
| `src/shared/messages.ts` | `MessageType`, all payload interfaces, `CustomMessage`, `MessageDirection`, `MESSAGE_DIRECTION`, `encodeMessage`, `decodeMessage`, `isClientMessage`, `isDOMessage` |
| `src/shared/markdown-protocol.ts` | `MARKDOWN_REQUEST_TIMEOUT_MS`, re-exports of `RequestMarkdownPayload`, `CanonicalMarkdownPayload`, `NeedsInitPayload`, `ReloadRemotePayload` |
| `src/shared/sync-state.ts` | `SyncEvent`, `SyncTransition`, `SYNC_TRANSITIONS`, `INITIAL_SYNC_STATE`, `nextSyncState`, `PENDING_SYNC_MAX_AGE_MS` |

### Global verification

- [ ] `tsc --noEmit` passes across the entire project
- [ ] No circular dependencies between shared modules
- [ ] No Node-only imports in any `src/shared/` file
- [ ] Every module can be imported from both `src/worker/` and `src/server/` entry points
- [ ] All unit tests pass
