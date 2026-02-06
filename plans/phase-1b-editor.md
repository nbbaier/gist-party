# Track 1B — Milkdown Editor

> **Goal**: A functional markdown WYSIWYG editor with local editing (no collaboration yet). A read-only rendered view component. An app shell with client routing.

## Prerequisites

- Phase 0 complete: Vite + React + TS project scaffolded, all Milkdown packages installed (`@milkdown/core`, `@milkdown/react`, `@milkdown/preset-commonmark`, `@milkdown/preset-gfm`, `@milkdown/plugin-listener`, `@milkdown/utils`), rendering packages installed (`remark`, `rehype`, `rehype-sanitize`), React Router installed
- `wrangler dev` starts and serves the SPA with Vite HMR

## Depends On / Produces

| Contract | Role | Notes |
|---|---|---|
| JWT sign/verify module | **Consumes** (indirectly) | Track 1B reads auth state from the `AuthContext` produced by Track 1A. The nav bar placeholder displays user info but the auth flow itself is wired in 1A. |
| Custom message protocol | **Consumes** (later) | The editor component exposes a `getMarkdown()` extraction API that Phase 2A uses to respond to `request-markdown` messages. This track builds the extraction capability; wiring happens in Phase 2A. |
| Markdown serialization protocol | **Produces** (partially) | Builds the client-side `getMarkdown()` capability and the `defaultValue` loading mechanism. Full protocol wiring (responding to DO messages) is Phase 2A. |

---

## Tasks

### Task 1: Milkdown Editor Component

**Description**: Create a React component that renders a Milkdown WYSIWYG markdown editor with CommonMark and GFM support.

**Implementation Details**:

1. Create `src/client/components/Editor.tsx`
2. Use `@milkdown/react`'s `Milkdown` and `MilkdownProvider` components with the `useEditor` hook
3. Configure the editor with:
   ```ts
   import { commonmarkPreset } from '@milkdown/preset-commonmark'
   import { gfmPreset } from '@milkdown/preset-gfm'
   ```
   - **Note**: Check the actual export names from `@milkdown/preset-commonmark` and `@milkdown/preset-gfm`. The API may use `commonmark()` / `gfm()` factory functions or named plugin arrays. Read the installed package's types/entry point to confirm.
4. Accept props:
   ```ts
   interface EditorProps {
     defaultValue?: string;      // Initial markdown content
     onChange?: (markdown: string) => void;  // Called on document change
     readonly?: boolean;         // If true, disable editing
   }
   ```
5. Set `defaultValue` on the editor — this is the markdown string loaded on first render. Milkdown parses it through its remark pipeline into ProseMirror nodes.
6. The editor should fill its container (`width: 100%`, responsive height)
7. Basic styling: import Milkdown's default theme/styles if available, or apply minimal CSS for readable typography (headings, lists, code blocks, blockquotes)

**Files to create/modify**:
- Create: `src/client/components/Editor.tsx`
- Create: `src/client/styles/editor.css` (editor-specific styles)

**Verification**:
1. Start `wrangler dev`
2. Navigate to `http://localhost:8787/` (or a test route)
3. Editor renders with the default value content displayed as formatted markdown (headings styled, bold rendered, etc.)
4. Type in the editor — text appears with WYSIWYG formatting
5. Type `## Hello` at the start of a new line → renders as an H2 heading
6. Type `**bold**` → renders as bold text
7. Type `- item` → creates a bulleted list
8. Type `- [ ] task` → creates a GFM task list checkbox
9. Create a table using GFM syntax → table renders in the editor
10. No console errors related to Milkdown initialization

---

### Task 2: Markdown Serialization (getMarkdown)

**Description**: Expose a way to extract the current editor content as a markdown string, and to programmatically set content.

**Implementation Details**:

1. In `src/client/components/Editor.tsx`:
   - Use `getMarkdown()` from `@milkdown/utils` to extract markdown from the editor instance
   - **Note**: Check the actual API. `@milkdown/utils` may export `getMarkdown` as a function that takes the editor context/ctx, or it may be accessed via `editor.action(getMarkdown())`. Read the installed types to confirm.
2. Expose the extraction capability via a ref or callback:
   ```ts
   // Option A: Ref-based
   interface EditorHandle {
     getMarkdown: () => string;
   }
   const Editor = forwardRef<EditorHandle, EditorProps>(...)

   // Option B: Callback-based (via onChange prop from Task 1)
   ```
