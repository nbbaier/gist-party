export const EDIT_COOKIE_NAME = "gp_edit_cap";
export const EDIT_COOKIE_TTL = 86400;

export interface EditCookieOptions {
	gistId: string;
}

export interface EditCookieAttributes {
	name: typeof EDIT_COOKIE_NAME;
	path: string;
	httpOnly: true;
	secure: true;
	sameSite: "Strict";
	maxAge: number;
}

export interface EditCookiePayload {
	gistId: string;
	expiresAt: number;
}

export function editCookiePath(gistId: string): string {
	return `/parties/gist-room/${gistId}`;
}

export function buildEditCookieAttributes(
	options: EditCookieOptions,
): EditCookieAttributes {
	return {
		name: EDIT_COOKIE_NAME,
		path: editCookiePath(options.gistId),
		httpOnly: true,
		secure: true,
		sameSite: "Strict",
		maxAge: EDIT_COOKIE_TTL,
	};
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

async function importHmacKey(secret: string): Promise<CryptoKey> {
	const encoder = new TextEncoder();
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function signEditCookie(
	payload: EditCookiePayload,
	secret: string,
): Promise<string> {
	const data = new TextEncoder().encode(JSON.stringify(payload));
	const key = await importHmacKey(secret);
	const signature = await crypto.subtle.sign("HMAC", key, data);
	const sigB64 = base64UrlEncode(signature);
	const dataB64 = base64UrlEncode(data);
	return `${dataB64}.${sigB64}`;
}

export async function verifyEditCookie(
	cookieValue: string,
	gistId: string,
	secret: string,
): Promise<EditCookiePayload | null> {
	try {
		const [dataB64, sigB64] = cookieValue.split(".");
		if (!dataB64 || !sigB64) return null;

		const data = base64UrlDecode(dataB64);
		const signature = base64UrlDecode(sigB64);
		const key = await importHmacKey(secret);
		const valid = await crypto.subtle.verify(
			"HMAC",
			key,
			signature.buffer as ArrayBuffer,
			data.buffer as ArrayBuffer,
		);

		if (!valid) return null;

		const payload: EditCookiePayload = JSON.parse(
			new TextDecoder().decode(data),
		);

		if (payload.gistId !== gistId) return null;
		if (payload.expiresAt < Math.floor(Date.now() / 1000)) return null;

		return payload;
	} catch {
		return null;
	}
}
