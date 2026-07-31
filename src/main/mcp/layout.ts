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
  /**
   * true when the in-page scan found a click signal the accessibility tree
   * misses — a `<div onClick>` with no ARIA role, for example.
   */
  clickable: boolean
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
  /** Elements the in-page click scan reported. */
  clickScanned: number
  /** How many of those actually correlated to a snapshot node by geometry. */
  clickMatched: number
}

/**
 * Requested in this order; `layout.styles[i]` is parallel to it, so the indices
 * below must move together with the array.
 */
const STYLE_PROPS = ['visibility', 'opacity', 'overflow-x', 'overflow-y'] as const
const STYLE_VISIBILITY = 0
const STYLE_OPACITY = 1
const STYLE_OVERFLOW_X = 2
const STYLE_OVERFLOW_Y = 3

/** Any of these on an ancestor means it clips whatever sticks out of its box. */
const CLIPPING_OVERFLOW = new Set(['hidden', 'auto', 'scroll', 'clip', 'overlay'])

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

function intersectRect(a: Viewport, b: Viewport): Viewport {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y)
  }
}

/**
 * Effective visible region for each laid-out node: the viewport intersected
 * with every clipping ancestor's box.
 *
 * Without this a button scrolled out of an `overflow:auto` container still
 * counts as visible, because its own rect is inside the page viewport — the
 * container is on screen, the button is just clipped out of it. A fixture run
 * showed exactly that: `C1-BOTTOM needs inner scroll` got a ref while being
 * invisible, and the filter reported nothing hidden at all. Reporting an
 * element the agent cannot see is worse than missing one; it plans against a
 * screen state that does not exist.
 */
function buildClipRects(
  doc: DocumentSnapshot,
  strings: string[],
  viewport: Viewport
): Map<number, Viewport> {
  const parentIndex = doc.nodes?.parentIndex
  const layout = doc.layout
  const clipByNodeIndex = new Map<number, Viewport>()
  if (!parentIndex || !layout?.nodeIndex) return clipByNodeIndex

  // Only laid-out nodes have a box, so clipping ancestors are looked up here.
  const ownClip = new Map<number, Viewport>()
  for (let i = 0; i < layout.nodeIndex.length; i++) {
    const bounds = layout.bounds?.[i]
    if (!bounds || bounds.length < 4) continue
    const styleIdx = layout.styles?.[i] ?? []
    const ox = styleIdx[STYLE_OVERFLOW_X] >= 0 ? strings[styleIdx[STYLE_OVERFLOW_X]] : ''
    const oy = styleIdx[STYLE_OVERFLOW_Y] >= 0 ? strings[styleIdx[STYLE_OVERFLOW_Y]] : ''
    if (!CLIPPING_OVERFLOW.has(ox) && !CLIPPING_OVERFLOW.has(oy)) continue
    const [x, y, width, height] = bounds
    ownClip.set(layout.nodeIndex[i], { x, y, width, height })
  }
  if (ownClip.size === 0) return clipByNodeIndex

  const resolve = (nodeIndex: number): Viewport => {
    const cached = clipByNodeIndex.get(nodeIndex)
    if (cached) return cached
    const parent = parentIndex[nodeIndex]
    const inherited =
      parent == null || parent < 0 || parent === nodeIndex ? viewport : resolve(parent)
    const own = ownClip.get(nodeIndex)
    const clip = own ? intersectRect(inherited, own) : inherited
    clipByNodeIndex.set(nodeIndex, clip)
    return clip
  }

  for (const nodeIndex of layout.nodeIndex) resolve(nodeIndex)
  return clipByNodeIndex
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
export function buildPageLayout(
  snap: CaptureResult,
  viewport: Viewport,
  clickablePaths?: ReadonlySet<string>
): PageLayout | null {
  // Paths are only meaningful for the main document: the in-page scan uses
  // querySelectorAll, which does not pierce iframes, so an iframe document's
  // paths would collide with the main document's.
  const clickableBackendIds = new Set<number>()
  if (clickablePaths && clickablePaths.size > 0 && snap.documents?.[0]) {
    const byPath = buildElementPaths(snap.documents[0])
    for (const p of clickablePaths) {
      const bid = byPath.get(p)
      if (bid != null) clickableBackendIds.add(bid)
    }
  }

  let clickMatched = 0
  const byBackendId = new Map<number, NodeLayout>()
  const entries: NodeLayout[] = []

  for (const doc of snap.documents ?? []) {
    const backendIds = doc.nodes?.backendNodeId
    const layout = doc.layout
    if (!backendIds || !layout?.nodeIndex) continue

    const clipByNodeIndex = buildClipRects(doc, snap.strings, viewport)

    for (let i = 0; i < layout.nodeIndex.length; i++) {
      const backendId = backendIds[layout.nodeIndex[i]]
      if (backendId == null) continue

      const bounds = layout.bounds?.[i]
      if (!bounds || bounds.length < 4) continue
      const [x, y, width, height] = bounds

      const styleIdx = layout.styles?.[i] ?? []
      const visibility =
        styleIdx[STYLE_VISIBILITY] >= 0 ? snap.strings[styleIdx[STYLE_VISIBILITY]] : ''
      const opacity = styleIdx[STYLE_OPACITY] >= 0 ? snap.strings[styleIdx[STYLE_OPACITY]] : ''

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
        occluded: false,
        clickable: clickableBackendIds.has(backendId)
      }
      if (entry.clickable) clickMatched++
      // Visible means inside the viewport AND inside every clipping ancestor.
      entry.inViewport = intersects(entry, clipByNodeIndex.get(layout.nodeIndex[i]) ?? viewport)

      // A backendNodeId can appear more than once across documents; the first
      // laid-out box wins, which is the one the user actually sees.
      if (!byBackendId.has(backendId)) byBackendId.set(backendId, entry)
      entries.push(entry)
    }
  }

  if (byBackendId.size === 0) return null

  markOccluded(entries, viewport)
  return {
    byBackendId,
    viewport,
    clickScanned: clickablePaths?.size ?? 0,
    clickMatched
  }
}

