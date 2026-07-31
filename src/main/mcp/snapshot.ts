import { emitAiAction } from '../ai-events'
import { getActiveTarget } from '../chrome-cdp'
import { visualize } from './cdp-eval'
import { humanMouseMove, humanPressRelease, humanType, thinkingPause } from './human-input'
import { collectFrames } from './frames'
import { capturePageLayout, scanClickable, type PageLayout } from './layout'

interface AXValue {
  type: string
  value?: unknown
}

interface AXProperty {
  name: string
  value: AXValue
}

export interface AXNode {
  nodeId: string
  ignored?: boolean
  childIds?: string[]
  role?: AXValue
  name?: AXValue
  value?: AXValue
  properties?: AXProperty[]
  backendDOMNodeId?: number
}

interface RefEntry {
  backendNodeId: number
  role: string
  name: string
  /**
   * Viewport offset of the owning `<iframe>`. Coordinates from
   * getBoundingClientRect inside a frame are relative to THAT frame, while
   * mouse events are dispatched in page space - without this a click on a
   * framed element lands wherever the same offset happens to point in the
   * top document.
   */
  frameOffset?: { x: number; y: number }
}

const refMap = new Map<string, RefEntry>()

/**
 * backendNodeIds that carried a ref in the previous snapshot, so the next one
 * can point at what just appeared.
 *
 * In browser-use the equivalent marker is an attention aid. Here it is closer
 * to evidence: paired with the traffic store, "what showed up right after this
 * request" is how a response field gets traced to the UI that renders it.
 */
let previousRefTargets = new Set<number>()
let previousUrl = ''
/**
 * Which filtering mode produced the baseline. A viewport-filtered snapshot and
 * a full one contain different node sets, so comparing across them reports
 * everything the filter had hidden as newly appeared — the first run of this
 * marked an off-screen button as new when nothing had changed.
 */
let previousPruned = true

const SKIP_ROLES = new Set([
  'none',
  'generic',
  'InlineTextBox',
  'LineBreak',
  'presentation',
  'LayoutTable',
  'LayoutTableRow',
  'LayoutTableCell',
  'LayoutTableColumn'
])

/**
 * Roles whose subtree is label, not structure. A button or link already prints
 * its accessible name, so everything under it repeats information the agent
 * has - except a control nested inside, which keeps its own ref and survives.
 */
const LABEL_ONLY_SUBTREE = new Set(['button', 'link', 'menuitem', 'tab', 'option', 'switch'])

const ACTIONABLE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'menuitem',
  'tab',
  'switch',
  'slider',
  'option'
])

/** Depth-limited: labels come from a node's own text, not a whole subtree dump. */
const TEXT_LABEL_DEPTH = 3

/** First piece of visible text under a node, used to name role-less click targets. */
export function firstText(node: AXNode, scope: Map<string, AXNode>, depth = 0): string {
  if (depth > TEXT_LABEL_DEPTH) return ''
  for (const id of node.childIds ?? []) {
    const child = scope.get(id)
    if (!child) continue
    const name = String((child.name?.value as string | undefined) ?? '').trim()
    if ((child.role?.value as string | undefined) === 'StaticText' && name) return name
    const nested = firstText(child, scope, depth + 1)
    if (nested) return nested
  }
  return ''
}

function quote(s: string): string {
  return JSON.stringify(s.length > 80 ? s.slice(0, 80) + '…' : s)
}

export interface SnapshotStats {
  /** Actionable nodes that got a ref. */
  refs: number
  /** Nodes dropped because nothing is painted for them (hidden or covered). */
  hidden: number
  /** Nodes dropped because their box sits outside the viewport. */
  offscreen: number
  /** Refs that exist only because the click scan found them (no ARIA role). */
  clickOnlyRefs: number
  /** Elements the in-page click scan reported, before geometry correlation. */
  clickScanned: number
  /** How many of those correlated to a snapshot node. */
  clickMatched: number
  /** True when the filter was discarded because it suppressed everything. */
  fellBackToFull: boolean
  /** Child frames whose content was spliced into the tree. */
  frames: number
  /**
   * `<iframe>` elements present in the outline that could NOT be entered.
   *
   * Counted from the tree, not from Page.getFrameTree: an out-of-process frame
   * belongs to another target and never appears in the frame tree at all, so
   * counting failures there reported 0 while a whole frame was missing.
   */
  framesUnreachable: number
  /** Frames entered but still empty after a retry (likely still loading). */
  framesEmpty: number
  /** Refs marked *new because they were absent from the previous snapshot. */
  newRefs: number
}

