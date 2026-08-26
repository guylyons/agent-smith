import { useState } from "react";
import { spawnAgent } from "./actions";
import { toast } from "./toast";

function repoName(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function NewAgentModal({ recentFolders, onClose }: { recentFolders: string[]; onClose: () => void }) {
  const [folder, setFolder] = useState(recentFolders[0] ?? "");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);

  async function launch() {
    if (!folder.trim() || !task.trim() || busy) return;
    setBusy(true);
    const ok = await spawnAgent(folder.trim(), task.trim());
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

        <label className="pix newagent-label">TASK</label>
        <textarea className="reply-input newagent-task" rows={5}
          placeholder="What should this agent do?"
          value={task} onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void launch(); }} />

        <div className="newagent-actions">
          <button className="deskbtn" onClick={onClose}>CANCEL</button>
          <button className="deskbtn primary" disabled={busy || !folder.trim() || !task.trim()} onClick={() => void launch()}>
            {busy ? "LAUNCHING…" : "▸ LAUNCH"}
          </button>
        </div>
        <div className="pix newagent-hint">Opens a new Claude session in a Ghostty tab and runs your task. It'll appear on the board; chat with it here. (⌘/Ctrl+Enter to launch)</div>
      </div>
    </div>
  );
}
