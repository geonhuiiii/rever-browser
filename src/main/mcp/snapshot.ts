import { emitAiAction } from '../ai-events'
import { getActiveTarget, waitForSettle } from '../chrome-cdp'
import { visualize } from './cdp-eval'
import {
  humanDrag,
  humanMouseMove,
  humanPressRelease,
  humanType,
  thinkingPause
} from './human-input'
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

/** An `<iframe>` element on the path from the page to a node, outermost first. */
interface FrameOwner {
  backendNodeId: number
  /** Session of the document CONTAINING this `<iframe>`, not of its content. */
  sessionId?: string
}

interface RefEntry {
  backendNodeId: number
  role: string
  name: string
  /**
   * The `<iframe>` chain this node sits behind, outermost first.
   *
   * Coordinates from getBoundingClientRect inside a frame are relative to THAT
   * frame, while mouse events are dispatched in page space, so the frames'
   * positions have to be added back. They are measured at click time rather
   * than stored from the snapshot: the click path calls scrollIntoView first,
   * which moves the page under the frame, and a stored offset is wrong by
   * exactly that scroll. The symptom is not an error — the click lands on
   * whatever is now at those coordinates. It selected the wrong card issuer
   * and silently unticked a consent box before this was measured live.
   */
  frameOwners?: FrameOwner[]
  /**
   * CDP session owning this node. Absent for the page session. Every command
   * about the node must carry it: backend ids are per-process, so the page
   * session answers about an out-of-process node with a different node rather
   * than an error.
   */
  sessionId?: string
}

const refMap = new Map<string, RefEntry>()

/**
 * Nodes that carried a ref in the previous snapshot, so the next one can point
 * at what just appeared. Keyed by session + backendNodeId, because the ids of
 * an out-of-process frame collide with the page's own.
 *
 * In browser-use the equivalent marker is an attention aid. Here it is closer
 * to evidence: paired with the traffic store, "what showed up right after this
 * request" is how a response field gets traced to the UI that renders it.
 */
let previousRefTargets = new Set<string>()
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
  'option',
  // A `<select multiple>` renders as a listbox whose options carry refs while
  // the element itself carried none — leaving browser_select_option with
  // nothing to address, so a multi-select could not be answered at all.
  'listbox'
])

/**
 * Bring `this` into view before measuring it. Interpolated into the
 * callFunctionOn bodies of the click / hover / type / drag paths.
 *
 * Two things it is careful about. It only scrolls when the element is actually
 * outside the viewport — centring on every click made the page jump on targets
 * that were already visible. And when it does scroll it animates, then waits
 * for the position to stop moving, because the caller measures coordinates
 * straight afterwards and a still-animating page yields a stale point.
 *
 * The rAF wait is raced against a timer: a backgrounded or occluded window
 * never produces an animation frame, and that is the normal state when an
 * agent drives the app without watching it.
 */
const SCROLL_INTO_VIEW = `
      const r0 = this.getBoundingClientRect()
      const margin = 8
      const offscreen =
        r0.top < margin || r0.left < margin ||
        r0.bottom > innerHeight - margin || r0.right > innerWidth - margin
      if (offscreen) {
        this.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
        let last = NaN
        let settled = 0
        for (let i = 0; i < 40 && settled < 3; i++) {
          await new Promise(r => setTimeout(r, 25))
          const top = this.getBoundingClientRect().top
          settled = Math.abs(top - last) < 0.5 ? settled + 1 : 0
          last = top
        }
      } else {
        await Promise.race([
          new Promise(r => requestAnimationFrame(() => r())),
          new Promise(r => setTimeout(r, 120))
        ])
      }`

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
  const first = await captureSnapshot(opts)

  // "Actionable elements exist, none of them are visible" is what an unsettled
  // layout looks like: the boxes have been created but not yet placed, so they
  // all read as sitting below the fold. It is also indistinguishable from a
  // correct snapshot of a page whose controls really are all off-screen, which
  // is why this waits and re-reads rather than trying to decide.
  //
  // A cold load of a heavy page produced exactly this - zero refs, while the
  // very next snapshot found 25. The agent's first look at a page is the one
  // that shapes the rest of the session, so an empty first look is expensive.
  const looksUnsettled =
    !opts.full &&
    first.stats.refs === 0 &&
    first.stats.hidden + first.stats.offscreen > 0

  if (!looksUnsettled) return first

  // Wait the way the page needs rather than a fixed pause: a cold load can
  // still be fetching well past the normal settle window, and a flat delay is
  // either too short for that or wasted on every other page.
  await waitForSettle({ idleMs: 300, timeoutMs: 2500, minWaitMs: 300 })
  const second = await captureSnapshot(opts)
  return second.stats.refs > 0 ? second : first
}

