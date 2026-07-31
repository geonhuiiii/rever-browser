import { describe, expect, it } from 'vitest'

import { buildElementPaths, buildPageLayout, type CaptureResult, type Viewport } from './layout'

const VIEWPORT: Viewport = { x: 0, y: 0, width: 1000, height: 800 }

/** Index into the shared string table used by every fixture below. */
const STRINGS = ['visible', 'hidden', '1', '0', 'collapse']
const S_VISIBLE = 0
const S_HIDDEN = 1
const S_OPACITY_1 = 2
const S_OPACITY_0 = 3

interface NodeSpec {
  backendNodeId: number
  bounds: [number, number, number, number]
  paintOrder?: number
  visibility?: number
  opacity?: number
}

/** Build a captureSnapshot-shaped payload from a compact node list. */
function snapshot(specs: NodeSpec[]): CaptureResult {
  return {
    strings: STRINGS,
    documents: [
      {
        nodes: { backendNodeId: specs.map((s) => s.backendNodeId) },
        layout: {
          nodeIndex: specs.map((_, i) => i),
          bounds: specs.map((s) => s.bounds),
          styles: specs.map((s) => [s.visibility ?? S_VISIBLE, s.opacity ?? S_OPACITY_1]),
          paintOrders: specs.map((s, i) => s.paintOrder ?? i)
        }
      }
    ]
  }
}

