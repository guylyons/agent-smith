export function parseTicket(branch: string | null): string | null {
  if (!branch) return null;
  const m = branch.match(/\d+/);
  return m ? `#${m[0]}` : null;
}
