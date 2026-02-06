import { useRef, useState, useCallback, useEffect } from "react";
import { useParams } from "react-router-dom";
import { Editor } from "../components/Editor";
import type { EditorHandle } from "../components/Editor";
import { MarkdownViewer } from "../components/MarkdownViewer";
import { MilkdownProvider } from "@milkdown/react";
import { useCollabProvider } from "../hooks/useCollabProvider";
import { useEditToken } from "../hooks/useEditToken";
import { useMarkdownProtocol } from "../hooks/useMarkdownProtocol";
import { useAuth } from "../contexts/AuthContext";
import { NotFoundPage } from "./NotFoundPage";
import "./gist-page.css";

type ViewState = "loading" | "not-found" | "editor" | "viewer";

interface GistMeta {
  gist_id: string;
  filename: string;
  owner_user_id: string;
  pending_sync: boolean;
  initialized: boolean;
}

function EditorView({
  gistId,
  user,
}: {
  gistId: string;
  user: { userId: string; login: string; avatarUrl: string } | null;
}) {
  const editorRef = useRef<EditorHandle>(null);
  const [exportedMarkdown, setExportedMarkdown] = useState("");
  const [defaultValue, setDefaultValue] = useState<string | undefined>(
    undefined,
  );

  const { doc, provider, awareness, connectionState } = useCollabProvider({
    gistId,
    user,
  });

  const getMarkdown = useCallback(
    () => editorRef.current?.getMarkdown() ?? "",
    [],
  );

  const handleNeedsInit = useCallback(
    async (initGistId: string, _filename: string) => {
      try {
        const res = await fetch(`/api/gists/${initGistId}`);
        if (!res.ok) return;
        const data = (await res.json()) as { content?: string };
        if (data.content) {
          setDefaultValue(data.content);
        }
      } catch {
        // failed to fetch initial content
      }
    },
    [],
  );

  const handleReloadRemote = useCallback((markdown: string) => {
    setDefaultValue(markdown);
  }, []);

  useMarkdownProtocol({
    provider,
    getMarkdown,
    onNeedsInit: handleNeedsInit,
    onReloadRemote: handleReloadRemote,
  });

  const handleExport = () => {
    const markdown = editorRef.current?.getMarkdown() || "";
    setExportedMarkdown(markdown);
  };

  const handleChange = () => {};

  return (
    <>
      <div className="gist-header">
        <h2>Editing: {gistId}</h2>
        <div className="gist-header-info">
          <span className={`connection-status ${connectionState}`}>
            {connectionState}
          </span>
        </div>
        <div className="gist-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleExport}
          >
            Export Markdown
          </button>
        </div>
      </div>

      <div className="editor-wrapper">
        {doc ? (
          <MilkdownProvider>
            <Editor
              ref={editorRef}
              doc={doc}
              awareness={awareness}
              defaultValue={defaultValue}
              onChange={handleChange}
            />
          </MilkdownProvider>
        ) : (
          <div className="editor-loading">Connecting...</div>
        )}
      </div>

      {exportedMarkdown && (
        <div className="export-preview">
          <h3>Exported Markdown:</h3>
          <pre className="export-content">{exportedMarkdown}</pre>
        </div>
      )}
    </>
  );
}

function ReadOnlyView({
  gistId,
  meta,
}: {
  gistId: string;
  meta: GistMeta;
}) {
  const [rawContent, setRawContent] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/gists/${gistId}/raw`)
      .then((r) => r.text())
      .then(setRawContent)
      .catch(() => setRawContent(""));
  }, [gistId]);

  if (rawContent === null) {
    return <div className="editor-loading">Loading...</div>;
  }

  return (
    <>
      <div className="gist-header">
        <h2>{meta.filename}</h2>
        <div className="gist-header-info">
          <span className="view-badge">Read-only</span>
        </div>
      </div>
      <div className="viewer-wrapper">
        <MarkdownViewer content={rawContent} />
      </div>
    </>
  );
}

export function GistPage() {
  const { gistId } = useParams<{ gistId: string }>();
  const { user, loading: authLoading } = useAuth();
  const { claiming } = useEditToken(gistId);
  const [viewState, setViewState] = useState<ViewState>("loading");
  const [meta, setMeta] = useState<GistMeta | null>(null);

  useEffect(() => {
    if (authLoading || claiming || !gistId) return;

    let cancelled = false;

    async function resolve() {
      try {
        const metaRes = await fetch(`/api/gists/${gistId}`);
        if (metaRes.status === 404) {
          if (!cancelled) setViewState("not-found");
          return;
        }
        if (!metaRes.ok) {
          if (!cancelled) setViewState("not-found");
          return;
        }

        const metaData = (await metaRes.json()) as GistMeta;
        if (cancelled) return;
        setMeta(metaData);

        const editRes = await fetch(`/api/gists/${gistId}/can-edit`, {
          credentials: "include",
        });
        const { canEdit } = (await editRes.json()) as { canEdit: boolean };

        if (!cancelled) {
          setViewState(canEdit ? "editor" : "viewer");
        }
      } catch {
        if (!cancelled) setViewState("not-found");
      }
    }

    resolve();
    return () => {
      cancelled = true;
    };
  }, [gistId, user, authLoading, claiming]);

  if (!gistId) return null;

  if (viewState === "loading") {
    return (
      <div className="gist-page">
        <div className="editor-loading">Loading...</div>
      </div>
    );
  }

  if (viewState === "not-found") {
    return <NotFoundPage gistId={gistId} />;
  }

  return (
    <div className="gist-page">
      {viewState === "editor" ? (
        <EditorView gistId={gistId} user={user} />
      ) : (
        meta && <ReadOnlyView gistId={gistId} meta={meta} />
      )}
    </div>
  );
}