describe('buildPageLayout', () => {
  describe('index correlation', () => {
    it('맵의 키를 nodeIndex가 가리키는 backendNodeId로 잡는다', () => {
      // nodeIndex is deliberately out of order: layout row 0 describes node 2.
      const snap: CaptureResult = {
        strings: STRINGS,
        documents: [
          {
            nodes: { backendNodeId: [10, 20, 30] },
            layout: {
              nodeIndex: [2, 0],
              bounds: [
                [5, 5, 50, 50],
                [100, 100, 20, 20]
              ],
              styles: [
                [S_VISIBLE, S_OPACITY_1],
                [S_VISIBLE, S_OPACITY_1]
              ],
              paintOrders: [1, 2]
            }
          }
        ]
      }

      const layout = buildPageLayout(snap, VIEWPORT)

      expect(layout?.byBackendId.get(30)?.x).toBe(5)
      expect(layout?.byBackendId.get(10)?.x).toBe(100)
      expect(layout?.byBackendId.has(20)).toBe(false)
    })

    it('레이아웃 항목이 하나도 없으면 null을 반환한다', () => {
      const empty: CaptureResult = {
        strings: STRINGS,
        documents: [{ nodes: { backendNodeId: [] }, layout: { nodeIndex: [], bounds: [], styles: [] } }]
      }

      expect(buildPageLayout(empty, VIEWPORT)).toBeNull()
    })
  })

  describe('rendered 판정', () => {
    it('visibility:hidden이면 rendered=false로 표시한다', () => {
      const layout = buildPageLayout(
        snapshot([{ backendNodeId: 1, bounds: [0, 0, 100, 100], visibility: S_HIDDEN }]),
        VIEWPORT
      )

      expect(layout?.byBackendId.get(1)?.rendered).toBe(false)
    })

    it('opacity:0이면 rendered=false로 표시한다', () => {
      const layout = buildPageLayout(
        snapshot([{ backendNodeId: 1, bounds: [0, 0, 100, 100], opacity: S_OPACITY_0 }]),
        VIEWPORT
      )

      expect(layout?.byBackendId.get(1)?.rendered).toBe(false)
    })

    it('크기가 0인 박스는 rendered=false로 표시한다', () => {
      const layout = buildPageLayout(
        snapshot([{ backendNodeId: 1, bounds: [10, 10, 0, 0] }]),
        VIEWPORT
      )

      expect(layout?.byBackendId.get(1)?.rendered).toBe(false)
    })

    it('보이는 박스는 rendered=true로 표시한다', () => {
      const layout = buildPageLayout(
        snapshot([{ backendNodeId: 1, bounds: [10, 10, 100, 40] }]),
        VIEWPORT
      )

      expect(layout?.byBackendId.get(1)?.rendered).toBe(true)
    })
  })

  describe('뷰포트 교차', () => {
    it('뷰포트 안 박스는 inViewport=true다', () => {
      const layout = buildPageLayout(
        snapshot([{ backendNodeId: 1, bounds: [10, 10, 100, 40] }]),
        VIEWPORT
      )

      expect(layout?.byBackendId.get(1)?.inViewport).toBe(true)
    })

    it('스크롤 아래쪽 박스는 inViewport=false다', () => {
      const layout = buildPageLayout(
        snapshot([{ backendNodeId: 1, bounds: [10, 5000, 100, 40] }]),
        VIEWPORT
      )

      expect(layout?.byBackendId.get(1)?.inViewport).toBe(false)
    })

    it('스크롤된 뷰포트를 문서 좌표 기준으로 판정한다', () => {
      const scrolled: Viewport = { x: 0, y: 4000, width: 1000, height: 800 }
      const layout = buildPageLayout(
        snapshot([
          { backendNodeId: 1, bounds: [10, 4100, 100, 40] },
          { backendNodeId: 2, bounds: [10, 10, 100, 40] }
        ]),
        scrolled
      )

      expect(layout?.byBackendId.get(1)?.inViewport).toBe(true)
      expect(layout?.byBackendId.get(2)?.inViewport).toBe(false)
    })

    it('경계에 걸친 박스는 inViewport=true다', () => {
      const layout = buildPageLayout(
        snapshot([{ backendNodeId: 1, bounds: [10, 780, 100, 100] }]),
        VIEWPORT
      )

      expect(layout?.byBackendId.get(1)?.inViewport).toBe(true)
    })
  })

  describe('페인트 순서 가려짐 판정', () => {
    it('나중에 그려진 전체 화면 오버레이가 덮은 박스를 occluded로 표시한다', () => {
      const layout = buildPageLayout(
        snapshot([
          { backendNodeId: 1, bounds: [100, 100, 200, 50], paintOrder: 1 },
          { backendNodeId: 2, bounds: [0, 0, 1000, 800], paintOrder: 9 }
        ]),
        VIEWPORT
      )

      expect(layout?.byBackendId.get(1)?.occluded).toBe(true)
    })

    it('오버레이보다 나중에 그려진 모달 내용은 occluded가 아니다', () => {
      const layout = buildPageLayout(
        snapshot([
          { backendNodeId: 1, bounds: [0, 0, 1000, 800], paintOrder: 5 }, // overlay
          { backendNodeId: 2, bounds: [300, 300, 200, 60], paintOrder: 9 } // modal button
        ]),
        VIEWPORT
      )

      expect(layout?.byBackendId.get(2)?.occluded).toBe(false)
    })

    it('먼저 그려진 조상 컨테이너는 자식을 가리지 않는다', () => {
      const layout = buildPageLayout(
        snapshot([
          { backendNodeId: 1, bounds: [0, 0, 1000, 800], paintOrder: 1 }, // ancestor
          { backendNodeId: 2, bounds: [100, 100, 200, 50], paintOrder: 4 } // child
        ]),
        VIEWPORT
      )

      expect(layout?.byBackendId.get(2)?.occluded).toBe(false)
    })

    it('뷰포트의 25% 미만인 작은 박스는 가리개로 치지 않는다', () => {
      const layout = buildPageLayout(
        snapshot([
          { backendNodeId: 1, bounds: [100, 100, 50, 20], paintOrder: 1 },
          { backendNodeId: 2, bounds: [90, 90, 200, 100], paintOrder: 9 }
        ]),
        VIEWPORT
      )

      expect(layout?.byBackendId.get(1)?.occluded).toBe(false)
    })

    it('오버레이가 완전히 감싸지 않으면 occluded가 아니다', () => {
      const layout = buildPageLayout(
        snapshot([
          { backendNodeId: 1, bounds: [900, 100, 200, 50], paintOrder: 1 },
          { backendNodeId: 2, bounds: [0, 0, 1000, 800], paintOrder: 9 }
        ]),
        VIEWPORT
      )

      expect(layout?.byBackendId.get(1)?.occluded).toBe(false)
    })
  })
})

