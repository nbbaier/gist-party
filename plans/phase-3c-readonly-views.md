# Track 3C — Read-only Views

> **Goal**: Anonymous users and users without edit capability see rendered markdown. Raw markdown is available via a dedicated endpoint for programmatic consumers.

---

## Prerequisites

- Phase 1B complete: Read-only rendered view component built (remark + rehype + rehype-sanitize pipeline), React Router app shell with `/:gist_id` route
- Phase 1C complete: `GistRoom` DO with `lastCanonicalMarkdown` stored in SQLite, `initialized` flag and `ownerUserId` in SQLite
- Phase 2A complete: Milkdown editor wired with `YProvider`, collab plugin, awareness — full editor experience working
- Phase 1A complete: JWT verify module available for checking auth state

## Depends On / Produces

| Depends On | What It Provides |
|---|---|
| Phase 1B — Read-only rendered view component | Reusable `<MarkdownView>` component with remark + rehype + rehype-sanitize pipeline |
| Phase 1B — React Router app shell (`/:gist_id` route) | Route structure to add view switching logic |
| Phase 1C — DO SQLite with `lastCanonicalMarkdown`, `initialized` flag | Data source for rendered and raw views |
| Phase 2A — Editor integration (Milkdown + YProvider) | Full editor to load for authorized editors |
| Phase 1A — JWT module | Auth state detection for view routing |

| Produces | Consumed By |
|---|---|
| View routing logic (editor vs. read-only) | Phase 3B — Edit permissions (provides the `hasEditCapability` check used here) |
| `GET /:gist_id/raw` endpoint | External consumers (curl, CI, AI agents) |
| 404 page for uninitialized rooms | All phases — consistent behavior for unknown gist IDs |

---

## Tasks

### Task 1: View Routing — Editor vs. Read-only

**Description**: The `/:gist_id` route detects the user's auth state and edit capability to decide whether to render the Milkdown editor (full collab experience) or the read-only rendered markdown view.

**Implementation Details**:

- The routing decision is made client-side after checking two things:
  1. **Auth state**: Is the user authenticated? Check for a valid session JWT cookie. The client can read a non-sensitive auth state indicator (e.g., from a `/api/auth/me` endpoint that returns `{ userId, login, avatarUrl }` or `null`, or from a React context populated on app load).
  2. **Edit capability**: Does the user have a valid edit capability cookie for this gist? The client cannot read `HttpOnly` cookies directly. Instead, the decision is deferred to the server/DO:
     - **Option A (preferred)**: Add a lightweight `GET /api/gists/:gist_id/access` endpoint that returns `{ canEdit: boolean, isOwner: boolean, initialized: boolean }`. This checks the session JWT and edit capability cookie server-side.
     - **Option B**: Always attempt to connect via WebSocket, and the DO's `isReadOnly(connection)` determines access. The provider emits a `readonly` status that the client uses to switch views. This is simpler but wastes a WebSocket connection for anonymous users.

- **Chosen approach**: Use Option A for the initial routing decision. This avoids connecting a WebSocket for anonymous/read-only users entirely.

- Routing logic in the `/:gist_id` route component:
  ```
  1. Call GET /api/gists/:gist_id/access
  2. If response.initialized === false → render <NotHostedPage />
  3. If response.canEdit === true → render <EditorView gistId={gistId} />
  4. If response.canEdit === false → render <ReadOnlyView gistId={gistId} />
  ```

- The `<EditorView>` component initializes `YProvider`, Milkdown, collab plugin, awareness (all existing from Phase 2A)
- The `<ReadOnlyView>` component fetches markdown and renders it through the remark/rehype pipeline (component from Phase 1B)

- Loading state: While the access check is in flight, show a skeleton/spinner. Do not flash between editor and read-only views.

- The access check response should also return basic metadata (title, owner login) for display in both views.

**Files to Create/Modify**:

| File | Action | Details |
|---|---|---|
| `src/server/routes/gists.ts` | Modify | Add `GET /api/gists/:gist_id/access` endpoint. Checks JWT, edit capability cookie, queries DO for `initialized` and `ownerUserId` |
| `src/server/gist-room.ts` | Modify | Add `/internal/check-access` fetch handler: returns `{ initialized, isOwner }` given a `userId` |
| `src/client/routes/gist-page.tsx` | Modify | Replace direct editor render with access-check-based routing. Add loading state |
| `src/client/hooks/useGistAccess.ts` | Create | Custom hook: `useGistAccess(gistId)` → `{ status: "loading" | "ready", canEdit: boolean, isOwner: boolean, initialized: boolean }` |
| `src/client/components/EditorView.tsx` | Create (or extract) | Wraps existing Milkdown + YProvider + collab setup. Accepts `gistId` prop |
| `src/client/components/ReadOnlyView.tsx` | Create | Fetches `lastCanonicalMarkdown` from the API (or raw endpoint) and renders via the `<MarkdownView>` component from Phase 1B |

