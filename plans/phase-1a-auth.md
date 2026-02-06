# Track 1A — Auth System

> **Goal**: A user can sign in with GitHub and receive a verified JWT session cookie. GitHub access tokens are encrypted at rest in Workers KV.

## Prerequisites

- Phase 0 complete: Vite + React + TS project scaffolded, Cloudflare Worker with Hono running, `wrangler.toml` configured with KV namespace binding (`SESSIONS`) and secrets placeholders (`JWT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ENCRYPTION_KEY_V1`)
- `wrangler dev` starts and serves the SPA

## Depends On / Produces

| Contract | Role | Notes |
|---|---|---|
| JWT sign/verify module | **Produces** | Pure WebCrypto. Payload: `{ userId, login, avatarUrl }`. Claims: `exp`, `aud`, `iss`. Consumed by Track 1C (DO), Track 2B (API middleware). |
| Token encryption module | **Produces** | AES-GCM via WebCrypto. Versioned key prefix `v1:<iv>:<ciphertext>`. Consumed by Track 1C (DO reads owner token from KV), Track 2B (API stores token on login). |
| Edit capability cookie format | **Consumes** (partially) | This track defines the session cookie format; the edit capability cookie format is defined by Track 3B but shares conventions (HttpOnly, Secure, SameSite). |

---

## Tasks

### Task 1: JWT Sign/Verify Module

**Description**: Create a standalone module that signs and verifies JWTs using only the WebCrypto API. This module must work identically in both the Cloudflare Worker and the Durable Object runtime (no Node.js `crypto` imports).

**Implementation Details**:

1. Create `src/server/auth/jwt.ts`
2. Use HMAC-SHA256 (`{ name: "HMAC", hash: "SHA-256" }`) via `crypto.subtle.importKey` / `crypto.subtle.sign` / `crypto.subtle.verify`
3. JWT structure: Base64url-encoded header + payload + signature
4. Header: `{ "alg": "HS256", "typ": "JWT" }`
5. Payload shape:
   ```ts
   interface JWTPayload {
     userId: number;     // GitHub user ID
     login: string;      // GitHub username
     avatarUrl: string;  // GitHub avatar URL
     exp: number;        // Expiration (Unix timestamp, 1 hour from issuance)
     aud: string;        // "gist.party"
     iss: string;        // "gist.party"
     iat: number;        // Issued at (Unix timestamp)
   }
   ```
6. Exported functions:
   ```ts
   export async function signJWT(payload: Omit<JWTPayload, 'exp' | 'aud' | 'iss' | 'iat'>, secret: string, ttlSeconds?: number): Promise<string>
   export async function verifyJWT(token: string, secret: string): Promise<JWTPayload>
   ```
7. `verifyJWT` must:
   - Verify HMAC signature
   - Check `exp` against current time (reject expired)
   - Check `aud === "gist.party"` and `iss === "gist.party"` (reject mismatched)
   - Return parsed payload on success, throw on failure
8. No external dependencies — pure WebCrypto + `TextEncoder`/`TextDecoder` + manual Base64url encoding

**Files to create/modify**:
- Create: `src/server/auth/jwt.ts`
- Create: `src/server/auth/base64url.ts` (Base64url encode/decode helpers)

**Verification**:
1. Write a test file `src/server/auth/__tests__/jwt.test.ts`:
   - Sign a token, then verify it — payload matches
   - Sign a token with 1s TTL, wait 2s, verify — throws expiration error
   - Tamper with signature — throws verification error
   - Wrong `aud` or `iss` — throws claim error
   - Verify roundtrip: `verifyJWT(await signJWT(payload, secret), secret)` returns exact payload with added claims
2. Run: `bun run vitest run src/server/auth/__tests__/jwt.test.ts`

---

### Task 2: Token Encryption Module

**Description**: Create a module that encrypts and decrypts GitHub access tokens using AES-GCM via WebCrypto. Supports key versioning for rotation.

**Implementation Details**:

1. Create `src/server/auth/encryption.ts`
2. Encryption format: `v1:<base64url(iv)>:<base64url(ciphertext)>` — version prefix allows key rotation
3. AES-GCM with 256-bit key, 96-bit (12-byte) IV generated via `crypto.getRandomValues`
4. Key derivation: Import raw key bytes from the Workers secret using `crypto.subtle.importKey` with `{ name: "AES-GCM" }`
5. Exported functions:
   ```ts
   interface EncryptionKeys {
     current: { version: string; key: string };  // e.g. { version: "v1", key: env.ENCRYPTION_KEY_V1 }
     legacy?: Record<string, string>;             // e.g. { "v0": env.ENCRYPTION_KEY_V0 }
   }

   export async function encryptToken(plaintext: string, keys: EncryptionKeys): Promise<string>
   export async function decryptToken(encrypted: string, keys: EncryptionKeys): Promise<string>
   export async function reencryptIfNeeded(encrypted: string, keys: EncryptionKeys): Promise<{ value: string; rotated: boolean }>
   ```
6. `decryptToken`: Parse version prefix, select corresponding key, decrypt
7. `reencryptIfNeeded`: Decrypt, check if version matches current — if not, re-encrypt under current key and return `{ value, rotated: true }`
8. Throw descriptive errors for unknown key versions

**Files to create/modify**:
- Create: `src/server/auth/encryption.ts`

**Verification**:
1. Write `src/server/auth/__tests__/encryption.test.ts`:
   - Encrypt then decrypt — plaintext matches
   - Encrypted string starts with `v1:`
   - Encrypted string has exactly 3 parts separated by `:`
   - Decrypt with wrong key — throws
   - Decrypt with unknown version prefix — throws
   - `reencryptIfNeeded` with current version — `rotated: false`, value unchanged
   - `reencryptIfNeeded` with legacy version — `rotated: true`, new string starts with current version
   - Two encryptions of the same plaintext produce different ciphertexts (random IV)
2. Run: `bun run vitest run src/server/auth/__tests__/encryption.test.ts`

---

### Task 3: OAuth Flow — Initiate

**Description**: Implement `GET /api/auth/github` which starts the GitHub OAuth flow with PKCE and state parameter.

**Implementation Details**:

1. Create `src/server/routes/auth.ts` — Hono route group
2. `GET /api/auth/github` handler:
   a. Generate a cryptographically random `state` (32 bytes, hex-encoded) via `crypto.getRandomValues`
   b. Generate PKCE code verifier (43–128 chars, URL-safe random) and code challenge (SHA-256 hash, Base64url-encoded)
   c. Store `{ state, codeVerifier }` in Workers KV with key `oauth:state:<state>`, TTL of 10 minutes
   d. Build GitHub authorization URL:
      ```
      https://github.com/login/oauth/authorize?
        client_id=<GITHUB_CLIENT_ID>&
        redirect_uri=<origin>/api/auth/github/callback&
        scope=gist read:user&
        state=<state>&
        code_challenge=<challenge>&
        code_challenge_method=S256
      ```
   e. Redirect (302) to the authorization URL
3. Register the route group in the main Hono app: `app.route('/api/auth', authRoutes)`

**Files to create/modify**:
- Create: `src/server/routes/auth.ts`
- Modify: `src/server/index.ts` (or wherever the main Hono app is) — mount auth routes

**Verification**:
1. Start `wrangler dev`
2. `curl -v http://localhost:8787/api/auth/github`
3. Verify response is a 302 redirect
4. Verify `Location` header points to `https://github.com/login/oauth/authorize` with correct query params: `client_id`, `redirect_uri`, `scope=gist+read%3Auser`, `state` (64-char hex), `code_challenge`, `code_challenge_method=S256`
5. Verify a KV entry `oauth:state:<state>` exists with a `codeVerifier` value (check via `wrangler kv key get`)

---

### Task 4: OAuth Flow — Callback

**Description**: Implement `GET /api/auth/github/callback` which exchanges the authorization code for an access token, fetches the user profile, encrypts the token, stores the session, and sets the JWT cookie.

**Implementation Details**:

1. In `src/server/routes/auth.ts`, add `GET /callback` handler:
   a. Extract `code` and `state` from query params. If missing, return 400.
   b. Look up `oauth:state:<state>` from KV. If not found or expired, return 400 ("Invalid or expired state").
   c. Delete the KV entry immediately (one-time use).
   d. Exchange authorization code for access token:
      ```
      POST https://github.com/login/oauth/access_token
      Content-Type: application/json
      Accept: application/json
      Body: { client_id, client_secret, code, redirect_uri, code_verifier }
      ```
   e. If error response, return 400 with error description.
   f. Fetch user profile: `GET https://api.github.com/user` with `Authorization: Bearer <access_token>`
   g. Extract `{ id: userId, login, avatar_url: avatarUrl }` from response.
   h. Encrypt the access token using the encryption module.
   i. Store session in KV with key `session:<userId>`:
      ```json
      {
        "userId": 12345,
        "login": "octocat",
        "avatarUrl": "https://...",
        "encryptedToken": "v1:<iv>:<ciphertext>",
        "createdAt": "2025-01-01T00:00:00Z"
      }
      ```
      TTL: 30 days (2592000 seconds).
   j. Sign a JWT with `{ userId, login, avatarUrl }` and 1-hour TTL.
   k. Set the JWT as a cookie:
      ```
      Set-Cookie: __session=<jwt>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600
      ```
   l. Redirect (302) to `/` (the SPA landing page).

**Files to create/modify**:
- Modify: `src/server/routes/auth.ts`

**Verification**:
1. Start `wrangler dev` with `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` set (create a GitHub OAuth app for dev with callback URL `http://localhost:8787/api/auth/github/callback`)
2. Open browser: `http://localhost:8787/api/auth/github`
3. GitHub auth page appears → authorize the app
4. Redirected back to `http://localhost:8787/`
5. Open browser DevTools → Application → Cookies: verify `__session` cookie exists, is HttpOnly, path `/`
6. Decode the JWT (e.g., paste at jwt.io or `echo <jwt> | cut -d. -f2 | base64 -d`): verify payload contains `userId`, `login`, `avatarUrl`, `exp`, `aud: "gist.party"`, `iss: "gist.party"`
7. Check KV: `session:<userId>` key exists with encrypted token (starts with `v1:`)

---

### Task 5: Auth Refresh Endpoint

**Description**: Implement `POST /api/auth/refresh` which validates the existing JWT, looks up the session in KV, and issues a fresh JWT.

**Implementation Details**:

1. In `src/server/routes/auth.ts`, add `POST /refresh` handler:
   a. Extract `__session` cookie from request
   b. Verify the JWT using `verifyJWT()`. If invalid or expired, return 401 `{ error: "invalid_session" }`
   c. Look up `session:<userId>` in KV. If not found, return 401 `{ error: "session_revoked" }`
   d. Sign a new JWT with the same payload claims (`userId`, `login`, `avatarUrl`) and fresh 1-hour TTL
   e. Set the new JWT cookie (same attributes as login)
   f. Optionally: re-encrypt the stored token if `reencryptIfNeeded` returns `rotated: true` (lazy key rotation)
   g. Return 200 `{ ok: true }`

2. Create `src/server/middleware/auth.ts` — a Hono middleware that:
   a. Reads `__session` cookie
   b. Calls `verifyJWT()` — if valid, sets `c.set('user', payload)` on the Hono context
   c. If invalid, does NOT block the request (auth is optional for some routes), just leaves `user` unset
   d. Export a separate `requireAuth` middleware that returns 401 if `user` is not set

**Files to create/modify**:
- Modify: `src/server/routes/auth.ts`
- Create: `src/server/middleware/auth.ts`

**Verification**:
1. After completing Task 4 (logged in with cookie), run:
   ```bash
   curl -v -X POST http://localhost:8787/api/auth/refresh \
     -H "Cookie: __session=<jwt_from_login>"
   ```
2. Response is 200 with `{ ok: true }`
3. Response includes `Set-Cookie: __session=<new_jwt>` with a new token
4. Decode new JWT: `exp` is ~1 hour in the future, payload matches original
5. Test with expired/invalid token:
   ```bash
   curl -v -X POST http://localhost:8787/api/auth/refresh \
     -H "Cookie: __session=invalid.token.here"
   ```
   Response is 401 `{ error: "invalid_session" }`
6. Test with no cookie:
   ```bash
   curl -v -X POST http://localhost:8787/api/auth/refresh
   ```
   Response is 401

---

### Task 6: Logout Endpoint

**Description**: Implement `POST /api/auth/logout` which clears the session cookie and revokes the server-side session in KV.