export interface SnapshotResult {
  url: string
  title: string
  tree: string
  stats: SnapshotStats
}

interface PageMeta {
  url: string
  title: string
  scrollX: number
  scrollY: number
  innerWidth: number
  innerHeight: number
}

/** Tally of actionable nodes the viewport filter kept out of the tree. */
export interface FilterTally {
  hidden: number
  below: number
  above: number
  side: number
  nearestBelow: number
  nearestAbove: number
}

/**
 * Count what the filter excludes, by scanning every AX node directly.
 *
 * This deliberately does NOT reuse the tree walk. The walk prunes whole
 * subtrees when a container falls off-screen, so an actionable node buried
 * under one is never visited — counting there under-reports by an order of
 * magnitude and suppresses the scroll hints that make pruning safe.
 */
export function tallyFiltered(nodes: AXNode[], layout: PageLayout): FilterTally {
  const t: FilterTally = {
    hidden: 0,
    below: 0,
    above: 0,
    side: 0,
    nearestBelow: Infinity,
    nearestAbove: Infinity
  }
  const v = layout.viewport

  for (const n of nodes) {
    if (n.backendDOMNodeId == null || n.ignored) continue
    const role = (n.role?.value as string | undefined) ?? ''
    if (!ACTIONABLE_ROLES.has(role)) continue

    const lay = layout.byBackendId.get(n.backendDOMNodeId)
    if (!lay) continue

    if (!lay.rendered || lay.occluded || lay.zeroSize) {
      t.hidden++
      continue
    }
    if (lay.inViewport) continue

    const below = lay.y - (v.y + v.height)
    const above = v.y - (lay.y + lay.height)
    if (below > 0) {
      t.below++
      t.nearestBelow = Math.min(t.nearestBelow, below)
    } else if (above > 0) {
      t.above++
      t.nearestAbove = Math.min(t.nearestAbove, above)
    } else {
      t.side++
    }
  }

  return t
}

export function describeOffscreen(t: FilterTally): string[] {
  const out: string[] = []
  // The distance is to the NEAREST element, not to all of them — say so, or a
  // "scroll down ~25px" hint alongside a count of 138 reads as "25px reveals
  // everything" and the agent scrolls one row at a time.
  if (t.below > 0) {
    const px = Math.max(0, Math.round(t.nearestBelow))
    out.push(`- [${t.below} more actionable element(s) below the fold — nearest ~${px}px down]`)
  }
  if (t.above > 0) {
    const px = Math.max(0, Math.round(t.nearestAbove))
    out.push(`- [${t.above} more actionable element(s) above the fold — nearest ~${px}px up]`)
  }
  if (t.side > 0) {
    out.push(`- [${t.side} more actionable element(s) outside the horizontal viewport]`)
  }
  return out
}

/**
 * Capture the page as an accessibility outline.
 *
 * By default only what is actually painted inside the viewport is emitted:
 * hidden, zero-size, overlay-covered and off-screen subtrees are dropped, and
 * off-screen actionable nodes are summarised as scroll hints instead. That
 * keeps the tree small enough that the agent keeps using refs rather than
 * falling back to raw JS (which skips the human-shaped input path and fires
 * untrusted events). Pass `full` to get the unfiltered tree back.
 */
