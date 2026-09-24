import { useCallback, useEffect, useRef, useState } from "react";
import { viewFromHash, hashForView, type AppView } from "./view";
import { useSnapshot } from "./useSnapshot";
import { Backdrop } from "./Backdrop";
import { Crt, TubeBevel } from "./Crt";
import { Header } from "./Header";
import { Crew } from "./Crew";
import { TheLine } from "./TheLine";
import { ConversationDrawer } from "./ConversationDrawer";
import { NewAgentModal } from "./NewAgentModal";
import { CommandPalette } from "./CommandPalette";
import { SettingsPanel } from "./SettingsPanel";
import { FaceHud } from "./FaceHud";
import { Toaster } from "./Toaster";
import { Dictation } from "./Dictation";
import { Notifier } from "./Notifier";
import { MoodBoard } from "./MoodBoard";
import { GameView } from "./GameView";
import { onOpenAgent, onOpenCard, openCard } from "./nav";
import { applyAllSettings, readDisplay, writeDisplay, loadBool, loadBoolDefaultOn, saveSetting, KEYS, LINE_ROWS_DEFAULT, FONT_DEFAULT, type Display } from "./settings";
import { diffUnread, loadUnread, saveUnread, type PrevStates } from "./unread";
import type { AgentStatus } from "../schema";