**Verification**:

1. **Authenticated owner**: Sign in → navigate to `/:gist_id` for an owned gist → verify Milkdown editor loads with collab features
2. **Authenticated with edit capability**: Sign in as collaborator with valid capability cookie → verify editor loads
3. **Authenticated without edit capability**: Sign in but don't claim edit token → navigate to `/:gist_id` → verify read-only rendered view loads (no editor)
4. **Anonymous user**: Open `/:gist_id` in incognito → verify read-only rendered view loads
5. **Uninitialized room**: Navigate to `/:random_id` → verify "Not hosted on gist.party" page
6. **No view flash**: Observe page load — verify no momentary flash of the wrong view (skeleton shown during access check)
7. **Access check response shape**: `curl /api/gists/:gist_id/access` and verify JSON structure: `{ canEdit, isOwner, initialized }`

---

### Task 2: Raw Markdown Endpoint

**Description**: `GET /:gist_id/raw` returns the last canonical markdown from DO SQLite as plain text. Designed for `curl`, scripts, CI pipelines, and AI agents.

**Implementation Details**:

- Route: `GET /:gist_id/raw` (on the Hono router, NOT under `/api/` — this is a public-facing URL)
- No auth required (public endpoint)
- Flow:
  1. Parse `gist_id` from URL params
  2. Forward to the DO via internal fetch: `GET /internal/raw-markdown`
  3. The DO checks `initialized` in SQLite — if `false`, return `404`
  4. The DO reads `lastCanonicalMarkdown` from SQLite
  5. If `lastCanonicalMarkdown` is `null` (room initialized but no content saved yet), return `200` with empty body
  6. Return the markdown string

- Response headers (set by the Worker, not the DO):
  - `Content-Type: text/plain; charset=utf-8`
  - `X-Content-Type-Options: nosniff`
  - `Cache-Control: no-cache`
  - `Referrer-Policy: strict-origin`

- The content may lag behind the live Yjs state by up to one save debounce interval (30s) when editors are connected. This is documented and acceptable.

- For uninitialized rooms, return a `404` response with:
  - `Content-Type: text/plain; charset=utf-8`
  - Body: `Not hosted on gist.party`

- Rate limiting is deferred to Phase 5 (Task 4) but the endpoint should be structured to make it easy to add middleware later

**Files to Create/Modify**:

| File | Action | Details |
|---|---|---|
| `src/server/routes/views.ts` | Create | New route file for public-facing view routes: `GET /:gist_id/raw`. Separate from API routes because these are not under `/api/` |
| `src/server/gist-room.ts` | Modify | Add `/internal/raw-markdown` fetch handler: reads `initialized` and `lastCanonicalMarkdown` from SQLite |
| `src/server/index.ts` | Modify | Mount view routes on the Hono app (after API routes, before SPA catch-all) |

**Verification**:

1. **Happy path**:
   ```sh
   curl -v "http://localhost:8787/<gist_id>/raw"
   ```
   Verify: `200`, `Content-Type: text/plain; charset=utf-8`, body is the markdown string
