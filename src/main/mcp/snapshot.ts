import { emitAiAction } from '../ai-events'
import { getActiveTarget } from '../chrome-cdp'
import { humanMouseMove, humanPressRelease, humanType, thinkingPause } from './human-input'
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
}

const refMap = new Map<string, RefEntry>()

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

    if (!lay.rendered || lay.occluded) {
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
  const [axRes, layout] = await Promise.all([
    target.dbg.sendCommand('Accessibility.getFullAXTree') as Promise<{ nodes: AXNode[] }>,
    scanClickable()
      .catch(() => null)
      .then((click) => capturePageLayout(viewport, click?.paths).catch(() => null))
  ])
  const { nodes } = axRes

  const byId = new Map<string, AXNode>()
  for (const n of nodes) byId.set(n.nodeId, n)

  const build = (
    filter: PageLayout | null,
    prune: boolean
  ): { tree: string; stats: SnapshotStats } => {
    refMap.clear()
    let counter = 0
    let clickOnlyRefs = 0
    const lines: string[] = []

    const walk = (
      id: string,
      depth: number,
      parentName: string,
      ancestorClaimed: boolean
    ): void => {
      const n = byId.get(id)
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
      if (prune && lay && (!lay.rendered || lay.occluded || !lay.inViewport)) return

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
        if (!name || name === parentName) return
        lines.push(`${'  '.repeat(depth)}- text ${quote(name)}`)
        return
      }

      const skip = !claimable && (!role || n.ignored || (SKIP_ROLES.has(role) && !name))
      let nextDepth = depth

      if (!skip) {
        // A click-scan node has no ARIA role or name by definition, so it would
        // print as a bare `- generic [ref=r4]`. Label it by its own text so the
        // agent can tell what it is about to click.
        const label = claimable && (!role || SKIP_ROLES.has(role)) ? 'clickable' : role
        const shownName = name || (claimable ? firstText(n, byId) : '')

        const parts: string[] = [`- ${label}`]
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
          const r = `r${counter}`
          refMap.set(r, {
            backendNodeId: n.backendDOMNodeId,
            role: role || 'clickable',
            name: shownName
          })
          parts.push(`[ref=${r}]`)
          if (claimable) parts.push('(click-scan)')
        }

        lines.push(`${'  '.repeat(depth)}${parts.join(' ')}`)
        nextDepth = depth + 1
      }

      const childParentName = skip ? parentName : name
      for (const c of n.childIds ?? []) {
        walk(c, nextDepth, childParentName, ancestorClaimed || claimable)
      }

    }

    if (nodes[0]) walk(nodes[0].nodeId, 0, '', false)

    if (!filter || !prune) {
      return {
        tree: lines.join('\n'),
        stats: {
          refs: counter,
          hidden: 0,
          offscreen: 0,
          clickOnlyRefs,
          clickScanned: filter?.clickScanned ?? 0,
          clickMatched: filter?.clickMatched ?? 0,
          fellBackToFull: false
        }
      }
    }

    const tally = tallyFiltered(nodes, filter)
    return {
      tree: [...lines, ...describeOffscreen(tally)].join('\n'),
      stats: {
        refs: counter,
        hidden: tally.hidden,
        offscreen: tally.below + tally.above + tally.side,
        clickOnlyRefs,
        clickScanned: filter.clickScanned,
        clickMatched: filter.clickMatched,
        fellBackToFull: false
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
      result.stats.fellBackToFull = true
    }
  }

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
async function clickObjectId(objectId: string, label: string, role?: string): Promise<void> {
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
  const { x, y } = result.result.value

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
async function hoverObjectId(objectId: string, label: string, role?: string): Promise<void> {
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
  const { x, y } = result.result.value

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
  role?: string
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
  const { x, y } = result.result.value

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
  await clickObjectId(objectId, label, entry?.role)
}

export async function typeRef(ref: string, text: string, submit: boolean): Promise<void> {
  const entry = refMap.get(ref)
  const objectId = await resolveObjectId(ref)
  const label = `AI type${entry?.name ? ` → "${entry.name.slice(0, 24)}"` : ''}`
  await typeObjectId(objectId, text, submit, label, entry?.role)
}

export async function hoverRef(ref: string): Promise<void> {
  const entry = refMap.get(ref)
  const objectId = await resolveObjectId(ref)
  const label = `AI hover${entry?.name ? ` "${entry.name.slice(0, 32)}"` : ''}`
  await hoverObjectId(objectId, label, entry?.role)
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
