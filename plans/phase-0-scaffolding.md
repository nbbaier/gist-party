# Phase 0: Scaffolding

> **Goal**: A deployable skeleton — Vite dev server, Worker, and a single DO all running locally. `wrangler dev` serves the SPA and a hello-world DO accepts a WebSocket connection.

## Prerequisites

None. This is the foundation for everything.

---

## Tasks

### Task 1: Initialize Vite + React + TypeScript project

Scaffold the project using Vite's React TypeScript template, then adapt it for the Cloudflare Workers + Vite plugin workflow.

#### Steps

1. From the project root (`/Users/nbbaier/Code/gist-party`), scaffold the project:
   ```bash
   bun create vite . --template react-ts
   ```
   (Use `.` to scaffold in the current directory. Accept any prompts to overwrite existing files.)

2. Install base dependencies:
   ```bash
   bun install
   ```

3. Add Cloudflare dev dependencies:
   ```bash
   bun add -D @cloudflare/vite-plugin wrangler @cloudflare/workers-types
   ```

4. Update `vite.config.ts` to include the Cloudflare plugin:
   ```ts
   import { defineConfig } from "vite";
   import react from "@vitejs/plugin-react";
   import { cloudflare } from "@cloudflare/vite-plugin";

   export default defineConfig({
     plugins: [react(), cloudflare()],
   });
   ```

5. Add a `tsconfig.worker.json` for Worker-side TypeScript:
   ```json
   {
     "extends": "./tsconfig.node.json",
     "compilerOptions": {
       "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.worker.tsbuildinfo",
       "types": ["@cloudflare/workers-types/2023-07-01", "vite/client"]
     },
     "include": ["worker"]
   }
   ```

6. Update the root `tsconfig.json` to include the worker reference:
   ```json
   {
     "files": [],
     "references": [
       { "path": "./tsconfig.app.json" },
       { "path": "./tsconfig.node.json" },
       { "path": "./tsconfig.worker.json" }
     ]
   }
   ```

7. Add `.wrangler` and `.dev.vars*` to `.gitignore`.

#### Files created/modified

- `package.json` (created by Vite scaffolding)
- `vite.config.ts` (modified to add Cloudflare plugin)
- `tsconfig.json` (modified to add worker reference)
- `tsconfig.worker.json` (created)
- `src/` directory (created by Vite scaffolding — React app files)
- `.gitignore` (modified)

#### Verification

- Run `bun run dev`. The Vite dev server starts and the default React app renders at the URL shown in the terminal (likely `http://localhost:5173`).
- Open the URL in a browser and confirm you see the Vite + React starter page.

---

### Task 2: Set up Cloudflare Worker with Hono as the HTTP router

Create the Worker entry point using Hono for HTTP routing. This Worker will eventually handle API routes, OAuth, SPA serving, and WebSocket routing to DOs.

#### Steps

1. Install Hono:
   ```bash
   bun add hono
   ```

2. Create the `worker/` directory and the Worker entry point at `worker/index.ts`:
   ```ts
   import { Hono } from "hono";

   type Env = {
     Bindings: {
       GIST_ROOM: DurableObjectNamespace;
       SESSION_KV: KVNamespace;
     };
   };

   const app = new Hono<Env>();

   app.get("/api/health", (c) => {
     return c.json({ status: "ok" });
   });

   export default app;
   ```

3. The Hono app is exported as the default export, which satisfies the `ExportedHandler` interface via Hono's built-in `fetch` method.

#### Files created/modified

- `worker/index.ts` (created)
- `package.json` (hono added)

#### Verification

- Run `bun run dev`.
- `curl http://localhost:8787/api/health` (or whatever port Vite assigns for the Worker) returns `{"status":"ok"}`.

---

### Task 3: Configure `partyserver` + `y-partyserver` for Durable Objects

Create a stub GistRoom Durable Object that extends `YServer` from `y-partyserver`. This is the foundation for real-time collaboration.

#### Steps

1. Install partyserver and y-partyserver:
   ```bash
   bun add partyserver y-partyserver yjs
   ```

2. Create `worker/gist-room.ts`:
   ```ts
   import { YServer } from "y-partyserver";
   import type { Connection } from "partyserver";

   export class GistRoom extends YServer {
     static options = {
       hibernate: true,
     };

     onConnect(connection: Connection) {
       console.log(`[GistRoom] Connection ${connection.id} joined room ${this.name}`);
     }

     onClose(connection: Connection) {
       console.log(`[GistRoom] Connection ${connection.id} left room ${this.name}`);
     }
   }
   ```

3. Export `GistRoom` from `worker/index.ts` so wrangler can discover it:
   ```ts
   export { GistRoom } from "./gist-room";
   ```

#### Files created/modified

- `worker/gist-room.ts` (created)
- `worker/index.ts` (modified — add re-export)

#### Verification

- TypeScript compiles without errors (the dev server starts).
- The `GistRoom` class is exported from the Worker entry point.

