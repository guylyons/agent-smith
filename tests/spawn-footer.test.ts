// tests/spawn-footer.test.ts — a spawn for a card hands the new agent THE LINE
// footer even when the caller (curl, the scrum master) sent only plain text.
// The browser already sends the full prompt, so the footer is never doubled.
import { test, expect } from "bun:test";
import { fixtureDir } from "./fixtures";
import { mkdirSync, rmSync } from "node:fs";

const FOOTER = "-- THE LINE --";

async function server() {
  const dir = fixtureDir("spawn-footer-http");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.AGENT_STATUS_DIR = dir;
  const tasks: string[] = [];
  const { makeServer } = await import("../src/server");
  const srv = makeServer(0, {
    // Stands in for Ghostty: records the task it was handed, launches nowhere.
    spawn: async (cwd, task) => { tasks.push(task); return { ok: false, error: "test: no launch" }; },
  });
  const base = `http://localhost:${srv.port}`;
  const post = (path: string, body: object) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const add = async (title: string) =>
    ((await (await post("/action/card-add", { columnId: "backlog", title })).json()) as any).cardId as string;
  return { srv, base, dir, post, add, tasks };
}

const count = (s: string, sub: string) => s.split(sub).length - 1;

test("spawn with a cardId and plain text appends that card's footer", async () => {
  const { srv, base, dir, post, add, tasks } = await server();
  try {
    const id = await add("Fix it");
    await post("/action/spawn", { cwd: dir, text: "do the card", cardId: id });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.startsWith("do the card")).toBe(true);
    expect(count(tasks[0]!, FOOTER)).toBe(1);
    expect(tasks[0]).toContain(`card: ${id}`);
    expect(tasks[0]).toContain(`curl -s -X POST ${base}/action/card-move`);
    expect(/^[\x00-\x7f]*$/.test(tasks[0]!)).toBe(true);
  } finally { srv.stop(true); }
});

// The card modal's "new agent" path sends cardTaskPrompt's full prompt, built
// in the browser before any agent (or crew id) exists. The server swaps that
// footer for one naming the new agent and carrying its crew id, so its writes
// can be refused once it is taken off the card.
test("spawn with text that already carries the footer replaces it with one carrying the crew", async () => {
  const { srv, dir, post, add, tasks } = await server();
  try {
    const id = await add("Fix it");
    const full = `do the card\n\n${FOOTER}\ncard: ${id}\n...`;
    await post("/action/spawn", { cwd: dir, text: full, cardId: id });
    expect(tasks[0]!.startsWith("do the card\n\n")).toBe(true);
    expect(count(tasks[0]!, FOOTER)).toBe(1);
    expect(tasks[0]).not.toContain("\n...");
    expect(tasks[0]).toMatch(/"as":"assignee","crew":"[a-z0-9-]+"/);
    expect(tasks[0]).not.toMatch(/"as":"assignee",(?!"crew")/);
  } finally { srv.stop(true); }
});

test("spawn with no cardId hands the text over unchanged", async () => {
  const { srv, dir, post, tasks } = await server();
  try {
    await post("/action/spawn", { cwd: dir, text: "just a task" });
    expect(tasks[0]).toBe("just a task");
  } finally { srv.stop(true); }
});
