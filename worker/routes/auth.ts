import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { encrypt } from "../../src/shared/encryption";
import { signJwt, verifyJwt } from "../../src/shared/jwt";

type Env = {
	Bindings: {
		SESSION_KV: KVNamespace;
		GITHUB_CLIENT_ID: string;
		GITHUB_CLIENT_SECRET: string;
		JWT_SECRET: string;
		ENCRYPTION_KEY_V1: string;
	};
};

function generateState(): string {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return Array.from(array)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function generateCodeVerifier(): string {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return base64UrlEncode(array);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return base64UrlEncode(new Uint8Array(hash));
}

function base64UrlEncode(buffer: Uint8Array): string {
	const base64 = btoa(String.fromCharCode(...buffer));
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

const authRoutes = new Hono<Env>();

authRoutes.get("/github", async (c) => {
	const state = generateState();
	const codeVerifier = generateCodeVerifier();
	const codeChallenge = await generateCodeChallenge(codeVerifier);

	await c.env.SESSION_KV.put(
		`oauth:state:${state}`,
		JSON.stringify({ state, codeVerifier }),
		{ expirationTtl: 600 },
	);

	const origin = new URL(c.req.url).origin;
	const redirectUri = `${origin}/api/auth/github/callback`;

	const params = new URLSearchParams({
		client_id: c.env.GITHUB_CLIENT_ID,
		redirect_uri: redirectUri,
		scope: "gist read:user",
		state: state,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
	});

	const githubAuthUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;

	return c.redirect(githubAuthUrl, 302);
});

authRoutes.get("/github/callback", async (c) => {
	const code = c.req.query("code");
	const state = c.req.query("state");

	if (!code || !state) {
		return c.json({ error: "Missing code or state" }, 400);
	}

	const stateData = await c.env.SESSION_KV.get(`oauth:state:${state}`);
	if (!stateData) {
		return c.json({ error: "Invalid or expired state" }, 400);
	}

	await c.env.SESSION_KV.delete(`oauth:state:${state}`);

	const { codeVerifier } = JSON.parse(stateData);

	const tokenResponse = await fetch(
		"https://github.com/login/oauth/access_token",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				client_id: c.env.GITHUB_CLIENT_ID,
				client_secret: c.env.GITHUB_CLIENT_SECRET,
				code,
				redirect_uri: `${new URL(c.req.url).origin}/api/auth/github/callback`,
				code_verifier: codeVerifier,
			}),
		},
	);

	const tokenData = (await tokenResponse.json()) as {
		error?: string;
		error_description?: string;
		access_token: string;
	};
	if (tokenData.error) {
		return c.json({ error: tokenData.error_description }, 400);
	}

	const userResponse = await fetch("https://api.github.com/user", {
		headers: {
			Authorization: `Bearer ${tokenData.access_token}`,
			Accept: "application/vnd.github.v3+json",
			"User-Agent": "gist-party",
		},
	});

	if (!userResponse.ok) {
		return c.json({ error: "Failed to fetch user profile" }, 500);
	}

	const userData = (await userResponse.json()) as {
		id: string | number;
		login: string;
		avatar_url: string;
	};
	const { id: userId, login, avatar_url: avatarUrl } = userData;

	const encryptedToken = await encrypt(tokenData.access_token, {
		currentKey: { version: 1, rawKey: c.env.ENCRYPTION_KEY_V1 },
		previousKeys: [],
	});

	const sessionData = {
		userId,
		login,
		avatarUrl,
		encryptedToken,
		createdAt: new Date().toISOString(),
	};

	await c.env.SESSION_KV.put(`session:${userId}`, JSON.stringify(sessionData), {
		expirationTtl: 2592000,
	});

	const jwt = await signJwt(
		{ userId: String(userId), login, avatarUrl },
		{
			secret: c.env.JWT_SECRET,
			expiresInSeconds: 3600,
			audience: "gist.party",
			issuer: "gist.party",
		},
	);

	setCookie(c, "__session", jwt, {
		httpOnly: true,
		secure: true,
		sameSite: "Strict",
		path: "/",
		maxAge: 3600,
	});

	return c.redirect("/", 302);
});

authRoutes.post("/refresh", async (c) => {
	const sessionCookie = c.req.header("cookie")?.match(/__session=([^;]+)/)?.[1];

	if (!sessionCookie) {
		return c.json({ error: "invalid_session" }, 401);
	}

	try {
		const payload = await verifyJwt(sessionCookie, {
			secret: c.env.JWT_SECRET,
			expiresInSeconds: 3600,
			audience: "gist.party",
			issuer: "gist.party",
		});

		const sessionData = await c.env.SESSION_KV.get(`session:${payload.userId}`);
		if (!sessionData) {
			return c.json({ error: "session_revoked" }, 401);
		}

		const newJwt = await signJwt(
			{
				userId: payload.userId,
				login: payload.login,
				avatarUrl: payload.avatarUrl,
			},
			{
				secret: c.env.JWT_SECRET,
				expiresInSeconds: 3600,
				audience: "gist.party",
				issuer: "gist.party",
			},
		);

		setCookie(c, "__session", newJwt, {
			httpOnly: true,
			secure: true,
			sameSite: "Strict",
			path: "/",
			maxAge: 3600,
		});

		return c.json({ ok: true });
	} catch {
		return c.json({ error: "invalid_session" }, 401);
	}
});

authRoutes.post("/logout", async (c) => {
	const sessionCookie = c.req.header("cookie")?.match(/__session=([^;]+)/)?.[1];

	if (sessionCookie) {
		try {
			const payload = await verifyJwt(sessionCookie, {
				secret: c.env.JWT_SECRET,
				expiresInSeconds: 3600,
				audience: "gist.party",
				issuer: "gist.party",
			});
			await c.env.SESSION_KV.delete(`session:${payload.userId}`);
		} catch {
			// Best effort - continue even if JWT is expired
		}
	}

	setCookie(c, "__session", "", {
		httpOnly: true,
		secure: true,
		sameSite: "Strict",
		path: "/",
		maxAge: 0,
	});

	return c.json({ ok: true });
});

authRoutes.get("/me", async (c) => {
	const sessionCookie = c.req.header("cookie")?.match(/__session=([^;]+)/)?.[1];

	if (!sessionCookie) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	try {
		const payload = await verifyJwt(sessionCookie, {
			secret: c.env.JWT_SECRET,
			expiresInSeconds: 3600,
			audience: "gist.party",
			issuer: "gist.party",
		});

		return c.json({
			userId: payload.userId,
			login: payload.login,
			avatarUrl: payload.avatarUrl,
		});
	} catch {
		return c.json({ error: "Unauthorized" }, 401);
	}
});

export default authRoutes;
