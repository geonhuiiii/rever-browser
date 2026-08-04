import { describe, it, expect } from 'vitest'

import { capToolsForOpenAI, OPENAI_MAX_TOOLS, OPENAI_DROP_ORDER } from './openai-tool-cap'

const tool = (name: string) => ({ type: 'function' as const, function: { name } })

describe('capToolsForOpenAI', () => {
  it('leaves a list at or under the cap untouched', () => {
    const tools = Array.from({ length: OPENAI_MAX_TOOLS }, (_, i) => tool(`t${i}`))
    const r = capToolsForOpenAI(tools)
    expect(r.tools).toHaveLength(OPENAI_MAX_TOOLS)
    expect(r.dropped).toEqual([])
  })

  it('drops denylist tools first, in order, only as many as needed (138 -> 128)', () => {
    const names = [
      ...OPENAI_DROP_ORDER.slice(0, 10),
      ...Array.from({ length: 128 }, (_, i) => `keep${i}`)
    ]
    expect(names).toHaveLength(138)
    const r = capToolsForOpenAI(names.map(tool))
    expect(r.tools).toHaveLength(128)
    expect(r.dropped).toEqual(OPENAI_DROP_ORDER.slice(0, 10))
    expect(r.tools.every((t) => !r.dropped.includes(t.function.name))).toBe(true)
  })

  it('ignores denylist names that are not present', () => {
    // 129 tools, only one denylist name present -> that one drops, list fits.
    const names = ['bp_add', ...Array.from({ length: 128 }, (_, i) => `keep${i}`)]
    const r = capToolsForOpenAI(names.map(tool))
    expect(r.tools).toHaveLength(128)
    expect(r.dropped).toEqual(['bp_add'])
  })

  it('falls back to dropping from the tail when the denylist is exhausted', () => {
    const names = Array.from({ length: 130 }, (_, i) => `x${i}`)
    const r = capToolsForOpenAI(names.map(tool))
    expect(r.tools).toHaveLength(128)
    expect(r.dropped).toEqual(['x128', 'x129'])
  })
})
