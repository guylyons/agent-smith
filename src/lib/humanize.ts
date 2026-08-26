function base(p: unknown): string {
  return typeof p === "string" ? p.split("/").pop() || p : "";
}

export function humanizeTool(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  switch (name) {
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return i.file_path ? `editing ${base(i.file_path)}` : name.toLowerCase();
    case "Read":
      return i.file_path ? `reading ${base(i.file_path)}` : name.toLowerCase();
    case "Bash":
      return typeof i.command === "string" ? `running ${i.command}` : name.toLowerCase();
    default:
      return name.toLowerCase();
  }
}
