import { useState } from "react";
import { useSnapshot } from "./useSnapshot";
import { Backdrop } from "./Backdrop";
import { Crt } from "./Crt";
import { Header } from "./Header";
import { Crew } from "./Crew";
import { TheLine } from "./TheLine";
import { ConversationDrawer } from "./ConversationDrawer";

export function App() {
  const snap = useSnapshot();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = snap.agents.find((a) => a.sessionId === selectedId) ?? null;

  return (
    <>
      <Backdrop />
      <Crt />
      <Header snap={snap} />
      <Crew agents={snap.agents} onOpen={setSelectedId} />
      <TheLine line={snap.line} />
      {selected && <ConversationDrawer agent={selected} onClose={() => setSelectedId(null)} />}
    </>
  );
}
