import { useEffect, useState } from "react";
import type { Snapshot } from "../lib/snapshot";

// The pre-SSE placeholder: no agents, an empty board. The server always sends a
// real (seeded) board on connect, so this blank board is only ever shown for the
// instant before the first /events message arrives.
export function emptySnapshot(): Snapshot {
  return { agents: [], board: { columns: [], cards: [] } };
}

export function parseEvent(data: string): Snapshot | null {
  try { return JSON.parse(data) as Snapshot; } catch { return null; }
}

export function useSnapshot(): Snapshot {
  const [snap, setSnap] = useState<Snapshot>(emptySnapshot);
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    // EventSource retries transient drops on its own, but a fatal error (a non-2xx
    // or wrong content-type response — e.g. the server restarted behind a proxy)
    // moves it to CLOSED for good, silently freezing the dashboard on stale data.
    // Detect that and rebuild the connection ourselves.
    const connect = () => {
      es = new EventSource("/events");
      es.onmessage = (e) => { const s = parseEvent(e.data); if (s) setSnap(s); };
      es.onerror = () => {
        if (closed || !es || es.readyState !== EventSource.CLOSED) return; // transient: it will retry
        es.close();
        if (!retry) retry = setTimeout(() => { retry = null; connect(); }, 2000);
      };
    };
    connect();

    return () => { closed = true; if (retry) clearTimeout(retry); es?.close(); };
  }, []);
  return snap;
}
