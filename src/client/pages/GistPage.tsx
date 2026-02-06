import { useRef, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Editor } from "../components/Editor";
import type { EditorHandle } from "../components/Editor";
import { MilkdownProvider } from "@milkdown/react";
import { useCollabProvider } from "../hooks/useCollabProvider";
import { useMarkdownProtocol } from "../hooks/useMarkdownProtocol";
import { useAuth } from "../contexts/AuthContext";
import "./gist-page.css";

export function GistPage() {
  const { gistId } = useParams<{ gistId: string }>();
  const editorRef = useRef<EditorHandle>(null);
  const [exportedMarkdown, setExportedMarkdown] = useState("");
  const [defaultValue, setDefaultValue] = useState<string | undefined>(undefined);
  const { user } = useAuth();

  const { doc, provider, awareness, connectionState } = useCollabProvider({ gistId, user });

  const getMarkdown = useCallback(
    () => editorRef.current?.getMarkdown() ?? "",
    [],
  );

  const handleNeedsInit = useCallback(
    async (initGistId: string, _filename: string) => {
      try {
        const res = await fetch(`/api/gists/${initGistId}`);
        if (!res.ok) return;
        const data = await res.json() as { content?: string };
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

  const handleChange = (_markdown: string) => {
    // debounced change handler — can be used for save triggers
  };

  return (
    <div className="gist-page">
      <div className="gist-header">
        <h2>Editing: {gistId}</h2>
        <div className="gist-header-info">
          <span className={`connection-status ${connectionState}`}>
            {connectionState}
          </span>
        </div>
        <div className="gist-actions">
          <button type="button" className="btn btn-secondary" onClick={handleExport}>
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
    </div>
  );
}
