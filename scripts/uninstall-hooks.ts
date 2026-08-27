// Removes the Agent Workshop status hooks from your USER-level Claude Code
// settings (~/.claude/settings.json). Only removes hook entries whose command
// points at this repo's hooks/status.ts, leaving any other hooks you have
// untouched. Prints what it removed.
//
//   bun run scripts/uninstall-hooks.ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const settingsPath = join(homedir(), ".claude", "settings.json");
const repoRoot = resolve(import.meta.dir, "..");
const marker = join(repoRoot, "hooks", "status.ts");

type Entry = { matcher?: string; hooks?: { type?: string; command?: string }[] };

function main() {
  if (!existsSync(settingsPath)) { console.log("No settings file; nothing to do."); return; }
  let settings: Record<string, unknown>;
  try { settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>; }
  catch { console.error(`Could not parse ${settingsPath}; aborting so nothing is clobbered.`); process.exit(1); }
  const hooks = settings.hooks as Record<string, Entry[]> | undefined;
  if (!hooks) { console.log("No hooks configured; nothing to do."); return; }

  const removed: string[] = [];
  for (const [event, entries] of Object.entries(hooks)) {
    const kept = (entries as Entry[])
      .map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((h) => !(h.command ?? "").includes(marker)) }))
      .filter((entry) => (entry.hooks ?? []).length > 0);
    if (kept.length !== entries.length || kept.some((e, i) => (e.hooks?.length ?? 0) !== (entries[i]?.hooks?.length ?? 0))) {
      removed.push(event);
    }
    if (kept.length) hooks[event] = kept; else delete hooks[event];
  }

  if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(removed.length ? `Removed Agent Workshop hooks from: ${removed.join(", ")}` : "No Agent Workshop hooks found.");
}

main();
