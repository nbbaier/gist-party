# Track 3B — Edit Permissions

> **Goal**: Capability-based edit tokens control who can write. Connections without a valid edit capability cookie are read-only — incoming Yjs updates and awareness updates are silently dropped.

---

## Prerequisites

- Phase 1C complete: `GistRoom` DO with SQLite schema including `editTokenHash` column, `isReadOnly(connection)` stub (returns `false` for all — to be replaced here)
- Phase 1A complete: JWT sign/verify module (for auth middleware on claim/edit-token endpoints)
- Phase 2B complete: `POST /api/gists` and `POST /api/gists/:gist_id/import` generate initial `editTokenHash` and store in DO SQLite alongside `ownerUserId`
- Phase 2A complete: Client-side `YProvider` connection established, custom message send/receive wired
- Auth middleware available on Hono routes (from Phase 2B)
- CSRF protection deferred to Phase 5 (Task 2) — endpoints are functional but not CSRF-hardened yet

## Depends On / Produces

| Depends On | What It Provides |
|---|---|
| Phase 1C — `GistRoom` DO (SQLite schema with `editTokenHash`, `ownerUserId`, `isReadOnly` stub) | Replaces `isReadOnly` with real cookie validation |
| Phase 1A — JWT module | Auth middleware for claim and edit-token endpoints |
| Phase 2B — API routes (room initialization stores `editTokenHash`) | Existing edit token hashes to validate against |
| Phase 2A — Client-side YProvider + custom messages | Client extracts fragment token, connects with cookie |

| Produces | Consumed By |
|---|---|
| Edit capability cookie format (shared contract) | Phase 3C — View routing (detect edit capability) |
| `isReadOnly(connection)` enforcement | All phases — determines write access for all connections |
| `POST /api/gists/:gist_id/claim` endpoint | Client-side token exchange flow |
| `POST /api/gists/:gist_id/edit-token` endpoint | Owner UX for sharing and revoking edit links |
| Revocation via WebSocket disconnect | Phase 4B — Sync Status UI (revocation feedback) |

---

## Tasks

### Task 1: `POST /api/gists/:gist_id/claim` — Token Claim Endpoint

**Description**: Authenticated users exchange a raw edit token (from the URL fragment) for a short-lived edit capability cookie. The server hashes the token with SHA-256 and compares against the hash stored in the DO.

**Implementation Details**:

- Route: `POST /api/gists/:gist_id/claim`
- Auth: Required (JWT cookie must be present and valid)
- Request body: `{ "token": "<raw_edit_token>" }`
- Validation:
  1. Parse `gist_id` from URL params
  2. Parse `token` from JSON body — reject if missing or not a string
  3. Hash the token: `SHA-256(token)` using WebCrypto (`crypto.subtle.digest("SHA-256", encoder.encode(token))`)
  4. Convert hash to hex string for comparison
  5. Forward the hash to the DO for validation: call the DO via `this.env.GIST_ROOM.get(id).fetch()` with an internal RPC-style request (e.g., `POST /internal/validate-edit-token` with `{ hash }`)
  6. The DO compares `hash === this.editTokenHash` from SQLite
  7. If match: return a success signal to the Worker
  8. If no match: return 403 `{ "error": "Invalid edit token" }`

- On success, set the edit capability cookie:
  - Name: `__edit_cap_<gist_id>` (unique per gist to avoid collisions)
  - Value: a signed, short-lived JWT containing `{ gistId, userId, cap: "edit" }` signed with the same secret as session JWTs (or a separate capability secret)
  - `HttpOnly: true`
  - `Secure: true`
  - `SameSite: Strict`
  - `Path: /parties/gist-room/<gist_id>` (scoped to the WebSocket path for this specific gist)
  - `Max-Age: 86400` (24 hours)

- The capability cookie value is a JWT (not a random token) so the DO can verify it independently without a network call during WebSocket connection

- Response: `200 OK` with `{ "ok": true }`

**Files to Create/Modify**:

