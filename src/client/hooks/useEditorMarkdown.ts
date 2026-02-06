import { useCallback, useRef } from "react";
import type { EditorHandle } from "../components/Editor";

export function useEditorMarkdown() {
	const editorRef = useRef<EditorHandle>(null);

	const getMarkdown = useCallback((): string => {
		return editorRef.current?.getMarkdown() ?? "";
	}, []);

	const isDirty = useCallback((): boolean => {
		return editorRef.current?.isDirty() ?? false;
	}, []);

	const markClean = useCallback((): void => {
		editorRef.current?.markClean();
	}, []);

	return {
		editorRef,
		getMarkdown,
		isDirty,
		markClean,
	};
}
