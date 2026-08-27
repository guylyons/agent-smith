import { useEffect, useState } from "react";
import { spawnAgent, fetchPersonas, type PersonaInfo } from "./actions";
import { slugify } from "../lib/slug";
import { toast } from "./toast";

function repoName(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function NewAgentModal({ recentFolders, onClose }: { recentFolders: string[]; onClose: () => void }) {
  const [folder, setFolder] = useState(recentFolders[0] ?? "");
  const [task, setTask] = useState("");
  const [model, setModel] = useState("");
  const [permissionMode, setPermissionMode] = useState("");
  const [worktree, setWorktree] = useState("");
  const [worktreeTouched, setWorktreeTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [personas, setPersonas] = useState<PersonaInfo[]>([]);
  const [persona, setPersona] = useState("");

  // Auto-fill the worktree name from the task until the user edits the field
  // themselves. Leaving it blank launches in the folder (today's behavior).
  useEffect(() => {
    if (!worktreeTouched) setWorktree(slugify(task));
  }, [task, worktreeTouched]);

  useEffect(() => { void fetchPersonas().then(setPersonas); }, []);

  async function launch() {
    if (!folder.trim() || !task.trim() || busy) return;
    setBusy(true);
    const ok = await spawnAgent(folder.trim(), task.trim(), {
      model: model || undefined,
      permissionMode: permissionMode || undefined,
      worktree: worktree.trim() || undefined,
      persona: persona || undefined,
    });
    setBusy(false);
    if (ok) { toast("Launching new agent…"); onClose(); }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="win newagent" onClick={(e) => e.stopPropagation()}>
        <div className="pix newagent-title">NEW AGENT</div>

        <label className="pix newagent-label">FOLDER</label>
        <input className="reply-input" placeholder="/Users/you/project" autoFocus
          value={folder} onChange={(e) => setFolder(e.target.value)} />
        {recentFolders.length > 0 && (
          <div className="newagent-recent">
            {recentFolders.map((f) => (
              <button key={f} className={`deskbtn ${f === folder ? "on" : ""}`} title={f} onClick={() => setFolder(f)}>{repoName(f)}</button>
            ))}
          </div>
        )}

        {personas.length > 0 && (
          <>
            <label className="pix newagent-label">PERSONA</label>
            <select className="reply-input newagent-select" value={persona} onChange={(e) => setPersona(e.target.value)}>
              <option value="">None</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>{p.role} · {p.name}</option>
              ))}
            </select>
          </>
        )}

        <div className="newagent-opts">
          <div className="newagent-opt">
            <label className="pix newagent-label">MODEL</label>
            <select className="reply-input newagent-select" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Default</option>
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
            </select>
          </div>
          <div className="newagent-opt">
            <label className="pix newagent-label">PERMISSIONS</label>
            <select className="reply-input newagent-select" value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
              <option value="">Default</option>
              <option value="plan">Plan</option>
              <option value="acceptEdits">Accept edits</option>
              <option value="bypassPermissions">Bypass</option>
            </select>
          </div>
        </div>

        <label className="pix newagent-label">TASK</label>
        <textarea className="reply-input newagent-task" rows={5}
          placeholder="What should this agent do?"
          value={task} onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void launch(); }} />

        <label className="pix newagent-label">WORKTREE</label>
        <input className="reply-input" placeholder="blank = launch in the folder"
          value={worktree}
          onChange={(e) => { setWorktreeTouched(true); setWorktree(e.target.value); }} />

        <div className="newagent-actions">
          <button className="deskbtn" onClick={onClose}>CANCEL</button>
          <button className="deskbtn primary" disabled={busy || !folder.trim() || !task.trim()} onClick={() => void launch()}>
            {busy ? "LAUNCHING…" : "▸ LAUNCH"}
          </button>
        </div>
        <div className="pix newagent-hint">Opens a new Claude session in a Ghostty tab and runs your task. It'll appear on the board; chat with it here. With a WORKTREE name it runs in an isolated <code>.claude/worktrees/&lt;name&gt;</code> branch off HEAD, so agents never share a working tree. A PERSONA starts the agent in a role — its skills, its look on the board. (⌘/Ctrl+Enter to launch)</div>
      </div>
    </div>
  );
}
