import { useEffect, useState } from "react";
import type { Snapshot, LineStage } from "../lib/snapshot";

export function emptySnapshot(): Snapshot {
  const stages: LineStage["stage"][] = ["backlog","working","needs","review","merged"];
  return { agents: [], line: stages.map((stage) => ({ stage, tickets: [] })) };
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
