// Installs the Agent Workshop status hooks into your USER-level Claude Code
// settings (~/.claude/settings.json), so every session — in any project —
// reports to the dashboard in real time.
//
// Safe to run: it backs up your settings first, merges non-destructively
// (only adds the five hook events if they aren't already present), and prints
// exactly what it changed. Undo with:  bun run scripts/uninstall-hooks.ts
//
//   bun run scripts/install-hooks.ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";

const settingsPath = join(homedir(), ".claude", "settings.json");
const backupPath = settingsPath + ".agentworkshop.bak";

const bun = process.execPath; // absolute path to the bun running this script
const repoRoot = resolve(import.meta.dir, "..");
const hookScript = join(repoRoot, "hooks", "status.ts");
// Quote both paths: a bun path or repo path containing a space would otherwise
// be split by the shell, installing a broken hook command for every event.
const command = `"${bun}" run "${hookScript}"`;

type Entry = { matcher?: string; hooks?: { type?: string; command?: string }[] };
const single = (): Entry[] => [{ hooks: [{ type: "command", command }] }];
const withMatcher = (): Entry[] => [{ matcher: "*", hooks: [{ type: "command", command }] }];

const OURS = { SessionStart: single, UserPromptSubmit: single, PreToolUse: withMatcher, Notification: single, Stop: single, SessionEnd: single };

function main() {
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); }
    catch { console.error(`Could not parse ${settingsPath}; aborting so nothing is clobbered.`); process.exit(1); }
    // Back up only if we don't already have one, so re-running never clobbers the
    // pristine pre-install copy with already-modified settings.
    if (!existsSync(backupPath)) {
      copyFileSync(settingsPath, backupPath);
      console.log(`Backed up existing settings → ${backupPath}`);
    }
  }

  const hooks = (settings.hooks as Record<string, Entry[]>) ?? {};
  const added: string[] = [];
  for (const [event, make] of Object.entries(OURS)) {
    // Merge per-COMMAND, not per-event: a user who already has some other Stop /
    // Notification / SessionStart hook must still get ours appended, or that
    // event never reports to the dashboard.
    const existing = Array.isArray(hooks[event]) ? hooks[event]! : [];
    const already = existing.some((e) => (e.hooks ?? []).some((h) => (h.command ?? "").includes(hookScript)));
    if (!already) { hooks[event] = [...existing, ...make()]; added.push(event); }
  }
  settings.hooks = hooks;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  if (added.length) {
    console.log(`Installed hooks for: ${added.join(", ")}`);
  } else {
    console.log("Our hook command was already present on all six events — nothing changed.");
  }
  console.log(`Hook command: ${command}`);
  console.log("\nNext:");
  console.log("  • New Claude sessions will report automatically.");
  console.log("  • Sessions you already have open won't fire hooks until restarted —");
  console.log("    the dashboard's transcript scanner surfaces those in the meantime.");
  console.log("  • Start the dashboard:  bun run dev   (then open the printed URL)");
}

main();