/**
 * <html>                     idx 1  path ''
 *   <body>                   idx 2  path '0'
 *     <div id=a>             idx 3  path '0.0'
 *       <span id=a1>         idx 4  path '0.0.0'
 *     <div id=b>             idx 5  path '0.1'
 * Node 0 is the document itself (nodeType 9).
 */
const TREE: CaptureResult = {
  strings: STRINGS,
  documents: [
    {
      nodes: {
        backendNodeId: [900, 901, 902, 903, 904, 905],
        parentIndex: [-1, 0, 1, 2, 3, 2],
        nodeType: [9, 1, 1, 1, 1, 1]
      },
      layout: {
        nodeIndex: [3, 4, 5],
        bounds: [
          [0, 0, 300, 100],
          [10, 10, 80, 20],
          [0, 200, 300, 100]
        ],
        styles: [
          [S_VISIBLE, S_OPACITY_1],
          [S_VISIBLE, S_OPACITY_1],
          [S_VISIBLE, S_OPACITY_1]
        ],
        paintOrders: [1, 2, 3]
      }
    }
  ]
}

describe('buildElementPaths', () => {
  it('요소 자식 인덱스 경로를 backendNodeId에 매핑한다', () => {
    const byPath = buildElementPaths(TREE.documents[0])

    expect(byPath.get('0')).toBe(902) // body
    expect(byPath.get('0.0')).toBe(903) // div#a
    expect(byPath.get('0.0.0')).toBe(904) // span#a1
    expect(byPath.get('0.1')).toBe(905) // div#b
  })

  it('documentElement 자신은 경로를 갖지 않는다', () => {
    expect(buildElementPaths(TREE.documents[0]).has('')).toBe(false)
  })

  it('노드 트리 정보가 없으면 빈 맵을 반환한다', () => {
    const bare = { nodes: { backendNodeId: [1] }, layout: TREE.documents[0].layout }
    expect(buildElementPaths(bare).size).toBe(0)
  })
})

describe('클릭 스캔 경로 매칭', () => {
  it('경로가 일치하는 노드에만 clickable=true를 붙인다', () => {
    const layout = buildPageLayout(TREE, VIEWPORT, new Set(['0.0']))

    expect(layout?.byBackendId.get(903)?.clickable).toBe(true)
    expect(layout?.byBackendId.get(904)?.clickable).toBe(false)
    expect(layout?.byBackendId.get(905)?.clickable).toBe(false)
    expect(layout?.clickMatched).toBe(1)
  })

  it('좌표가 어긋나도 경로 매칭은 영향받지 않는다', () => {
    // Bounds here are deliberately nothing like a viewport-relative rect; the
    // geometry-keyed version scored 0 correlated on exactly this mismatch.
    const scaled: CaptureResult = {
      ...TREE,
      documents: [
        {
          ...TREE.documents[0],
          layout: {
            ...TREE.documents[0].layout,
            bounds: [
              [0, 0, 600, 200],
              [20, 20, 160, 40],
              [0, 400, 600, 200]
            ]
          }
        }
      ]
    }

    const layout = buildPageLayout(scaled, VIEWPORT, new Set(['0.0.0']))

    expect(layout?.byBackendId.get(904)?.clickable).toBe(true)
    expect(layout?.clickMatched).toBe(1)
  })

  it('스캔 결과를 주지 않으면 clickable은 전부 false다', () => {
    const layout = buildPageLayout(TREE, VIEWPORT)

    expect(layout?.byBackendId.get(903)?.clickable).toBe(false)
    expect(layout?.clickMatched).toBe(0)
  })

  it('없는 경로는 무시하고 매칭 수에 세지 않는다', () => {
    const layout = buildPageLayout(TREE, VIEWPORT, new Set(['9.9.9']))

    expect(layout?.clickMatched).toBe(0)
  })
})

