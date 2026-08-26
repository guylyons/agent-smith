import { readdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { parseStatus } from "./schema";
import { buildSnapshot, type Snapshot } from "./lib/snapshot";
import { ensureStatusDir, statusDir } from "./lib/paths";

export function readSnapshot(dir: string, now: number): Snapshot {
  const agents = [];
  let names: string[] = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { /* no dir yet */ }
  for (const f of names) {
    try {
      const s = parseStatus(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (s) agents.push(s);
    } catch { /* half-written; skip */ }
  }
  return buildSnapshot(agents, now);
}

export function makeServer(port: number) {
  const dir = ensureStatusDir();
  const clients = new Set<(s: Snapshot) => void>();

  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    const snap = readSnapshot(dir, Date.now());
    for (const send of clients) send(snap);
  };
  const watcher = watch(dir, () => { if (timer) clearTimeout(timer); timer = setTimeout(push, 150); });

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
    return baseStop(closeActiveConnections);
  }) as typeof server.stop;

  return server;
}

if (import.meta.main) {
  const server = makeServer(Number(process.env.PORT ?? 4173));
  console.log(`Agent Workshop → http://localhost:${server.port}  (watching ${statusDir()})`);
}
