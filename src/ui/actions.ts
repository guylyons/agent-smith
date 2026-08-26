// Send a command to the server about a real session.
type Result = { ok: boolean; error?: string };

export type ChatMessage = { role: "user" | "assistant" | "tool"; text: string };

export async function fetchConversation(sessionId: string): Promise<ChatMessage[]> {
  try {
    const res = await fetch(`/conversation?sessionId=${encodeURIComponent(sessionId)}`);
    const body = (await res.json()) as { messages?: ChatMessage[] };
    return body.messages ?? [];
  } catch {
    return [];
  }
}

async function post(action: string, body: object): Promise<Result> {
  try {
    const res = await fetch(`/action/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Result;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function act(action: string, body: object): Promise<void> {
  const r = await post(action, body);
  if (!r.ok) alert(r.error ?? `${action} failed`);
}

export function focusSession(sessionId: string): void {
  void act("focus", { sessionId });
}

export function pauseSession(sessionId: string, name: string): void {
  if (!confirm(`Pause ${name}? This interrupts its current turn (like pressing Esc). It stays open and you can resume by typing in it.`)) return;
  void act("pause", { sessionId });
}

export function renameSession(sessionId: string, current: string): void {
  const name = prompt("Rename this agent:", current);
  if (name === null) return; // cancelled
  void act("rename", { sessionId, name });
}

// Returns whether the prompt was delivered, so the caller can keep the input
// open (and show the error) on failure.
export async function sendPromptTo(sessionId: string, text: string): Promise<boolean> {
  const r = await post("prompt", { sessionId, text });
  if (!r.ok) alert(r.error ?? "could not send");
  return r.ok;
}