describe('위임 루트 억제 (React 형태)', () => {
  // #d-root carries the single delegated listener; #d2 inside it has the
  // pointer cursor. Preferring the OUTER candidate made the delegation root
  // claim the ref and swallow #d2 — on a real React app that collapses the
  // whole application into one ref. The in-page scan now drops any candidate
  // that contains another candidate, so only the inner one survives.
  it('자식 후보를 가진 컨테이너는 경로 목록에서 빠진다', () => {
    // Emulates what the in-page dedup emits: only '0.0.0' (the inner span),
    // never '0.0' (the delegation root that contains it).
    const layout = buildPageLayout(TREE, VIEWPORT, new Set(['0.0.0']))

    expect(layout?.byBackendId.get(904)?.clickable).toBe(true) // inner
    expect(layout?.byBackendId.get(903)?.clickable).toBe(false) // containing root
    expect(layout?.clickMatched).toBe(1)
  })

  it('자식 후보가 없는 컨테이너는 그대로 살아남는다', () => {
    // C1's nested spans never become candidates (cursor inherits), so the
    // outer element is the only hit and must keep its ref.
    const layout = buildPageLayout(TREE, VIEWPORT, new Set(['0.0']))

    expect(layout?.byBackendId.get(903)?.clickable).toBe(true)
    expect(layout?.byBackendId.get(904)?.clickable).toBe(false)
  })
})

/**
 * A page-sized body, a small overflow:auto box inside it, and two children of
 * that box: one inside its visible band, one scrolled past it. The clipped
 * child's own rect is still within the page viewport — which is exactly why
 * comparing against the viewport alone reported it as visible.
 */
const CLIP_TREE: CaptureResult = {
  strings: ['visible', 'hidden', '1', '0', 'auto'],
  documents: [
    {
      nodes: {
        backendNodeId: [900, 901, 902, 903, 904],
        parentIndex: [-1, 0, 1, 2, 2],
        nodeType: [9, 1, 1, 1, 1]
      },
      layout: {
        nodeIndex: [1, 2, 3, 4],
        bounds: [
          [0, 0, 1000, 700], // html
          [0, 100, 400, 90], // scroller, overflow-y:auto
          [10, 110, 200, 30], // child inside the visible band
          [10, 330, 200, 30] // child scrolled past the container's fold
        ],
        styles: [
          [0, 2, -1, -1],
          [0, 2, -1, 4], // overflow-y: auto
          [0, 2, -1, -1],
          [0, 2, -1, -1]
        ],
        paintOrders: [1, 2, 3, 4]
      }
    }
  ]
}

describe('조상 클립 박스', () => {
  it('스크롤 컨테이너 밖으로 잘린 자식은 inViewport=false다', () => {
    const layout = buildPageLayout(CLIP_TREE, VIEWPORT)

    expect(layout?.byBackendId.get(903)?.inViewport).toBe(true) // inside the band
    expect(layout?.byBackendId.get(904)?.inViewport).toBe(false) // clipped out
  })

  it('컨테이너 자신은 뷰포트 안이면 그대로 보인다', () => {
    expect(buildPageLayout(CLIP_TREE, VIEWPORT)?.byBackendId.get(902)?.inViewport).toBe(true)
  })

  it('클리핑 조상이 없으면 판정이 달라지지 않는다', () => {
    const noClip: CaptureResult = {
      ...CLIP_TREE,
      documents: [
        {
          ...CLIP_TREE.documents[0],
          layout: {
            ...CLIP_TREE.documents[0].layout,
            // same geometry, but the container no longer clips
            styles: [
              [0, 2, -1, -1],
              [0, 2, -1, -1],
              [0, 2, -1, -1],
              [0, 2, -1, -1]
            ]
          }
        }
      ]
    }

    expect(buildPageLayout(noClip, VIEWPORT)?.byBackendId.get(904)?.inViewport).toBe(true)
  })
})