const ELEMENT_NODE = 1
const DOCUMENT_NODE = 9

/**
 * Map every element in a document snapshot to its element-child index path from
 * `<html>` — `"1.3.0"` is documentElement.children[1].children[3].children[0].
 *
 * Geometry was the obvious way to correlate in-page findings with snapshot
 * nodes and it failed outright: a fixture run in the app reported `10
 * candidate(s), 0 correlated`. The cause was never pinned down — a later probe
 * against plain headless Chrome matched 10 of 10 on the same fixture, so the
 * two coordinate spaces do agree under at least some conditions, and something
 * about the embedded webview (scale factor, zoom, or an emulated viewport) is
 * the likely difference.
 *
 * Paths sidestep the question entirely: they are exact regardless of scale,
 * origin or rounding, and cost nothing extra since the node tree already rides
 * along in the payload we fetch.
 */
export function buildElementPaths(doc: DocumentSnapshot): Map<string, number> {
  const parentIndex = doc.nodes?.parentIndex
  const nodeType = doc.nodes?.nodeType
  const backendIds = doc.nodes?.backendNodeId
  const byPath = new Map<string, number>()
  if (!parentIndex || !nodeType || !backendIds) return byPath

  const childrenOf = new Map<number, number[]>()
  let rootIdx = -1
  for (let i = 0; i < nodeType.length; i++) {
    if (nodeType[i] !== ELEMENT_NODE) continue
    const p = parentIndex[i]
    if (p == null || p < 0) continue
    if (nodeType[p] === DOCUMENT_NODE && rootIdx < 0) rootIdx = i
    const arr = childrenOf.get(p)
    if (arr) arr.push(i)
    else childrenOf.set(p, [i])
  }
  if (rootIdx < 0) return byPath

  const stack: Array<[number, string]> = [[rootIdx, '']]
  while (stack.length > 0) {
    const [idx, path] = stack.pop() as [number, string]
    if (path !== '') {
      const bid = backendIds[idx]
      if (bid != null) byPath.set(path, bid)
    }
    const kids = childrenOf.get(idx) ?? []
    for (let k = kids.length - 1; k >= 0; k--) {
      stack.push([kids[k], path === '' ? String(k) : `${path}.${k}`])
    }
  }
  return byPath
}

/** Above this element count the in-page click scan is skipped as too costly. */
const MAX_SCANNED_ELEMENTS = 10_000

export interface ClickScan {
  /** Element-child index paths from `<html>`, e.g. "1.3.0". */
  paths: Set<string>
  scanned: number
  /** true when the page was too large and the scan was skipped entirely */
  skipped: boolean
}

/**
 * The accessibility tree only marks elements that carry an interactive role,
 * so a `<div onClick>` with no ARIA is invisible to it — and an element the
 * agent cannot click is an API call it can never trigger.
 *
 * This finds them in one page evaluation and reports GEOMETRY, never touching
 * the DOM. Marking elements with a data attribute would be simpler, but this
 * app also ships stealth measures: writing attributes onto every clickable
 * element fires the target site's MutationObservers, which is exactly what
 * bot detection watches for.
 *
 * Known gap: React 17+ delegates events to the root container, so
 * `getEventListeners` finds nothing on individual React elements. The cursor
 * heuristic below is what actually catches those.
 */