async function captureSnapshot(opts: { full?: boolean }): Promise<SnapshotResult> {
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
  // Keyed by session + backend id. Backend ids are per-process, so a frame
  // nested inside an out-of-process one can carry the same number as an
  // unrelated element in the page — keying on the number alone would splice a
  // frame into whatever happened to share it.
  const framesByOwner = new Map(
    frameRes.frames.map((f) => [`${f.ownerSessionId ?? ''}:${f.ownerBackendNodeId}`, f])
  )

  // After a navigation every node is new, so the marker would say nothing. Only
  // compare within the same document.
  const sameDocument =
    previousUrl === meta.url && previousRefTargets.size > 0 && previousPruned === !opts.full

  const byId = new Map<string, AXNode>()
  for (const n of nodes) byId.set(n.nodeId, n)

  /**
   * The full `<iframe>` chain from the page down to `frame`, outermost first.
   *
   * The walk builds this as it descends, but a frame with no anchor is emitted
   * on its own, and its immediate owner may itself sit inside another frame.
   * Following ownerSessionId back up recovers the missing outer hops — without
   * them a click is short by the outer frame's position and lands elsewhere
   * without erroring.
   */
  const ownerChain = (frame: (typeof frameRes.frames)[number]): FrameOwner[] => {
    const chain: FrameOwner[] = []
    let cur: (typeof frameRes.frames)[number] | undefined = frame
    const guard = new Set<string>()
    while (cur && !guard.has(cur.frameId)) {
      guard.add(cur.frameId)
      chain.unshift({ backendNodeId: cur.ownerBackendNodeId, sessionId: cur.ownerSessionId })
      const parentSession: string | undefined = cur.ownerSessionId
      cur = parentSession
        ? frameRes.frames.find((f) => f.sessionId === parentSession)
        : undefined
    }
    return chain
  }

  const build = (
    filter: PageLayout | null,
    prune: boolean
  ): { tree: string; stats: SnapshotStats; refTargets: Set<string> } => {
    refMap.clear()
    let counter = 0
    let clickOnlyRefs = 0
    let newRefs = 0
    const seenRefTargets = new Set<string>()
    let framesEntered = 0
    let framesMissed = 0
    const splicedFrames = new Set<string>()
    const lines: string[] = []

    const walk = (
      id: string,
      depth: number,
      parentName: string,
      ancestorClaimed: boolean,
      scope: Map<string, AXNode>,
      frameOwners: FrameOwner[] = [],
      ancestorControl = false,
      frameSessionId?: string
    ): void => {
      const n = scope.get(id)
      if (!n) return
      const role = (n.role?.value as string | undefined) ?? ''
      const name = String((n.name?.value as string | undefined) ?? '').trim()

      // Layout gate. A node with no layout entry is left alone — absence of
      // data must never be read as "invisible", or whole pages would vanish.
      // Counting happens in tallyFiltered, not here: this prunes subtrees, so
      // anything below a pruned container is never reached.
      //
      // Skipped entirely inside an out-of-process frame: the layout pass runs
      // in the page's renderer, and that frame's backend ids belong to another
      // process. A lookup there does not miss, it MATCHES A DIFFERENT ELEMENT —
      // so the filter would prune or keep the frame's nodes at random.
      const lay =
        filter && !frameSessionId && n.backendDOMNodeId != null
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
          const refKey = `${frameSessionId ?? ''}:${n.backendDOMNodeId}`
          if (sameDocument && !previousRefTargets.has(refKey)) {
            parts.push('*new')
            newRefs++
          }
          seenRefTargets.add(refKey)
          const r = `r${counter}`
          refMap.set(r, {
            backendNodeId: n.backendDOMNodeId,
            role: role || 'clickable',
            name: shownName,
            frameOwners: frameOwners.length ? frameOwners : undefined,
            sessionId: frameSessionId
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
          frameOwners,
          nextAncestorControl,
          frameSessionId
        )
      }

      // Descend into a child frame. Its accessibility tree is a separate
      // document with its own node ids, so the scope map switches here rather
      // than being merged — ids collide across frames.
      //
      // Looked up per session, so a frame nested inside an out-of-process one
      // is reached from that frame's own document rather than being matched by
      // a bare backend id that means something else in the page.
      const frame =
        n.backendDOMNodeId != null
          ? framesByOwner.get(`${frameSessionId ?? ''}:${n.backendDOMNodeId}`)
          : undefined
      if (!frame && role === 'Iframe') framesMissed++
      if (frame) {
        framesEntered++
        splicedFrames.add(frame.frameId)
        // Record the `<iframe>` rather than its position — the position is
        // measured at click time, see RefEntry.frameOwners.
        walk(
          frame.rootNodeId,
          nextDepth,
          name,
          ancestorClaimed || claimable,
          frame.byId,
          [...frameOwners, { backendNodeId: n.backendDOMNodeId as number, sessionId: frameSessionId }],
          false,
          frame.sessionId
        )
      }
    }

    if (nodes[0]) walk(nodes[0].nodeId, 0, '', false, byId)

    // A frame whose `<iframe>` carries aria-hidden has NO node in the parent
    // accessibility tree — Chrome drops the element outright rather than
    // marking it ignored — so the walk never reaches an anchor to nest it
    // under. Emitting it at the end keeps it reachable instead of dropping it
    // without a word: a cross-site frame the page hides from assistive tech
    // (trackers, 3DS steps, captchas, status embeds) is exactly what a
    // reverser is looking for, and on the Toss sandbox this was the only real
    // OOPIF on the page.
    for (const frame of frameRes.frames) {
      if (splicedFrames.has(frame.frameId)) continue
      framesEntered++
      lines.push(`- Iframe (hidden from the a11y tree) ${quote(frame.url ?? frame.frameId)}`)
      walk(
        frame.rootNodeId,
        1,
        '',
        false,
        frame.byId,
        ownerChain(frame),
        false,
        frame.sessionId
      )
    }

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
  // The session is load-bearing, not an optimisation: asked about an
  // out-of-process node without it, the page session returns a DIFFERENT node
  // instead of failing, and the click lands somewhere else entirely.
  const res = (await target.dbg.sendCommand(
    'DOM.resolveNode',
    { backendNodeId: entry.backendNodeId },
    entry.sessionId
  )) as { object: { objectId: string } }
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
 * Current page-space position of a frame's content origin, measured now.
 *
 * Walks the `<iframe>` chain outermost-in, each element read in the session of
 * the document that holds it, and adds the border + padding because the child
 * document starts at the content box, not the border box. Called after
 * scrollIntoView so the numbers describe where the frame actually is at the
 * moment the mouse event is dispatched.
 */
async function measureFrameOffset(owners: FrameOwner[] | undefined): Promise<{
  x: number
  y: number
}> {
  if (!owners?.length) return { x: 0, y: 0 }
  const target = getActiveTarget()
  if (!target) return { x: 0, y: 0 }

  let x = 0
  let y = 0
  for (const owner of owners) {
    const node = (await target.dbg.sendCommand(
      'DOM.resolveNode',
      { backendNodeId: owner.backendNodeId },
      owner.sessionId
    )) as { object: { objectId: string } }
    const res = (await target.dbg.sendCommand(
      'Runtime.callFunctionOn',
      {
        objectId: node.object.objectId,
        functionDeclaration: `function() {
          const r = this.getBoundingClientRect()
          const s = getComputedStyle(this)
          const n = (v) => parseFloat(v) || 0
          return {
            x: r.left + n(s.borderLeftWidth) + n(s.paddingLeft),
            y: r.top + n(s.borderTopWidth) + n(s.paddingTop)
          }
        }`,
        returnByValue: true
      },
      owner.sessionId
    )) as { result: { value: { x: number; y: number } } }
    x += res.result.value.x
    y += res.result.value.y
  }
  return { x, y }
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
  frameOwners?: FrameOwner[],
  sessionId?: string,
  mouse: { button?: 'left' | 'right' | 'middle'; clickCount?: number } = {}
): Promise<void> {
  const target = getActiveTarget()!
  emitAiAction({ kind: 'click', label, detail: role })

  const result = (await target.dbg.sendCommand('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `async function() {
      ${SCROLL_INTO_VIEW}
      const r = this.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }`,
    returnByValue: true,
    awaitPromise: true
  }, sessionId)) as { result: { value: { x: number; y: number } } }
  // getBoundingClientRect ran inside the element's own frame, so its origin is
  // that frame — mouse events are dispatched in page space. Measured after the
  // scrollIntoView above, which moves the page under the frame.
  const frameOffset = await measureFrameOffset(frameOwners)
  const x = result.result.value.x + frameOffset.x
  const y = result.result.value.y + frameOffset.y

  await thinkingPause()
  await humanMouseMove(x, y)

  await target.dbg.sendCommand('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function(label) {
      if (window.__reverAi) window.__reverAi.flashElement(this, label, 'click')
    }`,
    arguments: [{ value: label }]
  }, sessionId)
  await humanPressRelease(x, y, mouse)
}

/**
 * Page-space centre of a ref, after scrolling it into view. Shared by the
 * gesture entry points so they inherit the frame-offset handling rather than
 * re-deriving coordinates that would be wrong inside an iframe.
 */
async function pointForRef(ref: string): Promise<{ x: number; y: number }> {
  const entry = refMap.get(ref)
  const objectId = await resolveObjectId(ref)
  const target = getActiveTarget()!
  const res = (await target.dbg.sendCommand(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: `async function() {
        ${SCROLL_INTO_VIEW}
        const r = this.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }`,
      returnByValue: true,
      awaitPromise: true
    },
    entry?.sessionId
  )) as { result: { value: { x: number; y: number } } }
  const off = await measureFrameOffset(entry?.frameOwners)
  return { x: res.result.value.x + off.x, y: res.result.value.y + off.y }
}

