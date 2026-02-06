import { createMiddleware } from "hono/factory";
import { verifyJwt } from "../../src/shared/jwt";

type Env = {
	Bindings: {
		GIST_ROOM: DurableObjectNamespace;
		SESSION_KV: KVNamespace;
		GITHUB_CLIENT_ID: string;
		GITHUB_CLIENT_SECRET: string;
		JWT_SECRET: string;
		ENCRYPTION_KEY_V1: string;
	};
	Variables: {
		userId: string;
		login: string;
		avatarUrl: string;
	};
};

export const authMiddleware = createMiddleware<Env>(async (c, next) => {
	const sessionCookie = c.req.header("cookie")?.match(/__session=([^;]+)/)?.[1];

	if (!sessionCookie) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	try {
		const claims = await verifyJwt(sessionCookie, {
			secret: c.env.JWT_SECRET,
			expiresInSeconds: 3600,
			audience: "gist.party",
			issuer: "gist.party",
		});

		c.set("userId", claims.userId);
		c.set("login", claims.login);
		c.set("avatarUrl", claims.avatarUrl);

		await next();
	} catch {
		return c.json({ error: "Unauthorized" }, 401);
	}
});
