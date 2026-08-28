import { useEffect, useState } from "react";
import type { Snapshot } from "../lib/snapshot";

// The pre-SSE placeholder: no agents, an empty board. The server always sends a
// real (seeded) board on connect, so this blank board is only ever shown for the
// instant before the first /events message arrives.
export function emptySnapshot(): Snapshot {
  return { agents: [], board: { columns: [], cards: [] }, boardPath: "" };
}

export function parseEvent(data: string): Snapshot | null {
  try { return JSON.parse(data) as Snapshot; } catch { return null; }
}

export function useSnapshot(): Snapshot {
  const [snap, setSnap] = useState<Snapshot>(emptySnapshot);
  useEffect(() => {
    const es = new EventSource("/events");
    es.onmessage = (e) => { const s = parseEvent(e.data); if (s) setSnap(s); };
    return () => es.close(); // EventSource auto-reconnects while open
  }, []);
  return snap;
}
