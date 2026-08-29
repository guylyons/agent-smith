// Knowing when the stand-alone app window has gone away.
//
// `bun run app` wants the server to stop when the human closes the window, but
// the browser process is no help: on macOS Chrome stays running with no windows
// open, so waiting for it to exit waits forever. The UI holds an SSE stream
// (`/events`) for as long as its page is open, so the server's own client count
// is the honest signal — one stream per open window, dropped the moment one
// closes.
//
// Two things stop that being a simple "clients === 0": a reload drops the
// stream and reopens it a moment later, and at startup there are no clients yet
// because the browser hasn't finished launching. Hence a grace on each side.
// All pure — the caller supplies the clock.

export type IdleState = {
  /** Open `/events` streams — one per window showing the dashboard. */
  clients: number;
  /** Has a window ever connected? Until one has, we're still starting up. */
  everConnected: boolean;
  /** When the count last reached zero, or null while a window is attached. */
  idleSince: number;
};

export type IdleOpts = {
  /** How long to stay up after the last window closes, so a reload survives. */
  graceMs: number;
  /** How long to wait for the first window before giving up on it. */
  startupGraceMs: number;
};

export function initialIdle(now: number): IdleState {
  return { clients: 0, everConnected: false, idleSince: now };
}

export function onConnect(s: IdleState, _now: number): IdleState {
  return { clients: s.clients + 1, everConnected: true, idleSince: 0 };
}

export function onDisconnect(s: IdleState, now: number): IdleState {
  // A client can be dropped twice — push() discards one whose controller has
  // already closed, and the stream's own cancel() still fires afterwards. Floor
  // at zero so that can't leave a phantom window holding the server open.
  const clients = Math.max(0, s.clients - 1);
  return { clients, everConnected: s.everConnected, idleSince: clients === 0 ? now : s.idleSince };
}

/** Has the app been window-less long enough to shut down? */
export function shouldShutDown(s: IdleState, now: number, opts: IdleOpts): boolean {
  if (s.clients > 0) return false;
  const grace = s.everConnected ? opts.graceMs : opts.startupGraceMs;
  return now - s.idleSince >= grace;
}