/** Right-click, middle-click or double-click a ref. */
export async function clickRefWith(
  ref: string,
  mouse: { button?: 'left' | 'right' | 'middle'; clickCount?: number }
): Promise<void> {
  const entry = refMap.get(ref)
  const objectId = await resolveObjectId(ref)
  const kind = mouse.clickCount === 2 ? 'double-click' : `${mouse.button ?? 'left'}-click`
  const label = `AI ${kind}${entry?.name ? ` "${entry.name.slice(0, 28)}"` : ''}`
  await clickObjectId(objectId, label, entry?.role, entry?.frameOwners, entry?.sessionId, mouse)
}

/** Drag one ref onto another as a single held gesture. */
export async function dragRef(fromRef: string, toRef: string): Promise<void> {
  const from = await pointForRef(fromRef)
  const to = await pointForRef(toRef)
  emitAiAction({ kind: 'click', label: `AI drag ${fromRef} → ${toRef}` })
  await thinkingPause()
  await humanDrag(from, to)
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
  frameOwners?: FrameOwner[],
  sessionId?: string
): Promise<void> {
  const target = getActiveTarget()!
  emitAiAction({ kind: 'hover', label, detail: role })

  const result = (await target.dbg.sendCommand('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `async function() {
      ${SCROLL_INTO_VIEW}
      const r = this.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }`,
    returnByValue: true,
    awaitPromise: true
  }, sessionId)) as { result: { value: { x: number; y: number } } }
  // getBoundingClientRect ran inside the element's own frame, so its origin is
  // that frame — mouse events are dispatched in page space. Measured after the
  // scrollIntoView above, which moves the page under the frame.
  const frameOffset = await measureFrameOffset(frameOwners)
  const x = result.result.value.x + frameOffset.x
  const y = result.result.value.y + frameOffset.y

  await thinkingPause()
  await humanMouseMove(x, y)

  await target.dbg.sendCommand('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function(label) {
      if (window.__reverAi) window.__reverAi.flashElement(this, label, 'hover')
    }`,
    arguments: [{ value: label }]
  }, sessionId)
}

