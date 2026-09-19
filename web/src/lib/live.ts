import { useEffect, useState } from "react";
import type { StateSnapshot, TimeseriesResponse } from "@gpa/shared";
import { api } from "./api";

/**
 * The live snapshot, pushed by the server every second over server-sent events.
 * Reconnects on its own; a closed stream is checked against /api/auth/me so an
 * expired session signs the user out instead of retrying forever.
 */
export function useLiveState() {
  const [state, setState] = useState<StateSnapshot | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let alive = true;

    const connect = () => {
      source = new EventSource("/api/stream");
      source.onopen = () => setConnected(true);
      source.onmessage = (e) => { setState(JSON.parse(e.data)); setConnected(true); };
      source.addEventListener("signedout", () => { source?.close(); api.me().catch(() => undefined); });
      source.onerror = () => {
        setConnected(false);
        if (source?.readyState === EventSource.CLOSED) {
          api.me().then(() => { if (alive) retry = setTimeout(connect, 3000); }).catch(() => undefined); // 401 signs out
        }
      };
    };
    connect();
    return () => { alive = false; source?.close(); clearTimeout(retry); };
  }, []);

  return { state, connected };
}

/** Occupancy samples, refreshed every sample period. */
export function useTimeseries() {
  const [data, setData] = useState<TimeseriesResponse | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.timeseries().then((d) => alive && setData(d)).catch(() => undefined);
    load();
    const id = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return data;
}
