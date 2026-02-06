import { Hono } from "hono";
import { routePartykitRequest } from "partyserver";
import authRoutes from "./routes/auth";
import gistRoutes from "./routes/gists";

type Env = {
	Bindings: {
		GIST_ROOM: DurableObjectNamespace;
		SESSION_KV: KVNamespace;
		GITHUB_CLIENT_ID: string;
		GITHUB_CLIENT_SECRET: string;
		JWT_SECRET: string;
		ENCRYPTION_KEY_V1: string;
	};
};

const app = new Hono<Env>();

app.get("/api/health", (c) => {
	return c.json({ status: "ok" });
});

app.route("/api/auth", authRoutes);
app.route("/api/gists", gistRoutes);

app.all("/parties/*", async (c) => {
	const response = await routePartykitRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Not Found", 404);
});

export default app;

export { GistRoom } from "./gist-room";