/** Core type: same human-shaped sequence as clickObjectId, then focus + type
 * (+ optional Enter) via real CDP key events. Shared by typeRef/typeSelector. */
async function typeObjectId(
  objectId: string,
  text: string,
  submit: boolean,
  label: string,
  role?: string,
  frameOwners?: FrameOwner[],
  sessionId?: string
): Promise<void> {
  const target = getActiveTarget()!
  emitAiAction({ kind: 'type', label, detail: text.slice(0, 80) })

  const result = (await target.dbg.sendCommand('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `async function() {
      ${SCROLL_INTO_VIEW}
      const r = this.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }`,
    returnByValue: true,
    awaitPromise: true
  }, sessionId)) as { result: { value: { x: number; y: number } } }
  // getBoundingClientRect ran inside the element's own frame, so its origin is
  // that frame — mouse events are dispatched in page space. Measured after the
  // scrollIntoView above, which moves the page under the frame.
  const frameOffset = await measureFrameOffset(frameOwners)
  const x = result.result.value.x + frameOffset.x
  const y = result.result.value.y + frameOffset.y

  await thinkingPause()
  await humanMouseMove(x, y)

  await target.dbg.sendCommand('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function(label) {
      if (window.__reverAi) window.__reverAi.flashElement(this, label, 'type')
    }`,
    arguments: [{ value: label }]
  }, sessionId)
  await humanPressRelease(x, y)
  await humanType(objectId, text, submit, sessionId)
}

