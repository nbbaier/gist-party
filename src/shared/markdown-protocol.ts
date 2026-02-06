import type {
	CanonicalMarkdownPayload,
	NeedsInitPayload,
	ReloadRemotePayload,
	RequestMarkdownPayload,
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

export type {
	RequestMarkdownPayload,
	CanonicalMarkdownPayload,
	NeedsInitPayload,
	ReloadRemotePayload,
};
