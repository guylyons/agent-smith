import { useEffect, useRef, useState } from "react";
import { useSnapshot } from "./useSnapshot";
import { Backdrop } from "./Backdrop";
import { Crt } from "./Crt";
import { Header } from "./Header";
import { Crew } from "./Crew";
import { TheLine } from "./TheLine";
import { ConversationDrawer } from "./ConversationDrawer";
import { Toaster } from "./Toaster";
import type { AgentStatus } from "../schema";

export function App() {
  const snap = useSnapshot();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Keep the last-known agent so the drawer doesn't slam shut (losing unsent
  // input) if the session ages out of the snapshot mid-conversation.
  const fromSnap = selectedId ? snap.agents.find((a) => a.sessionId === selectedId) ?? null : null;
  const lastRef = useRef<AgentStatus | null>(null);
  useEffect(() => { if (fromSnap) lastRef.current = fromSnap; }, [fromSnap]);
  const selected = fromSnap ?? (selectedId ? lastRef.current : null);
  const ended = !!selectedId && !fromSnap;

  return (
    <>
      <Backdrop />
      <Crt />
      <Header snap={snap} />
      <Crew agents={snap.agents} onOpen={setSelectedId} />
      <TheLine line={snap.line} />
      {selected && selected.sessionId === selectedId && (
        <ConversationDrawer agent={selected} ended={ended} onClose={() => setSelectedId(null)} />
      )}
      <Toaster />
    </>
  );
}