**Implementation Details**:

1. In `src/server/routes/auth.ts`, add `POST /logout` handler:
   a. Extract `__session` cookie
   b. Verify the JWT (best-effort — proceed with clearing even if expired)
   c. If JWT is valid, delete `session:<userId>` from KV
   d. Clear the cookie:
      ```
      Set-Cookie: __session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0
      ```
   e. Return 200 `{ ok: true }`

**Files to create/modify**:
- Modify: `src/server/routes/auth.ts`

**Verification**:
1. Login first (complete Task 4 flow)
2. Run:
   ```bash
   curl -v -X POST http://localhost:8787/api/auth/logout \
     -H "Cookie: __session=<jwt>"
   ```
3. Response is 200 `{ ok: true }`
4. Response includes `Set-Cookie: __session=; ... Max-Age=0`
5. Verify KV: `session:<userId>` key is deleted
6. Attempt refresh with the old token:
   ```bash
   curl -v -X POST http://localhost:8787/api/auth/refresh \
     -H "Cookie: __session=<old_jwt>"
   ```
   Response is 401 `{ error: "session_revoked" }` (session no longer in KV)

---

### Task 7: Client-side Auth State

**Description**: Create a React hook and context for reading auth state from the JWT cookie and triggering refresh/logout.

**Implementation Details**:

1. Create `src/client/hooks/useAuth.ts`:
   - On mount, call `POST /api/auth/refresh` to get a fresh JWT and confirm session is valid
   - If refresh succeeds, parse the JWT payload from the cookie (decode the middle segment client-side — the cookie is HttpOnly so this requires the server to also return user info in the response body or a separate endpoint)
   - **Alternative approach**: Add a `GET /api/auth/me` endpoint that reads the JWT cookie and returns `{ userId, login, avatarUrl }` or 401. This is simpler and avoids parsing JWT client-side.
   - Expose: `{ user: { userId, login, avatarUrl } | null, loading: boolean, logout: () => void }`
   - `logout()` calls `POST /api/auth/logout` and clears local state

2. Create `src/client/contexts/AuthContext.tsx`:
   - Wrap the app in `<AuthProvider>` 
   - Provide `useAuth()` via context

3. Add `GET /api/auth/me` to the auth routes:
   - Uses `requireAuth` middleware
   - Returns `{ userId, login, avatarUrl }` from the verified JWT payload

**Files to create/modify**:
- Create: `src/client/hooks/useAuth.ts`
- Create: `src/client/contexts/AuthContext.tsx`
- Modify: `src/server/routes/auth.ts` (add `/me` endpoint)

**Verification**:
1. After login, navigate to `http://localhost:8787/` in the browser
2. Open browser DevTools → Console: verify no auth-related errors
3. `curl http://localhost:8787/api/auth/me -H "Cookie: __session=<jwt>"` returns `{ userId, login, avatarUrl }`
4. `curl http://localhost:8787/api/auth/me` (no cookie) returns 401
5. The nav bar placeholder (from Track 1B) can read auth state and display the user's login/avatar

---

## Track Complete

### Overall Milestone Verification

Perform this end-to-end sequence in a browser with DevTools open:

1. **Navigate** to `http://localhost:8787/`
2. **Click "Sign in"** (or navigate to `/api/auth/github`)
3. **GitHub OAuth** page appears → authorize the app
4. **Redirected** back to `/` with `__session` cookie set (verify in DevTools → Application → Cookies)
5. **Decode JWT**: `exp` is ~1 hour ahead, `aud` = `"gist.party"`, `iss` = `"gist.party"`, payload includes `userId`, `login`, `avatarUrl`
6. **Verify KV session**: `session:<userId>` exists with `encryptedToken` starting with `v1:`
7. **Call `/api/auth/me`**: Returns user object
8. **Call `/api/auth/refresh`**: Returns 200, new `__session` cookie with fresh `exp`
9. **Call `/api/auth/logout`**: Returns 200, cookie cleared (`Max-Age=0`), `session:<userId>` deleted from KV
10. **Call `/api/auth/refresh` again**: Returns 401 `{ error: "session_revoked" }`
11. **Call `/api/auth/me` again**: Returns 401

All steps must pass. The JWT module and encryption module must have passing unit tests.