export function App() {
  const { snap, live } = useSnapshot();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // null = closed; {} = blank; {task, cardId} = seeded from a card's "new agent for this card"
  const [spawnSeed, setSpawnSeed] = useState<{ task?: string; cardId?: string; persona?: string; folder?: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  // Which page is up: the workshop (desks + THE LINE), the MOOD board or the
  // GAME map. Kept in the URL hash, so a reload, a bookmark and the back
  // button all agree.
  const [view, setViewState] = useState<AppView>(() => viewFromHash(location.hash));
  useEffect(() => {
    const onHash = () => setViewState(viewFromHash(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const setView = useCallback((v: AppView) => {
    location.hash = hashForView(v);
    setViewState(v);
  }, []);
  // A card opened from the MOOD board, the GAME map (or a notice) lives on THE
  // LINE, which only the workshop mounts: switch over, then ask again once it
  // is listening.
  const viewRef = useRef(view);
  viewRef.current = view;
  const pendingCard = useRef<string | null>(null);
  useEffect(() => onOpenCard((cardId) => {
    if (viewRef.current === "workshop") return;
    pendingCard.current = cardId;
    setView("workshop");
  }), [setView]);
  useEffect(() => {
    if (view !== "workshop" || !pendingCard.current) return;
    const id = pendingCard.current;
    pendingCard.current = null;
    openCard(id);
  }, [view]);
  // Theme / CRT / background live here rather than in the Settings panel: the
  // CRT overlay needs the mode to play its power-on sweep, and the panel is
  // unmounted most of the time.
  const [display, setDisplay] = useState<Display>(() => ({ theme: "default", crt: "on", bevel: "off", bg: "night", bgImage: "", bgDim: 0, font: FONT_DEFAULT, lineRows: LINE_ROWS_DEFAULT }));
  // The status face ships on; the toggle is an opt-OUT, so it can't default to
  // false the way an unset alerts key does.
  const [faceEnabled, setFaceEnabled] = useState(true);
  // The fight strip over THE LINE: on unless switched off, like the face.
  const [fightEnabled, setFightEnabled] = useState(true);
  // Just the folders live agents are running in; the New Agent dialog merges
  // these with its own remembered history (see recentFolders.ts).
  const liveFolders = [...new Set(snap.agents.map((a) => a.cwd).filter(Boolean))];

  // Apply saved display settings once on load.
  useEffect(() => {
    applyAllSettings();
    setDisplay(readDisplay());
    setAlertsEnabled(loadBool(KEYS.alerts));
    setFaceEnabled(loadBoolDefaultOn(KEYS.face));
    setFightEnabled(loadBoolDefaultOn(KEYS.fight));
  }, []);

  function toggleFace() {
    const next = !faceEnabled;
    setFaceEnabled(next);
    saveSetting(KEYS.face, next ? "1" : "0");
  }
  function toggleFight() {
    const next = !fightEnabled;
    setFightEnabled(next);
    saveSetting(KEYS.fight, next ? "1" : "0");
  }

  const changeDisplay = useCallback((patch: Partial<Display>) => {
    setDisplay((d) => { const next = { ...d, ...patch }; writeDisplay(next); return next; });
  }, []);

  // ---- "this agent has something for you to read" badges -------------------
  // Flagged when an agent finishes or stops to ask (see diffUnread), cleared
  // when you open its drawer. Persisted, so the badge survives a reload the way
  // an unread message should.
  const [unread, setUnread] = useState<Set<string>>(() => new Set());
  const prevStates = useRef<PrevStates>(new Map());
  const primed = useRef(false);

  useEffect(() => { setUnread(loadUnread()); }, []);

  useEffect(() => {
    const { ids, next } = diffUnread(prevStates.current, snap.agents, primed.current);
    prevStates.current = next;
    if (snap.agents.length > 0) primed.current = true;
    setUnread((cur) => {
      // Never badge the agent whose drawer is already open — you're reading it.
      const fresh = ids.filter((id) => id !== selectedId && !cur.has(id));
      if (!fresh.length) return cur;
      const nextSet = new Set([...cur, ...fresh]);
      saveUnread(nextSet, snap.agents);
      return nextSet;
    });
  }, [snap, selectedId]);

  // Opening an agent is reading it.
  const openAgent = useCallback((id: string) => {
    setSelectedId(id);
    setUnread((cur) => {
      if (!cur.has(id)) return cur;
      const next = new Set(cur);
      next.delete(id);
      saveUnread(next, snap.agents);
      return next;
    });
  }, [snap.agents]);

  // Open an agent's drawer when the notification center or quick-find asks. Goes
  // through a ref so this subscribes once, while still calling the CURRENT
  // openAgent — which also clears that agent's unread badge.
  const openRef = useRef(openAgent);
  openRef.current = openAgent;
  useEffect(() => onOpenAgent((id: string) => openRef.current(id)), []);

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
    saveSetting(KEYS.alerts, next ? "1" : "0");
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
      <Crt mode={display.crt} />
      <TubeBevel mode={display.bevel} />
      <Header snap={snap} live={live} view={view} onView={setView} onNewAgent={() => setSpawnSeed({})} onFind={() => setPaletteOpen(true)} onSettings={() => setSettingsOpen(true)} />
      {view === "mood" ? (
        <MoodBoard mood={snap.mood} board={snap.board} onOpenCard={openCard} />
      ) : view === "game" ? (
        <GameView agents={snap.agents} board={snap.board} onOpen={openAgent} onOpenCard={openCard} />
      ) : (
        <>
          <Crew agents={snap.agents} board={snap.board} unread={unread} onOpen={openAgent} />
          <TheLine board={snap.board} agents={snap.agents} archived={snap.archived} lineRows={display.lineRows} fight={fightEnabled} onSpawnForCard={(task, cardId, seed) => setSpawnSeed({ task, cardId, ...seed })} />
        </>
      )}
      {selected && selected.sessionId === selectedId && (
        <ConversationDrawer agent={selected} ended={ended} onClose={() => setSelectedId(null)} />
      )}
      {spawnSeed && (
        <NewAgentModal
          liveFolders={liveFolders}
          initialTask={spawnSeed.task}
          cardId={spawnSeed.cardId}
          initialPersona={spawnSeed.persona}
          initialFolder={spawnSeed.folder}
          onClose={() => setSpawnSeed(null)}
        />
      )}
      {paletteOpen && <CommandPalette snap={snap} onClose={() => setPaletteOpen(false)} />}
      {settingsOpen && (
        <SettingsPanel
          display={display}
          onChange={changeDisplay}
          alertsEnabled={alertsEnabled}
          onToggleAlerts={toggleAlerts}
          face={faceEnabled}
          onToggleFace={toggleFace}
          fight={fightEnabled}
          onToggleFight={toggleFight}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {faceEnabled && <FaceHud agents={snap.agents} board={snap.board} archived={snap.archived} />}
      <Toaster />
      <Dictation />
      <Notifier snap={snap} enabled={alertsEnabled} />
    </>
  );
}
