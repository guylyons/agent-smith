import { test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir } from "./fixtures";
import {
  emptyMood, sanitizeMood, addNote, updateNote, raiseNote, deleteNote, restoreNote,
  addLink, linkBlockReason, setLinkLabel, deleteLink, moodBounds, rectEdgePoint, zoomAt, fitView,
  formatMood, readMood, writeMood, moodFile, NOTE_W, type Mood,
} from "../src/lib/mood";
import { nextNoteSpot } from "../src/lib/mcp";
import { viewFromHash } from "../src/ui/view";

function two(): { mood: Mood; a: string; b: string } {
  const r1 = addNote(emptyMood(), { title: "A", x: 0, y: 0 }, 1);
  const r2 = addNote(r1.mood, { title: "B", x: 400, y: 0, kind: "risk" }, 2);
  return { mood: r2.mood, a: r1.id, b: r2.id };
}

test("addNote fills defaults and never mutates its input", () => {
  const before = emptyMood();
  const { mood, id } = addNote(before, { title: "Ship it", x: 10.6, y: -3 }, 5);
  expect(before.notes).toEqual([]);
  expect(mood.notes).toEqual([{ id, kind: "note", title: "Ship it", x: 11, y: -3, w: NOTE_W, at: 5 }]);
});

test("sanitizeMood repairs bad input: unknown kind, wild coords, dangling and duplicate links", () => {
  const m = sanitizeMood({
    notes: [
      { id: "n1", title: "x", kind: "bogus", x: 1e9, y: "no", w: 5 },
      { id: "n2", title: "y", kind: "done", x: 0, y: 0 },
      { id: "n1", title: "dupe id" },
      { title: "no id" },
    ],
    links: [
      { id: "l1", from: "n1", to: "n2", label: "  blocks  " },
      { id: "l2", from: "n2", to: "n1" }, // same pair, other way
      { id: "l3", from: "n1", to: "gone" },
      { id: "l4", from: "n1", to: "n1" },
    ],
  });
  expect(m.notes.map((n) => n.id)).toEqual(["n1", "n2"]);
  expect(m.notes[0]).toMatchObject({ kind: "note", x: 20_000, y: 0, w: 140 });
  expect(m.links).toEqual([{ id: "l1", from: "n1", to: "n2", label: "blocks" }]);
  expect(sanitizeMood("garbage")).toEqual(emptyMood());
});

test("updateNote changes only the given fields; null cardId and empty body clear", () => {
  const { mood, a } = two();
  const withCard = updateNote(mood, a, { cardId: "card_1", body: "why" });
  expect(withCard.notes[0]).toMatchObject({ cardId: "card_1", body: "why", title: "A" });
  const cleared = updateNote(withCard, a, { cardId: null, body: "" });
  expect(cleared.notes[0]!.cardId).toBeUndefined();
  expect(cleared.notes[0]!.body).toBeUndefined();
  expect(updateNote(mood, "nope", { title: "z" })).toEqual(mood);
});

test("raiseNote moves a note to the top of the stack", () => {
  const { mood, a, b } = two();
  expect(raiseNote(mood, a).notes.map((n) => n.id)).toEqual([b, a]);
  expect(raiseNote(mood, b)).toBe(mood);
});

test("links: one per pair, no self links, delete and relabel", () => {
  const { mood, a, b } = two();
  expect(linkBlockReason(mood, a, a)).toMatch(/itself/);
  expect(linkBlockReason(mood, a, "x")).toMatch(/unknown note/);
  const r = addLink(mood, a, b, "blocks");
  expect(r.id).toBeDefined();
  expect(linkBlockReason(r.mood, b, a)).toMatch(/already linked/);
  expect(addLink(r.mood, b, a).id).toBeUndefined();
  const relabelled = setLinkLabel(r.mood, r.id!, "");
  expect(relabelled.links[0]!.label).toBeUndefined();
  expect(deleteLink(r.mood, r.id!).links).toEqual([]);
});

test("deleteNote takes its links with it, restoreNote brings both back", () => {
  const { mood, a, b } = two();
  const linked = addLink(mood, a, b).mood;
  const note = linked.notes.find((n) => n.id === a)!;
  const gone = deleteNote(linked, a);
  expect(gone.notes.map((n) => n.id)).toEqual([b]);
  expect(gone.links).toEqual([]);
  const back = restoreNote(gone, note, linked.links);
  expect(back.notes).toHaveLength(2);
  expect(back.links).toEqual(linked.links);
  expect(restoreNote(back, note, [])).toBe(back);
});

