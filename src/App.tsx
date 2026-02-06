import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./client/components/Layout";
import { AuthProvider } from "./client/contexts/AuthContext";
import { GistPage } from "./client/pages/GistPage";
import { LandingPage } from "./client/pages/LandingPage";
import "./index.css";

function App() {
	return (
		<AuthProvider>
			<BrowserRouter>
				<Layout>
					<Routes>
						<Route path="/" element={<LandingPage />} />
						<Route path="/:gistId" element={<GistPage />} />
					</Routes>
				</Layout>
			</BrowserRouter>
		</AuthProvider>
	);
}

export default App;
