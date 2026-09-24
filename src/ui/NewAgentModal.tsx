import { useEffect, useState } from "react";
import { spawnAgent, pickFolder, fetchPersonas, type PersonaInfo } from "./actions";
import { slugify, slugifyBranch } from "../lib/slug";
import { ModalBackdrop } from "./Backdrop";
import { toast } from "./toast";
import { loadRecentFolders, saveRecentFolders, mergeRecent, pushRecent } from "./recentFolders";

function segments(cwd: string): string[] {
  return cwd.split("/").filter(Boolean);
}

function repoName(cwd: string): string {
  const parts = segments(cwd);
  return parts[parts.length - 1] ?? cwd;
}

/**
 * Button labels for the recent-folder row. Normally just the folder name — but
 * two checkouts of the same repo (`~/work/api` and `~/fork/api`) would render as
 * two identical buttons with no way to tell them apart, so a repeated name is
 * qualified with its parent. Pure, so the disambiguation is unit-tested.
 */
export function folderLabels(paths: string[]): string[] {
  const names = paths.map(repoName);
  return paths.map((p, i) => {
    if (names.filter((n) => n === names[i]).length < 2) return names[i]!;
    return segments(p).slice(-2).join("/");
  });
}

/**
 * One line saying, in plain terms, where this agent is about to run — because
 * "worktree" and "branch" being independent is exactly the kind of thing a
 * dialog should show rather than explain. Pure, and unit-tested.
 */
export function launchSummary(worktree: string, branch: string): string {
  const wt = worktree.trim();
  const br = branch.trim();
  const wtSlug = slugify(wt);
  const brSlug = slugifyBranch(br);
  if (wt && !wtSlug) return "That worktree name has no letters or numbers in it.";
  if (br && !brSlug) return "That branch name has no letters or numbers in it.";
  if (wtSlug) {
    return `Isolated worktree .claude/worktrees/${wtSlug}, on branch ${brSlug || wtSlug}.`;
  }
  if (brSlug) return `The folder itself, switched to branch ${brSlug}.`;
  return "The folder itself, on whatever branch it is on now.";
}