export async function takeSnapshot(opts: { full?: boolean } = {}): Promise<SnapshotResult> {
  const target = getActiveTarget()
  if (!target) throw new Error('no active browser target — open a page first')
  // Emit here (not per-tool) so implicit snapshots after navigate/click/type
  // also surface in the AI-activity overlay. The in-page scan runs alongside
  // the AX tree walk (not awaited) so it never slows the agent down.
  emitAiAction({ kind: 'snapshot', label: 'AI snapshot' })
  visualize('scanPage')

  await target.dbg.sendCommand('Accessibility.enable').catch(() => {})

  const metaRes = (await target.dbg.sendCommand('Runtime.evaluate', {
    expression:
      '({ url: location.href, title: document.title, scrollX, scrollY, innerWidth, innerHeight })',
    returnByValue: true
  })) as { result: { value: PageMeta } }
  const meta = metaRes.result.value

  const viewport = {
    x: meta.scrollX,
    y: meta.scrollY,
    width: meta.innerWidth,
    height: meta.innerHeight
  }

  // The AX tree, the click scan and the layout snapshot are independent reads —
  // issuing them together keeps the added passes off the critical path.
  // The click scan feeds the layout pass, so those two are a chain; the AX tree
  // is independent and runs alongside the whole chain.
  //
  // `full` only turns off viewport PRUNING — the click scan still runs. The
  // agent reaches for full=true when it cannot find something, so having that
  // switch also drop the click-scan refs would remove exactly the elements it
  // is looking for.
  const [axRes, layout, frameRes] = await Promise.all([
    target.dbg.sendCommand('Accessibility.getFullAXTree') as Promise<{ nodes: AXNode[] }>,
    scanClickable()
      .catch(() => null)
      .then((click) => capturePageLayout(viewport, click?.paths).catch(() => null)),
    collectFrames().catch(() => ({ frames: [], unreachable: 0, empty: 0 }))
  ])
  const { nodes } = axRes
  const framesByOwner = new Map(frameRes.frames.map((f) => [f.ownerBackendNodeId, f]))

  // After a navigation every node is new, so the marker would say nothing. Only
  // compare within the same document.
  const sameDocument =
    previousUrl === meta.url && previousRefTargets.size > 0 && previousPruned === !opts.full

  const byId = new Map<string, AXNode>()
  for (const n of nodes) byId.set(n.nodeId, n)

  const build = (
    filter: PageLayout | null,
    prune: boolean
  ): { tree: string; stats: SnapshotStats; refTargets: Set<number> } => {
    refMap.clear()
    let counter = 0
    let clickOnlyRefs = 0
    let newRefs = 0
    const seenRefTargets = new Set<number>()
    let framesEntered = 0
    let framesMissed = 0
    const lines: string[] = []

    const walk = (
      id: string,
      depth: number,
      parentName: string,
      ancestorClaimed: boolean,
      scope: Map<string, AXNode>,
      frameOffset?: { x: number; y: number },
      ancestorControl = false
    ): void => {
      const n = scope.get(id)
      if (!n) return
      const role = (n.role?.value as string | undefined) ?? ''
      const name = String((n.name?.value as string | undefined) ?? '').trim()

      // Layout gate. A node with no layout entry is left alone — absence of
      // data must never be read as "invisible", or whole pages would vanish.
      // Counting happens in tallyFiltered, not here: this prunes subtrees, so
      // anything below a pruned container is never reached.
      const lay =
        filter && n.backendDOMNodeId != null
          ? filter.byBackendId.get(n.backendDOMNodeId)
          : undefined
      // A zero-size box is invisible on its own but its children can overflow
      // it, so it must not take the subtree down with it — only style-hidden,
      // covered and off-screen boxes do.
      if (prune && lay && !lay.zeroSize && (!lay.rendered || lay.occluded || !lay.inViewport)) {
        return
      }

      // A click signal with no interactive ARIA role — the `<div onClick>`
      // case. Only the outermost such node in a chain gets a ref, so a button
      // wrapped in three pointer-cursor divs still yields exactly one.
      const claimable =
        lay?.clickable === true &&
        !ancestorClaimed &&
        !ACTIONABLE_ROLES.has(role) &&
        n.backendDOMNodeId != null

      // StaticText is collapsed into its parent's name. Suppress entirely if it
      // duplicates the parent name (Playwright MCP rule); otherwise emit as a
      // single quoted text line without a ref (text is not actionable).
      if (role === 'StaticText' && !claimable) {
        if (ancestorControl) return
        if (!name || name === parentName) return
        lines.push(`${'  '.repeat(depth)}- text ${quote(name)}`)
        return
      }

      // Inside a link or button, the label text and its wrapper spans carry no
      // information the ancestor line does not already give — a button prints
      // its own accessible name. Emitting them is most of what the outline
      // wastes on a real page. Anything with its own ref survives, so a nested
      // control or a click-scan hit is never swallowed.
      const insideControl = ancestorControl && !claimable && !ACTIONABLE_ROLES.has(role)

      const isScroller = (lay?.scrollableBy ?? 0) > 0
      const skip =
        !isScroller &&
        (insideControl || (!claimable && (!role || n.ignored || (SKIP_ROLES.has(role) && !name))))
      let nextDepth = depth

      if (!skip) {
        // A click-scan node has no ARIA role or name by definition, so it would
        // print as a bare `- generic [ref=r4]`. Label it by its own text so the
        // agent can tell what it is about to click.
        const label = claimable && (!role || SKIP_ROLES.has(role)) ? 'clickable' : role
        const shownName = name || (claimable ? firstText(n, scope) : '')

        const parts: string[] = [`- ${label || (isScroller ? 'scroller' : 'generic')}`]
        if (shownName) parts.push(quote(shownName))

        if (n.value?.value !== undefined && n.value.value !== '') {
          parts.push(`value=${quote(String(n.value.value))}`)
        }

        if (n.properties) {
          for (const p of n.properties) {
            const v = p.value?.value
            if ((p.name === 'checked' || p.name === 'selected' || p.name === 'expanded') && v) {
              parts.push(`${p.name}=${v}`)
            }
            if (p.name === 'disabled' && v) parts.push('disabled')
            if (p.name === 'level' && typeof v === 'number') parts.push(`level=${v}`)
          }
        }

        if (n.backendDOMNodeId != null && (ACTIONABLE_ROLES.has(role) || claimable)) {
          counter++
          if (claimable) clickOnlyRefs++
          if (sameDocument && !previousRefTargets.has(n.backendDOMNodeId)) {
            parts.push('*new')
            newRefs++
          }
          seenRefTargets.add(n.backendDOMNodeId)
          const r = `r${counter}`
          refMap.set(r, {
            backendNodeId: n.backendDOMNodeId,
            role: role || 'clickable',
            name: shownName,
            frameOffset
          })
          parts.push(`[ref=${r}]`)
          if (claimable) parts.push('(click-scan)')
        }

        // A scrollable box is worth calling out even when it carries no ref:
        // browser_scroll moves the window, so if the real scroller is this
        // container the agent needs to know it exists to reach what is inside.
        if (lay && lay.scrollableBy > 0) parts.push(`[scrollable +${lay.scrollableBy}px]`)

        lines.push(`${'  '.repeat(depth)}${parts.join(' ')}`)
        nextDepth = depth + 1
      }

      const childParentName = skip ? parentName : name
      const nextAncestorControl = ancestorControl || LABEL_ONLY_SUBTREE.has(role)
      for (const c of n.childIds ?? []) {
        walk(
          c,
          nextDepth,
          childParentName,
          ancestorClaimed || claimable,
          scope,
          frameOffset,
          nextAncestorControl
        )
      }

      // Descend into a child frame. Its accessibility tree is a separate
      // document with its own node ids, so the scope map switches here rather
      // than being merged — ids collide across frames.
      const frame = n.backendDOMNodeId != null ? framesByOwner.get(n.backendDOMNodeId) : undefined
      if (!frame && role === 'Iframe') framesMissed++
      if (frame) {
        framesEntered++
        // Frame-local coordinates need the iframe's own position added back.
        const box = filter?.byBackendId.get(n.backendDOMNodeId as number)
        const nextOffset = box
          ? {
              x: (frameOffset?.x ?? 0) + box.x - viewport.x,
              y: (frameOffset?.y ?? 0) + box.y - viewport.y
            }
          : frameOffset
        walk(
          frame.rootNodeId,
          nextDepth,
          name,
          ancestorClaimed || claimable,
          frame.byId,
          nextOffset,
          false
        )
      }
    }

    if (nodes[0]) walk(nodes[0].nodeId, 0, '', false, byId)

    if (!filter || !prune) {
      return {
        tree: lines.join('\n'),
        refTargets: seenRefTargets,
        stats: {
          refs: counter,
          hidden: 0,
          offscreen: 0,
          clickOnlyRefs,
          clickScanned: filter?.clickScanned ?? 0,
          clickMatched: filter?.clickMatched ?? 0,
          fellBackToFull: false,
          frames: framesEntered,
          framesUnreachable: framesMissed,
          framesEmpty: frameRes.empty,
          newRefs
        }
      }
    }

    const tally = tallyFiltered(nodes, filter)
    return {
      tree: [...lines, ...describeOffscreen(tally)].join('\n'),
      refTargets: seenRefTargets,
      stats: {
        refs: counter,
        hidden: tally.hidden,
        offscreen: tally.below + tally.above + tally.side,
        clickOnlyRefs,
        clickScanned: filter.clickScanned,
        clickMatched: filter.clickMatched,
        fellBackToFull: false,
        frames: framesEntered,
        framesUnreachable: framesMissed,
        framesEmpty: frameRes.empty,
        newRefs
      }
    }
  }

  let result = build(layout, !opts.full)

  // Safety valve for a coordinate mismatch (detached document, odd frame
  // setup): the filter suppressed everything AND cannot say why.
  //
  // "Cannot say why" is the load-bearing half. A full-screen modal legitimately
  // covers every actionable element, which also yields zero refs — firing the
  // valve there throws away a correct result and silently disables the filter
  // exactly when the page is most confusing. So only fall back when the tally
  // accounts for nothing.
  if (layout && !opts.full && result.stats.refs === 0) {
    const explained = result.stats.hidden > 0 || result.stats.offscreen > 0
    if (!explained) {
      result = build(layout, false)
      // Only a real mismatch if dropping the filter actually reveals controls.
      // An error page with no controls at all also lands here, and claiming a
      // coordinate problem there is a false alarm.
      result.stats.fellBackToFull = result.stats.refs > 0
    }
  }

  previousRefTargets = result.refTargets
  previousUrl = meta.url
  previousPruned = !opts.full

  return {
    url: meta.url,
    title: meta.title,
    tree: result.tree,
    stats: result.stats
  }
}

