// `bun run app` — the dashboard as a stand-alone window.
//
// Builds the UI if it hasn't been built, makes sure a server is up (reusing one
// that's already running rather than fighting it for the port), and opens the
// board in a Chromium `--app` window: no URL bar, no tabs, no bookmarks.
//
// Whoever starts the server owns it. If that's us, closing the window quits the
// whole thing. If we found a server already running, we just open a window onto
// it and get out of the way; it isn't ours to shut down.
//
// Note we don't wait on the browser process to learn that the window closed:
// macOS Chrome stays running with no windows open, so that wait never returns.
// The server watches its own /events streams instead — one per open window.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appProfileDir, appUrl, browserArgv, pickBrowser, BROWSERS } from "../src/lib/appwindow";
import { makeServer } from "../src/server";
import { statusDir } from "../src/lib/paths";

const root = join(import.meta.dir, "..");
const port = Number(process.env.PORT ?? 4173);
const url = appUrl(port);

/** Is a server already answering on our port? */
async function alreadyServing(): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
  } catch { return false; }
}

async function build(): Promise<void> {
  console.log("building the UI…");
  const p = Bun.spawn(["bun", "build", "src/ui/index.html", "--outdir", "dist", "--minify"], {
    cwd: root, stdout: "inherit", stderr: "inherit",
  });
  if ((await p.exited) !== 0) {
    console.error("the UI build failed — fix that and run `bun run app` again");
    process.exit(1);
  }
}

if (!existsSync(join(root, "dist", "index.html"))) await build();

let win: { kill: () => void } | null = null;
let server: ReturnType<typeof makeServer> | null = null;

function quit(why: string): never {
  console.log(why);
  try { win?.kill(); } catch { /* already gone */ }
  server?.stop(true);
  process.exit(0);
}

// Reuse a dashboard that's already up (a `bun run dev` in another terminal, or
// a second `bun run app`), so opening a window never kills someone's server.
// The probe can also lose a race with another launcher starting at the same
// moment, in which case the port is taken by the time we bind — same outcome.
if (!(await alreadyServing())) {
  try {
    server = makeServer(port, {
      scan: true,
      // The window is the app: when the last one closes, we're done.
      onWindowsClosed: () => quit("Window closed — stopping the dashboard."),
    });
  } catch { /* someone beat us to the port; treat it as theirs */ }
}
console.log(
  server
    ? `Agent Workshop → ${url}  (watching ${statusDir()}, scanning open sessions)`
    : `Agent Workshop → ${url}  (using the server already running there)`,
);

const browser = pickBrowser(existsSync, process.env.AGENT_WORKSHOP_BROWSER);

if (!browser) {
  console.error(
    `\nNo Chromium browser found, so there's nothing that can open a window without\n` +
    `browser decorations. Looked for:\n` +
    BROWSERS.map((b) => `  - ${b.name}`).join("\n") +
    `\nInstall one, or point AGENT_WORKSHOP_BROWSER at a Chromium binary.\n` +
    `Opening in your default browser instead — this window WILL have a URL bar.\n`,
  );
  Bun.spawn(["open", url]);
} else {
  const argv = browserArgv(browser.bin, url, appProfileDir(homedir(), port), { size: [1440, 900] });
  win = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
}

if (!server) {
  // Not our server, so there's nothing left for us to hold open. Say that the
  // window outlives this command, so its exiting doesn't look like a failure.
  console.log("Opened a window on it. The window stays open after this exits.");
  process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => quit("Stopping the dashboard."));
}
