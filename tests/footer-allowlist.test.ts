// The task footer (cardTaskPrompt) tells a worker which curl calls to make; the
// worktree settings (workerPermissionSettings) decide which of those run without
// a permission prompt. Nothing else ties the two together, so a new curl added
// to the footer would stall every worker spawned after it. This test reads the
// curl commands out of the footer's real output and checks each one against the
// allowlist, using the same rule shapes Claude Code does: `Bash(cmd)` matches
// that exact command, `Bash(prefix:*)` matches anything starting with prefix.
import { test, expect } from "bun:test";
import { addCard, defaultBoard, moveCard, cardTaskPrompt, type Board } from "../src/lib/board";
import { workerPermissionSettings } from "../src/ghostty";

const SERVER = "http://localhost:4173";
const REPO = "/Users/someone/repo";

/** Every curl command line the prompt tells the agent to run, trimmed. A command
 *  names a URL; that keeps prose lines that merely start with "curl" out. */
function footerCurls(prompt: string): string[] {
  return prompt
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^curl\s.*\bhttps?:\/\//.test(l));
}

/** Is `cmd` allowed by one of the `Bash(...)` rules? */
function bashAllowed(cmd: string, allow: string[]): boolean {
  return allow.some((rule) => {
    const m = /^Bash\((.*)\)$/.exec(rule);
    if (!m) return false;
    const body = m[1]!;
    return body.endsWith(":*") ? cmd.startsWith(body.slice(0, -2)) : cmd === body;
  });
}

/** The URL path a curl command hits, for a readable failure. */
function curlPath(cmd: string): string {
  const url = cmd.split(/\s+/).find((w) => w.startsWith("http"));
  return url ? new URL(url).pathname : cmd;
}

/** Every footer variant: a card that STEP 1 must move (backlog), one already in
 *  the work column (no move), each with and without the "worked before" lines. */
function allFooterCurls(): string[] {
  let b: Board = addCard(defaultBoard(), "backlog", "to move");
  b = addCard(b, "backlog", "in progress");
  const [toMove, inProgress] = b.cards;
  b = moveCard(b, inProgress!.id, "in-progress");
  const cmds = new Set<string>();
  for (const id of [toMove!.id, inProgress!.id]) {
    for (const workedBefore of [false, true]) {
      for (const c of footerCurls(cardTaskPrompt(b, id, SERVER, "AGENT", { workedBefore }))) cmds.add(c);
    }
  }
  return [...cmds];
}

test("the footer emits curl calls to check (the test isn't vacuous)", () => {
  const paths = new Set(allFooterCurls().map(curlPath));
  // Both STEP 1 shapes are exercised: the move-first one and the comment-only one.
  expect(paths.has("/action/card-move")).toBe(true);
  expect(paths.has("/action/card-comment")).toBe(true);
});

test("every curl the task footer emits is on the worker worktree allowlist", () => {
  const allow = workerPermissionSettings(SERVER, REPO).permissions.allow;
  const uncovered = new Set(allFooterCurls().filter((cmd) => !bashAllowed(cmd, allow)).map(curlPath));
  expect([...uncovered]).toEqual([]);
});
