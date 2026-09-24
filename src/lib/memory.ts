// The team's memory: a small graph the scrum master (and any agent) can search
// for what was done before and why. Two kinds of node:
//
//   - FACTS agents record on purpose (a decision, a gotcha, a note, a summary
//     rolling up many cards). Only these are stored, in `.line-memory.json`
//     next to `.line.json`, because nothing else could rebuild them.
//   - CARDS, read back from the board and the archive at query time. They are
//     never copied into the memory file: the board and archive already hold
//     them whole, so a card node can't go stale or be lost.
//
// Edges are links, one-way strings on a node: another fact's id, a card
// ("card:card_1a2b"), or an entity hub ("repo:agent-smith", "file:src/x.ts",
// "person:VASQUEZ"). Hubs are not nodes; two nodes sharing one are related.
//
// Staying lean is compaction's job, run on every write: an old fact's body
// shrinks to its first sentence, links to forgotten facts go, and past
// MAX_FACTS the oldest, least valuable facts are evicted. The view compacts
// old cards the same way, display only; their full text stays in the archive.
//
// Search is plain keywords (no dependencies, no API calls) plus filters:
// kind: repo: file: person: tag: card: near: since:. See searchMemory.
//
// Everything is PURE except the last four functions, which touch the disk.
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { repoName, type Board, type Card } from "./board";
import type { Archive } from "./archive";

export const FACT_KINDS = ["decision", "gotcha", "note", "summary"] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export type NodeKind = FactKind | "card";

export type MemoryNode = {
  id: string;
  kind: NodeKind;
  title: string;
  body?: string;
  tags?: string[];
  links?: string[];
  by?: string;
  at: number;
  updatedAt?: number;
  /** Set once compaction has shortened the body to a summary. */
  compact?: true;
};
export type Memory = { nodes: MemoryNode[] };

const VERSION = 1;
/** Stored facts kept at most; past it the least valuable, oldest go first. */
export const MAX_FACTS = 400;
/** A fact untouched this long has its body cut to a summary. */
export const COMPACT_AFTER_MS = 30 * 86_400_000;
/** The longest a summary gets, ellipsis included. */
export const SUMMARY_MAX = 160;
const TITLE_MAX = 200;
const BODY_MAX = 4000;
/** A card's body: its description, then its last comment (usually how it
 *  ended). Each half is capped on its own so a long description can never
 *  push the outcome out. */
const CARD_DESC_MAX = 400;
const CARD_OUTCOME_MAX = 200;
const LINK_MAX = 200;
const TAG_MAX = 40;

/** Which facts compaction evicts first when over the cap: lower goes sooner. */
const KEEP_RANK: Record<FactKind, number> = { note: 0, gotcha: 1, summary: 2, decision: 2 };

const MEM_ID_RE = /^mem_[0-9a-f]{8}$/;
const CARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function emptyMemory(): Memory {
  return { nodes: [] };
}

const flatten = (s: string) => s.replace(/\s+/g, " ").trim();
const isFactKind = (k: unknown): k is FactKind => typeof k === "string" && (FACT_KINDS as readonly string[]).includes(k);

// ---- links and tags ---------------------------------------------------------

/** A link in its one canonical spelling, or null when it isn't one we know.
 *  Repos by folder name, lowercased; files relative, without "./"; people
 *  uppercase (as the board names them); a bare card id gains its prefix. */
export function normalizeLink(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > LINK_MAX) return null;
  if (MEM_ID_RE.test(s)) return s;
  if (/^card_[A-Za-z0-9_-]+$/.test(s)) return `card:${s}`;
  const m = /^(repo|file|person|card):(.+)$/.exec(s);
  if (!m) return null;
  const [, kind, rest] = m as unknown as [string, string, string];
  let v = rest.trim();
  if (kind === "repo") v = repoName(v).toLowerCase();
  else if (kind === "file") v = v.replace(/^(\.\/)+/, "");
  else if (kind === "person") v = v.toUpperCase();
  else if (!CARD_ID_RE.test(v)) return null;
  return v ? `${kind}:${v}` : null;
}

function cleanLinks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    const l = normalizeLink(v as string);
    if (l && !out.includes(l)) out.push(l);
  }
  return out;
}

function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const t = v.trim().toLowerCase().slice(0, TAG_MAX);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// ---- recording facts --------------------------------------------------------

export type RememberInput = { kind: FactKind; title: string; body?: string; tags?: string[]; links?: string[]; by?: string };

const titleKey = (kind: string, title: string) => `${kind}|${flatten(title).toLowerCase()}`;

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** A fresh fact id, from its kind and title so it reads the same on every
 *  machine; salted only if that id is somehow taken. */
