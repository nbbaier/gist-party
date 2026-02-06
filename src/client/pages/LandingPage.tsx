import { useState } from "react";
import { useNavigate } from "react-router-dom";
import "./landing-page.css";

export function LandingPage() {
	const navigate = useNavigate();
	const [gistUrl, setGistUrl] = useState("");

	const handleNewDocument = () => {
		// Generate a random gist ID for now
		const randomId = Math.random().toString(36).substring(2, 15);
		navigate(`/${randomId}`);
	};

	const handleImportGist = () => {
		// Extract gist ID from URL or use as-is
		const gistId = gistUrl.split("/").pop() || gistUrl;
		if (gistId) {
			navigate(`/${gistId}`);
		}
	};

	return (
		<div className="landing-page">
			<div className="hero">
				<h1>Collaborative Gist Editing</h1>
				<p className="subtitle">
					Real-time markdown editing powered by Yjs and GitHub Gists
				</p>
			</div>

			<div className="actions">
				<button
					type="button"
					className="btn btn-primary"
					onClick={handleNewDocument}
				>
					New Document
				</button>

				<div className="import-section">
					<input
						type="text"
						placeholder="Paste GitHub Gist URL or ID"
						value={gistUrl}
						onChange={(e) => setGistUrl(e.target.value)}
						className="import-input"
						onKeyDown={(e) => e.key === "Enter" && handleImportGist()}
					/>
					<button
						type="button"
						className="btn btn-secondary"
						onClick={handleImportGist}
						disabled={!gistUrl.trim()}
					>
						Import Gist
					</button>
				</div>
			</div>

			<div className="features">
				<div className="feature">
					<h3>Real-time Collaboration</h3>
					<p>Edit together with others in real-time using Yjs</p>
				</div>
				<div className="feature">
					<h3>GitHub Integration</h3>
					<p>Sync your changes directly to GitHub Gists</p>
				</div>
				<div className="feature">
					<h3>WYSIWYG Editor</h3>
					<p>Beautiful markdown editing with live preview</p>
				</div>
			</div>
		</div>
	);
}
