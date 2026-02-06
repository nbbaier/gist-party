import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";
import type { Awareness } from "y-protocols/awareness";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface CollabUser {
  name: string;
  userId: string;
  color: string;
}

export interface CollabProviderResult {
  doc: Y.Doc | null;
  provider: YProvider | null;
  awareness: Awareness | null;
  connectionState: ConnectionState;
}

export interface UseCollabProviderProps {
  gistId: string | null | undefined;
  user?: { userId: string; login: string; avatarUrl: string } | null;
}

const CURSOR_COLORS = [
  { color: "#30bced", light: "#30bced33" },
  { color: "#6eeb83", light: "#6eeb8333" },
  { color: "#ffbc42", light: "#ffbc4233" },
  { color: "#e84855", light: "#e8485533" },
  { color: "#8458B3", light: "#8458B333" },
  { color: "#0D98BA", light: "#0D98BA33" },
  { color: "#FFA07A", light: "#FFA07A33" },
  { color: "#20B2AA", light: "#20B2AA33" },
];

function userColor(userId: string): { color: string; light: string } {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}

export function useCollabProvider({
  gistId,
  user,
}: UseCollabProviderProps): CollabProviderResult {
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [provider, setProvider] = useState<YProvider | null>(null);
  const [awareness, setAwareness] = useState<Awareness | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");

  const providerRef = useRef<YProvider | null>(null);
  const docRef = useRef<Y.Doc | null>(null);

  useEffect(() => {
    if (!gistId) {
      return;
    }

    const ydoc = new Y.Doc();
    docRef.current = ydoc;
    setDoc(ydoc);

    const yProvider = new YProvider(window.location.host, gistId, ydoc, {
      party: "gist-room",
    });

    providerRef.current = yProvider;
    setProvider(yProvider);
    setAwareness(yProvider.awareness);
    setConnectionState("connecting");

    yProvider.on("sync", (isSynced: boolean) => {
      if (isSynced) {
        setConnectionState("connected");
      }
    });

    yProvider.on("connection-close", () => {
      setConnectionState("disconnected");
    });

    yProvider.on("connection-error", () => {
      setConnectionState("disconnected");
    });

    if (user) {
      const colors = userColor(user.userId);
      yProvider.awareness.setLocalStateField("user", {
        name: user.login,
        userId: user.userId,
        color: colors.color,
        colorLight: colors.light,
      });
    }

    yProvider.connect();

    return () => {
      yProvider.destroy();
      ydoc.destroy();
      providerRef.current = null;
      docRef.current = null;
      setDoc(null);
      setProvider(null);
      setAwareness(null);
      setConnectionState("disconnected");
    };
  }, [gistId]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && providerRef.current) {
        providerRef.current.connect();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return { doc, provider, awareness, connectionState };
}
