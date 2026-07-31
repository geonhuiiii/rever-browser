import { describe, expect, it } from 'vitest'

import type { NodeLayout, PageLayout } from './layout'
import { describeOffscreen, tallyFiltered, type AXNode } from './snapshot'

const VIEWPORT = { x: 0, y: 0, width: 1000, height: 800 }

function lay(partial: Partial<NodeLayout> & Pick<NodeLayout, 'y'>): NodeLayout {
  return {
    x: 0,
    width: 200,
    height: 40,
    paintOrder: 1,
    rendered: true,
    zeroSize: false,
    scrollableBy: 0,
    inViewport: false,
    occluded: false,
    clickable: false,
    nodeIndex: 0,
    ...partial
  }
}

function pageLayout(entries: Array<[number, NodeLayout]>): PageLayout {
  return { byBackendId: new Map(entries), viewport: VIEWPORT, clickScanned: 0, clickMatched: 0 }
}

/** Minimal actionable AX node. */
function link(nodeId: string, backendDOMNodeId: number, childIds: string[] = []): AXNode {
  return { nodeId, backendDOMNodeId, role: { type: 'role', value: 'link' }, childIds }
}

/** Non-actionable container — the shape that used to swallow the tally. */
function container(nodeId: string, backendDOMNodeId: number, childIds: string[]): AXNode {
  return { nodeId, backendDOMNodeId, role: { type: 'role', value: 'LayoutTable' }, childIds }
}

describe('tallyFiltered', () => {
  it('잘려나간 컨테이너 밑의 조작 가능 요소도 전부 집계한다', () => {
    // The Hacker News shape: one off-screen container holding many off-screen
    // links. The tree walk prunes at the container and never visits the links,
    // so the tally must not depend on traversal.
    const nodes: AXNode[] = [
      container('c1', 100, ['l1', 'l2', 'l3']),
      link('l1', 1),
      link('l2', 2),
      link('l3', 3)
    ]
    const layout = pageLayout([
      [100, lay({ y: 2000, height: 900 })],
      [1, lay({ y: 2000 })],
      [2, lay({ y: 2100 })],
      [3, lay({ y: 2200 })]
    ])

    const t = tallyFiltered(nodes, layout)

    expect(t.below).toBe(3)
    expect(t.nearestBelow).toBe(1200)
  })

  it('가장 가까운 화면 밖 요소까지의 스크롤 거리를 보고한다', () => {
    const nodes = [link('l1', 1), link('l2', 2)]
    const layout = pageLayout([
      [1, lay({ y: 3000 })],
      [2, lay({ y: 900 })]
    ])

    expect(tallyFiltered(nodes, layout).nearestBelow).toBe(100)
  })

  it('뷰포트 안 요소는 집계하지 않는다', () => {
    const nodes = [link('l1', 1)]
    const layout = pageLayout([[1, lay({ y: 100, inViewport: true })]])

    const t = tallyFiltered(nodes, layout)

    expect(t.below + t.above + t.side).toBe(0)
    expect(t.hidden).toBe(0)
  })

  it('숨김/가려진 요소는 hidden으로 분류한다', () => {
    const nodes = [link('l1', 1), link('l2', 2)]
    const layout = pageLayout([
      [1, lay({ y: 100, rendered: false })],
      [2, lay({ y: 100, occluded: true })]
    ])

    expect(tallyFiltered(nodes, layout).hidden).toBe(2)
  })

  it('위쪽으로 벗어난 요소는 above로 분류한다', () => {
    const scrolled: PageLayout = {
      byBackendId: new Map([[1, lay({ y: 100 })]]),
      viewport: { x: 0, y: 2000, width: 1000, height: 800 },
      clickScanned: 0,
      clickMatched: 0
    }

    const t = tallyFiltered([link('l1', 1)], scrolled)

    expect(t.above).toBe(1)
    expect(t.nearestAbove).toBe(1860)
  })

  it('조작 불가능한 노드는 집계에서 제외한다', () => {
    const nodes = [container('c1', 100, [])]
    const layout = pageLayout([[100, lay({ y: 3000 })]])

    const t = tallyFiltered(nodes, layout)

    expect(t.below + t.above + t.side + t.hidden).toBe(0)
  })

  it('레이아웃 정보가 없는 노드는 건너뛴다', () => {
    const t = tallyFiltered([link('l1', 999)], pageLayout([[1, lay({ y: 3000 })]]))

    expect(t.below + t.above + t.side + t.hidden).toBe(0)
  })
})

describe('describeOffscreen', () => {
  it('아래쪽 요소 개수와 스크롤 거리를 힌트로 만든다', () => {
    const hints = describeOffscreen({
      hidden: 0,
      below: 90,
      above: 0,
      side: 0,
      nearestBelow: 1200,
      nearestAbove: Infinity
    })

    expect(hints).toEqual(['- [90 more actionable element(s) below the fold — nearest ~1200px down]'])
  })

  it('벗어난 요소가 없으면 힌트를 만들지 않는다', () => {
    const hints = describeOffscreen({
      hidden: 3,
      below: 0,
      above: 0,
      side: 0,
      nearestBelow: Infinity,
      nearestAbove: Infinity
    })

    expect(hints).toEqual([])
  })
})

describe('안전밸브 발동 조건', () => {
  // The overlay case: a full-screen modal legitimately covers every actionable
  // element, so refs hit 0. Falling back to the unfiltered tree there discards
  // a correct result and turns the filter off exactly when it matters most.
  it('전부 가려져서 ref가 0이면 tally가 그 이유를 설명하므로 밸브는 발동하지 않아야 한다', () => {
    const nodes = [link('l1', 1), link('l2', 2)]
    const layout = pageLayout([
      [1, lay({ y: 100, occluded: true })],
      [2, lay({ y: 100, occluded: true })]
    ])

    const t = tallyFiltered(nodes, layout)
    const explained = t.hidden > 0 || t.below + t.above + t.side > 0

    expect(t.hidden).toBe(2)
    expect(explained).toBe(true)
  })

  it('설명되지 않는 0건이면 밸브가 발동해야 한다 (좌표 불일치)', () => {
    // No layout entries correlate, so nothing is attributed — the shape a real
    // coordinate mismatch produces.
    const t = tallyFiltered([link('l1', 999)], pageLayout([[1, lay({ y: 100 })]]))
    const explained = t.hidden > 0 || t.below + t.above + t.side > 0

    expect(explained).toBe(false)
  })
})
