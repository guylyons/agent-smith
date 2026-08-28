// Images attached to a ticket. A card's description and its comments are plain
// markdown text stored in `.line.json`, so an attached image is just an
// `![name](path)` token inside that text — nothing new on the board schema, and
// an agent reading the card sees a real file path it can open. The browser can't
// load that path, so the markdown renderer maps it to /uploads (see imageSrc).
//
// Pure string helpers, unit-tested without a DOM.

/** One `![alt](src)` token found in a block of markdown. */
export type CardImage = { token: string; alt: string; src: string };

const IMG_RE = /!\[([^\]]*)\]\(([^)]*)\)/g;

/** Every image token in `text`, in order. */
export function imagesIn(text: string): CardImage[] {
  const out: CardImage[] = [];
  for (const m of text.matchAll(IMG_RE)) {
    out.push({ token: m[0], alt: m[1] ?? "", src: (m[2] ?? "").trim() });
  }
  return out;
}

/** The markdown for one uploaded image. The alt is the original filename, so a
 *  card still reads sensibly as plain text; the src is the absolute path. */
export function imageMarkdown(name: string, path: string): string {
  // ']' and ')' would end the token early and corrupt the rest of the card.
  const alt = (name || "image").replace(/[\]\[()]/g, "");
  return `![${alt}](${path})`;
}

/** Append an image on its own line at the end of `text`, keeping a blank line
 *  between prose and the attachments so the card stays readable as source. */
export function appendImage(text: string, markdown: string): string {
  if (!text.trim()) return markdown;
  return text.replace(/\s+$/, "") + "\n\n" + markdown;
}

/** Remove one image token, collapsing the whitespace it leaves behind so the
 *  text doesn't accumulate blank lines as attachments come and go. */
export function removeImage(text: string, token: string): string {
  const at = text.indexOf(token);
  if (at === -1) return text;
  const out = text.slice(0, at) + text.slice(at + token.length);
  return out.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}
