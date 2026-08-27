import { useEffect, useRef, useState } from "react";
import { useSnapshot } from "./useSnapshot";
import { Backdrop } from "./Backdrop";
import { Crt } from "./Crt";
import { Header } from "./Header";
import { Crew } from "./Crew";
import { TheLine } from "./TheLine";
import { ConversationDrawer } from "./ConversationDrawer";
import { NewAgentModal } from "./NewAgentModal";
import { SettingsPanel } from "./SettingsPanel";
import { Toaster } from "./Toaster";
import { Notifier } from "./Notifier";
import { applyTube, applyBg, loadSetting, loadBool, saveSetting } from "./settings";
import type { AgentStatus } from "../schema";

export function App() {
  const snap = useSnapshot();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const recentFolders = [...new Set(snap.agents.map((a) => a.cwd).filter(Boolean))];

  // Apply saved display settings once on load.
  useEffect(() => {
    applyTube(loadSetting("aw-tube", ""));
    applyBg(loadSetting("aw-bg", "night"));
    setAlertsEnabled(loadBool("aw-alerts"));
  }, []);

  function toggleAlerts() {
    const next = !alertsEnabled;
    if (next && typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    setAlertsEnabled(next);
    saveSetting("aw-alerts", next ? "1" : "0");
  }

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
      <button className="settings-btn" title="Settings" onClick={() => setSettingsOpen(true)}>⚙</button>
      <Header snap={snap} onNewAgent={() => setNewAgentOpen(true)} />
      <Crew agents={snap.agents} onOpen={setSelectedId} />
      <TheLine board={snap.board} />
      {selected && selected.sessionId === selectedId && (
        <ConversationDrawer agent={selected} ended={ended} onClose={() => setSelectedId(null)} />
      )}
      {newAgentOpen && <NewAgentModal recentFolders={recentFolders} onClose={() => setNewAgentOpen(false)} />}
      {settingsOpen && <SettingsPanel alertsEnabled={alertsEnabled} onToggleAlerts={toggleAlerts} onClose={() => setSettingsOpen(false)} />}
      <Toaster />
      <Notifier snap={snap} enabled={alertsEnabled} />
    </>
  );
}