function newId(memory: Memory, key: string): string {
  const taken = new Set(memory.nodes.map((n) => n.id));
  for (let salt = 0; ; salt++) {
    const id = `mem_${hash(salt ? `${key}#${salt}` : key)}`;
    if (!taken.has(id)) return id;
  }
}

/** Record a fact. The same kind and title again (ignoring case and spacing)
 *  updates that node instead of adding a twin: the new body wins, links and
 *  tags are merged. Throws on a blank title or unknown kind — the caller's
 *  mistake, reported before anything is written. */
export function remember(memory: Memory, input: RememberInput, now: number): { memory: Memory; node: MemoryNode } {
  if (!isFactKind(input.kind)) throw new Error(`kind must be one of: ${FACT_KINDS.join(", ")}`);
  const title = flatten(String(input.title ?? "")).slice(0, TITLE_MAX);
  if (!title) throw new Error("title is required");
  const body = typeof input.body === "string" ? input.body.trim().slice(0, BODY_MAX) : "";
  const key = titleKey(input.kind, title);
  const prev = memory.nodes.find((n) => n.kind !== "card" && titleKey(n.kind, n.title) === key);
  const links = cleanLinks([...(prev?.links ?? []), ...(input.links ?? [])]);
  const tags = cleanTags([...(prev?.tags ?? []), ...(input.tags ?? [])]);
  const by = input.by?.trim() || prev?.by;
  const node: MemoryNode = {
    id: prev?.id ?? newId(memory, key),
    kind: input.kind,
    title,
    ...(body ? { body } : prev?.body ? { body: prev.body } : {}),
    ...(tags.length ? { tags } : {}),
    links,
    ...(by ? { by } : {}),
    at: prev?.at ?? now,
    updatedAt: now,
  };
  if (!body && prev?.compact) node.compact = true;
  const nodes = prev ? memory.nodes.map((n) => (n.id === prev.id ? node : n)) : [...memory.nodes, node];
  return { memory: { nodes }, node };
}

/** Drop a fact and every link pointing at it. Null when there is no such fact. */
export function forget(memory: Memory, id: string): Memory | null {
  if (!memory.nodes.some((n) => n.id === id)) return null;
  return {
    nodes: memory.nodes
      .filter((n) => n.id !== id)
      .map((n) => (n.links?.includes(id) ? { ...n, links: n.links.filter((l) => l !== id) } : n)),
  };
}

// ---- compaction ---------------------------------------------------------------

/** One line: the first sentence of `text`, capped at SUMMARY_MAX. */
export function summarize(text: string): string {
  const flat = flatten(text);
  const m = /^.+?[.!?](?=\s|$)/.exec(flat);
  const first = m ? m[0] : flat;
  return first.length > SUMMARY_MAX ? first.slice(0, SUMMARY_MAX - 1).trimEnd() + "…" : first;
}

/** A node with an old body cut to its summary, or the node itself. */
function compactNode(n: MemoryNode, now: number): MemoryNode {
  if (!n.body || now - (n.updatedAt ?? n.at) < COMPACT_AFTER_MS) return n;
  const short = summarize(n.body);
  return short === n.body ? n : { ...n, body: short, compact: true };
}

/** Keep the stored memory lean: summarize old bodies, drop links to facts
 *  that no longer exist, and evict past MAX_FACTS (least valuable kind first,
 *  then oldest). Idempotent, so it is safe to run on every write. */
export function compactMemory(memory: Memory, now: number): Memory {
  const ids = new Set(memory.nodes.map((n) => n.id));
  let nodes = memory.nodes.map((n) => {
    const c = compactNode(n, now);
    const links = (c.links ?? []).filter((l) => !MEM_ID_RE.test(l) || ids.has(l));
    return links.length === (c.links ?? []).length ? c : { ...c, links };
  });
  if (nodes.length > MAX_FACTS) {
    const rank = (n: MemoryNode) => (isFactKind(n.kind) ? KEEP_RANK[n.kind] : 0);
    const evict = new Set(
      [...nodes]
        .sort((a, b) => rank(a) - rank(b) || (a.updatedAt ?? a.at) - (b.updatedAt ?? b.at))
        .slice(0, nodes.length - MAX_FACTS)
        .map((n) => n.id),
    );
    nodes = nodes.filter((n) => !evict.has(n.id)).map((n) => (n.links?.some((l) => evict.has(l)) ? { ...n, links: n.links.filter((l) => !evict.has(l)) } : n));
  }
  return { nodes };
}

// ---- cards as nodes -----------------------------------------------------------

function lastActivity(card: Card): number {
  return Math.max(0, ...(card.comments ?? []).map((c) => c.at));
}

