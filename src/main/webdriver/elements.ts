import { randomUUID } from 'node:crypto'

import { WebDriverError } from './protocol'

// Per-session map of WebDriver element ids ↔ live CDP RemoteObject ids.
//
// WebDriver hands the client an opaque id; every element command resolves it
// back to the objectId the CDP calls actually need. objectIds are released by
// Chromium on navigation, so a resolve that fails at the CDP layer surfaces as
// the spec's `stale element reference`, which is exactly what a client expects
// after the page changed under a saved handle.
export class ElementStore {
  private readonly byId = new Map<string, string>() // wdId -> objectId
  private readonly byObject = new Map<string, string>() // objectId -> wdId

  /** Register an objectId, reusing the id if this object is already tracked. */
  register(objectId: string): string {
    const existing = this.byObject.get(objectId)
    if (existing) return existing
    const id = randomUUID()
    this.byId.set(id, objectId)
    this.byObject.set(objectId, id)
    return id
  }

  /** Resolve a WebDriver element id to its objectId, or throw noSuchElement. */
  resolve(wdId: string): string {
    const objectId = this.byId.get(wdId)
    if (!objectId) {
      throw new WebDriverError('noSuchElement', `unknown element id: ${wdId}`)
    }
    return objectId
  }

  /** Drop everything — called when the browsing context is reset. */
  clear(): void {
    this.byId.clear()
    this.byObject.clear()
  }
}
