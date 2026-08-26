import { readdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { parseStatus, type AgentStatus } from "./schema";
import { buildSnapshot, type Snapshot } from "./lib/snapshot";
import { ensureStatusDir, statusDir } from "./lib/paths";
import { scanLiveSessions } from "./scan";
import { readOverrides, applyOverrides, setNameOverride } from "./lib/overrides";
import { focusSession, interruptSession } from "./ghostty";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function loadStatus(dir: string, sessionId: string): AgentStatus | null {
  // sessionId comes from the client; keep it to a single path segment
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  try { return parseStatus(JSON.parse(readFileSync(join(dir, `${sessionId}.json`), "utf8"))); }
  catch { return null; }
}

export function readSnapshot(dir: string, now: number): Snapshot {
  const agents: AgentStatus[] = [];
  let names: string[] = [];
  // status files are <sessionId>.json; skip dotfiles like .overrides.json
  try { names = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")); } catch { /* no dir yet */ }
  for (const f of names) {
    try {
      const s = parseStatus(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (s) agents.push(s);
    } catch { /* half-written; skip */ }
  }
  return buildSnapshot(applyOverrides(agents, readOverrides(dir)), now);
}

export function makeServer(port: number, opts: { scan?: boolean; scanIntervalMs?: number } = {}) {
  const { scan = false, scanIntervalMs = 20_000 } = opts;
  const dir = ensureStatusDir();
  const clients = new Set<(s: Snapshot) => void>();

  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    const snap = readSnapshot(dir, Date.now());
    for (const send of clients) {
      try {
        send(snap);
      } catch {
        // Client's controller is closed (cancel() hasn't fired yet) —
        // drop it so it isn't retried on the next push.
        clients.delete(send);
      }
    }
  };
  const watcher = watch(dir, () => { if (timer) clearTimeout(timer); timer = setTimeout(push, 150); });

  // Surface currently-open Claude Code sessions by scanning their transcripts,
  // on startup and on an interval. Hooks handle real-time deltas in between.
  let scanTimer: ReturnType<typeof setInterval> | null = null;
  if (scan) {
    let scanning = false;
    const runScan = async () => {
      if (scanning) return; // don't overlap passes
      scanning = true;
      try { await scanLiveSessions(Date.now()); } catch { /* keep serving */ }
      finally { scanning = false; }
      push();
    };
    void runScan();
    scanTimer = setInterval(() => void runScan(), scanIntervalMs);
  }

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/events") {
        let send!: (s: Snapshot) => void;
        const stream = new ReadableStream({
          start(ctrl) {
            const enc = new TextEncoder();
            send = (s) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(s)}\n\n`));
            clients.add(send);
            send(readSnapshot(dir, Date.now())); // initial
          },
          cancel() { clients.delete(send); },
        });
        return new Response(stream, { headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        }});
      }
      // commands: act on a real session
      if (req.method === "POST" && url.pathname.startsWith("/action/")) {
        const action = url.pathname.slice("/action/".length);
        let body: { sessionId?: string; name?: string };
        try { body = await req.json(); } catch { return json({ ok: false, error: "bad body" }, 400); }
        const status = body.sessionId ? loadStatus(dir, body.sessionId) : null;
        if (action === "rename") {
          if (!body.sessionId) return json({ ok: false, error: "no sessionId" }, 400);
          setNameOverride(dir, body.sessionId, body.name ?? null);
          push();
          return json({ ok: true });
        }
        if (!status) return json({ ok: false, error: "unknown session" }, 404);
        if (action === "focus") return json(await focusSession(status));
        if (action === "pause") return json(interruptSession(status));
        return json({ ok: false, error: "unknown action" }, 404);
      }

      // static
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(join(import.meta.dir, "..", "dist", path));
      if (await file.exists()) return new Response(file);
      return new Response("not found", { status: 404 });
    },
  });

  // Close the fs.watch handle when the server stops, so repeated
  // makeServer() calls (e.g. across tests) don't leak OS watchers.
  const baseStop = server.stop.bind(server);
  server.stop = ((closeActiveConnections?: boolean) => {
    watcher.close();
    if (scanTimer) clearInterval(scanTimer);
    return baseStop(closeActiveConnections);
  }) as typeof server.stop;

  return server;
}

if (import.meta.main) {
  const server = makeServer(Number(process.env.PORT ?? 4173), { scan: true });
  console.log(`Agent Workshop → http://localhost:${server.port}  (watching ${statusDir()}, scanning open sessions)`);
}
