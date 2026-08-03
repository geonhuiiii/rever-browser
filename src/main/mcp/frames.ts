import { getActiveTarget } from '../chrome-cdp'

import { listOopifSessions } from './oopif'
import type { AXNode } from './snapshot'

/**
 * One child frame, resolved far enough to splice its accessibility tree into
 * the parent outline under the `<iframe>` element that owns it.
 */
export interface FrameTree {
  frameId: string
  /** backendNodeId of the owning `<iframe>` element in the PARENT document. */
  ownerBackendNodeId: number
  byId: Map<string, AXNode>
  rootNodeId: string
  /**
   * CDP session the frame's nodes belong to. Absent means the page session.
   * Present for an out-of-process frame, and every later command about one of
   * its nodes must carry it — backend ids are per-process, so the page session
   * answers with a different node instead of an error.
   */
  sessionId?: string
  /** Document URL, used to label a frame that has no anchor in the outline. */
  url?: string
  /** Session holding the owning `<iframe>`. Undefined means the page session. */
  ownerSessionId?: string
}

/** Frames deeper than this are ignored; matches the iframe nesting seen in practice. */
const MAX_DEPTH = 5

/** Hard cap so an ad-riddled page cannot turn one snapshot into hundreds of calls. */
const MAX_FRAMES = 24

interface FrameNode {
  frame: { id: string; parentId?: string; url?: string }
  childFrames?: FrameNode[]
}

function flatten(node: FrameNode, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FRAMES) return
  for (const child of node.childFrames ?? []) {
    out.push(child.frame.id)
    flatten(child, depth + 1, out)
  }
}

/**
 * Collect the accessibility tree of every reachable child frame.
 *
 * `Accessibility.getFullAXTree` with no arguments returns the main frame only —
 * a fixture run showed all three iframes rendering as a bare `- Iframe "..."`
 * node with nothing under it, same-origin included. Payment widgets, embedded
 * auth and OAuth consent screens all live in frames, and those are the highest
 * value targets for reversing, so the tree has to be fetched per frame.
 *
 * Out-of-process frames (a cross-SITE iframe, which Chrome puts in its own
 * renderer) reject the call on this session; they need a separate CDP session
 * and are reported by the caller rather than silently dropped.
 */
/** A tree this small is a bare document root — the frame has not painted yet. */
const EMPTY_TREE_NODES = 2

/** One short retry for a frame that answered before it had content. */
const RETRY_DELAY_MS = 150

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Pick the frame's document root by ROLE, not by position or by reachability.
 * nodes[0] is not reliably the root, and "the node nothing claims as a child"
 * is not either: a per-frame response carries some of the parent document's
 * nodes too, so several are unclaimed and the walk can start on one that
 * renders nothing. RootWebArea is the document itself and is unambiguous.
 */
function pickRoot(nodes: AXNode[]): AXNode {
  const claimed = new Set<string>()
  for (const n of nodes) for (const c of n.childIds ?? []) claimed.add(c)
  return (
    nodes.find((n) => (n.role?.value as string | undefined) === 'RootWebArea') ??
    nodes.find((n) => !claimed.has(n.nodeId) && (n.childIds?.length ?? 0) > 0) ??
    nodes[0]
  )
}

/**
 * Trees for the out-of-process frames attached by `Target.setAutoAttach`.
 *
 * The AX tree comes from the frame's own session; the owning `<iframe>` is
 * looked up on the PAGE session, because that element lives in the parent
 * document. An OOPIF is absent from `Page.getFrameTree`, so these frames are
 * invisible to collectFrames and are collected separately.
 */
