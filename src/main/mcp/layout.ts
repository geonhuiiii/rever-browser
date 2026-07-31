import { getActiveTarget } from '../chrome-cdp'

/**
 * Layout facts for one DOM node, correlated back to the AX tree by
 * backendNodeId. Sourced from a single `DOMSnapshot.captureSnapshot` call so
 * the whole page costs one round trip, not one per node.
 */
export interface NodeLayout {
  x: number
  y: number
  width: number
  height: number
  paintOrder: number
  /** false when visibility/opacity or a zero-size box means nothing is drawn */
  rendered: boolean
  /** true when the box intersects the current viewport */
  inViewport: boolean
  /** true when a later-painted box fully covers it (modal overlays, drawers) */
  occluded: boolean
}

export interface Viewport {
  x: number
  y: number
  width: number
  height: number
}

export interface PageLayout {
  byBackendId: Map<number, NodeLayout>
  viewport: Viewport
}

/** Requested in this order; `layout.styles[i]` is parallel to it. */
const STYLE_PROPS = ['visibility', 'opacity'] as const

/**
 * A box only counts as an occluder if it covers at least this much of the
 * viewport. Keeps the check on real overlays instead of every wrapper div.
 */
const OCCLUDER_MIN_AREA_RATIO = 0.25

/** Upper bound on the occluder scan so a huge page can't make it quadratic. */
const MAX_OCCLUDERS = 40

export interface DocumentSnapshot {
  nodes: {
    backendNodeId?: number[]
    parentIndex?: number[]
    nodeType?: number[]
  }
  layout: {
    nodeIndex: number[]
    styles: number[][]
    bounds: number[][]
    paintOrders?: number[]
  }
}

export interface CaptureResult {
  documents: DocumentSnapshot[]
  strings: string[]
}

function intersects(a: NodeLayout, v: Viewport): boolean {
  return (
    a.x + a.width > v.x &&
    a.x < v.x + v.width &&
    a.y + a.height > v.y &&
    a.y < v.y + v.height
  )
}

function contains(outer: NodeLayout, inner: NodeLayout): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  )
}

/**
 * Mark every rendered box that a later-painted, viewport-sized box fully
 * covers. Parents paint before their children, so a box that both contains
 * another box AND paints after it is a genuine overlay rather than an
 * ancestor — that is what makes this cheap heuristic safe.
 */
function markOccluded(entries: NodeLayout[], viewport: Viewport): void {
  const minArea = viewport.width * viewport.height * OCCLUDER_MIN_AREA_RATIO
  const occluders = entries
    .filter((e) => e.rendered && e.width * e.height >= minArea)
    .sort((a, b) => b.paintOrder - a.paintOrder)
    .slice(0, MAX_OCCLUDERS)

  if (occluders.length === 0) return

  for (const e of entries) {
    if (!e.rendered) continue
    for (const o of occluders) {
      // Sorted by paint order descending, so once we drop below e's own paint
      // order nothing later in the list can cover it either.
      if (o.paintOrder <= e.paintOrder) break
      if (contains(o, e)) {
        e.occluded = true
        break
      }
    }
  }
}

/**
 * Turn a raw `DOMSnapshot.captureSnapshot` payload into per-node layout facts.
 * Pure so the index correlation and the occlusion heuristic can be tested
 * without a live browser.
 */
export function buildPageLayout(snap: CaptureResult, viewport: Viewport): PageLayout | null {
  const byBackendId = new Map<number, NodeLayout>()
  const entries: NodeLayout[] = []

  for (const doc of snap.documents ?? []) {
    const backendIds = doc.nodes?.backendNodeId
    const layout = doc.layout
    if (!backendIds || !layout?.nodeIndex) continue

    for (let i = 0; i < layout.nodeIndex.length; i++) {
      const backendId = backendIds[layout.nodeIndex[i]]
      if (backendId == null) continue

      const bounds = layout.bounds?.[i]
      if (!bounds || bounds.length < 4) continue
      const [x, y, width, height] = bounds

      const styleIdx = layout.styles?.[i] ?? []
      const visibility = styleIdx[0] >= 0 ? snap.strings[styleIdx[0]] : ''
      const opacity = styleIdx[1] >= 0 ? snap.strings[styleIdx[1]] : ''

      const rendered =
        width > 0 &&
        height > 0 &&
        visibility !== 'hidden' &&
        visibility !== 'collapse' &&
        opacity !== '0'

      const entry: NodeLayout = {
        x,
        y,
        width,
        height,
        paintOrder: layout.paintOrders?.[i] ?? 0,
        rendered,
        inViewport: false,
        occluded: false
      }
      entry.inViewport = intersects(entry, viewport)

      // A backendNodeId can appear more than once across documents; the first
      // laid-out box wins, which is the one the user actually sees.
      if (!byBackendId.has(backendId)) byBackendId.set(backendId, entry)
      entries.push(entry)
    }
  }

  if (byBackendId.size === 0) return null

  markOccluded(entries, viewport)
  return { byBackendId, viewport }
}

/**
 * Capture bounds, computed visibility styles and paint order for every laid-out
 * node on the page. Returns null when the page has no layout data or the
 * command is unavailable — callers must treat null as "no filtering possible"
 * rather than as an empty page.
 */
export async function capturePageLayout(viewport: Viewport): Promise<PageLayout | null> {
  const target = getActiveTarget()
  if (!target) return null

  await target.dbg.sendCommand('DOMSnapshot.enable').catch(() => {})

  try {
    const snap = (await target.dbg.sendCommand('DOMSnapshot.captureSnapshot', {
      computedStyles: [...STYLE_PROPS],
      includePaintOrder: true,
      includeDOMRects: false
    })) as CaptureResult
    return buildPageLayout(snap, viewport)
  } catch {
    return null
  }
}
