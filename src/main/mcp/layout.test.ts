import { describe, expect, it } from 'vitest'

import { buildPageLayout, type CaptureResult, type Viewport } from './layout'

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