function cardNode(card: Card, columnName: string, archivedAt?: number): MemoryNode {
  const comments = card.comments ?? [];
  const last = comments[comments.length - 1];
  const clip = (t: string, max: number) => (t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t);
  const body = [
    clip(flatten(card.description ?? ""), CARD_DESC_MAX),
    last ? clip(flatten(`${last.author}: ${last.text}`), CARD_OUTCOME_MAX) : "",
  ].filter(Boolean).join("\n");
  const tags = cleanTags([columnName, ...(archivedAt !== undefined ? ["archived"] : [])]);
  const links = cleanLinks([
    card.repo ? `repo:${card.repo}` : "",
    card.assignee?.name ? `person:${card.assignee.name}` : "",
    ...(card.touches ?? []).map((p) => `file:${p}`),
  ]);
  return {
    id: `card:${card.id}`,
    kind: "card",
    title: card.title,
    ...(body ? { body } : {}),
    ...(tags.length ? { tags } : {}),
    links,
    ...(card.assignee?.name ? { by: card.assignee.name } : {}),
    at: Math.max(lastActivity(card), archivedAt ?? 0),
  };
}

/** Every card on the board and in the archive, as nodes. A card in both
 *  (a restore cut short) is the board's. */
export function cardNodes(board: Board, archive: Archive): MemoryNode[] {
  const colName = new Map(board.columns.map((c) => [c.id, c.name]));
  const live = new Set(board.cards.map((k) => k.id));
  return [
    ...board.cards.map((k) => cardNode(k, colName.get(k.columnId) ?? k.columnId)),
    ...archive.cards.filter((k) => !live.has(k.id)).map((k) => cardNode(k, colName.get(k.columnId) ?? k.columnId, k.archivedAt)),
  ];
}

/** What search runs over: the stored facts plus every card, old ones compacted. */
export function memoryView(memory: Memory, board: Board, archive: Archive, now: number): MemoryNode[] {
  return [...memory.nodes, ...cardNodes(board, archive).map((n) => compactNode(n, now))];
}

// ---- graph and search -----------------------------------------------------------

/** Hubs too broad to relate two nodes by themselves: everything in a repo, or
 *  everything one person did, is not "related". Files and cards are. */
const isBroadHub = (l: string) => l.startsWith("repo:") || l.startsWith("person:");

/** The nodes one step from `id`: those it links to, those linking to it, and
 *  those sharing a file or card link with it. */
export function neighbours(view: MemoryNode[], id: string): MemoryNode[] {
  const self = view.find((n) => n.id === id);
  const mine = new Set((self?.links ?? []).filter((l) => !isBroadHub(l)));
  return view.filter((n) => n.id !== id && (
    mine.has(n.id) || n.links?.includes(id) || (n.links ?? []).some((l) => mine.has(l))
  ));
}

export type SearchOpts = { limit?: number; now?: number };

const FILTER_RE = /^(kind|repo|file|person|tag|card|near|since):(.+)$/i;

/** Keyword search over a view. Words must all appear (title, body, tags or
 *  links; case-insensitive); a title hit counts most. Filters narrow first:
 *    kind:decision,gotcha   repo:agent-smith   file:src/lib (a prefix)
 *    person:VASQUEZ (assignee or author)   tag:ui   card:card_1a2b
 *    near:<node id> (graph neighbours)   since:14d (touched in the last 14 days)
 *  No words: everything the filters keep, newest first. */
export function searchMemory(view: MemoryNode[], query: string, opts: SearchOpts = {}): MemoryNode[] {
  const limit = opts.limit ?? 20;
  const now = opts.now ?? Date.now();
  const words: string[] = [];
  let nodes = view;
  for (const tok of query.trim().split(/\s+/).filter(Boolean)) {
    const f = FILTER_RE.exec(tok);
    if (!f) { words.push(tok.toLowerCase()); continue; }
    const key = f[1]!.toLowerCase();
    const val = f[2]!;
    if (key === "kind") {
      const kinds = new Set(val.toLowerCase().split(","));
      nodes = nodes.filter((n) => kinds.has(n.kind));
    } else if (key === "tag") {
      const t = val.toLowerCase();
      nodes = nodes.filter((n) => n.tags?.includes(t));
    } else if (key === "near") {
      const near = new Set(neighbours(view, val).map((n) => n.id));
      nodes = nodes.filter((n) => near.has(n.id));
    } else if (key === "since") {
      const days = Number.parseFloat(val);
      if (Number.isFinite(days)) nodes = nodes.filter((n) => (n.updatedAt ?? n.at) >= now - days * 86_400_000);
    } else {
      const ref = normalizeLink(`${key}:${val}`);
      if (!ref) return [];
      nodes = nodes.filter((n) =>
        n.id === ref ||
        (n.links ?? []).some((l) => l === ref || (key === "file" && l.startsWith(ref.replace(/\/+$/, "") + "/"))) ||
        (key === "person" && n.by?.toUpperCase() === ref.slice("person:".length)));
    }
  }
  const recent = (a: MemoryNode, b: MemoryNode) => (b.updatedAt ?? b.at) - (a.updatedAt ?? a.at);
  if (!words.length) return [...nodes].sort(recent).slice(0, limit);

  const scored: { n: MemoryNode; score: number }[] = [];
  for (const n of nodes) {
    const title = n.title.toLowerCase();
    const body = (n.body ?? "").toLowerCase();
    const tags = (n.tags ?? []).join(" ");
    const links = (n.links ?? []).join(" ").toLowerCase();
    let score = 0;
    for (const w of words) {
      const s = (title.includes(w) ? 3 : 0) + (tags.includes(w) ? 2 : 0) + (links.includes(w) ? 1 : 0) + (body.includes(w) ? 1 : 0);
      if (!s) { score = 0; break; }
      score += s;
    }
    if (score) scored.push({ n, score });
  }
  return scored.sort((a, b) => b.score - a.score || recent(a.n, b.n)).slice(0, limit).map((s) => s.n);
}