const CLICK_SCAN_EXPRESSION = `(() => {
  const all = document.querySelectorAll('*')
  if (all.length > ${MAX_SCANNED_ELEMENTS}) return { paths: [], scanned: all.length, skipped: true }

  // Element-child index path from <html>. Must mirror buildElementPaths().
  const pathOf = (el) => {
    const parts = []
    let cur = el
    while (cur && cur !== document.documentElement) {
      const p = cur.parentElement
      if (!p) return null
      parts.push(Array.prototype.indexOf.call(p.children, cur))
      cur = p
    }
    return cur === document.documentElement ? parts.reverse().join('.') : null
  }

  // Natively interactive tags already surface through the accessibility tree.
  const NATIVE = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','OPTION','LABEL'])
  const EVENTS = ['click','mousedown','pointerdown','keydown']
  const paths = []
  const hits = []

  for (const el of all) {
    if (NATIVE.has(el.tagName)) continue

    let hit = false
    try {
      // Console-API only; present because we evaluate with includeCommandLineAPI.
      const ls = typeof getEventListeners === 'function' ? getEventListeners(el) : null
      if (ls && EVENTS.some((e) => ls[e] && ls[e].length)) hit = true
    } catch (e) { /* command line API unavailable */ }

    if (!hit && (el.onclick || el.hasAttribute('onclick'))) hit = true

    if (!hit) {
      const ti = el.getAttribute('tabindex')
      if (ti !== null && Number(ti) >= 0) hit = true
    }

    if (!hit) {
      // The cursor property INHERITS, so every descendant of a pointer element
      // reports 'pointer' too. Only the element that originates the change is
      // the real click target; without this test a single button contributes
      // one hit per nested span.
      const cs = getComputedStyle(el)
      if (cs.cursor === 'pointer') {
        const p = el.parentElement
        if (!p || getComputedStyle(p).cursor !== 'pointer') hit = true
      }
    }

    if (!hit) continue
    hits.push(el)
  }

  // Innermost candidate wins. A delegation root (React 17+ attaches ONE
  // listener at the app container) is itself a hit, and preferring the outer
  // element would collapse an entire app into a single ref and hide every
  // button inside it. Nested inheritance is already handled by the cursor
  // origin test above, so nothing needs the outer element to win.
  const hitSet = new Set(hits)
  const hasInnerHit = new Set()
  for (const el of hits) {
    let p = el.parentElement
    while (p) {
      if (hitSet.has(p)) hasInnerHit.add(p)
      p = p.parentElement
    }
  }

  for (const el of hits) {
    if (hasInnerHit.has(el)) continue
    const path = pathOf(el)
    if (path !== null && path !== '') paths.push(path)
  }

  return { paths, scanned: all.length, skipped: false }
})()`

export async function scanClickable(): Promise<ClickScan> {
  const empty: ClickScan = { paths: new Set(), scanned: 0, skipped: true }
  const target = getActiveTarget()
  if (!target) return empty

  try {
    const res = (await target.dbg.sendCommand('Runtime.evaluate', {
      expression: CLICK_SCAN_EXPRESSION,
      returnByValue: true,
      includeCommandLineAPI: true
    })) as { result: { value?: { paths: string[]; scanned: number; skipped: boolean } } }

    const value = res.result?.value
    if (!value) return empty
    return { paths: new Set(value.paths), scanned: value.paths.length, skipped: value.skipped }
  } catch {
    return empty
  }
}

/**
 * Capture bounds, computed visibility styles and paint order for every laid-out
 * node on the page. Returns null when the page has no layout data or the
 * command is unavailable — callers must treat null as "no filtering possible"
 * rather than as an empty page.
 */
export async function capturePageLayout(
  viewport: Viewport,
  clickableRects?: ReadonlySet<string>
): Promise<PageLayout | null> {
  const target = getActiveTarget()
  if (!target) return null

  await target.dbg.sendCommand('DOMSnapshot.enable').catch(() => {})

  try {
    const snap = (await target.dbg.sendCommand('DOMSnapshot.captureSnapshot', {
      computedStyles: [...STYLE_PROPS],
      includePaintOrder: true,
      includeDOMRects: false
    })) as CaptureResult
    return buildPageLayout(snap, viewport, clickableRects)
  } catch {
    return null
  }
}
