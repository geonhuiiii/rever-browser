/**
 * Registry of out-of-process iframe (OOPIF) CDP sessions.
 *
 * A cross-SITE iframe runs in its own renderer, so the page's CDP session
 * cannot read it: `Accessibility.getFullAXTree({frameId})` rejects and the
 * frame never appears in `Page.getFrameTree`. `Target.setAutoAttach` with
 * `flatten: true` gives us a sessionId per such frame, and every command for
 * that frame's nodes must carry it.
 *
 * Routing is not optional. A probe against real Chrome showed the parent
 * session answering `DOM.resolveNode` for an OOPIF backendNodeId with a
 * DIFFERENT node rather than an error — backend ids are per-process and
 * collide, so an unrouted click lands on whatever shares the number.
 */
export interface OopifSession {
  sessionId: string
  /** CDP targetId, which for an iframe target is also its frameId. */
  frameId: string
  url: string
}

/** webContentsId → sessionId → session. */
const byTarget = new Map<number, Map<string, OopifSession>>()

export function registerOopif(webContentsId: number, session: OopifSession): void {
  let m = byTarget.get(webContentsId)
  if (!m) {
    m = new Map()
    byTarget.set(webContentsId, m)
  }
  m.set(session.sessionId, session)
}

export function unregisterOopif(webContentsId: number, sessionId: string): void {
  byTarget.get(webContentsId)?.delete(sessionId)
}

export function clearOopifs(webContentsId: number): void {
  byTarget.delete(webContentsId)
}

export function listOopifSessions(webContentsId: number): OopifSession[] {
  return [...(byTarget.get(webContentsId)?.values() ?? [])]
}
