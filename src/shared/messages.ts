export enum MessageType {
  RequestMarkdown = "request-markdown",
  CanonicalMarkdown = "canonical-markdown",
  NeedsInit = "needs-init",
  ReloadRemote = "reload-remote",
  RemoteChanged = "remote-changed",
  SyncStatus = "sync-status",
  ErrorRetrying = "error-retrying",
  Conflict = "conflict",
  PushLocal = "push-local",
  DiscardLocal = "discard-local",
}

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
  nextRetryAt: number;
}

export interface ConflictPayload {
  localMarkdown: string;
  remoteMarkdown: string;
}

export type PushLocalPayload = Record<string, never>;
export type DiscardLocalPayload = Record<string, never>;

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

export function encodeMessage(message: CustomMessage): string {
  return JSON.stringify(message);
}

export function decodeMessage(data: string): CustomMessage {
  const parsed = JSON.parse(data);

  if (!parsed.type || !Object.values(MessageType).includes(parsed.type)) {
    throw new Error(`Unknown message type: ${parsed.type}`);
  }

  if (!parsed.payload || typeof parsed.payload !== 'object') {
    throw new Error('Missing or invalid payload');
  }

  return parsed as CustomMessage;
}

export function isClientMessage(message: CustomMessage): boolean {
  return MESSAGE_DIRECTION[message.type] === "client-to-do";
}

export function isDOMessage(message: CustomMessage): boolean {
  return MESSAGE_DIRECTION[message.type] === "do-to-client";
}
