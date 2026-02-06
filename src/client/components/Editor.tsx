import {
	defaultValueCtx,
	Editor as MilkdownEditor,
	rootCtx,
} from "@milkdown/core";
import { CollabReady, collab, collabServiceCtx } from "@milkdown/plugin-collab";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import {
	Milkdown,
	MilkdownProvider,
	useEditor,
	useInstance,
} from "@milkdown/react";
import { getMarkdown } from "@milkdown/utils";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import type { Awareness } from "y-protocols/awareness";
import type { Doc } from "yjs";

import "../styles/editor.css";

export interface EditorHandle {
	getMarkdown: () => string;
	isDirty: () => boolean;
	markClean: () => void;
}

export interface EditorProps {
	defaultValue?: string;
	onChange?: (markdown: string) => void;
	readonly?: boolean;
	doc?: Doc | null;
	awareness?: Awareness | null;
}

function EditorComponent(
	{
		defaultValue = "",
		onChange,
		readonly = false,
		doc,
		awareness,
	}: EditorProps,
	ref: React.Ref<EditorHandle>,
) {
	const [isDirty, setIsDirty] = useState(false);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastSavedRef = useRef(defaultValue);

	useEditor(
		(container) => {
			const editor = MilkdownEditor.make()
				.config((ctx) => {
					ctx.set(rootCtx, container);
					if (defaultValue && !doc) {
						ctx.set(defaultValueCtx, defaultValue);
					}
					ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
						if (debounceRef.current) {
							clearTimeout(debounceRef.current);
						}
						debounceRef.current = setTimeout(() => {
							setIsDirty(markdown !== lastSavedRef.current);
							onChange?.(markdown);
						}, 300);
					});
				})
				.use(commonmark)
				.use(gfm)
				.use(listener);

			if (doc) {
				editor.use(collab);
			}

			return editor;
		},
		[defaultValue, onChange, doc],
	);

	const [loading, getInstance] = useInstance();

	useEffect(() => {
		if (loading || !doc) return;

		const editor = getInstance();
		if (!editor) return;

		const ctx = editor.ctx;
		let cancelled = false;

		ctx.wait(CollabReady).then(() => {
			if (cancelled) return;
			const collabService = ctx.get(collabServiceCtx);
			collabService.bindDoc(doc);
			if (awareness) {
				collabService.setAwareness(awareness);
			}
			collabService.connect();
		});

		return () => {
			cancelled = true;
			try {
				const collabService = ctx.get(collabServiceCtx);
				collabService.disconnect();
			} catch {
				// editor may already be destroyed
			}
		};
	}, [loading, getInstance, doc, awareness]);

	useEffect(() => {
		return () => {
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
			}
		};
	}, []);

	const handleGetMarkdown = useCallback((): string => {
		if (loading) return "";
		const editor = getInstance();
		if (!editor) return "";
		try {
			return editor.action(getMarkdown());
		} catch {
			return "";
		}
	}, [loading, getInstance]);

	const handleIsDirty = useCallback((): boolean => {
		return isDirty;
	}, [isDirty]);

	const handleMarkClean = useCallback((): void => {
		lastSavedRef.current = handleGetMarkdown();
		setIsDirty(false);
	}, [handleGetMarkdown]);

	useImperativeHandle(ref, () => ({
		getMarkdown: handleGetMarkdown,
		isDirty: handleIsDirty,
		markClean: handleMarkClean,
	}));

	return (
		<div className={`editor-container ${readonly ? "readonly" : ""}`}>
			<Milkdown />
		</div>
	);
}

export const Editor = forwardRef(EditorComponent);

export function EditorWithProvider(
	props: EditorProps & { ref?: React.Ref<EditorHandle> },
) {
	return (
		<MilkdownProvider>
			<Editor {...props} ref={props.ref} />
		</MilkdownProvider>
	);
}
