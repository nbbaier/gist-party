import type { SyncState } from "./messages";

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

export const INITIAL_SYNC_STATE: SyncState = "saved";

export function nextSyncState(current: SyncState, event: SyncEvent): SyncState {
	const transition = SYNC_TRANSITIONS.find(
		(t) => t.from === current && t.event === event.type,
	);
	return transition?.to ?? current;
}

export const PENDING_SYNC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
