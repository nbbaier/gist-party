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

export interface YjsSnapshot {
  id: 1;
  snapshot: ArrayBuffer;
  saved_at: string;
}
