import { useEffect, useRef, useState } from "react";
import { useSnapshot } from "./useSnapshot";
import { Backdrop } from "./Backdrop";
import { Crt } from "./Crt";
import { Header } from "./Header";
import { Crew } from "./Crew";
import { TheLine } from "./TheLine";
import { ConversationDrawer } from "./ConversationDrawer";
import { NewAgentModal } from "./NewAgentModal";
import { CommandPalette } from "./CommandPalette";
import { SettingsPanel } from "./SettingsPanel";
import { Toaster } from "./Toaster";
import { Notifier } from "./Notifier";
import { onOpenAgent } from "./nav";
import { applyTube, applyBg, loadSetting, loadBool, saveSetting } from "./settings";
import type { AgentStatus } from "../schema";

export function App() {
  const snap = useSnapshot();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Open an agent's drawer when the notification center asks (a needs-you).
  useEffect(() => onOpenAgent(setSelectedId), []);
  // null = closed; {} = blank; {task, cardId} = seeded from a card's "new agent for this card"
  const [spawnSeed, setSpawnSeed] = useState<{ task?: string; cardId?: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const recentFolders = [...new Set(snap.agents.map((a) => a.cwd).filter(Boolean))];

  // Apply saved display settings once on load.
  useEffect(() => {
    applyTube(loadSetting("aw-tube", ""));
    applyBg(loadSetting("aw-bg", "night"));
    setAlertsEnabled(loadBool("aw-alerts"));
  }, []);

  // Quick find: Alt+P opens the command palette. We match on e.code because on
  // mac Alt+P types "π" rather than a plain "p".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyP") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
      <Header snap={snap} onNewAgent={() => setSpawnSeed({})} onFind={() => setPaletteOpen(true)} />
      <Crew agents={snap.agents} board={snap.board} onOpen={setSelectedId} />
      <TheLine board={snap.board} agents={snap.agents} onSpawnForCard={(task, cardId) => setSpawnSeed({ task, cardId })} />
      {selected && selected.sessionId === selectedId && (
        <ConversationDrawer agent={selected} ended={ended} onClose={() => setSelectedId(null)} />
      )}
      {spawnSeed && (
        <NewAgentModal
          recentFolders={recentFolders}
          initialTask={spawnSeed.task}
          cardId={spawnSeed.cardId}
          onClose={() => setSpawnSeed(null)}
        />
      )}
      {paletteOpen && <CommandPalette snap={snap} onClose={() => setPaletteOpen(false)} />}
      {settingsOpen && <SettingsPanel alertsEnabled={alertsEnabled} onToggleAlerts={toggleAlerts} onClose={() => setSettingsOpen(false)} />}
      <Toaster />
      <Notifier snap={snap} enabled={alertsEnabled} />
    </>
  );
}
