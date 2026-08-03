// Browsing sessions. Ordinary tabs live in one persistent Electron partition
// so cookies/storage behave like a normal browser profile — logging in on one
// tab keeps you logged in on tabs opened from it (e.g. Naver cafe posts that
// open in a new tab).
//
// Proxy tabs are the exception: each one gets its own in-memory partition
// (no `persist:` prefix → incognito-style, cookies vanish with the app), so a
// proxied tab browses with a separate cookie jar and its proxy applies to
// that tab alone. The renderer generates the partition name and registers it
// via the proxy:set IPC before navigating the tab.
//
// IMPORTANT: the renderer uses SHARED_PARTITION inline as the webview
// `partition` attribute default in WebviewTab.tsx — keep the two in sync.

export const SHARED_PARTITION = 'persist:rever-shared'

// tabId -> isolated partition. Entries are only added for proxy tabs; every
// other tab resolves to the shared partition. Not cleaned up on tab close —
// entries are a few bytes and tab ids are never reused within a run.
const tabPartitions = new Map<string, string>()

export function registerTabPartition(tabId: string, partition: string): void {
  tabPartitions.set(tabId, partition)
}

export function partitionForTab(tabId: string): string {
  return tabPartitions.get(tabId) ?? SHARED_PARTITION
}

// Features that act on the browsing session via the Electron `session.cookies`
// API (sticky-cookie persistence, Chrome cookie import) resolve the partition
// through these helpers so they target the visible tab's session.
let activePartition = SHARED_PARTITION

export function setActivePartition(partition: string): void {
  activePartition = partition
}

export function getActivePartition(): string {
  return activePartition
}
