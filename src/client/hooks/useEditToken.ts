import { useEffect, useState, useRef } from "react";

export interface UseEditTokenResult {
  hasEditCapability: boolean;
  claiming: boolean;
}

export function useEditToken(gistId: string | undefined): UseEditTokenResult {
  const [hasEditCapability, setHasEditCapability] = useState(false);
  const [claiming, setClaiming] = useState(() => {
    if (!gistId) return false;
    return /^#edit=.+$/.test(window.location.hash);
  });
  const claimedRef = useRef(false);

  useEffect(() => {
    if (!gistId || claimedRef.current) return;

    const hash = window.location.hash;
    const match = hash.match(/^#edit=(.+)$/);
    if (!match) return;

    claimedRef.current = true;
    const token = match[1];

    fetch(`/api/gists/${gistId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "same-origin",
    })
      .then((res) => {
        if (res.ok) {
          setHasEditCapability(true);
        }
      })
      .catch(() => {})
      .finally(() => {
        history.replaceState(null, "", window.location.pathname + window.location.search);
        setClaiming(false);
      });
  }, [gistId]);

  return { hasEditCapability, claiming };
}