---

### Task 4: Create `wrangler.toml` with all bindings

Define the full Worker configuration including Durable Object bindings, KV namespace, and secrets placeholders.

#### Steps

1. Create `wrangler.toml` in the project root:
   ```toml
   name = "gist-party"
   main = "./worker/index.ts"
   compatibility_date = "2025-01-01"

   [assets]
   not_found_handling = "single-page-application"
   run_worker_first = ["/api/*", "/parties/*"]

   [durable_objects]
   bindings = [
     { name = "GIST_ROOM", class_name = "GistRoom" }
   ]

   [[migrations]]
   tag = "v1"
   new_classes = ["GistRoom"]

   [[kv_namespaces]]
   binding = "SESSION_KV"
   id = "placeholder-kv-id"

   # Secrets (set via `wrangler secret put <NAME>`):
   # GITHUB_CLIENT_ID
   # GITHUB_CLIENT_SECRET
   # JWT_SECRET
   # ENCRYPTION_KEY
   ```

2. For local development, create `.dev.vars` with placeholder secrets:
   ```
   GITHUB_CLIENT_ID=placeholder
   GITHUB_CLIENT_SECRET=placeholder
   JWT_SECRET=dev-jwt-secret-change-me
   ENCRYPTION_KEY=dev-encryption-key-change-me
   ```

3. Ensure `.dev.vars` is in `.gitignore` (should already be from Task 1).

#### Files created/modified

- `wrangler.toml` (created)
- `.dev.vars` (created)

#### Verification

- Run `bun run dev`. Wrangler parses the config without errors.
- Check terminal output for successful binding of `GIST_ROOM` Durable Object and `SESSION_KV` KV namespace (wrangler will create a local KV namespace automatically for dev).

---

### Task 5: Wire `routePartykitRequest` in the Worker

Connect incoming WebSocket requests at `/parties/gist-room/:gist_id` to the GistRoom Durable Object via partyserver's routing.

#### Steps

1. Update `worker/index.ts` to use `routePartykitRequest`:
   ```ts
   import { Hono } from "hono";
   import { routePartykitRequest } from "partyserver";

   type Env = {
     Bindings: {
       GIST_ROOM: DurableObjectNamespace;
       SESSION_KV: KVNamespace;
     };
   };

   const app = new Hono<Env>();

   app.get("/api/health", (c) => {
     return c.json({ status: "ok" });
   });

   app.all("/parties/*", async (c) => {
     const response = await routePartykitRequest(c.req.raw, c.env);
     if (response) return response;
     return c.text("Not Found", 404);
   });

   export default app;

   export { GistRoom } from "./gist-room";
   ```

   `routePartykitRequest` automatically maps the URL pattern `/parties/:server/:name` to the corresponding Durable Object binding. The binding name `GIST_ROOM` maps to the party name `gist-room` (kebab-cased).

#### Files created/modified

- `worker/index.ts` (modified)

#### Verification

- Run `bun run dev`.
- Use a WebSocket client (e.g., `websocat`, browser console, or a quick test script) to connect to `ws://localhost:8787/parties/gist-room/test-room`.
- Confirm the connection upgrades successfully (HTTP 101). Check terminal for the `[GistRoom] Connection ... joined room test-room` log.

---

### Task 6: Set up SPA serving via Cloudflare Worker Assets

Ensure the Vite-built React SPA is served for all non-API, non-party routes. The `wrangler.toml` already configures `not_found_handling = "single-page-application"` and `run_worker_first` to route API and party requests to the Worker.

#### Steps

1. Verify the `[assets]` section in `wrangler.toml` is configured (done in Task 4):
   ```toml
   [assets]
   not_found_handling = "single-page-application"
   run_worker_first = ["/api/*", "/parties/*"]
   ```
   The Cloudflare Vite plugin handles the `directory` mapping automatically — it points to the client build output at build time.

2. Update `src/App.tsx` to a minimal placeholder that confirms the SPA is running:
   ```tsx
   function App() {
     return (
       <div>
         <h1>gist.party</h1>
         <p>Scaffolding complete.</p>
       </div>
     );
   }

   export default App;
   ```

3. Clean up unused Vite starter files (optional but recommended): remove `src/App.css`, `src/assets/`, and update `src/index.css` to minimal styles. Remove the Vite/React logo imports from `App.tsx` and `index.html`.

#### Files created/modified

- `src/App.tsx` (modified)
- `src/App.css` (removed or emptied)
- `src/assets/` (removed)
- `index.html` (modified — update `<title>` to "gist.party", remove logo references)

#### Verification

- Run `bun run dev`.
- Open `http://localhost:5173` (or the port shown) in a browser.
- Confirm you see "gist.party" and "Scaffolding complete." rendered by React.
- Navigate to a random path like `http://localhost:5173/some-random-path` — the SPA should still load (SPA routing via `not_found_handling`).
- `curl http://localhost:8787/api/health` still returns `{"status":"ok"}` (Worker routes are not intercepted by asset serving).

