import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";

interface User {
	userId: string;
	login: string;
	avatarUrl: string;
}

interface AuthContextType {
	user: User | null;
	loading: boolean;
	logout: () => Promise<void>;
	refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
	children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
	const [user, setUser] = useState<User | null>(null);
	const [loading, setLoading] = useState(true);

	const fetchMe = useCallback(async () => {
		const response = await fetch("/api/auth/me", {
			credentials: "include",
		});

		if (!response.ok) {
			if (response.status === 401) {
				return null;
			}
			throw new Error("Failed to fetch user");
		}

		return response.json() as Promise<User>;
	}, []);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const refreshResponse = await fetch("/api/auth/refresh", {
				method: "POST",
				credentials: "include",
			});

			if (!refreshResponse.ok) {
				setUser(null);
				return;
			}

			const userData = await fetchMe();
			setUser(userData);
		} catch {
			setUser(null);
		} finally {
			setLoading(false);
		}
	}, [fetchMe]);

	const logout = useCallback(async () => {
		try {
			await fetch("/api/auth/logout", {
				method: "POST",
				credentials: "include",
			});
		} finally {
			setUser(null);
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	return (
		<AuthContext.Provider value={{ user, loading, logout, refresh }}>
			{children}
		</AuthContext.Provider>
	);
}

export function useAuth() {
	const context = useContext(AuthContext);
	if (context === undefined) {
		throw new Error("useAuth must be used within an AuthProvider");
	}
	return context;
}