export async function clickRef(ref: string): Promise<void> {
  const entry = refMap.get(ref)
  const objectId = await resolveObjectId(ref)
  const label = `AI click${entry?.name ? ` "${entry.name.slice(0, 32)}"` : ''}`
  await clickObjectId(objectId, label, entry?.role, entry?.frameOwners, entry?.sessionId)
}

export async function typeRef(ref: string, text: string, submit: boolean): Promise<void> {
  const entry = refMap.get(ref)
  const objectId = await resolveObjectId(ref)
  const label = `AI type${entry?.name ? ` → "${entry.name.slice(0, 24)}"` : ''}`
  await typeObjectId(
    objectId,
    text,
    submit,
    label,
    entry?.role,
    entry?.frameOwners,
    entry?.sessionId
  )
}

/**
 * Choose option(s) in a `<select>`.
 *
 * A native dropdown has no DOM to click: the option list is drawn by the OS,
 * so the click and type paths cannot reach it. Setting `selected` and firing
 * input/change is what Playwright does too, and it is the only way a form
 * gated on a select can be completed — a real one blocked a card payment on
 * its mandatory installment field, with no tool able to answer it.
 *
 * Returns the labels actually chosen. On no match the available options come
 * back in the error, so the caller can retry without another snapshot.
 */
export async function selectRef(ref: string, values: string[]): Promise<string[]> {
  const entry = refMap.get(ref)
  const objectId = await resolveObjectId(ref)
  const target = getActiveTarget()!
  emitAiAction({ kind: 'type', label: `AI select${entry?.name ? ` "${entry.name.slice(0, 24)}"` : ''}`, detail: values.join(', ') })

  const res = (await target.dbg.sendCommand(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: `function(values) {
        if (this.tagName !== 'SELECT') {
          return { error: 'ref is a <' + this.tagName.toLowerCase() + '>, not a <select>' }
        }
        const wanted = new Set(values)
        const picked = []
        for (const opt of this.options) {
          const label = (opt.label || opt.text || '').trim()
          const on = wanted.has(opt.value) || wanted.has(label)
          opt.selected = on
          if (on) picked.push(label || opt.value)
        }
        if (picked.length === 0) {
          return {
            error: 'no option matched',
            options: Array.from(this.options).map(o => (o.label || o.text || '').trim())
          }
        }
        this.dispatchEvent(new Event('input', { bubbles: true }))
        this.dispatchEvent(new Event('change', { bubbles: true }))
        return { picked }
      }`,
      arguments: [{ value: values }],
      returnByValue: true
    },
    entry?.sessionId
  )) as { result: { value: { picked?: string[]; error?: string; options?: string[] } } }

  const out = res.result.value
  if (out.error) {
    const list = out.options?.length ? ` — options: ${out.options.join(' | ')}` : ''
    throw new Error(`${out.error}${list}`)
  }
  return out.picked ?? []
}

/**
 * Give a ref keyboard focus without clicking it.
 *
 * Clicking to focus is not always equivalent: a click on a dialog's backdrop
 * dismisses it, and a click on a listbox item selects the wrong row before the
 * arrow keys ever run.
 */
export async function focusRef(ref: string): Promise<void> {
  const entry = refMap.get(ref)
  const objectId = await resolveObjectId(ref)
  const target = getActiveTarget()!
  await target.dbg.sendCommand(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: `function() {
        if (this.focus) this.focus()
        else if (this.tabIndex >= 0) this.focus()
      }`
    },
    entry?.sessionId
  )
}

export async function hoverRef(ref: string): Promise<void> {
  const entry = refMap.get(ref)
  const objectId = await resolveObjectId(ref)
  const label = `AI hover${entry?.name ? ` "${entry.name.slice(0, 32)}"` : ''}`
  await hoverObjectId(objectId, label, entry?.role, entry?.frameOwners, entry?.sessionId)
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
