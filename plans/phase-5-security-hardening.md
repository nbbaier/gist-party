# Phase 5 — Security Hardening

> **Goal**: Harden all attack surfaces — response headers, CSRF, rate limiting, WebSocket abuse, and content sniffing. All 6 tasks are independent and can be implemented in any order.

---

## Prerequisites

- **Phase 3 (all tracks)** is complete: GitHub sync, edit permissions, and read-only views are functional. All API routes exist and are testable.
- **Phase 2A (Collab)** is complete: WebSocket connections work, `YProvider` is wired.
- **Phase 1A (Auth)** is complete: OAuth flow, JWT cookies, session management exist.
- The Hono router is serving all HTTP routes. `routePartykitRequest()` handles WebSocket upgrades.
- Milkdown editor and remark rendering pipeline are functional (needed to verify CSP doesn't break them).

## Depends On / Produces

| Depends On | What It Provides |
|---|---|
| Phase 3 (all tracks) | All routes exist, WebSocket connections are functional, read-only views serve content |
| Phase 1A — Auth | OAuth callback, refresh endpoint, session cookies (needed for CSRF wiring) |
| Phase 1B — Editor | Milkdown rendering (needed to verify CSP compatibility) |
| Phase 1C — GistRoom DO | WebSocket message handling (needed for WS hardening) |

| Produces | Consumed By |
|---|---|
| Hardened HTTP responses, CSRF protection, rate limiting, WS limits | Phase 6 (End-to-end validation — security checks) |

---

## Tasks

### Task 1: Content Security Policy

**Description**: Add a restrictive Content-Security-Policy header to all HTML responses. The CSP must be strict enough to prevent XSS but permissive enough for Milkdown and remark rendering to function.

**Implementation Details**:

1. **CSP middleware**: Create a Hono middleware that sets the `Content-Security-Policy` header on all responses with `Content-Type: text/html`.
   - Do NOT set CSP on non-HTML responses (API JSON, raw markdown, WebSocket upgrades).
2. **Policy directives**:
   ```
   default-src 'self';
   script-src 'self';
   style-src 'self' 'unsafe-inline';
   img-src 'self' data: https:;
   font-src 'self';
   connect-src 'self' wss: https://api.github.com;
   frame-src 'none';
   object-src 'none';
   base-uri 'self';
   form-action 'self';
   ```
   - `style-src 'unsafe-inline'` is required because Milkdown/ProseMirror injects inline styles for cursor positioning and editor chrome. If this can be avoided (e.g., via nonce), prefer that — but verify Milkdown still works.
   - `img-src data:` is needed if Milkdown or remark render data URIs for images.
   - `connect-src wss:` is needed for WebSocket connections to the DO.
   - `connect-src https://api.github.com` is needed if the client makes direct GitHub API calls (e.g., fetching Gist content for `needs-init`).
   - `frame-src 'none'` prevents clickjacking.
3. **Verification approach**: After setting CSP, load the editor and perform all common actions (type, format, paste, use slash commands). Check the browser console for CSP violations. Adjust the policy if needed.

**Files to Create/Modify**:

- `src/server/middleware/csp.ts` — New file. Hono middleware that adds CSP header to HTML responses.
- `src/server/index.ts` (or main Hono app file) — Register the CSP middleware.

**Verification**:

- [ ] Check CSP header is present on HTML responses:
  ```bash
  curl -s -D - https://gist.party/ | grep -i content-security-policy
  ```
- [ ] CSP header is NOT present on API JSON responses:
  ```bash
  curl -s -D - https://gist.party/api/gists/test123 | grep -i content-security-policy
  # Should return empty
  ```
- [ ] Load the Milkdown editor → type text, apply formatting (bold, headings, lists), use slash commands → no CSP violations in browser console.
- [ ] Load the read-only rendered view → all content renders correctly, no CSP violations.
- [ ] Attempt to inject `<script>alert(1)</script>` in markdown content → script is blocked by both `rehype-sanitize` AND CSP (defense-in-depth).
- [ ] Verify `frame-src 'none'` prevents embedding in iframes:
  ```html
  <iframe src="https://gist.party/someid"></iframe>
  <!-- Should be blocked -->
  ```

---

### Task 2: CSRF Protection

**Description**: Implement double-submit cookie CSRF protection on all state-changing POST routes. `SameSite=Strict` on the session cookie is the primary defense; the double-submit token is defense-in-depth.

**Implementation Details**:

1. **Set CSRF cookie**: In the OAuth callback handler (`GET /api/auth/github/callback`) and the refresh handler (`POST /api/auth/refresh`), after setting the session JWT cookie, also set a `__csrf` cookie:
   - Value: Cryptographically random string (32 bytes, hex-encoded).
   - `HttpOnly: false` (the SPA must read it via `document.cookie`).
   - `Secure: true`, `SameSite: Strict`, `Path: /`.
   - Same expiry as the session cookie (or slightly longer).
2. **Client-side header**: In the SPA's HTTP client (fetch wrapper or axios instance), read the `__csrf` cookie value and include it as the `X-CSRF-Token` header on all POST requests.
   - Helper function: `getCsrfToken()` that parses `document.cookie` for the `__csrf` value.
   - Apply to all `fetch()` calls for POST routes.
3. **Server-side validation middleware**: Create a Hono middleware that runs on all POST routes. It:
   - Reads the `__csrf` cookie from the request.
   - Reads the `X-CSRF-Token` header from the request.
   - Compares them using a constant-time comparison (`crypto.subtle.timingSafeEqual` or equivalent). If they don't match or either is missing, return `403 Forbidden` with `{ error: "csrf_token_mismatch" }`.
   - Skip validation for routes that don't need it (none currently — all POST routes are state-changing).
4. **Protected routes**: `/api/gists` (POST), `/api/gists/:id/import` (POST), `/api/gists/:id/claim` (POST), `/api/gists/:id/edit-token` (POST), `/api/auth/logout` (POST), `/api/auth/refresh` (POST).
5. **Session cookie**: Ensure the session JWT cookie has `SameSite=Strict` (should already be set from Phase 1A — verify).

**Files to Create/Modify**:

- `src/server/middleware/csrf.ts` — New file. Hono middleware for CSRF validation.
- `src/server/auth/callback.ts` (or equivalent OAuth callback handler) — Add `__csrf` cookie setting.
- `src/server/auth/refresh.ts` (or equivalent refresh handler) — Add `__csrf` cookie setting.
- `src/client/lib/api.ts` (or equivalent fetch wrapper) — Add `X-CSRF-Token` header to all POST requests.
- `src/server/index.ts` — Register CSRF middleware on POST routes.

**Verification**:

- [ ] After login, verify `__csrf` cookie is set:
  ```bash
  # In browser DevTools → Application → Cookies → check for __csrf
  # Cookie should be: HttpOnly=false, Secure=true, SameSite=Strict
  ```
- [ ] POST to a protected route WITH correct `X-CSRF-Token` header → request succeeds (200/201).
- [ ] POST to a protected route WITHOUT `X-CSRF-Token` header → 403 Forbidden:
  ```bash
  curl -s -X POST https://gist.party/api/auth/logout \
    -H "Cookie: session=<valid_jwt>" \
    -w "%{http_code}"
  # Should return 403
  ```
- [ ] POST with mismatched `X-CSRF-Token` → 403 Forbidden:
  ```bash
  curl -s -X POST https://gist.party/api/auth/logout \
    -H "Cookie: session=<valid_jwt>; __csrf=abc123" \
    -H "X-CSRF-Token: wrong_value" \
    -w "%{http_code}"
  # Should return 403
  ```
- [ ] Verify session cookie has `SameSite=Strict`.
- [ ] All 6 protected POST routes reject requests without valid CSRF tokens.

---

### Task 3: Response Headers

**Description**: Add security-related response headers to all HTTP responses. Some headers are global; others are endpoint-specific.

**Implementation Details**:

1. **Global headers middleware**: Create a Hono middleware that adds the following headers to ALL responses:
   - `Referrer-Policy: strict-origin` — Prevents edit token leakage via Referer headers. Defense-in-depth (token is in URL fragment, which browsers don't send in Referer, but the header protects against any other leakable URL components).
   - `X-Content-Type-Options: nosniff` — Prevents MIME type sniffing on all responses.
2. **Raw endpoint headers**: The `GET /:gist_id/raw` route handler should set:
   - `Content-Type: text/plain; charset=utf-8` (should already be set from Phase 3C — verify and enforce).
   - `Cache-Control: no-cache` (ensures `curl` and scripts always get fresh content while allowing conditional requests via ETag).
   - `X-Content-Type-Options: nosniff` (covered by global middleware, but verify it's present).
3. **Registration**: The global middleware should run early in the middleware chain (before route handlers) so all responses include these headers.

**Files to Create/Modify**:

- `src/server/middleware/security-headers.ts` — New file. Hono middleware for global response headers.
- `src/server/index.ts` — Register the middleware early in the chain.
- `src/server/routes/raw.ts` (or equivalent raw endpoint handler) — Verify/add `Cache-Control: no-cache`.

**Verification**:

- [ ] All HTML responses include `Referrer-Policy: strict-origin`:
  ```bash
  curl -s -D - https://gist.party/ | grep -i referrer-policy
  # Referrer-Policy: strict-origin
  ```
- [ ] All API responses include `Referrer-Policy`:
  ```bash
  curl -s -D - https://gist.party/api/gists/test123 | grep -i referrer-policy
  # Referrer-Policy: strict-origin
  ```
- [ ] All responses include `X-Content-Type-Options: nosniff`:
  ```bash
  curl -s -D - https://gist.party/ | grep -i x-content-type-options
  # X-Content-Type-Options: nosniff
  ```
- [ ] Raw endpoint has correct headers:
  ```bash
  curl -s -D - https://gist.party/someid/raw | grep -iE "(content-type|x-content-type|cache-control)"
  # Content-Type: text/plain; charset=utf-8
  # X-Content-Type-Options: nosniff
  # Cache-Control: no-cache
  ```
- [ ] Raw endpoint does NOT return `text/html` (even if markdown contains HTML):
  ```bash
  curl -s -D - https://gist.party/someid/raw | grep "content-type"
  # Must be text/plain, never text/html
  ```

---

### Task 4: Rate Limiting

**Description**: IP-based rate limiting on anonymous viewer requests and auth endpoints to prevent abuse and gist_id enumeration.

**Implementation Details**:

1. **Rate limiter implementation**: Use Cloudflare's built-in rate limiting if available on the Workers plan. If not, implement a simple in-memory rate limiter in the Worker using a `Map<string, { count: number, windowStart: number }>` with a sliding window.
   - **Caveat**: In-memory rate limiting on Workers is per-isolate, not global. For true global rate limiting, use Cloudflare Rate Limiting rules (configured in `wrangler.toml` or the dashboard) or a KV-backed counter. For MVP, per-isolate is acceptable — document the limitation.
2. **Anonymous viewer rate limits**:
   - Routes: `GET /:gist_id` (viewer), `GET /:gist_id/raw` (raw endpoint).
   - Apply only to unauthenticated requests (requests without a valid JWT session cookie).
   - Limit: 60 requests per minute per IP.
   - Response on limit: `429 Too Many Requests` with `Retry-After` header.
3. **Auth endpoint rate limits**:
   - Routes: `GET /api/auth/github` (OAuth initiation), `GET /api/auth/github/callback` (OAuth callback), `POST /api/auth/refresh`.
   - Limit: 10 requests per minute per IP.
   - Response on limit: `429 Too Many Requests` with `Retry-After` header.
4. **Rate limit headers**: Include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers on rate-limited routes (informational, not required).
5. **IP extraction**: Use `request.headers.get("CF-Connecting-IP")` on Cloudflare Workers. Fall back to `request.headers.get("X-Forwarded-For")` in local dev.

**Files to Create/Modify**:

- `src/server/middleware/rate-limit.ts` — New file. Rate limiting middleware. Configurable per-route limits. Uses `CF-Connecting-IP` for IP extraction.
- `src/server/index.ts` — Register rate limiting middleware on viewer and auth routes.

**Verification**:

- [ ] Anonymous request to `/:gist_id` within rate limit → 200 OK.
- [ ] 61st anonymous request to `/:gist_id` within 1 minute from same IP → 429:
  ```bash
  for i in $(seq 1 65); do
    curl -s -o /dev/null -w "%{http_code}\n" https://gist.party/someid
  done
  # First 60 should be 200, 61+ should be 429
  ```
- [ ] Authenticated request to `/:gist_id` → not rate-limited (or has a higher limit).
- [ ] Auth endpoint rate limit: 11th request to `/api/auth/github` within 1 minute → 429:
  ```bash
  for i in $(seq 1 15); do
    curl -s -o /dev/null -w "%{http_code}\n" https://gist.party/api/auth/github
  done
  # First 10 should be 302, 11+ should be 429
  ```
- [ ] `429` response includes `Retry-After` header:
  ```bash
  curl -s -D - https://gist.party/someid | grep -i retry-after
  ```
- [ ] Rate limit resets after the window expires (wait 60s, then requests succeed again).

---

### Task 5: WebSocket Hardening

**Description**: Enforce connection limits, message rate limits, document size caps, and awareness restrictions on WebSocket connections.

**Implementation Details**:

1. **Per-IP connection limit**: Track active WebSocket connections per IP in the GistRoom DO. Use a `Map<string, number>` (IP → connection count). Limit: 5 connections per IP per room.
   - In the connection handler (before accepting the WebSocket upgrade), check the count. If exceeded, reject with `{ error: "connection_limit_exceeded" }` and close the WebSocket with code 4429.
   - Decrement on disconnect.
2. **Per-room connection limit**: Total connections per room. Limit: 50 connections per room.
   - If exceeded, reject new connections.
3. **Message rate limiting**: Track messages per connection per second. Limit: 30 messages per second per connection.
   - Use a sliding window or token bucket per connection.
   - If exceeded, send a warning message and drop excess messages. If sustained abuse (e.g., 3 consecutive violations), disconnect with code 4429.
4. **Document size limit**: On every inbound Yjs update message, check the encoded size. Limit: 2 MB.
   - If exceeded, drop the update, send an error message to the client, and do NOT apply it to the Yjs document.
   - Also check the total document size after applying: if `Y.encodeStateAsUpdate(this.document).byteLength > 2 * 1024 * 1024`, reject the update.
5. **Read-only awareness blocking**: In `GistRoom`, when a read-only connection sends an awareness update, silently drop it. Do NOT broadcast it to other clients.
   - This is partially handled by `isReadOnly()` in Phase 1C — verify that awareness updates are also blocked, not just Yjs document updates.
   - If `y-partyserver`'s `YServer` only blocks document updates via `isReadOnly()`, override the awareness message handler to also check read-only status.

**Files to Create/Modify**:

- `src/server/gist-room.ts` — Add connection tracking (`Map<string, number>` for IP counts, total count). Add message rate limiting logic. Add document size check on inbound updates. Verify awareness blocking for read-only connections.
- `src/server/constants.ts` — Add constants: `MAX_CONNECTIONS_PER_IP = 5`, `MAX_CONNECTIONS_PER_ROOM = 50`, `MAX_MESSAGES_PER_SECOND = 30`, `MAX_DOCUMENT_SIZE_BYTES = 2 * 1024 * 1024`.

**Verification**:

- [ ] Open 6 WebSocket connections from the same IP to the same room → 6th is rejected with code 4429:
  ```javascript
  // Test script
  const sockets = [];
  for (let i = 0; i < 6; i++) {
    const ws = new WebSocket("wss://gist.party/parties/gist-room/test123");
    ws.onclose = (e) => console.log(`Socket ${i}: closed ${e.code}`);
    sockets.push(ws);
  }
  // Socket 5 should close with code 4429
  ```
- [ ] Open 51 connections from different IPs (or via test harness) → 51st is rejected.
- [ ] Send 35 messages in 1 second from a single connection → excess messages are dropped, warning sent.
- [ ] Send a Yjs update that would make the document exceed 2 MB → update is rejected, error message sent to client.
- [ ] Read-only connection sends an awareness update → update is NOT broadcast to other clients:
  ```javascript
  // Connect without edit capability
  const ws = new WebSocket("wss://gist.party/parties/gist-room/test123");
  // Send awareness update → verify other clients don't receive it
  ```
- [ ] Connection counts decrement correctly on disconnect (no leak).

---

### Task 6: Raw Endpoint Headers

**Description**: Ensure the raw markdown endpoint (`/:gist_id/raw`) serves content with security-conscious headers that prevent content sniffing and browser interpretation.

**Implementation Details**:

1. **Content-Type**: Set `Content-Type: text/plain; charset=utf-8` explicitly. Do NOT let the framework auto-detect content type. This prevents browsers from interpreting markdown as HTML.
2. **X-Content-Type-Options**: Set `X-Content-Type-Options: nosniff`. This prevents browsers from overriding `Content-Type` and interpreting `text/plain` as `text/html` (which could lead to XSS if the markdown contains HTML).
3. **Cache-Control**: Set `Cache-Control: no-cache`. This ensures:
   - Scripted consumers (`curl`, CI, AI agents) always get fresh content.
   - Conditional requests (ETag / If-None-Match) still work for bandwidth efficiency.
   - Do NOT use `no-store` — that would prevent conditional requests.
4. **Implementation location**: These headers should be set directly in the raw endpoint route handler, not via middleware, to ensure they're always present regardless of middleware ordering. The global `X-Content-Type-Options` from Task 3 provides defense-in-depth.

**Note**: This task overlaps with Task 3 (Response Headers). Task 3 sets global headers including `X-Content-Type-Options: nosniff`. Task 6 is specifically about ensuring the raw endpoint's full header set is correct and explicitly set in the route handler (defense-in-depth — even if the global middleware is misconfigured, the raw endpoint should be safe).

**Files to Create/Modify**:

- `src/server/routes/raw.ts` (or the route handler for `GET /:gist_id/raw`) — Explicitly set all three headers in the response.

**Verification**:

- [ ] Verify `Content-Type` is exactly `text/plain; charset=utf-8`:
  ```bash
  curl -s -D - https://gist.party/someid/raw | grep -i "content-type:"
  # Content-Type: text/plain; charset=utf-8
  ```
- [ ] Verify `X-Content-Type-Options: nosniff`:
  ```bash
  curl -s -D - https://gist.party/someid/raw | grep -i "x-content-type-options"
  # X-Content-Type-Options: nosniff
  ```
- [ ] Verify `Cache-Control: no-cache`:
  ```bash
  curl -s -D - https://gist.party/someid/raw | grep -i "cache-control"
  # Cache-Control: no-cache
  ```
- [ ] Verify content is served as plain text even if markdown contains HTML:
  ```bash
  # Create a gist with content: <script>alert(1)</script>
  curl -s https://gist.party/someid/raw
  # Should return the raw text, not execute or render HTML
  ```
- [ ] Verify conditional requests work:
  ```bash
  # First request — get ETag
  ETAG=$(curl -s -D - https://gist.party/someid/raw | grep -i etag | awk '{print $2}')
  # Conditional request
  curl -s -D - -H "If-None-Match: $ETAG" https://gist.party/someid/raw -w "%{http_code}"
  # Should return 304 Not Modified if content hasn't changed
  ```
- [ ] Open the raw URL in a browser → browser displays plain text, does NOT render HTML or execute scripts.

---

## Phase Complete

### Milestone Verification

> All security hardening measures are in place. No regressions in editor or collaboration functionality.

**Automated header check script** (run against deployed or local instance):

```bash
#!/bin/bash
BASE_URL="${1:-http://localhost:8787}"
GIST_ID="test123"  # Use a valid initialized gist ID

echo "=== Task 1: CSP ==="
curl -s -D - "$BASE_URL/" -o /dev/null | grep -i "content-security-policy"

echo "=== Task 2: CSRF ==="
# Verify __csrf cookie is set after auth (requires a valid session — test manually or via integration test)
echo "(Verify __csrf cookie in browser DevTools after login)"
# Verify POST without CSRF token is rejected
curl -s -X POST "$BASE_URL/api/auth/logout" -H "Cookie: session=test" -o /dev/null -w "POST without CSRF: %{http_code}\n"

echo "=== Task 3: Response Headers ==="
curl -s -D - "$BASE_URL/" -o /dev/null | grep -i "referrer-policy"
curl -s -D - "$BASE_URL/" -o /dev/null | grep -i "x-content-type-options"

echo "=== Task 4: Rate Limiting ==="
echo "(Run burst test: 65 requests in quick succession to /$GIST_ID)"
for i in $(seq 1 65); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/$GIST_ID")
  if [ "$CODE" = "429" ]; then
    echo "Rate limited at request $i"
    break
  fi
done

echo "=== Task 5: WebSocket Hardening ==="
echo "(Verify via integration test: open 6 WS connections from same IP, 6th should be rejected)"

echo "=== Task 6: Raw Endpoint Headers ==="
curl -s -D - "$BASE_URL/$GIST_ID/raw" -o /dev/null | grep -iE "(content-type|x-content-type|cache-control|referrer-policy)"
```

**Full checklist**:

- [ ] CSP header on all HTML responses; editor and read-only view work without CSP violations.
- [ ] CSRF double-submit token set on login/refresh; all 6 POST routes reject requests without valid token.
- [ ] `Referrer-Policy: strict-origin` on all responses.
- [ ] `X-Content-Type-Options: nosniff` on all responses.
- [ ] Raw endpoint: `text/plain`, `nosniff`, `no-cache`.
- [ ] Anonymous viewer rate limiting: 60/min per IP.
- [ ] Auth endpoint rate limiting: 10/min per IP.
- [ ] WebSocket: per-IP limit (5), per-room limit (50), message rate limit (30/s), 2 MB doc size limit.
- [ ] Read-only WebSocket connections cannot send awareness updates.
- [ ] No regressions: editor loads, real-time collab works, GitHub sync works, auth flow works.
