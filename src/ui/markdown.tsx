import type { ReactNode } from "react";

// Small, dependency-free markdown renderer for chat message text.
// Never uses dangerouslySetInnerHTML — builds React elements directly from
// untrusted text. Unknown/unsupported syntax simply falls through as plain
// text rather than throwing.
//
// Supported:
//  - fenced code blocks: ```lang\n...\n```
//  - inline `code`
//  - **bold** and *italic*
//  - unordered (-, *) and ordered (1.) list lines
//  - GitHub-style tables: | a | b | with a |---|---| separator row
//  - blank-line separated paragraphs, with single newlines preserved as <br/>

let keySeed = 0;
function nextKey(): string {
  keySeed += 1;
  return `md${keySeed}`;
}

/** Render inline markdown (bold/italic/code) within a single line of text. */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Matches, in priority order: inline code, bold (**x** or __x__), italic (*x* or _x_)
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const chunk = m[0];
    if (chunk.startsWith("`")) {
      out.push(<code key={nextKey()}>{chunk.slice(1, -1)}</code>);
    } else if (chunk.startsWith("**") || chunk.startsWith("__")) {
      out.push(<strong key={nextKey()}>{renderInline(chunk.slice(2, -2))}</strong>);
    } else {
      out.push(<em key={nextKey()}>{renderInline(chunk.slice(1, -1))}</em>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("|") && !t.includes("|")) return false;
  const cells = splitTableRow(t);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-{3,}:?$/.test(c.trim()) || /^:?-+:?$/.test(c.trim()));
}

function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|");
}

function renderTable(lines: string[]): ReactNode {
  const header = splitTableRow(lines[0]!).map((c) => c.trim());
  const rows = lines.slice(2).map((l) => splitTableRow(l).map((c) => c.trim()));
  return (
    <div className="md-table-wrap" key={nextKey()}>
      <table>
        <thead>
          <tr>
            {header.map((c) => (
              <th key={nextKey()}>{renderInline(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={nextKey()}>
              {row.map((c) => (
                <td key={nextKey()}>{renderInline(c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isListLine(line: string): boolean {
  return /^\s*([-*+]|\d+\.)\s+/.test(line);
}

function renderListBlock(lines: string[]): ReactNode {
  const ordered = /^\s*\d+\.\s+/.test(lines[0] ?? "");
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag className="md-list" key={nextKey()}>
      {lines.map((line) => {
        const content = line.replace(/^\s*([-*+]|\d+\.)\s+/, "");
        return <li key={nextKey()}>{renderInline(content)}</li>;
      })}
    </Tag>
  );
}

function renderParagraph(lines: string[]): ReactNode {
  const nodes: ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) nodes.push(<br key={nextKey()} />);
    nodes.push(...renderInline(line));
  });
  return <p key={nextKey()}>{nodes}</p>;
}

export function renderMarkdown(text: string): ReactNode {
  if (!text) return text;
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Blank line: skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block
    const fenceMatch = /^```(\S*)\s*$/.exec(line.trim());
    if (fenceMatch) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.trim() !== "```") {
        codeLines.push(lines[i]!);
        i++;
      }
      // consume closing fence if present
      if (i < lines.length) i++;
      blocks.push(
        <pre key={nextKey()} className="md-code">
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Table: current line + next line looks like a separator
    if (i + 1 < lines.length && line.includes("|") && isTableSeparator(lines[i + 1]!)) {
      const tableLines = [line, lines[i + 1]!];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        tableLines.push(lines[i]!);
        i++;
      }
      blocks.push(renderTable(tableLines));
      continue;
    }

    // List block
    if (isListLine(line)) {
      const listLines: string[] = [];
      while (i < lines.length && isListLine(lines[i]!)) {
        listLines.push(lines[i]!);
        i++;
      }
      blocks.push(renderListBlock(listLines));
      continue;
    }

    // Paragraph: consume until blank line or a line starting a new block
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !isListLine(lines[i]!) &&
      !/^```/.test(lines[i]!.trim()) &&
      !(i + 1 < lines.length && lines[i]!.includes("|") && isTableSeparator(lines[i + 1]!))
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push(renderParagraph(paraLines));
    }
  }

  return <>{blocks}</>;
}
