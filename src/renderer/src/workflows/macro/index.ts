// M1 — Macro (record & replay, v1: hand-authored + deterministic replay).
// A named sequence of MCP tool calls that runs with no LLM in the loop. The
// Editor doubles as the runner (Run button + per-step results). Self-contained:
// delete this folder + its line in workflows/index.ts to remove the kind.
import { registerWorkflowKind } from '../core/registry'
import { newWorkflowId, type Workflow } from '../core/types'
import { MacroEditor, resolveSteps, type MacroData } from './MacroEditor'

registerWorkflowKind({
  id: 'macro',
  label: 'Macro',
  description: 'A saved sequence of tool calls, replayed deterministically.',
  create: (): Workflow => {
    const now = Date.now()
    return {
      id: newWorkflowId(),
      kind: 'macro',
      name: '',
      data: { steps: [], vars: '' } satisfies MacroData,
      createdAt: now,
      updatedAt: now
    }
  },
  Editor: MacroEditor,
  // One-click replay from the list. Per-step results are only shown in the
  // Editor, so this reports failures and otherwise stays quiet.
  actionLabel: '▶ Run',
  action: async (workflow): Promise<void> => {
    const data = workflow.data as MacroData
    const resolved = resolveSteps(data.steps, data.vars)
    if (!resolved.ok) throw new Error(resolved.error)
    if (resolved.steps.length === 0) throw new Error('No steps to run')
    const results = await window.rev.workflows.run(resolved.steps, () => {})
    const failed = results.find((r) => r.status === 'error')
    if (failed) throw new Error(`Step ${failed.index + 1} (${failed.tool}): ${failed.error}`)
  }
})