async function resolveObjectId(ref: string): Promise<string> {
  const entry = refMap.get(ref)
  if (!entry) throw new Error(`unknown ref "${ref}" — call browser_snapshot first`)
  const target = getActiveTarget()
  if (!target) throw new Error('no active browser target')
  const res = (await target.dbg.sendCommand('DOM.resolveNode', {
    backendNodeId: entry.backendNodeId
  })) as { object: { objectId: string } }
  return res.object.objectId
}

/**
 * Resolve a CSS selector to a live RemoteObject id for its first match. Throws
 * if nothing matches. This lets selector-based tools reuse the exact same
 * human-input path (cursor move + flash + real events) as ref-based ones
 * WITHOUT needing a prior browser_snapshot — the fix for pages whose snapshot
 * is too big to be practical (the agent used to fall back to raw JS, which
 * skips the whole animation and fires no trusted events).
 */
async function resolveSelectorObjectId(selector: string): Promise<string> {
  const target = getActiveTarget()
  if (!target) throw new Error('no active browser target')
  const res = (await target.dbg.sendCommand('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false
  })) as { result: { objectId?: string } }
  if (!res.result.objectId) {
    throw new Error(`no element matches selector: ${selector}`)
  }
  return res.result.objectId
}

/**
 * Core click: given an already-resolved objectId + a human-readable label,
 * run the full scroll → thinking pause → cursor move → flash → press/release
 * sequence. The overlay flash appears only once the cursor has arrived. Shared
 * by clickRef (snapshot ref) and clickSelector (CSS selector).
 */
