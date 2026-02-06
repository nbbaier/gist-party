import { Hono } from "hono";
import { routePartykitRequest } from "partyserver";

// biome-ignore lint/performance/noBarrelFile: we need to re-export the GistRoom class
export { GistRoom } from "./gist-room";

import authRoutes from "./routes/auth";
import gistRoutes from "./routes/gists";
import { csrfMiddleware } from "./shared/csrf";

interface Env {
  Bindings: {
    GIST_ROOM: DurableObjectNamespace;
    SESSION_KV: KVNamespace;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    JWT_SECRET: string;
    ENCRYPTION_KEY_V1: string;
  };
}

const app = new Hono<Env>();

// Security headers middleware
app.use("*", async (c, next) => {
  await next();
  c.header("Referrer-Policy", "strict-origin");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' https://avatars.githubusercontent.com data:",
      "connect-src 'self' wss://*.gist.party wss://localhost:*",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self' https://github.com",
    ].join("; ")
  );
});

app.get("/api/health", (c) => {
  return c.json({ status: "ok" });
});

// CSRF protection on state-changing API routes
app.use("/api/gists/*", csrfMiddleware);
app.use("/api/auth/logout", csrfMiddleware);
app.use("/api/auth/refresh", csrfMiddleware);

app.route("/api/auth", authRoutes);
app.route("/api/gists", gistRoutes);

app.all("/parties/*", async (c) => {
  const response = await routePartykitRequest(c.req.raw, c.env);
  if (response) {
    return response;
  }
  return c.text("Not Found", 404);
});

export default app;
