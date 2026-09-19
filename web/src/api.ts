import { useEffect, useState } from "react";
import type { StateSnapshot } from "@gpa/shared";

/** Polls our own server (never the simulator - its list endpoints have a cost). */
export function useLiveState(intervalMs = 1000) {
  const [state, setState] = useState<StateSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/state");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = (await res.json()) as StateSnapshot;
        if (alive) { setState(next); setError(null); }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    load();
    const id = setInterval(load, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [intervalMs]);

  return { state, error };
}
