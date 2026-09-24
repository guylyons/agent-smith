import { useEffect, useState } from "react";
import { ModalBackdrop } from "./Backdrop";
import { subscribeEndConfirm, type EndRequest } from "./sessionEnd";
import { cardButton } from "./moveFocus";

// The "this ends the agent's session" check before a card moves into Done.
// A real in-page dialog, not confirm(): named, focus lands on CANCEL (the safe
// choice for Enter), Esc and a backdrop click cancel, and focus goes back to
// the card — wherever it is by then (see ModalBackdrop's returnTo).
export function EndConfirm() {
  const [req, setReq] = useState<EndRequest | null>(null);
  // A second ask while one is open replaces it and cancels the first: one
  // question on screen at a time.
  useEffect(() => subscribeEndConfirm((r) => setReq((prev) => { prev?.answer(false); return r; })), []);
  if (!req) return null;

  const answer = (ok: boolean) => { setReq(null); req.answer(ok); };

  return (
    <ModalBackdrop
      key={req.id}
      className="drawer-backdrop endconfirm-backdrop"
      onClose={() => answer(false)}
      labelledBy="endconfirm-title"
      returnTo={() => cardButton(req.cardId)}
    >
      {/* The title is the whole warning, so a screen reader hears it as the
          dialog's name when focus lands on CANCEL. */}
      <div className="win endconfirm">
        <div className="pix endconfirm-title" id="endconfirm-title">Moving to {req.column} ends {req.agent}'s session.</div>
        <p className="endconfirm-body">Its terminal closes, and moving the card back will not reopen it.</p>
        <div className="endconfirm-actions">
          <button type="button" className="deskbtn" autoFocus onClick={() => answer(false)}>CANCEL</button>
          <button type="button" className="deskbtn danger" onClick={() => answer(true)}>MOVE AND END SESSION</button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