async function collectOopifFrames(): Promise<{ frames: FrameTree[]; unreachable: number }> {
  const target = getActiveTarget()
  if (!target) return { frames: [], unreachable: 0 }
  const sessions = listOopifSessions(target.wc.id).slice(0, MAX_FRAMES)
  if (sessions.length === 0) return { frames: [], unreachable: 0 }

  let unreachable = 0
  const frames: FrameTree[] = []

  await Promise.all(
    sessions.map(async (s) => {
      try {
        const axTree = (): Promise<{ nodes: AXNode[] }> =>
          target.dbg.sendCommand('Accessibility.getFullAXTree', {}, s.sessionId) as Promise<{
            nodes: AXNode[]
          }>

        // targetInfo.url is empty at attach time, so the URL is read from the
        // frame itself. Concurrent with the other two, so it costs no latency.
        const [owner, first, loc] = await Promise.all([
          target.dbg.sendCommand(
            'DOM.getFrameOwner',
            { frameId: s.frameId },
            s.parentSessionId
          ) as Promise<{ backendNodeId: number }>,
          axTree(),
          target.dbg
            .sendCommand(
              'Runtime.evaluate',
              { expression: 'location.href', returnByValue: true },
              s.sessionId
            )
            .catch(() => null) as Promise<{ result: { value: string } } | null>
        ])

        let tree = first
        if ((tree?.nodes?.length ?? 0) <= EMPTY_TREE_NODES) {
          await sleep(RETRY_DELAY_MS)
          tree = await axTree().catch(() => tree)
        }
        if (!tree?.nodes?.length || owner?.backendNodeId == null) {
          unreachable++
          return
        }

        const byId = new Map<string, AXNode>()
        for (const n of tree.nodes) byId.set(n.nodeId, n)

        frames.push({
          frameId: s.frameId,
          ownerBackendNodeId: owner.backendNodeId,
          byId,
          rootNodeId: pickRoot(tree.nodes).nodeId,
          sessionId: s.sessionId,
          url: loc?.result?.value || s.url || undefined,
          ownerSessionId: s.parentSessionId
        })
      } catch {
        unreachable++
      }
    })
  )

  return { frames, unreachable }
}

export async function collectFrames(): Promise<{
  frames: FrameTree[]
  unreachable: number
  empty: number
}> {
  const target = getActiveTarget()
  if (!target) return { frames: [], unreachable: 0, empty: 0 }

  // Out-of-process frames are absent from Page.getFrameTree, so they are
  // gathered from the auto-attached sessions instead and merged in below.
  const oopif = await collectOopifFrames().catch(() => ({ frames: [], unreachable: 0 }))

  let ids: string[] = []
  try {
    const { frameTree } = (await target.dbg.sendCommand('Page.getFrameTree')) as {
      frameTree: FrameNode
    }
    flatten(frameTree, 1, ids)
  } catch {
    return { frames: oopif.frames, unreachable: oopif.unreachable, empty: 0 }
  }
  if (ids.length === 0) {
    return { frames: oopif.frames, unreachable: oopif.unreachable, empty: 0 }
  }
  ids = ids.slice(0, MAX_FRAMES)

  let unreachable = oopif.unreachable
  let empty = 0
  const frames: FrameTree[] = [...oopif.frames]

  await Promise.all(
    ids.map(async (frameId) => {
      try {
        const axTree = (): Promise<{ nodes: AXNode[] }> =>
          target.dbg.sendCommand('Accessibility.getFullAXTree', { frameId }) as Promise<{
            nodes: AXNode[]
          }>

        const [owner, first] = await Promise.all([
          target.dbg.sendCommand('DOM.getFrameOwner', { frameId }) as Promise<{
            backendNodeId: number
          }>,
          axTree()
        ])

        // A frame that answers with nothing but its root has not finished
        // loading. Retrying once turns an intermittently empty frame into a
        // reliable one; two runs of the same fixture disagreed without this.
        let tree = first
        if ((tree?.nodes?.length ?? 0) <= EMPTY_TREE_NODES) {
          await sleep(RETRY_DELAY_MS)
          tree = await axTree().catch(() => tree)
        }

        if (!tree?.nodes?.length || owner?.backendNodeId == null) {
          unreachable++
          return
        }
        if (tree.nodes.length <= EMPTY_TREE_NODES) empty++

        const byId = new Map<string, AXNode>()
        for (const n of tree.nodes) byId.set(n.nodeId, n)

        frames.push({
          frameId,
          ownerBackendNodeId: owner.backendNodeId,
          byId,
          rootNodeId: pickRoot(tree.nodes).nodeId
        })
      } catch {
        // Cross-site frames live in another renderer and reject this session.
        unreachable++
      }
    })
  )

  return { frames, unreachable, empty }
}