| File | Action | Details |
|---|---|---|
| `src/server/routes/gists.ts` | Modify | Add `POST /api/gists/:gist_id/claim` route |
| `src/server/gist-room.ts` | Modify | Add internal `/internal/validate-edit-token` fetch handler (in the DO's `onRequest()` or equivalent) |
| `src/shared/edit-capability.ts` | Create | Shared module: `signEditCapability(gistId, userId, secret)` → JWT string, `verifyEditCapability(jwt, gistId, secret)` → `{ userId }` or null. Cookie name helper: `editCapCookieName(gistId)` |
| `src/server/constants.ts` | Modify | Add `EDIT_CAP_COOKIE_TTL = 86400`, `EDIT_CAP_COOKIE_PREFIX = "__edit_cap_"` |

**Verification**:

1. Create a gist (get back `edit_token`), then claim it:
   ```sh
   # Create
   TOKEN=$(curl -s -X POST https://localhost:8787/api/gists \
     -H "Cookie: __session=<jwt>" \
     -H "Content-Type: application/json" | jq -r '.edit_token')

   GIST_ID=$(curl -s -X POST https://localhost:8787/api/gists \
     -H "Cookie: __session=<jwt>" \
     -H "Content-Type: application/json" | jq -r '.gist_id')

   # Claim
   curl -v -X POST "https://localhost:8787/api/gists/${GIST_ID}/claim" \
     -H "Cookie: __session=<jwt>" \
     -H "Content-Type: application/json" \
     -d "{\"token\": \"${TOKEN}\"}"
   ```
2. Verify response is `200` with `Set-Cookie` header containing `__edit_cap_<gist_id>=<jwt>; HttpOnly; Secure; SameSite=Strict; Path=/parties/gist-room/<gist_id>; Max-Age=86400`
3. Verify invalid token returns `403`:
   ```sh
   curl -v -X POST "https://localhost:8787/api/gists/${GIST_ID}/claim" \
     -H "Cookie: __session=<jwt>" \
     -H "Content-Type: application/json" \
     -d '{"token": "wrong-token"}'
   ```
4. Verify missing auth returns `401`
5. Verify missing/empty body returns `400`

---

### Task 2: `POST /api/gists/:gist_id/edit-token` — Token Revocation & Regeneration

**Description**: Owner-only endpoint. Revokes the current edit token, kicks all editor WebSocket connections using the old token, and generates a new token.

**Implementation Details**:

- Route: `POST /api/gists/:gist_id/edit-token`
- Auth: Required, owner only (JWT `userId` must match `ownerUserId` in DO SQLite)
- Flow:
  1. Verify the requesting user is the owner: forward an ownership check to the DO via internal fetch
  2. Generate a new cryptographically random edit token: `crypto.getRandomValues(new Uint8Array(32))` → base64url encode → 43-char URL-safe string
  3. Hash with SHA-256 → hex string
  4. Send the new hash to the DO via internal fetch: `POST /internal/rotate-edit-token` with `{ newHash }`
  5. In the DO:
     a. Update `editTokenHash` in SQLite to the new hash
     b. Iterate all active WebSocket connections
     c. For each connection that has an edit capability cookie, verify the cookie — if the cookie was signed for the old token's validity period (or simply: re-validate all edit capability cookies — they will still be "valid" JWTs but the DO should now reject them because the underlying token was revoked)
     d. **Simpler approach**: The DO tracks a `tokenVersion: number` in SQLite (incremented on each rotation). The edit capability JWT includes `tokenVersion`. On rotation, increment `tokenVersion`. `isReadOnly()` checks `jwt.tokenVersion === this.currentTokenVersion`. After rotation, all existing capability cookies become invalid.
     e. Close all connections where `isReadOnly(connection)` now returns `true` (they lost edit capability). Use WebSocket close code `4001` with reason `"Edit token revoked"`.
  6. Return `{ "edit_token": "<new_raw_token>" }` to the owner

- Response: `200 OK` with `{ "edit_token": "<new_token>" }`

**Files to Create/Modify**:

| File | Action | Details |
|---|---|---|
| `src/server/routes/gists.ts` | Modify | Add `POST /api/gists/:gist_id/edit-token` route |
| `src/server/gist-room.ts` | Modify | Add `/internal/rotate-edit-token` handler, add `tokenVersion` to state, add connection eviction logic |
| `src/shared/edit-capability.ts` | Modify | Include `tokenVersion` in capability JWT payload. `verifyEditCapability` accepts `expectedTokenVersion` param |
| `src/server/utils/crypto.ts` | Create (or modify) | `generateEditToken()` → `{ raw: string, hash: string }`. Uses `crypto.getRandomValues` + base64url encoding + SHA-256 hashing |

**Verification**:

1. Create a gist, claim the edit token as a second user (collaborator)
2. Verify collaborator has write access (WebSocket edits accepted)
3. Owner calls `POST /api/gists/:gist_id/edit-token`:
   ```sh
   NEW_TOKEN=$(curl -s -X POST "https://localhost:8787/api/gists/${GIST_ID}/edit-token" \
     -H "Cookie: __session=<owner_jwt>" \
     -H "Content-Type: application/json" | jq -r '.edit_token')
   ```
4. Verify collaborator's WebSocket is closed with code `4001` and reason `"Edit token revoked"`
5. Verify collaborator can no longer connect with edit access (old capability cookie is rejected)
6. Verify collaborator can claim the new token and regain edit access:
   ```sh
   curl -v -X POST "https://localhost:8787/api/gists/${GIST_ID}/claim" \
     -H "Cookie: __session=<collab_jwt>" \
     -H "Content-Type: application/json" \
     -d "{\"token\": \"${NEW_TOKEN}\"}"
   ```
7. Verify non-owner calling this endpoint gets `403`

---

### Task 3: `isReadOnly(connection)` — WebSocket Write Access Enforcement

**Description**: Replace the `isReadOnly()` stub with real edit capability cookie validation. Read-only connections have Yjs updates and awareness updates silently dropped by `YServer`.

**Implementation Details**:

- `YServer` calls `isReadOnly(connection)` to decide whether to apply incoming Yjs updates. Return `true` to drop updates silently.

- Cookie extraction: When a WebSocket upgrade request arrives, the cookies are available on the initial HTTP request. `partyserver` / `y-partyserver` makes the original request available on the connection object (e.g., `connection.request` or via `onConnect(connection)` where you can read headers). Extract the edit capability cookie from `Cookie` header.

- Validation logic:
  1. Parse `Cookie` header from the connection's initial request
  2. Look for `__edit_cap_<gistId>` cookie
  3. If missing → `isReadOnly = true`
  4. Decode the cookie value as a JWT using `verifyEditCapability(jwt, gistId, secret)`
  5. Check `jwt.tokenVersion === this.currentTokenVersion` (from DO SQLite)
  6. Check `jwt.gistId === this.gistId`
  7. If all checks pass → `isReadOnly = false`
  8. If any check fails → `isReadOnly = true`

- Cache the read-only status per connection to avoid re-parsing the cookie on every message. Store it on the connection object: `(connection as any).__isReadOnly = result`

- **Owner bypass**: If the connecting user's `userId` (from the session JWT in the `Cookie` header) matches `ownerUserId`, always return `isReadOnly = false` — the owner does not need an edit capability cookie

- **Awareness rejection**: Override the awareness broadcast to skip awareness updates from read-only connections. `YServer` may handle this automatically if `isReadOnly` is implemented, but verify — if not, intercept awareness messages in `onCustomMessage` or the equivalent hook

**Files to Create/Modify**:

| File | Action | Details |
|---|---|---|
| `src/server/gist-room.ts` | Modify | Replace `isReadOnly()` stub. Add cookie parsing, JWT verification, owner bypass, caching on connection object |
| `src/shared/edit-capability.ts` | Import | Use `verifyEditCapability`, `editCapCookieName` |
| `src/server/utils/cookie.ts` | Create | `parseCookies(cookieHeader: string): Record<string, string>` utility |

**Verification**:

1. **Editor with valid capability**: Claim edit token → connect WebSocket → type in editor → verify changes are broadcast to other clients and persisted
2. **Read-only without capability**: Connect WebSocket without claiming edit token → type in editor → verify changes are NOT broadcast and NOT persisted (Yjs state on DO remains unchanged)
3. **Read-only awareness**: Connect without capability → verify cursor/selection awareness updates are not visible to other clients
4. **Owner without capability cookie**: Connect as owner (session JWT present, no capability cookie) → verify edits are accepted (owner bypass)
5. **Expired capability cookie**: Manually set a capability cookie with `exp` in the past → connect → verify treated as read-only
6. **Wrong gist_id in cookie**: Craft a capability cookie for a different gist → connect → verify treated as read-only
7. **Revoked token version**: Claim token, then owner rotates token → reconnect with old cookie → verify treated as read-only

---

### Task 4: Client-Side Token Exchange

**Description**: When a user opens an edit link (`gist.party/<gist_id>#edit=<token>`), the client extracts the token from the URL fragment, exchanges it for an edit capability cookie, and then connects the WebSocket.

**Implementation Details**:

- In the React Router route handler for `/:gist_id`:
  1. On mount, check `window.location.hash` for `#edit=<token>` pattern
  2. If present, extract the token value: `const token = window.location.hash.match(/^#edit=(.+)$/)?.[1]`
  3. Clear the hash from the URL immediately (to prevent leakage if the user copies/shares the URL): `history.replaceState(null, "", window.location.pathname)`
  4. Call `POST /api/gists/:gist_id/claim` with `{ token }`:
     ```ts
     const res = await fetch(`/api/gists/${gistId}/claim`, {
       method: "POST",
       headers: { "Content-Type": "application/json" },
       credentials: "include",
       body: JSON.stringify({ token }),
     });
     ```
  5. If `200`: the browser now has the capability cookie set. Proceed to connect the WebSocket (the cookie will be sent automatically on the upgrade request because of path scoping)
  6. If `403`: show a "This edit link is invalid or has been revoked" error message. Fall back to read-only view.
  7. If `401`: user is not authenticated. Redirect to login flow, preserving the current URL (including hash) in a `returnTo` parameter so the exchange can complete after auth.

- The WebSocket connection (`YProvider`) must be deferred until after the claim completes — don't connect until the capability cookie is set

- State management: Use a React state machine or simple states:
  - `idle` → `claiming` → `claimed` / `claim-failed`
  - Only initialize `YProvider` once in `claimed` state (or if no hash is present — normal editor load)

- If no `#edit=` hash is present, check if the user already has a valid capability cookie (the browser will send it automatically). The DO's `isReadOnly()` will determine access.

**Files to Create/Modify**:

| File | Action | Details |
|---|---|---|
| `src/client/routes/gist-page.tsx` | Modify | Add `useEffect` for hash extraction, claim flow, state management for deferred WebSocket connection |
| `src/client/hooks/useEditToken.ts` | Create | Custom hook: `useEditToken(gistId)` → `{ status: "idle" | "claiming" | "claimed" | "failed" | "no-token", error?: string }`. Handles hash extraction, claim POST, URL cleanup |
| `src/client/components/ClaimError.tsx` | Create | Error UI for invalid/revoked edit links |

**Verification**:

1. Generate an edit link from the owner UI (or manually construct one with a known token)
2. Open `http://localhost:5173/<gist_id>#edit=<token>` in a new browser/incognito window (authenticated as a different user)
3. Verify: hash is cleared from URL bar immediately
4. Verify: `POST /claim` is called → `200` response → capability cookie is set
5. Verify: WebSocket connects → user can edit → changes are broadcast
6. Open `http://localhost:5173/<gist_id>#edit=invalid-token` → verify `403` → error message displayed → read-only view loaded
7. Open edit link while not authenticated → verify redirect to login → after login, return to gist page and complete claim
8. Open `http://localhost:5173/<gist_id>` (no hash, no capability) → verify read-only view loads directly

---

### Task 5: Revocation UX

**Description**: Owner clicks "Revoke" in the UI, which calls the edit-token endpoint, disconnects existing editors, and displays a new edit link.

**Implementation Details**:

- Add a "Share" section to the editor UI (visible only to the owner):
  - Shows the current edit link: `gist.party/<gist_id>#edit=<token>` with a copy button
  - The raw token is stored in component state after creating/importing a gist (it's returned by `POST /api/gists` and `POST /api/gists/:gist_id/import`)
  - "Revoke & Regenerate" button

- "Revoke & Regenerate" flow:
  1. Show a confirmation dialog: "This will disconnect all current editors. They'll need the new link to edit again."
  2. On confirm, call `POST /api/gists/:gist_id/edit-token`
  3. On success: update the displayed edit link with the new token
  4. The DO will kick existing editor connections (handled server-side in Task 2)

- Collaborator experience on revocation:
  1. WebSocket closes with code `4001`, reason `"Edit token revoked"`
  2. `YProvider` triggers a disconnect event
  3. Client detects the `4001` close code and shows: "Your edit access has been revoked. Ask the owner for a new link."
  4. Client does NOT auto-reconnect (normal disconnect would trigger reconnect, but `4001` should be treated as intentional)

- Initial edit link display: After `POST /api/gists` or `POST /api/gists/:gist_id/import`, the response includes `edit_token`. Store this in component state and display the share link.

**Files to Create/Modify**:

| File | Action | Details |
|---|---|---|
| `src/client/components/SharePanel.tsx` | Create | Share panel with edit link display, copy button, revoke button, confirmation dialog |
| `src/client/routes/gist-page.tsx` | Modify | Integrate `SharePanel` (owner only). Store `editToken` from create/import response |
| `src/client/hooks/useEditToken.ts` | Modify | Handle `4001` close code — set `status: "revoked"`, suppress auto-reconnect |
| `src/client/components/RevokedBanner.tsx` | Create | "Edit access revoked" banner with message to request new link |

**Verification**:

1. Owner creates a gist → share panel shows edit link
2. Owner clicks copy → link is copied to clipboard (verify with paste)
3. Collaborator opens the edit link → gains edit access → edits visible
4. Owner clicks "Revoke & Regenerate" → confirmation dialog appears
5. Owner confirms → verify:
   - Collaborator's WebSocket closes with code `4001`
   - Collaborator sees "Edit access revoked" message
   - Collaborator cannot edit (read-only)
   - Collaborator does NOT auto-reconnect
6. Owner sees new edit link in share panel
7. Owner shares new link → collaborator opens it → gains edit access again
8. Verify non-owner cannot see the share panel or access the revoke endpoint

---

## Track Complete

### Overall Milestone

Share an edit link → collaborator claims the token → edits are accepted and broadcast. Revoke the token → collaborator is kicked and sees a revocation message. Connections without a valid edit capability cookie are read-only — Yjs updates and awareness updates are silently dropped.

### Verification Checklist

| # | Scenario | Expected Outcome | How to Verify |
|---|---|---|---|
| 1 | Claim valid edit token | 200, capability cookie set, edit access granted | `curl` claim endpoint, inspect `Set-Cookie`, connect WebSocket, send Yjs update |
| 2 | Claim invalid token | 403, no cookie, read-only | `curl` with wrong token, verify no `Set-Cookie` |
| 3 | Claim without auth | 401 | `curl` without session cookie |
| 4 | Owner edits without capability cookie | Edits accepted (owner bypass) | Connect as owner without claiming, verify writes propagate |
| 5 | Non-owner without capability | Read-only, Yjs updates dropped | Connect without cookie, send updates, verify DO state unchanged |
| 6 | Awareness from read-only connection | Dropped, not broadcast | Connect read-only, set awareness, verify other clients don't see cursor |
| 7 | Revoke token | Existing editors kicked (4001), new token generated | Call edit-token endpoint, observe WebSocket close, verify old cookie rejected |
| 8 | Re-claim after revocation | New token works, old does not | Claim new token → success. Claim old token → 403 |
| 9 | Client-side token exchange (happy path) | Hash extracted, claimed, cookie set, editor loads | Open edit link in incognito, verify full flow |
| 10 | Client-side exchange (invalid token) | Error displayed, read-only fallback | Open link with bad token, verify error UI |
| 11 | Client-side exchange (unauthenticated) | Redirect to login, return to claim | Open link while logged out, verify redirect and post-login claim |
| 12 | Token version mismatch | Connection treated as read-only | Claim token, rotate, reconnect with old cookie, verify read-only |
