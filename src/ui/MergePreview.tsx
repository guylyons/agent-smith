import { useEffect, useState } from "react";
import { fetchMergePreview } from "./actions";
import {
  fileChange, isEmptyPreview, moreLine, previewSummary, startsOpen, type MergePreview as Preview,
} from "../lib/mergePreview";

// WHAT WILL LAND: the commits and changed files a MERGE would put on the
// trunk, shown right above the key so the human can review without leaving
// the dashboard. A plain <details>, so it opens from the keyboard and reads
// as a disclosure to a screen reader. Short lists start open; long ones start
// folded so the key stays in view. No diff viewer — the list is the point.

type Read = { kind: "loading" } | { kind: "preview"; preview: Preview } | { kind: "error"; message: string };

/** `refresh` changes whenever the branch moves (the MERGE key's poll sees a
 *  new commit), which re-reads the list without blanking it in between. */
export function MergePreview({ cardId, refresh }: { cardId: string; refresh: string }) {
  const [read, setRead] = useState<Read>({ kind: "loading" });
  // null until the first read decides the default; after that it is the
  // human's, and a re-read never folds a list they opened.
  const [open, setOpen] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchMergePreview(cardId).then((r) => {
      if (!alive) return;
      if ("error" in r) { setRead({ kind: "error", message: r.error }); return; }
      setRead({ kind: "preview", preview: r.preview });
      setOpen((o) => o ?? startsOpen(r.preview));
    });
    return () => { alive = false; };
  }, [cardId, refresh]);

  if (read.kind === "loading") return null;
  if (read.kind === "error") {
    return <p className="mergepreview-error" role="status">Couldn't read what will land: {read.message}</p>;
  }
  const p = read.preview;
  if (isEmptyPreview(p)) return null;

  const moreCommits = moreLine(p.commits.length, p.totalCommits, "commit");
  const moreFiles = moreLine(p.files.length, p.totalFiles, "file");
  return (
    <details
      className="mergepreview"
      open={!!open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="mergepreview-head">
        <span className="pix mergepreview-label">WHAT WILL LAND</span>
        <span className="mergepreview-sum">{previewSummary(p)}</span>
      </summary>
      <div className="mergepreview-body">
        <p className="mergepreview-range">{p.branch} → {p.base}</p>
        <ul className="mergepreview-commits" aria-label="Commits">
          {p.commits.map((c) => (
            <li key={c.sha}>
              <code className="mergepreview-sha">{c.sha}</code>
              <span className="mergepreview-subject">{c.subject}</span>
            </li>
          ))}
        </ul>
        {moreCommits && <p className="mergepreview-more">{moreCommits}</p>}
        {p.files.length > 0 && (
          <ul className="mergepreview-files" aria-label="Changed files">
            {p.files.map((f) => (
              <li key={f.path}>
                <span className="mergepreview-path">{f.path}</span>
                <span className="mergepreview-change">{fileChange(f)}</span>
              </li>
            ))}
          </ul>
        )}
        {moreFiles && <p className="mergepreview-more">{moreFiles}</p>}
      </div>
    </details>
  );
}
