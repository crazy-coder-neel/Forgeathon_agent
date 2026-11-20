// Size budgets for everything that can enter the model's context window.
export const BUDGET = {
  /** Max chars returned by any single MCP tool call. */
  toolResult: 8000,
  /** Default number of lines read_file returns when no range is given. */
  readLines: 200,
  /** Max chars for the whole repo_map result. */
  repoMap: 8000,
  /** Per @mention cap, and the cap for all mentions in one turn. */
  mentionEach: 6000,
  mentionTotal: 20000,
  /** Max search hits returned. */
  searchHits: 40,
  /** Command output kept (tail), and command timeout. */
  commandOutput: 6000,
  commandTimeoutMs: 120_000,
};

export function cap(text: string, max: number = BUDGET.toolResult, hint = 'narrow your request (line range, path, or a more specific query)'): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const cut = head.lastIndexOf('\n');
  const kept = cut > max * 0.6 ? head.slice(0, cut) : head;
  return `${kept}\n... [truncated: ${text.length - kept.length} more chars; ${hint}]`;
}

export function capTail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `[... ${text.length - max} earlier chars omitted ...]\n${text.slice(text.length - max)}`;
}
