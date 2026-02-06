import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import "./navbar.css";

export function NavBar() {
	const { user, logout } = useAuth();

	return (
		<nav className="navbar">
			<div className="navbar-brand">
				<Link to="/" className="navbar-logo">
					gist.party
				</Link>
			</div>
			<div className="navbar-auth">
				{user ? (
					<div className="navbar-user">
						<img
							src={user.avatarUrl}
							alt={user.login}
							className="navbar-avatar"
						/>
						<span className="navbar-username">{user.login}</span>
						<button onClick={logout} className="navbar-logout">
							Logout
						</button>
					</div>
				) : (
					<a href="/api/auth/github" className="navbar-signin">
						Sign in with GitHub
					</a>
				)}
			</div>
		</nav>
	);
}
