export interface JwtPayload {
	userId: string;
	login: string;
	avatarUrl: string;
}

export interface JwtClaims extends JwtPayload {
	exp: number;
	aud: string;
	iss: string;
	iat: number;
}

export interface JwtOptions {
	secret: string;
	expiresInSeconds: number;
	audience: string;
	issuer: string;
}

function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	const base64 = btoa(String.fromCharCode(...bytes));
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64UrlDecode(base64url: string): Uint8Array {
	const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
	const padding = "=".repeat((4 - (base64.length % 4)) % 4);
	const padded = base64 + padding;
	const binary = atob(padded);
	return new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
}

async function importKey(secret: string): Promise<CryptoKey> {
	const encoder = new TextEncoder();
	const keyData = encoder.encode(secret);
	return crypto.subtle.importKey(
		"raw",
		keyData,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function signJwt(
	payload: JwtPayload,
	options: JwtOptions,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const claims: JwtClaims = {
		...payload,
		iat: now,
		exp: now + options.expiresInSeconds,
		aud: options.audience,
		iss: options.issuer,
	};

	const header = { alg: "HS256", typ: "JWT" };
	const headerB64 = base64UrlEncode(
		new TextEncoder().encode(JSON.stringify(header)),
	);
	const payloadB64 = base64UrlEncode(
		new TextEncoder().encode(JSON.stringify(claims)),
	);
	const message = `${headerB64}.${payloadB64}`;

	const key = await importKey(options.secret);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(message),
	);
	const signatureB64 = base64UrlEncode(signature);

	return `${message}.${signatureB64}`;
}

export async function verifyJwt(
	token: string,
	options: JwtOptions,
): Promise<JwtClaims> {
	const parts = token.split(".");
	if (parts.length !== 3) {
		throw new Error("Invalid JWT format");
	}

	const [headerB64, payloadB64, signatureB64] = parts;
	const message = `${headerB64}.${payloadB64}`;

	const key = await importKey(options.secret);
	const signature = base64UrlDecode(signatureB64);
	const valid = await crypto.subtle.verify(
		"HMAC",
		key,
		signature.buffer as ArrayBuffer,
		new TextEncoder().encode(message),
	);

	if (!valid) {
		throw new Error("Invalid signature");
	}

	const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
	const claims: JwtClaims = JSON.parse(payloadJson);

	const now = Math.floor(Date.now() / 1000);
	if (claims.exp < now) {
		throw new Error("Token expired");
	}

	if (claims.aud !== options.audience) {
		throw new Error("Invalid audience");
	}

	if (claims.iss !== options.issuer) {
		throw new Error("Invalid issuer");
	}

	return claims;
}
