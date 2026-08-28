// Registers THE LINE's board tools as an MCP server with Claude Code, at the
// USER level (~/.claude.json) — so every session, in any project, can read the
// board and drive its own card with tools instead of hand-written curl calls.
//
//   bun run scripts/install-mcp.ts
//
// Re-running is safe: an existing registration under the same name is replaced.
// Undo with:  claude mcp remove --scope user the-line
//
// The dashboard still has to be running (`bun run dev`) — the tools talk to it
// over HTTP so every write lands the same way the UI's does.
import { resolve } from "node:path";

const NAME = "the-line";
const bun = process.execPath; // absolute path to the bun running this script
const entry = resolve(import.meta.dir, "..", "src", "mcp.ts");
// Where the tools will look for the dashboard. Baked in at install time so a
// non-default PORT keeps working; the server itself defaults to 4173.
const url = process.env.AGENT_WORKSHOP_URL ?? `http://localhost:${process.env.PORT ?? 4173}`;

async function run(args: string[]): Promise<{ ok: boolean; out: string }> {
  const p = Bun.spawn(["claude", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, error] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { ok: (await p.exited) === 0, out: (out + error).trim() };
}

const probe = await run(["mcp", "list"]).catch(() => null);
if (!probe) {
  console.error("Could not run `claude` — is Claude Code installed and on your PATH?");
  process.exit(1);
}

// Remove first: `mcp add` refuses a name that already exists, and a re-install
// after moving the repo must point at the new path.
if (probe.out.includes(`${NAME}:`)) await run(["mcp", "remove", "--scope", "user", NAME]);

// Arg order matters: `-e` is variadic, so the server name has to come before
// it and `--` has to close it off, or the name is swallowed as an env pair.
const add = await run(["mcp", "add", "--scope", "user", NAME, "-e", `AGENT_WORKSHOP_URL=${url}`, "--", bun, "run", entry]);
if (!add.ok) {
  console.error(`Registering the MCP server failed:\n${add.out}`);
  process.exit(1);
}

console.log(`Registered MCP server "${NAME}" (user scope)`);
console.log(`  command: ${bun} run ${entry}`);
console.log(`  board:   ${url}`);
console.log("\nNext:");
console.log("  • Start the dashboard:  bun run dev");
console.log("  • Restart any open Claude session to pick the server up.");
console.log(`  • Check it:  claude mcp list   (look for "${NAME}")`);
console.log(`  • Remove it: claude mcp remove --scope user ${NAME}`);
