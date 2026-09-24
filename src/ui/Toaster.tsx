import { useEffect, useState } from "react";
import { subscribeToasts, type Toast } from "./toast";

// A plain toast is a passing notice; one carrying an action is an offer to take
// something back, so it stays up long enough to actually reach for.
const PLAIN_MS = 4500;
const ACTION_MS = 9000;

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts((t) => {
    setToasts((prev) => [...prev, t]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), t.action ? ACTION_MS : PLAIN_MS);
  }), []);
  if (!toasts.length) return null;

  const dismiss = (id: number) => setToasts((prev) => prev.filter((x) => x.id !== id));

  return (
    <div className="toaster">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pix toast${t.kind === "error" ? " error" : ""}`}
          role={t.kind === "error" ? "alert" : "status"}
          aria-live={t.kind === "error" ? "assertive" : "polite"}
          aria-atomic="true"
        >
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => { t.action!.run(); dismiss(t.id); }}
            >{t.action.label}</button>
          )}
        </div>
      ))}
    </div>
  );
}
