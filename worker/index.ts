import { Hono } from "hono";
import { routePartykitRequest } from "partyserver";

type Env = {
  Bindings: {
    GIST_ROOM: DurableObjectNamespace;
    SESSION_KV: KVNamespace;
  };
};

const app = new Hono<Env>();

app.get("/api/health", (c) => {
  return c.json({ status: "ok" });
});

app.all("/parties/*", async (c) => {
  const response = await routePartykitRequest(c.req.raw, c.env);
  if (response) return response;
  return c.text("Not Found", 404);
});

export default app;

export { GistRoom } from "./gist-room";
