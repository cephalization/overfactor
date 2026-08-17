export function buildContinuationPrompt(draft: string, paths: readonly string[]): string {
  const body = draft.trim();
  if (paths.length === 0) return body;
  const fileBlock = `File paths:\n${paths.map((path) => `- ${path}`).join("\n")}`;
  return body === "" ? fileBlock : `${body}\n\n${fileBlock}`;
}
