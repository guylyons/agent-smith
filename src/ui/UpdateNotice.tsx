import { useEffect, useRef, useState } from "react";
import type { UiState } from "../lib/snapshot";
import { watchUi, type UiSeen } from "./uiUpdate";
import { toastError } from "./toast";

// "New version, reload": shown once the server is serving a newer UI build
// than this page loaded (a MERGE rebuilt it). It stays up until the reload, so
// an unsent draft is never thrown away for you. A failed rebuild is a toast.
export function UpdateNotice({ ui }: { ui: UiState | undefined }) {
  const seen = useRef<UiSeen>({});
  const [reload, setReload] = useState(false);
  useEffect(() => {
    const r = watchUi(seen.current, ui);
    seen.current = r.seen;
    setReload(r.reload);
    if (r.failed) toastError(`UI build failed after merge, still on the old build: ${r.failed}`);
  }, [ui]);
  if (!reload) return null;
  return (
    <div className="pix toast update-notice" role="status" aria-live="polite">
      <span className="toast-text">New version of the dashboard is ready.</span>
      <button className="toast-action" onClick={() => location.reload()}>RELOAD</button>
    </div>
  );
}
