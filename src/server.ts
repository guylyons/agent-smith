import { readdirSync, readFileSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { parseStatus, type AgentStatus } from "./schema";
import { buildSnapshot, type Snapshot } from "./lib/snapshot";
import { ensureStatusDir, statusDir } from "./lib/paths";
import { scanLiveSessions, readConversation, readSubagents } from "./scan";
import { readOverrides, applyOverrides, setNameOverride, setSpriteOverride } from "./lib/overrides";
import { loadPersonas, applyPersonas } from "./lib/personas";
import { readBoard, writeBoard, sanitizeBoard } from "./lib/board";
import { ALLOWED_MODELS, ALLOWED_PERMISSION_MODES, focusSession, interruptSession, killAgent, sendPrompt, spawnAgent } from "./ghostty";
import { readRepo } from "./repo";
import { saveUpload } from "./lib/uploads";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// sessionId comes from the client; keep it to a single, safe path/key segment.
function validSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && /^[A-Za-z0-9-]+$/.test(sessionId);
}

function loadStatus(dir: string, sessionId: string): AgentStatus | null {
  if (!validSessionId(sessionId)) return null;
  try { return parseStatus(JSON.parse(readFileSync(join(dir, `${sessionId}.json`), "utf8"))); }
  catch { return null; }
}

export function readSnapshot(dir: string, now: number): Snapshot {
  const agents: AgentStatus[] = [];
  let names: string[] = [];
  // status files are <sessionId>.json; skip dotfiles like .overrides.json / .line.json
  try { names = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")); } catch { /* no dir yet */ }
  for (const f of names) {
    try {
      const s = parseStatus(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (s) agents.push(s);
    } catch { /* half-written; skip */ }
  }
  // personas resolve INSIDE applyOverrides so a name you typed yourself wins:
  // user override > persona > inferRole > hashed codename
  return buildSnapshot(applyOverrides(applyPersonas(agents, loadPersonas()), readOverrides(dir)), now, {
    board: readBoard(dir),
  });
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
      // a session's full conversation (+ any pending question)
      if (url.pathname === "/conversation") {
        const sid = url.searchParams.get("sessionId") ?? "";
        if (!validSessionId(sid)) return json({ messages: [], question: null, blocked: null }, 400);
        return json(await readConversation(sid));
      }

      // a session's live subagents
      if (url.pathname === "/subagents") {
        const sid = url.searchParams.get("sessionId") ?? "";
        if (!validSessionId(sid)) return json({ subagents: [] }, 400);
        return json({ subagents: await readSubagents(sid, Date.now()) });
      }

      // the persona picker's options
      if (url.pathname === "/personas") {
        // id/name/role/skills only — the prompt body is never sent to the browser
        return json(loadPersonas().map(({ id, name, role, skills }) => ({ id, name, role, skills })));
      }

      // a session's git context (branch, commits, working-tree status)
      if (url.pathname === "/repo") {
        const sid = url.searchParams.get("sessionId") ?? "";
        if (!validSessionId(sid)) return json({ error: "bad sessionId" }, 400);
        const status = loadStatus(dir, sid);
        if (!status) return json({ error: "unknown session" }, 404);
        return json(await readRepo(status.cwd));
      }

      // commands: act on a real session
      if (req.method === "POST" && url.pathname.startsWith("/action/")) {
        // Block cross-site POSTs (localhost-CSRF from another local tab). Our own
        // page sends same-origin; direct clients (curl) send no such header.
        const site = req.headers.get("sec-fetch-site");
        if (site && site !== "same-origin" && site !== "none") {
          return json({ ok: false, error: "cross-site blocked" }, 403);
        }
        const action = url.pathname.slice("/action/".length);
        let body: { sessionId?: string; name?: string; text?: string; cwd?: string; palette?: number; gear?: string; body?: string; model?: string; permissionMode?: string; worktree?: string; persona?: string; board?: unknown; type?: string; dataBase64?: string };
        try { body = await req.json(); } catch { return json({ ok: false, error: "bad body" }, 400); }
        // spawn creates a brand-new session — it has a folder + task, not a sessionId
        if (action === "spawn") {
          const cwd = typeof body.cwd === "string" ? body.cwd : "";
          const task = typeof body.text === "string" ? body.text : "";
          if (!cwd || !task.trim()) return json({ ok: false, error: "folder and task are required" }, 400);
          try { if (!statSync(cwd).isDirectory()) throw 0; } catch { return json({ ok: false, error: `folder not found: ${cwd}` }, 400); }
          const model = typeof body.model === "string" && ALLOWED_MODELS.has(body.model) ? body.model : undefined;
          const permissionMode = typeof body.permissionMode === "string" && ALLOWED_PERMISSION_MODES.has(body.permissionMode) ? body.permissionMode : undefined;
          // A blank/whitespace field means "no worktree" (launch in the folder). The
          // name is sanitized to a slug inside createWorktree, so pass it as typed.
          const worktree = typeof body.worktree === "string" && body.worktree.trim() ? body.worktree.trim() : undefined;
          const persona = typeof body.persona === "string" && body.persona.trim() ? body.persona.trim() : undefined;
          return json(await spawnAgent(cwd, task, { model, permissionMode, worktree, persona }));
        }
        // board: the whole kanban board (THE LINE). The client owns the edit and
        // sends the full board; the server sanitizes it (dropping malformed
        // columns/cards, orphan cards) before persisting so a bad write can't
        // corrupt the file agents read. Not tied to a sessionId.
        if (action === "board") {
          writeBoard(dir, sanitizeBoard(body.board));
          push();
          return json({ ok: true });
        }
        // upload: save an image dropped/pasted into a chat to a temp file, and
        // return its path. Not tied to a session — the path is later prepended to
        // a prompt and typed into the terminal, where Claude Code reads it.
        if (action === "upload") {
          const name = typeof body.name === "string" ? body.name : "image";
          const type = typeof body.type === "string" ? body.type : "";
          const data = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
          if (!data) return json({ ok: false, error: "no image data" }, 400);
          const r = saveUpload(name, type, data);
          return json(r, r.ok ? 200 : 400);
        }
        if (!validSessionId(body.sessionId)) return json({ ok: false, error: "bad sessionId" }, 400);
        if (action === "rename") {
          setNameOverride(dir, body.sessionId, body.name ?? null);
          push();
          return json({ ok: true });
        }
        if (action === "sprite") {
          if (typeof body.palette !== "number" || typeof body.gear !== "string") {
            return json({ ok: false, error: "palette and gear are required" }, 400);
          }
          const character = typeof body.body === "string" ? body.body : undefined;
          setSpriteOverride(dir, body.sessionId, { palette: body.palette, gear: body.gear, body: character });
          push();
          return json({ ok: true });
        }
        const status = loadStatus(dir, body.sessionId);
        if (!status) return json({ ok: false, error: "unknown session" }, 404);
        if (action === "focus") return json(await focusSession(status));
        if (action === "pause") return json(await interruptSession(status));
        if (action === "kill") return json(await killAgent(status));
        if (action === "prompt") {
          const text = typeof body.text === "string" ? body.text : "";
          if (!text.trim()) return json({ ok: false, error: "empty prompt" }, 400);
          if (text.length > 10_000) return json({ ok: false, error: "prompt too long" }, 400);
          return json(await sendPrompt(status, text));
        }
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