async function clickObjectId(
  objectId: string,
  label: string,
  role?: string,
  frameOffset?: { x: number; y: number }
): Promise<void> {
  const target = getActiveTarget()!
  emitAiAction({ kind: 'click', label, detail: role })

  const result = (await target.dbg.sendCommand('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `async function() {
      this.scrollIntoView({block:"center"})
      await new Promise(r => requestAnimationFrame(() => r()))
      const r = this.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }`,
    returnByValue: true,
    awaitPromise: true
  })) as { result: { value: { x: number; y: number } } }
  // getBoundingClientRect ran inside the element's own frame, so its origin is
  // that frame — mouse events are dispatched in page space.
  const x = result.result.value.x + (frameOffset?.x ?? 0)
  const y = result.result.value.y + (frameOffset?.y ?? 0)

  await thinkingPause()
  await humanMouseMove(x, y)

  await target.dbg.sendCommand('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function(label) {
      if (window.__reverAi) window.__reverAi.flashElement(this, label, 'click')
    }`,
    arguments: [{ value: label }]
  })
  await humanPressRelease(x, y)
}

/**
 * Core hover: same scroll → thinking pause → cursor move → flash sequence as
 * clickObjectId, but WITHOUT the press/release — the cursor just arrives and
 * stays, so :hover styles / mouseover-driven menus stay open. Shared by
 * hoverRef (snapshot ref) and hoverSelector (CSS selector).
 */
