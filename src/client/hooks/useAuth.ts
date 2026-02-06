import { useCallback, useEffect, useState } from "react";

interface User {
	userId: string;
	login: string;
	avatarUrl: string;
}

interface AuthState {
	user: User | null;
	loading: boolean;
	error: string | null;
}

export function useAuth(): AuthState & {
	logout: () => Promise<void>;
	refresh: () => Promise<void>;
} {
	const [state, setState] = useState<AuthState>({
		user: null,
		loading: true,
		error: null,
	});

	const fetchUser = useCallback(async () => {
		try {
			const response = await fetch("/api/auth/me", {
				credentials: "include",
			});

			if (response.ok) {
				const user = await response.json();
				setState({ user, loading: false, error: null });
			} else if (response.status === 401) {
				// Try to refresh the session
				const refreshResponse = await fetch("/api/auth/refresh", {
					method: "POST",
					credentials: "include",
				});

				if (refreshResponse.ok) {
					// Refresh successful, fetch user again
					const userResponse = await fetch("/api/auth/me", {
						credentials: "include",
					});
					if (userResponse.ok) {
						const user = await userResponse.json();
						setState({ user, loading: false, error: null });
					} else {
						setState({ user: null, loading: false, error: null });
					}
				} else {
					setState({ user: null, loading: false, error: null });
				}
			} else {
				setState({ user: null, loading: false, error: "Failed to fetch user" });
			}
		} catch (err) {
			setState({ user: null, loading: false, error: "Network error" });
		}
	}, []);

	useEffect(() => {
		fetchUser();
	}, [fetchUser]);

	const logout = useCallback(async () => {
		try {
			await fetch("/api/auth/logout", {
				method: "POST",
				credentials: "include",
			});
			setState({ user: null, loading: false, error: null });
		} catch (err) {
			console.error("Logout failed:", err);
		}
	}, []);

	const refresh = useCallback(async () => {
		setState((prev) => ({ ...prev, loading: true }));
		await fetchUser();
	}, [fetchUser]);

	return {
		...state,
		logout,
		refresh,
	};
}
