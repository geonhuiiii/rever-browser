// OpenAI's Chat Completions API rejects requests carrying more than 128 tools
// (Anthropic has no such limit). The in-process MCP server exposes more than
// that, so when talking to OpenAI we drop the least-useful tools first — led by
// the bp_* pause family, which is non-functional under Electron's
// webContents.debugger anyway — until the list fits. Claude keeps all tools.

export const OPENAI_MAX_TOOLS = 128

// Ordered "drop first" list. Only as many entries as needed are removed, so the
// list can grow ahead of the tool count without over-trimming.
export const OPENAI_DROP_ORDER: string[] = [
  // Non-functional in this build (execution never pauses) — safe to drop first.
  'bp_add',
  'bp_resume',
  'bp_step_over',
  'bp_step_into',
  'bp_step_out',
  'bp_eval_in_frame',
  // Niche crypto / probe helpers the browser assistant rarely reaches for.
  'magic_hash_lookup',
  'hash_iter',
  'lfi_probe',
  'crlf_test',
  'path_probe',
  'burst_send',
  'dialog_inject_override',
  'dialog_set_auto_dismiss'
]

export interface CapResult<T> {
  tools: T[]
  dropped: string[]
}

// Trim `tools` to at most OPENAI_MAX_TOOLS, removing OPENAI_DROP_ORDER entries
// first (in order) and, only if that isn't enough, dropping from the tail.
export function capToolsForOpenAI<T extends { function: { name: string } }>(
  tools: T[]
): CapResult<T> {
  if (tools.length <= OPENAI_MAX_TOOLS) return { tools, dropped: [] }

  const drop = new Set<string>()
  const present = new Set(tools.map((t) => t.function.name))
  for (const name of OPENAI_DROP_ORDER) {
    if (tools.length - drop.size <= OPENAI_MAX_TOOLS) break
    if (present.has(name)) drop.add(name)
  }

  let kept = tools.filter((t) => !drop.has(t.function.name))
  if (kept.length > OPENAI_MAX_TOOLS) {
    // Denylist exhausted but still over the cap — drop from the tail as a backstop.
    for (const t of kept.slice(OPENAI_MAX_TOOLS)) drop.add(t.function.name)
    kept = kept.slice(0, OPENAI_MAX_TOOLS)
  }

  return { tools: kept, dropped: [...drop] }
}