/** Results as a compact text digest, what the MCP tool hands an agent. */
export function formatResults(nodes: MemoryNode[]): string {
  if (!nodes.length) return "Nothing in memory matches that.";
  return nodes.map((n) => {
    const day = n.at ? new Date(n.updatedAt ?? n.at).toISOString().slice(0, 10) : "----------";
    const head = [n.id, n.kind, day, n.by ? `by ${n.by}` : "", n.title].filter(Boolean).join("  ");
    const out = [head];
    if (n.body) out.push(`    ${n.body.replace(/\n/g, "\n    ")}${n.compact ? " [compacted]" : ""}`);
    if (n.tags?.length) out.push(`    tags: ${n.tags.join(", ")}`);
    if (n.links?.length) out.push(`    links: ${n.links.join(", ")}`);
    return out.join("\n");
  }).join("\n");
}

// ---- repair and disk ------------------------------------------------------------

/** Repair arbitrary input into a Memory. Unusable nodes and repeated ids are
 *  dropped rather than failing the read. Only facts are stored; a stray card
 *  node is dropped too (cards come from the board). */
export function sanitizeMemory(input: unknown): Memory {
  if (!input || typeof input !== "object" || Array.isArray(input)) return emptyMemory();
  const raw = (input as { nodes?: unknown }).nodes;
  if (!Array.isArray(raw)) return emptyMemory();
  const seen = new Set<string>();
  const nodes: MemoryNode[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    if (typeof o.id !== "string" || !MEM_ID_RE.test(o.id) || seen.has(o.id)) continue;
    if (!isFactKind(o.kind)) continue;
    const title = typeof o.title === "string" ? flatten(o.title).slice(0, TITLE_MAX) : "";
    if (!title) continue;
    seen.add(o.id);
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
    const tags = cleanTags(o.tags);
    const node: MemoryNode = { id: o.id, kind: o.kind, title, links: cleanLinks(o.links), at: num(o.at) ?? 0 };
    if (typeof o.body === "string" && o.body.trim()) node.body = o.body.slice(0, BODY_MAX);
    if (tags.length) node.tags = tags;
    if (typeof o.by === "string" && o.by.trim()) node.by = o.by.trim();
    if (num(o.updatedAt) !== undefined) node.updatedAt = num(o.updatedAt);
    if (o.compact === true) node.compact = true;
    nodes.push(node);
  }
  return { nodes };
}

export function memoryFile(dir: string): string {
  return join(dir, ".line-memory.json");
}

export function readMemory(dir: string): Memory {
  try {
    return sanitizeMemory(JSON.parse(readFileSync(memoryFile(dir), "utf8")));
  } catch {
    return emptyMemory(); // missing or corrupt
  }
}

/** The memory as a writer must read it: empty when there is no file yet, but
 *  null when the file is there and can't be parsed — readMemory's forgiving
 *  empty would let the next write erase everything in it. */
export function loadMemoryForWrite(dir: string): Memory | null {
  let text: string;
  try {
    text = readFileSync(memoryFile(dir), "utf8");
  } catch (e) {
    return (e as { code?: string }).code === "ENOENT" ? emptyMemory() : null;
  }
  try { return sanitizeMemory(JSON.parse(text)); } catch { return null; }
}

/** Write atomically (temp file + rename), so a kill mid-write leaves the old
 *  file whole rather than a truncated one. */
export function writeMemory(dir: string, memory: Memory): void {
  const clean = sanitizeMemory(memory);
  const tmp = `${memoryFile(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: VERSION, ...clean }));
  renameSync(tmp, memoryFile(dir));
}