export function NewAgentModal({
  liveFolders, onClose, initialTask = "", initialFolder, cardId,
}: {
  liveFolders: string[]; onClose: () => void; initialTask?: string; initialFolder?: string; cardId?: string;
}) {
  // The remembered history is the source of the button row; live agents' folders
  // are merged on top so a session someone else started is one click away too.
  const [stored, setStored] = useState<string[]>(() => loadRecentFolders());
  const recent = mergeRecent(stored, liveFolders);

  // Opening the dialog folds whatever agents are running right now INTO the
  // history. Without this the list is only ever as good as the sessions that
  // happen to be alive: kill your agents and the folder you were working in
  // vanishes from the row. Seeing a folder here is enough to remember it.
  useEffect(() => {
    setStored((s) => {
      const merged = mergeRecent(s, liveFolders);
      return merged.length === s.length && merged.every((p, i) => p === s[i]) ? s : saveRecentFolders(merged);
    });
    // Once, on open — not on every snapshot, which would keep re-writing while
    // the dialog sits there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [folder, setFolder] = useState(initialFolder ?? loadRecentFolders()[0] ?? liveFolders[0] ?? "");
  // Only an explicit initialFolder (e.g. "new agent for this card") is a
  // deliberate default. A recent- or live-folder fallback is a guess pulled
  // from unrelated past activity — mark it "remembered" until the user
  // types, browses, or picks a chip, so it never reads as something typed.
  const [folderTouched, setFolderTouched] = useState(!!initialFolder);
  const folderRemembered = !folderTouched && !!folder;
  const [task, setTask] = useState(initialTask);
  const [model, setModel] = useState("");
  const [permissionMode, setPermissionMode] = useState("");
  const [worktree, setWorktree] = useState("");
  const [worktreeTouched, setWorktreeTouched] = useState(false);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [personas, setPersonas] = useState<PersonaInfo[]>([]);
  const [persona, setPersona] = useState("");

  // Auto-fill the worktree name from the task until the user edits the field
  // themselves. Leaving it blank launches in the folder (today's behavior).
  // BRANCH is deliberately never auto-filled: blank means "named after the
  // worktree", which is the old behaviour, so typing there is always a choice.
  useEffect(() => {
    if (!worktreeTouched) setWorktree(slugify(task));
  }, [task, worktreeTouched]);

  useEffect(() => { void fetchPersonas().then(setPersonas); }, []);

  const labels = folderLabels(recent);

  async function browse() {
    if (picking) return;
    setPicking(true);
    // Start the dialog in the folder that's already typed, so "the one next to
    // this one" is a couple of clicks rather than a walk from home.
    const chosen = await pickFolder(folder.trim() || undefined);
    setPicking(false);
    if (chosen) { setFolder(chosen); setFolderTouched(true); }
  }

  function forget(path: string) {
    setStored((s) => saveRecentFolders(s.filter((p) => p !== path)));
  }

  async function launch() {
    if (!folder.trim() || !task.trim() || busy) return;
    setBusy(true);
    const ok = await spawnAgent(folder.trim(), task.trim(), {
      model: model || undefined,
      permissionMode: permissionMode || undefined,
      worktree: worktree.trim() || undefined,
      branch: branch.trim() || undefined,
      persona: persona || undefined,
      cardId,
    });
    setBusy(false);
    if (ok) {
      setStored((s) => saveRecentFolders(pushRecent(s, folder.trim())));
      toast("Launching new agent…");
      onClose();
    }
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="win newagent">
        <div className="pix newagent-title">NEW AGENT</div>

        <label className="pix newagent-label" htmlFor="na-folder">FOLDER</label>
        <div className="newagent-folder">
          <input id="na-folder" className={`reply-input ${folderRemembered ? "remembered" : ""}`}
            placeholder="/Users/you/project" autoFocus
            aria-describedby={folderRemembered ? "na-folder-remembered" : undefined}
            value={folder} onChange={(e) => { setFolderTouched(true); setFolder(e.target.value); }} />
          <button type="button" className="deskbtn newagent-browse" disabled={picking}
            title="Browse for a folder" aria-label="Browse for a folder"
            onClick={() => void browse()}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" shapeRendering="crispEdges">
              <path fill="currentColor" d="M1 2h5v2h9v10H1V2zm1 3v8h12V5H2z" />
            </svg>
          </button>
        </div>
        {folderRemembered && (
          <div id="na-folder-remembered" className="pix newagent-folder-hint">
            ↳ Remembered from a past launch — may not be this project. Edit, browse, or pick below to confirm.
          </div>
        )}
        {recent.length > 0 && (
          <div className="newagent-recent">
            {recent.map((f, i) => (
              <span key={f} className={`newagent-chip ${f === folder ? "on" : ""}`}>
                <button type="button" className={`deskbtn ${f === folder ? "on" : ""}`} title={f}
                  onClick={() => { setFolder(f); setFolderTouched(true); }}>{labels[i]}</button>
                {/* Only where it does something you can see: a folder an agent is
                    running in stays on the row regardless, so offering to forget
                    it would look like a dead button. */}
                {stored.includes(f) && !liveFolders.includes(f) && (
                  <button type="button" className="deskbtn newagent-forget" title={`Forget ${f}`}
                    aria-label={`Forget ${f}`} onClick={() => forget(f)}>×</button>
                )}
              </span>
            ))}
          </div>
        )}

        {personas.length > 0 && (
          <>
            <label className="pix newagent-label" htmlFor="na-persona">PERSONA</label>
            <select id="na-persona" className="reply-input newagent-select" value={persona} onChange={(e) => setPersona(e.target.value)}>
              <option value="">None</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>{p.name ? `${p.role} · ${p.name}` : p.role}</option>
              ))}
            </select>
          </>
        )}

        <div className="newagent-opts">
          <div className="newagent-opt">
            <label className="pix newagent-label" htmlFor="na-model">MODEL</label>
            <select id="na-model" className="reply-input newagent-select" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Default</option>
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
            </select>
          </div>
          <div className="newagent-opt">
            <label className="pix newagent-label" htmlFor="na-perm">PERMISSIONS</label>
            <select id="na-perm" className="reply-input newagent-select" value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
              <option value="">Default</option>
              <option value="plan">Plan</option>
              <option value="acceptEdits">Accept edits</option>
              <option value="auto">Auto</option>
              <option value="bypassPermissions">Bypass</option>
            </select>
          </div>
        </div>

        <label className="pix newagent-label" htmlFor="na-task">TASK</label>
        <textarea id="na-task" className="reply-input newagent-task" rows={5}
          placeholder="What should this agent do?"
          value={task} onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void launch(); }} />

        <div className="newagent-opts">
          <div className="newagent-opt">
            <label className="pix newagent-label" htmlFor="na-worktree">WORKTREE</label>
            <input id="na-worktree" className="reply-input" placeholder="blank = the folder"
              value={worktree}
              onChange={(e) => { setWorktreeTouched(true); setWorktree(e.target.value); }} />
          </div>
          <div className="newagent-opt">
            <label className="pix newagent-label" htmlFor="na-branch">BRANCH</label>
            <input id="na-branch" className="reply-input"
              placeholder={worktree.trim() ? "blank = worktree name" : "blank = current branch"}
              value={branch} onChange={(e) => setBranch(e.target.value)} />
          </div>
        </div>
        <div className="pix newagent-where" aria-live="polite">↳ {launchSummary(worktree, branch)}</div>

        <div className="newagent-actions">
          <button type="button" className="deskbtn" onClick={onClose}>CANCEL</button>
          <button type="button" className="deskbtn primary" disabled={busy || !folder.trim() || !task.trim()} onClick={() => void launch()}>
            {busy ? "LAUNCHING…" : "▸ LAUNCH"}
          </button>
        </div>
        <div className="pix newagent-hint">Opens a new Claude session in a Ghostty tab and runs your task. It'll appear on the board; chat with it here. WORKTREE and BRANCH are independent: a WORKTREE name gets an isolated <code>.claude/worktrees/&lt;name&gt;</code> checkout so agents never share a working tree, a BRANCH name on its own puts the folder you picked onto that feature branch, and both together give you a worktree sitting on the branch you named. A PERSONA starts the agent in a role — its skills, its look on the board. (⌘/Ctrl+Enter to launch)</div>
      </div>
    </ModalBackdrop>
  );
}