---

### Task 7: Install all dependencies

Install the complete dependency set for the project. Some were installed in earlier tasks; this step ensures everything is present.

#### Steps

1. Install editor dependencies:
   ```bash
   bun add @milkdown/core @milkdown/react @milkdown/preset-commonmark @milkdown/preset-gfm @milkdown/plugin-collab @milkdown/utils @milkdown/plugin-listener
   ```

2. Install CRDT dependencies (yjs already installed in Task 3):
   ```bash
   bun add y-partyserver
   ```
   (Already installed — this is a no-op confirmation.)

3. Install server dependencies (hono, partyserver already installed):
   ```bash
   bun add partyserver hono
   ```
   (Already installed — this is a no-op confirmation.)

4. Install rendering dependencies:
   ```bash
   bun add remark rehype rehype-sanitize remark-rehype remark-parse remark-gfm unified
   ```

5. Verify the full dependency list in `package.json` includes all of the following:
   - **Editor**: `@milkdown/core`, `@milkdown/react`, `@milkdown/preset-commonmark`, `@milkdown/preset-gfm`, `@milkdown/plugin-collab`, `@milkdown/utils`, `@milkdown/plugin-listener`
   - **CRDT**: `yjs`, `y-partyserver`
   - **Server**: `partyserver`, `hono`
   - **Rendering**: `remark`, `remark-parse`, `remark-gfm`, `remark-rehype`, `rehype`, `rehype-sanitize`, `unified`
   - **Dev**: `@cloudflare/vite-plugin`, `wrangler`, `@cloudflare/workers-types`

#### Files created/modified

- `package.json` (modified — all dependencies added)
- `bun.lockb` (updated)

#### Verification

- Run `bun pm ls` and confirm all listed packages are installed without errors.
- Run `bun run dev` — the dev server starts without module resolution errors.

---

### Task 8: End-to-end verification

Confirm the full skeleton works: Vite HMR, Worker API routes, SPA serving, and a stub DO accepting WebSocket connections.

#### Steps

1. Start the dev server:
   ```bash
   bun run dev
   ```

2. **SPA serving**: Open the browser to the URL shown (e.g., `http://localhost:5173`). Confirm the React app renders with "gist.party" heading.

3. **Vite HMR**: Edit `src/App.tsx` (e.g., change the heading text). Confirm the browser updates without a full page reload.

4. **API route**: In a separate terminal:
   ```bash
   curl http://localhost:8787/api/health
   ```
   Expected: `{"status":"ok"}`

5. **WebSocket upgrade to DO**: Run a quick test from the browser console or a script:
   ```js
   const ws = new WebSocket("ws://localhost:8787/parties/gist-room/test-room-123");
   ws.onopen = () => { console.log("Connected!"); ws.close(); };
   ws.onerror = (e) => console.error("Error:", e);
   ```
   Expected: `"Connected!"` logs in the browser console, and the Worker terminal shows the GistRoom connection log.

6. **SPA fallback routing**: Navigate to `http://localhost:5173/abc123` — the SPA should load (not a 404 page from the server).

#### Files created/modified

None — this is a verification-only task.

#### Verification

All of the above checks pass:
- [ ] React SPA renders at root URL
- [ ] Vite HMR updates the page on file save
- [ ] `/api/health` returns `{"status":"ok"}`
- [ ] WebSocket connects to `/parties/gist-room/test-room-123` and the DO logs the connection
- [ ] SPA fallback serves `index.html` for arbitrary paths

---

## Phase Complete

### Milestone

`wrangler dev` (via `bun run dev`) serves the React SPA and a hello-world GistRoom Durable Object accepts a WebSocket connection.

### Checklist

- [ ] `bun run dev` starts without errors
- [ ] Browser shows the React SPA at the dev server URL
- [ ] Vite HMR works (edit `App.tsx`, see changes instantly)
- [ ] `GET /api/health` returns `{"status":"ok"}`
- [ ] WebSocket connection to `/parties/gist-room/<any-room-id>` upgrades successfully (HTTP 101)
- [ ] GistRoom DO logs connection events to the terminal
- [ ] SPA fallback routing works for arbitrary paths (no server 404)
- [ ] All dependencies listed in Task 7 are present in `package.json`
- [ ] No TypeScript compilation errors

### What's next

This skeleton is the foundation for **Phase 1: Core Verticals**, which has three parallel tracks:
- **Track 1A**: Auth System (GitHub OAuth, JWT, token encryption)
- **Track 1B**: Milkdown Editor (WYSIWYG markdown editing)
- **Track 1C**: GistRoom Durable Object (Yjs persistence, SQLite schema, custom messages)

Before starting Phase 1, define the **Shared Interface Contracts** documented in `plans/plan.md` (JWT module, token encryption module, DO SQLite schema, edit capability cookie format, custom message protocol).