3. Create a helper hook `src/client/hooks/useEditorMarkdown.ts` that wraps the extraction logic for use by other components (e.g., Phase 2A's custom message handler)
4. Test with a simple "Export" button that calls `getMarkdown()` and logs the result

**Files to create/modify**:
- Modify: `src/client/components/Editor.tsx`
- Create: `src/client/hooks/useEditorMarkdown.ts`

**Verification**:
1. Add a temporary "Export Markdown" button to the editor page
2. Type formatted content in the editor (headings, bold, lists, code blocks)
3. Click "Export Markdown" → console logs the markdown string
4. Verify the markdown is valid: headings have `##` prefixes, bold has `**`, lists have `- `, code blocks have triple backticks
5. Verify roundtrip: copy the exported markdown, reload the page, paste it as `defaultValue` → editor renders identically

---

### Task 3: Change Listener

**Description**: Set up `plugin-listener` to observe document changes for future save triggers and dirty-state tracking.

**Implementation Details**:

1. In `src/client/components/Editor.tsx`, add `@milkdown/plugin-listener`:
   ```ts
   import { listener, listenerCtx } from '@milkdown/plugin-listener'
   ```
   - **Note**: Check actual exports. The plugin may be configured differently — read the installed package types.
2. Register the listener plugin with the editor and configure a markdown change callback:
   - On each document change, invoke the `onChange` prop with the current markdown string
   - **Debounce consideration**: The listener fires on every ProseMirror transaction. The `onChange` callback should be debounced (300ms) to avoid excessive calls. Use a simple `setTimeout`/`clearTimeout` pattern — no external debounce library needed.
3. Track "dirty" state: `isDirty` boolean that is `true` when content has changed since last save/load. This will be used by Phase 4B for the "unsaved changes" warning.
4. Export `isDirty` via the editor handle or a separate hook

**Files to create/modify**:
- Modify: `src/client/components/Editor.tsx`

**Verification**:
1. Open the editor with `onChange` wired to `console.log`
2. Type a character → after 300ms debounce, the full markdown string is logged
3. Rapid typing → only one log per 300ms window (debounce working)
4. Verify `isDirty` starts as `false`, becomes `true` after typing

---

### Task 4: App Shell and Client Routing

**Description**: Set up React Router with the application shell (nav bar, layout) and route structure.

**Implementation Details**:

1. Create `src/client/App.tsx` (or modify if it exists from Phase 0):
   - Set up `BrowserRouter` (or `createBrowserRouter`) from `react-router-dom`
   - **Note**: Check which version of react-router-dom is installed. v6 uses `createBrowserRouter` + `RouterProvider`; earlier versions use `<BrowserRouter>`. Read `package.json` to confirm.

2. Define routes:
   | Path | Component | Notes |
   |---|---|---|
   | `/` | `LandingPage` | Home page with "Sign in" and "New Document" |
   | `/:gistId` | `GistPage` | Editor or read-only view (mode determined later by auth + capability) |

3. Create `src/client/pages/LandingPage.tsx`:
   - "Sign in with GitHub" button (links to `/api/auth/github`)
   - "New Document" button (placeholder — wired in Phase 2B)
   - "Import Gist" input (placeholder — wired in Phase 2B)

4. Create `src/client/pages/GistPage.tsx`:
   - Extracts `gistId` from route params (`useParams()`)
   - For now, renders the `Editor` component with placeholder markdown content
   - In Phase 2A, this will be wired to the YProvider; in Phase 3C, it will conditionally render editor vs read-only view

5. Create `src/client/components/NavBar.tsx`:
   - Displays app name/logo linking to `/`
   - Auth state placeholder: shows "Sign in" link or user avatar + login (reads from `AuthContext` when Track 1A is integrated)
   - Renders at the top of every page (in the layout)

6. Create `src/client/components/Layout.tsx`:
   - `NavBar` at top
   - `<Outlet />` or `{children}` for page content
   - Minimal responsive layout (centered content, max-width for readability)

**Files to create/modify**:
- Create or modify: `src/client/App.tsx`
- Create: `src/client/pages/LandingPage.tsx`
- Create: `src/client/pages/GistPage.tsx`
- Create: `src/client/components/NavBar.tsx`
- Create: `src/client/components/Layout.tsx`

**Verification**:
1. Start `wrangler dev`
2. Navigate to `http://localhost:8787/` → landing page renders with "Sign in" and "New Document" buttons
3. Navigate to `http://localhost:8787/abc123` → `GistPage` renders with the editor, `gistId` is `abc123`
4. Click the app name in the nav bar → navigates back to `/`
5. Browser back/forward buttons work (client-side routing, no full page reloads)
6. Direct URL access works: open `http://localhost:8787/abc123` in a new tab → SPA loads and routes to `GistPage`
   - **Note**: This requires the Worker to serve `index.html` for all non-API, non-asset routes (SPA fallback). Verify this is configured in the Worker/wrangler setup from Phase 0.

---

### Task 5: Read-Only Rendered View Component

**Description**: Create a component that renders markdown as sanitized HTML using the `remark` → `rehype` → `rehype-sanitize` pipeline. This is used for anonymous viewers and users without edit capability.

**Implementation Details**:

1. Create `src/client/components/MarkdownViewer.tsx`
2. Accept props:
   ```ts
   interface MarkdownViewerProps {
     markdown: string;  // Raw markdown string to render
   }
   ```
3. Build the rendering pipeline:
   ```ts
   import { unified } from 'unified'
   import remarkParse from 'remark-parse'
   import remarkGfm from 'remark-gfm'
   import remarkRehype from 'remark-rehype'
   import rehypeSanitize from 'rehype-sanitize'
   import rehypeStringify from 'rehype-stringify'
   ```
   - **Note**: Check which of these packages are already installed. The SPEC lists `remark`, `rehype`, `rehype-sanitize` but the specific sub-packages (`remark-parse`, `remark-gfm`, `remark-rehype`, `rehype-stringify`) may need to be added. Check `package.json`.
   - If `remark-gfm` is not installed, add it (needed for GFM table/task list rendering consistency with the editor)
4. Process markdown to sanitized HTML:
   ```ts
   const html = await unified()
     .use(remarkParse)
     .use(remarkGfm)
     .use(remarkRehype)
     .use(rehypeSanitize)
     .use(rehypeStringify)
     .process(markdown)
   ```
5. Render using `dangerouslySetInnerHTML` (safe because `rehype-sanitize` strips all dangerous HTML)
6. Use `useMemo` or `useEffect` + state to cache the rendered HTML and avoid re-processing on every render
7. Apply typography styles matching the editor's look (so read-only and edit views feel consistent)
8. **Important**: `rehype-sanitize` uses the default schema which strips most HTML. This is correct for security. Do NOT relax the schema unless specifically needed.

**Files to create/modify**:
- Create: `src/client/components/MarkdownViewer.tsx`
- Create: `src/client/styles/markdown-viewer.css` (typography styles for rendered output)
- Possibly modify: `package.json` (if sub-packages like `remark-parse`, `remark-gfm`, `remark-rehype`, `rehype-stringify` need to be added)

**Verification**:
1. Create a test page or storybook-like route that renders `<MarkdownViewer>` with sample markdown:
   ```markdown
   # Heading 1
   ## Heading 2

   **Bold** and *italic* and ~~strikethrough~~

   - List item 1
   - List item 2
     - Nested item

   - [ ] Task 1
   - [x] Task 2 (done)

   | Col A | Col B |
   |-------|-------|
   | 1     | 2     |

   ```js
   console.log("hello")
   ```

   > Blockquote

   [Link](https://example.com)

   <script>alert('xss')</script>
   <img src=x onerror="alert('xss')">
   ```
2. Headings render as `<h1>`, `<h2>` with appropriate sizing
3. Bold, italic, strikethrough render correctly
4. Lists and nested lists render correctly
5. GFM task lists render as checkboxes
6. Tables render as `<table>` with rows and columns
7. Code blocks render in monospace
8. Blockquotes render with visual indentation
9. Links render as `<a>` tags
10. **XSS test**: The `<script>` tag is stripped entirely (not visible in rendered output, not in DOM)
11. **XSS test**: The malicious `<img>` tag is stripped (no `onerror` attribute in DOM)
12. Inspect the DOM: no `<script>` elements, no `onerror`/`onclick` attributes anywhere

---

## Track Complete

### Overall Milestone Verification

Perform this sequence in a browser:

1. **Navigate** to `http://localhost:8787/` → landing page with nav bar, "Sign in" button, "New Document" placeholder
2. **Navigate** to `http://localhost:8787/test-gist` → editor page loads
3. **Type** in the editor:
   - `## Hello World` → renders as H2
   - `**bold text**` → renders as bold
   - `- [ ] todo item` → renders as task list
   - Create a GFM table → renders as table
4. **Extract markdown**: Click the temporary "Export Markdown" button (or call `getMarkdown()` via console/ref) → valid markdown string output
5. **Verify roundtrip**: Take the exported markdown, pass it as `defaultValue` to a new editor instance → renders identically
6. **Change listener**: Type in the editor → `onChange` fires (debounced) with the current markdown → verify in console
7. **Read-only view**: Navigate to a test route rendering `<MarkdownViewer>` with the same markdown → sanitized HTML output
8. **XSS safety**: `<script>alert('xss')</script>` in the markdown input → no script tag in rendered DOM
9. **Client routing**: Navigate between `/` and `/:gistId` using links and browser back/forward → no full page reloads, routes resolve correctly
10. **Direct URL access**: Open `http://localhost:8787/some-gist-id` in a new tab → SPA loads and renders the editor page

All editor features work without collaboration (no WebSocket connections needed). The editor and read-only viewer are standalone components ready for integration.
