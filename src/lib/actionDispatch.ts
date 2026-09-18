// The POST /action/* dispatcher. The CSRF gate lives here, wrapped around the
// handler lookup, so every action is behind it by construction: a handler
// can't be reached without passing the gate, however the handlers are split
// up or ordered.

/** What a handler gets: the raw request (for its own header checks), the URL
 *  (for its origin), the action name, and the already-parsed JSON body. */
export type ActionContext<B> = { req: Request; url: URL; action: string; body: B };
export type ActionHandler<B> = (ctx: ActionContext<B>) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Gate, parse, dispatch. `fallback` answers any action not in `handlers`.
 *  The lookup is own-property only, so "constructor" or "__proto__" can't
 *  resolve to something off Object.prototype. */
export async function dispatchAction<B>(
  req: Request,
  handlers: Record<string, ActionHandler<B>>,
  fallback: ActionHandler<B>,
): Promise<Response> {
  // Block cross-site POSTs (localhost-CSRF from another local tab). Our own
  // page sends same-origin; direct clients (curl) send no such header.
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return json({ ok: false, error: "cross-site blocked" }, 403);
  }
  const url = new URL(req.url);
  const action = url.pathname.slice("/action/".length);
  let body: B;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad body" }, 400); }
  const handler = Object.hasOwn(handlers, action) ? handlers[action]! : fallback;
  return handler({ req, url, action, body });
}
