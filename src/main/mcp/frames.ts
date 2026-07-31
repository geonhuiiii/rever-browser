import { getActiveTarget } from '../chrome-cdp'

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

export async function collectFrames(): Promise<{
  frames: FrameTree[]
  unreachable: number
  empty: number
}> {
  const target = getActiveTarget()
  if (!target) return { frames: [], unreachable: 0, empty: 0 }

  let ids: string[] = []
  try {
    const { frameTree } = (await target.dbg.sendCommand('Page.getFrameTree')) as {
      frameTree: FrameNode
    }
    flatten(frameTree, 1, ids)
  } catch {
    return { frames: [], unreachable: 0, empty: 0 }
  }
  if (ids.length === 0) return { frames: [], unreachable: 0, empty: 0 }
  ids = ids.slice(0, MAX_FRAMES)

  let unreachable = 0
  let empty = 0
  const frames: FrameTree[] = []

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

        // Pick the frame's document root by ROLE, not by position or by
        // reachability. nodes[0] is not reliably the root, and "the node nothing
        // claims as a child" is not either: the per-frame response carries some
        // of the parent document's nodes too, so several are unclaimed and the
        // walk can start on one that renders nothing. RootWebArea is the
        // document itself and is unambiguous.
        const claimed = new Set<string>()
        for (const n of tree.nodes) for (const c of n.childIds ?? []) claimed.add(c)
        const root =
          tree.nodes.find((n) => (n.role?.value as string | undefined) === 'RootWebArea') ??
          tree.nodes.find((n) => !claimed.has(n.nodeId) && (n.childIds?.length ?? 0) > 0) ??
          tree.nodes[0]

        frames.push({
          frameId,
          ownerBackendNodeId: owner.backendNodeId,
          byId,
          rootNodeId: root.nodeId
        })
      } catch {
        // Cross-site frames live in another renderer and reject this session.
        unreachable++
      }
    })
  )

  return { frames, unreachable, empty }
}