2. **Response headers**:
   ```sh
   curl -I "http://localhost:8787/<gist_id>/raw"
   ```
   Verify all four headers: `Content-Type`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-cache`, `Referrer-Policy: strict-origin`
3. **Uninitialized room**:
   ```sh
   curl -v "http://localhost:8787/nonexistent-id/raw"
   ```
   Verify: `404`, body is `Not hosted on gist.party`
4. **Empty content** (initialized but no saves yet):
   ```sh
   # Create a gist but don't type anything, then:
   curl "http://localhost:8787/<gist_id>/raw"
   ```
   Verify: `200`, empty body
5. **Content freshness**: Edit the document → wait for save (30s debounce) → `curl` the raw endpoint → verify content matches latest save
6. **No MIME sniffing**: Verify that a browser opening the raw URL does NOT render HTML (even if the markdown contains HTML tags), because `X-Content-Type-Options: nosniff` forces `text/plain` interpretation
7. **Pipe to tools**:
   ```sh
   curl -s "http://localhost:8787/<gist_id>/raw" | wc -l
   curl -s "http://localhost:8787/<gist_id>/raw" | grep "# "
   ```

---

### Task 3: Read-only Rendered View Data Source

**Description**: The read-only rendered view fetches `lastCanonicalMarkdown` from DO SQLite and renders it client-side through the remark + rehype + rehype-sanitize pipeline (using the component built in Phase 1B).

**Implementation Details**:

- The `<ReadOnlyView>` component (created in Task 1) needs a data source. Two options:

  - **Option A**: Fetch from the raw endpoint (`GET /:gist_id/raw`) and render client-side. Simple, reuses the existing endpoint, but adds one more HTTP request.
  - **Option B**: Include the markdown in the access check response (`GET /api/gists/:gist_id/access` returns `{ ..., markdown: string }`). Saves a round-trip but mixes concerns.
  - **Option C (preferred)**: Dedicated `GET /api/gists/:gist_id/content` endpoint that returns `{ markdown: string, updatedAt: string }`. Clean separation, typed response, can include metadata.

- **Chosen approach**: Use Option A (fetch from raw endpoint). It avoids creating another endpoint, and the raw endpoint already exists. The `<ReadOnlyView>` component calls `fetch(\`/${gistId}/raw\`)` and passes the text to the `<MarkdownView>` component.

- Rendering pipeline (in `<MarkdownView>`, built in Phase 1B):
  1. Parse markdown with `remark` (using `remark-parse`)
  2. Convert to HTML with `remark-rehype`
  3. Apply GitHub Flavored Markdown support (`remark-gfm`)
  4. Sanitize with `rehype-sanitize` (using the default schema, which strips raw HTML, scripts, event handlers)
  5. Stringify with `rehype-stringify`
  6. Render the resulting HTML string via `dangerouslySetInnerHTML` (safe because `rehype-sanitize` has stripped all dangerous content)

- Styling: The rendered view should use a clean, readable typography style. Use a CSS class (e.g., `.markdown-body`) for prose styling. Consider using a classnames plugin for rehype to add GitHub-style markdown classes.

- The rendered view should show:
  - The rendered markdown content
  - A header with the gist filename/title
  - A subtle "View on GitHub" link (to `https://gist.github.com/<gist_id>`)
  - A "View raw" link (to `/:gist_id/raw`)
  - If the user is authenticated, a "Sign in to edit" or "Request edit access" prompt (depending on whether they have a session)

- Auto-refresh: The rendered view does NOT auto-refresh. If editors are actively changing the document, the read-only view shows the content as of the last page load. A manual refresh gets the latest `lastCanonicalMarkdown`. (Real-time read-only views via WebSocket are a post-MVP enhancement.)

**Files to Create/Modify**:

| File | Action | Details |
|---|---|---|
| `src/client/components/ReadOnlyView.tsx` | Modify | Fetch from raw endpoint, pass to `<MarkdownView>`, add header with metadata, links |
| `src/client/components/MarkdownView.tsx` | Modify (if needed) | Ensure the Phase 1B component accepts a `markdown: string` prop and runs the full remark/rehype/sanitize pipeline. Add prose styling class |
| `src/client/styles/markdown.css` | Create | Prose typography styles for rendered markdown (`.markdown-body`). Headings, lists, code blocks, tables, blockquotes, links, images |

**Verification**:

1. **Rendered content matches**: Create a gist with rich markdown (headings, bold, lists, code blocks, tables, links) → let it save → open in incognito → verify all elements render correctly
2. **Sanitization**: Create content with raw HTML (`<script>alert(1)</script>`, `<img onerror="alert(1)">`) → verify these are stripped in the rendered view (inspect DOM)
3. **GFM features**: Add a task list, strikethrough, and a table → verify they render correctly in the read-only view
4. **Metadata display**: Verify the header shows the filename/title, "View on GitHub" link, and "View raw" link
5. **View raw link**: Click "View raw" → navigates to `/:gist_id/raw` → shows plain text
6. **View on GitHub link**: Click "View on GitHub" → opens `https://gist.github.com/<gist_id>` in a new tab
7. **Empty document**: Gist with no content → read-only view shows empty state (not a broken page)
8. **Styling**: Verify headings have appropriate sizes, code blocks have monospace font and background, tables have borders, blockquotes have left border styling

---

### Task 4: Uninitialized Room 404 Page

**Description**: If a `gist_id` does not correspond to an initialized room, serve a "Not hosted on gist.party" page for both `/:gist_id` and `/:gist_id/raw`.

**Implementation Details**:

- The 404 behavior is needed in two places:
  1. **Raw endpoint** (`/:gist_id/raw`): Already handled in Task 2 — returns `404` with `text/plain` body "Not hosted on gist.party"
  2. **View route** (`/:gist_id`): Handled by the access check in Task 1 — when `initialized === false`, render a dedicated 404 page component

- Create a `<NotHostedPage>` component:
  - Clean, centered layout
  - Heading: "Not hosted on gist.party"
  - Subtext: "This Gist hasn't been set up for collaborative editing yet."
  - If the user is authenticated: "Want to import this Gist? [Import it →]" button that links to the import flow
  - If the Gist ID looks valid (32-char hex): "This Gist exists on GitHub but isn't hosted here." with a link to `https://gist.github.com/<gist_id>`
  - If the Gist ID looks invalid: "This doesn't look like a valid Gist ID."
  - Link back to home: "← Back to gist.party"

- The DO's `/internal/check-access` handler (from Task 1) returns `initialized: false` for rooms that have never been set up. The DO stub ID is derived from `gist_id`, so calling into the DO for any arbitrary ID is fine — it will simply not find the `initialized` flag.

- Edge case: The DO is created on first request (Cloudflare creates the stub). Make sure querying an uninitialized DO does not accidentally create persistent state. The `/internal/check-access` handler should only read from SQLite, never write. If no rows exist, return `{ initialized: false }`.

**Files to Create/Modify**:

| File | Action | Details |
|---|---|---|
| `src/client/components/NotHostedPage.tsx` | Create | 404 page component with messaging, import CTA (if authed), links |
| `src/client/routes/gist-page.tsx` | Modify | Render `<NotHostedPage>` when access check returns `initialized: false` |
| `src/server/gist-room.ts` | Verify | Ensure `/internal/check-access` is read-only — does not create state for uninitialized rooms |

**Verification**:

1. **Browser 404**:
   ```
   Navigate to http://localhost:5173/nonexistent-gist-id
   ```
   Verify: "Not hosted on gist.party" page renders with appropriate messaging
2. **Raw 404**:
   ```sh
   curl -v "http://localhost:8787/nonexistent-gist-id/raw"
   ```
   Verify: `404` status, body is `Not hosted on gist.party`
3. **Authenticated user sees import CTA**: Sign in → visit uninitialized room → verify "Import it" button is visible
4. **Anonymous user**: Visit uninitialized room in incognito → verify no import button, just informational text
5. **Valid-looking Gist ID**: Visit `/<32-char-hex>` that isn't initialized → verify "exists on GitHub" link
6. **Invalid Gist ID**: Visit `/not-a-gist` → verify "doesn't look like a valid Gist ID" message
7. **No side effects**: Visit an uninitialized room → verify no data is written to the DO's SQLite. Check by visiting the same ID again — it should still return `initialized: false`, not create an empty room.
8. **Initialized room works**: After the 404 test, create/import a gist with that ID → verify the room now serves content (no stale 404 cache)

---

## Track Complete

### Overall Milestone

Anonymous user visits `gist.party/<gist_id>` → sees beautifully rendered markdown with proper typography, sanitized HTML, and metadata links. `curl gist.party/<gist_id>/raw` → gets raw markdown as `text/plain` with correct security headers. Uninitialized room IDs → 404 page with helpful messaging. Authenticated editors see the full Milkdown editor. The view routing decision is seamless with no flashing.

### Verification Checklist

| # | Scenario | Expected Outcome | How to Verify |
|---|---|---|---|
| 1 | Anonymous visit to initialized room | Read-only rendered markdown view | Open in incognito, verify rendered content |
| 2 | Authenticated visit without edit capability | Read-only rendered markdown view | Sign in, don't claim token, visit room |
| 3 | Authenticated visit with edit capability | Milkdown editor with collab | Sign in, claim token, visit room |
| 4 | Owner visit | Milkdown editor | Sign in as owner, visit owned room |
| 5 | `curl /:gist_id/raw` on initialized room | `200`, `text/plain`, markdown content | `curl -v`, inspect headers and body |
| 6 | `curl /:gist_id/raw` on uninitialized room | `404`, "Not hosted on gist.party" | `curl -v`, verify status and body |
| 7 | Browser visit to uninitialized room | 404 page with messaging | Navigate in browser |
| 8 | Raw endpoint security headers | `nosniff`, `no-cache`, `strict-origin` | `curl -I`, verify all headers present |
| 9 | XSS in markdown content | Stripped by `rehype-sanitize` | Add `<script>` tags in content, verify stripped in rendered view |
| 10 | GFM rendering | Tables, task lists, strikethrough render correctly | Create content with GFM features, verify in read-only view |
| 11 | No view flash on page load | Skeleton shown during access check | Observe page load, verify no momentary wrong view |
| 12 | No DO side effects for uninitialized rooms | Read-only check, no data written | Visit unknown ID twice, verify no state created |
