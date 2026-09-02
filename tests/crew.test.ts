import { test, expect } from "bun:test";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ROSTER, CREW_ID_RE, rosterName, pickName, mintCrewId, crewFrom, applyCrew,
  isAssigneeSession, findAssigneeSession, readNotes, addNote, notesContext, NOTES_CAP,
} from "../src/lib/crew";
import type { AgentStatus } from "../src/schema";

const dir = "/tmp/aw-crew-test";
function reset() { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }

test("the roster is uppercase ASCII with no duplicates", () => {
  expect(ROSTER.length).toBeGreaterThan(50);
  expect(new Set(ROSTER).size).toBe(ROSTER.length);
  for (const n of ROSTER) expect(/^[A-Z]+$/.test(n)).toBe(true);
});

test("rosterName is stable for an anchor and drawn from the roster", () => {
  expect(rosterName("pid:123")).toBe(rosterName("pid:123"));
  expect(ROSTER).toContain(rosterName("anything"));
});

test("pickName avoids names already live, case-insensitively", () => {
  const taken = ROSTER.filter((n) => n !== "RIPLEY").map((n) => n.toLowerCase());
  expect(pickName(taken, () => 0)).toBe("RIPLEY");
  expect(pickName(taken, () => 0.999)).toBe("RIPLEY");
});

test("pickName still answers when every name is live", () => {
  expect(ROSTER).toContain(pickName(ROSTER, () => 0.5));
});

test("mintCrewId is the lowercase name plus a four-hex tag, and a valid crew id", () => {
  const id = mintCrewId("RIPLEY", () => 0.5);
  expect(id).toMatch(/^ripley-[0-9a-f]{4}$/);
  expect(CREW_ID_RE.test(id)).toBe(true);
  expect(mintCrewId("RIPLEY", () => 0)).toBe("ripley-0000");
});

test("crewFrom takes the launch env when both halves are present and well-formed", () => {
  expect(crewFrom({ AGENT_CREW: "ripley-3f2a", AGENT_NAME: "RIPLEY" }, 99)).toEqual({ id: "ripley-3f2a", name: "RIPLEY" });
});

test("crewFrom falls back to the pid when the env is missing or malformed", () => {
  const byPid = crewFrom({}, 86569);
  expect(byPid).toEqual({ id: "pid-86569", name: rosterName("pid:86569") });
  expect(crewFrom({ AGENT_CREW: "ripley-3f2a" }, 86569)).toEqual(byPid);          // name missing
  expect(crewFrom({ AGENT_CREW: "../x", AGENT_NAME: "RIPLEY" }, 86569)).toEqual(byPid); // bad id
  expect(crewFrom({ AGENT_CREW: "ripley-3f2a", AGENT_NAME: "R\nIPLEY" }, 86569)).toEqual(byPid); // bad name
});

test("crewFrom is undefined with neither env nor pid", () => {
  expect(crewFrom({})).toBeUndefined();
  expect(crewFrom({}, 0)).toBeUndefined();
});

const agent = (o: Partial<AgentStatus>): AgentStatus => ({
  sessionId: "s", name: "HASHED", role: "r", ticket: null, state: "idle", doing: "", cwd: "/", branch: null, updatedAt: 0, ...o,
});

test("applyCrew shows the crew name and leaves crewless agents alone", () => {
  const input = [agent({ crew: { id: "ripley-1", name: "RIPLEY" } }), agent({ sessionId: "t" })];
  const out = applyCrew(input);
  expect(out[0]!.name).toBe("RIPLEY");
  expect(out[1]!.name).toBe("HASHED");
  expect(input[0]!.name).toBe("HASHED"); // pure
});

test("a card follows its crew member into a new session id", () => {
  const before = agent({ sessionId: "old", crew: { id: "ripley-1", name: "RIPLEY" } });
  const after = agent({ sessionId: "new", crew: { id: "ripley-1", name: "RIPLEY" } });
  const other = agent({ sessionId: "x", crew: { id: "kane-2", name: "KANE" } });
  const assignee = { id: "old", name: "RIPLEY", crew: "ripley-1" };
  expect(isAssigneeSession(assignee, before)).toBe(true);
  expect(isAssigneeSession(assignee, after)).toBe(true);
  expect(isAssigneeSession(assignee, other)).toBe(false);
  expect(findAssigneeSession([other, after], assignee)).toBe(after);
});

test("an assignee without a crew still matches by session id only", () => {
  const a = agent({ sessionId: "old" });
  expect(isAssigneeSession({ id: "old", name: "X" }, a)).toBe(true);
  expect(isAssigneeSession({ id: "new", name: "X" }, a)).toBe(false);
  expect(isAssigneeSession(null, a)).toBe(false);
});

test("notes start empty and addNote appends one line at a time", () => {
  reset();
  expect(readNotes(dir, "ripley-1")).toBe("");
  expect(addNote(dir, "ripley-1", "  tests live in tests/  ")).toEqual({ ok: true, notes: "tests live in tests/\n" });
  expect(addNote(dir, "ripley-1", "bun test is the runner").ok).toBe(true);
  expect(readNotes(dir, "ripley-1")).toBe("tests live in tests/\nbun test is the runner\n");
  expect(existsSync(join(dir, "crew", "ripley-1.md"))).toBe(true);
});

test("replace rewrites the file, and may empty it", () => {
  reset();
  addNote(dir, "ripley-1", "one");
  expect(addNote(dir, "ripley-1", "two\nthree", { replace: true })).toEqual({ ok: true, notes: "two\nthree\n" });
  expect(addNote(dir, "ripley-1", "", { replace: true })).toEqual({ ok: true, notes: "" });
  expect(readFileSync(join(dir, "crew", "ripley-1.md"), "utf8")).toBe("");
});

test("a note past the cap is refused with advice, and nothing is written", () => {
  reset();
  addNote(dir, "ripley-1", "keep");
  const r = addNote(dir, "ripley-1", "x".repeat(NOTES_CAP));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("replace");
  expect(readNotes(dir, "ripley-1")).toBe("keep\n");
});

test("blank appends and bad crew ids are refused", () => {
  reset();
  expect(addNote(dir, "ripley-1", "   ").ok).toBe(false);
  expect(addNote(dir, "../escape", "x").ok).toBe(false);
  expect(readNotes(dir, "../escape")).toBe("");
});

test("notesContext names the crew member, carries the notes and the exact call, in ASCII", () => {
  const out = notesContext({ id: "ripley-3f2a", name: "RIPLEY" }, "tests live in tests/\n", "http://localhost:4173");
  expect(out.startsWith("[THE LINE] You are RIPLEY (crew id ripley-3f2a).")).toBe(true);
  expect(out).toContain("tests live in tests/");
  expect(out).toContain(`curl -s -X POST http://localhost:4173/action/crew-note -H 'content-type: application/json' -d '{"crew":"ripley-3f2a","text":"<note>"}'`);
  expect(out).toContain("crew_note");
  expect(/^[\x00-\x7f]*$/.test(out)).toBe(true);
});

test("notesContext says so when there are no notes yet", () => {
  expect(notesContext({ id: "kane-1", name: "KANE" }, "", "http://x")).toContain("(none yet)");
});