test("geometry: bounds, edge points, zoom about a point, fit", () => {
  const { mood } = two();
  expect(moodBounds(emptyMood())).toBeNull();
  expect(moodBounds(mood, 100)).toEqual({ x: 0, y: 0, w: 400 + NOTE_W, h: 100 });

  const r = { x: 0, y: 0, w: 100, h: 50 };
  expect(rectEdgePoint(r, 1000, 25)).toEqual({ x: 100, y: 25 }); // straight right
  expect(rectEdgePoint(r, 50, -1000)).toEqual({ x: 50, y: 0 }); // straight up
  expect(rectEdgePoint(r, 60, 30)).toEqual({ x: 60, y: 30 }); // target inside: stays put

  // the canvas point under the cursor stays under it
  const v = zoomAt({ x: 10, y: 20, z: 1 }, 2, 110, 120);
  expect(v.z).toBe(2);
  expect((110 - v.x) / v.z).toBeCloseTo(100);
  expect((120 - v.y) / v.z).toBeCloseTo(100);
  expect(zoomAt({ x: 0, y: 0, z: 2 }, 100, 0, 0).z).toBe(2.5);

  const f = fitView({ x: 0, y: 0, w: 2000, h: 1000 }, 1000, 600, 0);
  expect(f.z).toBeCloseTo(0.5);
  expect(fitView({ x: 0, y: 0, w: 10, h: 10 }, 1000, 600).z).toBe(1); // never zooms past 1:1
});

test("formatMood lists notes by kind with ids, then links", () => {
  const { mood, a, b } = two();
  const text = formatMood(addLink(mood, a, b, "blocks").mood);
  expect(text).toContain(`NOTE:\n- ${a} "A"`);
  expect(text).toContain(`RISK:\n- ${b} "B"`);
  expect(text).toContain(`"A" -> "B" [blocks]`);
  expect(formatMood(emptyMood())).toBe("The mood board is empty.");
});

test("nextNoteSpot drops new notes below everything already there", () => {
  expect(nextNoteSpot(emptyMood())).toEqual({ x: 0, y: 0 });
  expect(nextNoteSpot(two().mood)).toEqual({ x: 0, y: 160 });
});

test("viewFromHash", () => {
  expect(viewFromHash("#mood")).toBe("mood");
  expect(viewFromHash("")).toBe("workshop");
  expect(viewFromHash("#other")).toBe("workshop");
});

test("readMood/writeMood round-trip; a corrupt file reads as empty", () => {
  const dir = fixtureDir("mood-io");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  expect(readMood(dir)).toEqual(emptyMood());
  const { mood } = two();
  writeMood(dir, mood);
  expect(readMood(dir)).toEqual(mood);
  writeFileSync(moodFile(dir), "{ nope");
  expect(readMood(dir)).toEqual(emptyMood());
});

test("mood-* actions over HTTP: add, move, link, refuse bad links, delete, restore, and the snapshot carries it", async () => {
  const dir = fixtureDir("mood-server");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.AGENT_STATUS_DIR = dir;
  const { makeServer, readSnapshot } = await import("../src/server");
  const server = makeServer(0);
  const base = `http://localhost:${server.port}`;
  const post = async (action: string, body: object) => {
    const res = await fetch(`${base}/action/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  try {
    expect((await post("mood-note-add", { x: 0, y: 0 })).body.error).toBe("title is required");
    expect((await post("mood-note-add", { title: "t", kind: "nope" })).status).toBe(400);

    const a = (await post("mood-note-add", { title: "Focus", kind: "focus", x: 5, y: 6, author: "CHRISTIE" })).body.noteId;
    const b = (await post("mood-note-add", { title: "Risk", kind: "risk", x: 300, y: 6 })).body.noteId;
    expect(a).toMatch(/^note_/);

    expect((await post("mood-note-update", { noteId: a })).status).toBe(400);
    expect((await post("mood-note-update", { noteId: "note_x", x: 1 })).status).toBe(404);
    expect((await post("mood-note-update", { noteId: a, x: 50, y: 60, raise: true })).body.ok).toBe(true);

    expect((await post("mood-link-add", { from: a, to: a })).body.error).toMatch(/itself/);
    const link = (await post("mood-link-add", { from: a, to: b, label: "watch" })).body.linkId;
    expect((await post("mood-link-add", { from: b, to: a })).body.error).toMatch(/already linked/);
    expect((await post("mood-link-update", { linkId: link, label: "blocks" })).body.ok).toBe(true);

    const got = (await (await fetch(`${base}/mood`)).json()) as any;
    expect(got.moodPath).toBe(moodFile(dir));
    expect(got.mood.notes.map((n: any) => n.id)).toEqual([b, a]); // raised
    expect(got.mood.notes[1]).toMatchObject({ x: 50, y: 60, by: "CHRISTIE", kind: "focus" });
    expect(got.mood.links).toEqual([{ id: link, from: a, to: b, label: "blocks" }]);
    expect(await (await fetch(`${base}/mood?format=text`)).text()).toContain("FOCUS:");
    expect(readSnapshot(dir, Date.now()).mood).toEqual(got.mood);

    const note = got.mood.notes[1];
    expect((await post("mood-note-delete", { noteId: a })).body.ok).toBe(true);
    expect(readMood(dir).links).toEqual([]);
    expect((await post("mood-note-restore", { note, links: got.mood.links })).body.ok).toBe(true);
    expect(readMood(dir).links).toHaveLength(1);

    expect((await post("mood-link-delete", { linkId: link })).body.ok).toBe(true);
    expect(readMood(dir).links).toEqual([]);
  } finally {
    server.stop(true);
  }
});
