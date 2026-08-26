import { useEffect, useState } from "react";
import { subscribeToasts, type Toast } from "./toast";

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts((t) => {
    setToasts((prev) => [...prev, t]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), 4500);
  }), []);
  if (!toasts.length) return null;
  return (
    <div className="toaster">
      {toasts.map((t) => <div key={t.id} className="pix toast">{t.text}</div>)}
    </div>
  );
}
