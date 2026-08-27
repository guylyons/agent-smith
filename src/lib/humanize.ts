function base(p: unknown): string {
  return typeof p === "string" ? p.split("/").pop() || p : "";
}

// Collapse whitespace to one line and cap length, so a long shell command
// doesn't blow up the desk card.
function clip(s: string, max = 48): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export function humanizeTool(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  switch (name) {
    case "NotebookEdit":
      // NotebookEdit's path parameter is notebook_path, not file_path.
      return i.notebook_path ? `editing ${base(i.notebook_path)}` : name.toLowerCase();
    case "Edit":
    case "Write":
      return i.file_path ? `editing ${base(i.file_path)}` : name.toLowerCase();
    case "Read":
      return i.file_path ? `reading ${base(i.file_path)}` : name.toLowerCase();
    case "Bash":
      return typeof i.command === "string" ? `running ${clip(i.command)}` : name.toLowerCase();
    default:
      return name.toLowerCase();
  }
}
