// `bun run sandbox` — a throwaway dashboard for testing, isolated from the
// live one. Copies the live board into a temp dir, points the status and
// projects dirs there (so no live session shows up as a desk), and turns every
// terminal action — typing, quitting, spawning — into a no-op that reports
// "sandbox". See src/lib/sandbox.ts for why both dirs matter.
//
// PORT picks the port (default: any free one). The live board's port, 4173,
// is refused.
import { tmpdir } from "node:os";
import { statusDir } from "../src/lib/paths";
import { prepareSandbox, sandboxOps } from "../src/lib/sandbox";

const port = Number(process.env.PORT ?? 0);
if (port === 4173) {
  console.error("sandbox: refusing port 4173, that is the live dashboard. Pick another PORT.");
  process.exit(1);
}

const env = prepareSandbox(statusDir(), tmpdir());
Object.assign(process.env, env, { SANDBOX: "1" });

// Imported after the env is set, so nothing in the server can read the live dirs.
const { makeServer } = await import("../src/server");
const server = makeServer(port, { scan: true, ...sandboxOps });
console.log(`Sandbox → http://localhost:${server.port}`);
console.log(`  board:    ${env.AGENT_STATUS_DIR}`);
console.log(`  projects: ${env.AGENT_PROJECTS_DIR} (empty: no live sessions)`);
console.log(`  terminal actions are off (typing, quitting, spawning report "sandbox")`);
