import type { ReactNode } from "react";
import { NavBar } from "./NavBar";
import "./layout.css";

export interface LayoutProps {
	children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
	return (
		<div className="layout">
			<NavBar />
			<main className="layout-main">{children}</main>
		</div>
	);
}
