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

/** EventSource retries transient drops on its own; only CLOSED means it has
 *  given up for good (a non-2xx or wrong content-type response — e.g. the server
 *  restarted behind a proxy), which is the one case we rebuild ourselves. */
export function isFatalDrop(readyState: number): boolean {
  return readyState === 2; // EventSource.CLOSED
}

/** The live snapshot, plus whether we are actually connected to it. `live`
 *  going false is the difference between "the board is quiet" and "the board is
 *  frozen and lying to you" — without it a dead server looks like a calm one. */
export function useSnapshot(): { snap: Snapshot; live: boolean } {
  const [snap, setSnap] = useState<Snapshot>(emptySnapshot);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      es = new EventSource("/events");
      es.onopen = () => setLive(true);
      es.onmessage = (e) => { const s = parseEvent(e.data); if (s) { setLive(true); setSnap(s); } };
      es.onerror = () => {
        setLive(false);
        if (closed || !es || !isFatalDrop(es.readyState)) return; // transient: it will retry
        es.close();
        if (!retry) retry = setTimeout(() => { retry = null; connect(); }, 2000);
      };
    };
    connect();

    return () => { closed = true; if (retry) clearTimeout(retry); es?.close(); };
  }, []);

  return { snap, live };
}
