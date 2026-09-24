// THE LINE paints a board edit before the server has it (see mutate in
// TheLine.tsx). If the server then refuses it — a card another tab deleted, a
// move the stage gate blocks, a bad body — nothing is pushed back, because the
// server's board never changed and a push leaves an unchanged board out (see
// snapshotEvent). So the refused edit would sit on screen, a card in the wrong
// column, until some unrelated change arrived. Undo it here instead: on a
// refusal, show the server's board again.

import type { Board } from "../lib/board";

/** Show `fn` applied to the board now, send the edit, and if the server
 *  refuses it put back `server()` — the last board the server sent, read when
 *  the refusal lands so it is the newest one. `send` resolving to anything but
 *  false (or returning nothing) keeps the edit; the server's echo confirms it. */
export function optimisticEdit(
  fn: ((b: Board) => Board) | null,
  send: () => Promise<boolean> | void,
  setBoard: (next: (prev: Board) => Board) => void,
  server: () => Board,
): void {
  if (fn) setBoard(fn);
  const sent = send();
  if (fn && sent) void sent.then((ok) => { if (!ok) setBoard(() => server()); });
}