async function hoverObjectId(
  objectId: string,
  label: string,
  role?: string,
  frameOffset?: { x: number; y: number }
): Promise<void> {
  const target = getActiveTarget()!
  emitAiAction({ kind: 'hover', label, detail: role })

  const result = (await target.dbg.sendCommand('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `async function() {
      this.scrollIntoView({block:"center"})
      await new Promise(r => requestAnimationFrame(() => r()))
      const r = this.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }`,
    returnByValue: true,
    awaitPromise: true
  })) as { result: { value: { x: number; y: number } } }
  // getBoundingClientRect ran inside the element's own frame, so its origin is
  // that frame — mouse events are dispatched in page space.
  const x = result.result.value.x + (frameOffset?.x ?? 0)
  const y = result.result.value.y + (frameOffset?.y ?? 0)

  await thinkingPause()
  await humanMouseMove(x, y)

  await target.dbg.sendCommand('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function(label) {
      if (window.__reverAi) window.__reverAi.flashElement(this, label, 'hover')
    }`,
    arguments: [{ value: label }]
  })
}

/** Core type: same human-shaped sequence as clickObjectId, then focus + type
 * (+ optional Enter) via real CDP key events. Shared by typeRef/typeSelector. */
async function typeObjectId(
  objectId: string,
  text: string,
  submit: boolean,
  label: string,
  role?: string,
  frameOffset?: { x: number; y: number }
): Promise<void> {
  const target = getActiveTarget()!
  emitAiAction({ kind: 'type', label, detail: text.slice(0, 80) })

  const result = (await target.dbg.sendCommand('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `async function() {
      this.scrollIntoView({block:"center"})
      await new Promise(r => requestAnimationFrame(() => r()))
      const r = this.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }`,
    returnByValue: true,
    awaitPromise: true
  })) as { result: { value: { x: number; y: number } } }
  // getBoundingClientRect ran inside the element's own frame, so its origin is
  // that frame — mouse events are dispatched in page space.
  const x = result.result.value.x + (frameOffset?.x ?? 0)
  const y = result.result.value.y + (frameOffset?.y ?? 0)

  await thinkingPause()
  await humanMouseMove(x, y)

  await target.dbg.sendCommand('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function(label) {
      if (window.__reverAi) window.__reverAi.flashElement(this, label, 'type')
    }`,
    arguments: [{ value: label }]
  })
  await humanPressRelease(x, y)
  await humanType(objectId, text, submit)
}

export async function clickRef(ref: string): Promise<void> {
  const entry = refMap.get(ref)
  const objectId = await resolveObjectId(ref)
  const label = `AI click${entry?.name ? ` "${entry.name.slice(0, 32)}"` : ''}`
  await clickObjectId(objectId, label, entry?.role, entry?.frameOffset)
}

export async function typeRef(ref: string, text: string, submit: boolean): Promise<void> {
  const entry = refMap.get(ref)
  const objectId = await resolveObjectId(ref)
  const label = `AI type${entry?.name ? ` → "${entry.name.slice(0, 24)}"` : ''}`
  await typeObjectId(objectId, text, submit, label, entry?.role, entry?.frameOffset)
}

export async function hoverRef(ref: string): Promise<void> {
  const entry = refMap.get(ref)
  const objectId = await resolveObjectId(ref)
  const label = `AI hover${entry?.name ? ` "${entry.name.slice(0, 32)}"` : ''}`
  await hoverObjectId(objectId, label, entry?.role, entry?.frameOffset)
}

export async function hoverSelector(selector: string): Promise<void> {
  const objectId = await resolveSelectorObjectId(selector)
  const shortSel = selector.length > 32 ? selector.slice(0, 32) + '…' : selector
  await hoverObjectId(objectId, `AI hover "${shortSel}"`)
}

export async function clickSelector(selector: string): Promise<void> {
  const objectId = await resolveSelectorObjectId(selector)
  const shortSel = selector.length > 32 ? selector.slice(0, 32) + '…' : selector
  await clickObjectId(objectId, `AI click "${shortSel}"`)
}

export async function typeSelector(selector: string, text: string, submit: boolean): Promise<void> {
  const objectId = await resolveSelectorObjectId(selector)
  const shortSel = selector.length > 24 ? selector.slice(0, 24) + '…' : selector
  await typeObjectId(objectId, text, submit, `AI type → "${shortSel}"`)
}
