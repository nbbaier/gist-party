import { useEffect, useState } from "react";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import "./markdown-viewer.css";

export interface MarkdownViewerProps {
	content: string;
	className?: string;
}

export function MarkdownViewer({
	content,
	className = "",
}: MarkdownViewerProps) {
	const [html, setHtml] = useState<string>("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const processMarkdown = async () => {
			try {
				const result = await unified()
					.use(remarkParse)
					.use(remarkGfm)
					.use(remarkRehype)
					.use(rehypeSanitize)
					.use(rehypeStringify)
					.process(content);

				setHtml(String(result));
				setError(null);
			} catch (err) {
				setError("Failed to render markdown");
				console.error("Markdown rendering error:", err);
			}
		};

		processMarkdown();
	}, [content]);

	if (error) {
		return (
			<div className={`markdown-viewer markdown-viewer--error ${className}`}>
				<p className="markdown-viewer__error">{error}</p>
				<pre className="markdown-viewer__raw">{content}</pre>
			</div>
		);
	}

	return (
		<div
			className={`markdown-viewer ${className}`}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
