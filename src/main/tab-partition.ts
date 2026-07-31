// Shared browsing session. All tabs live in one persistent Electron partition
// so cookies/storage behave like a normal browser profile — logging in on one
// tab keeps you logged in on tabs opened from it (e.g. Naver cafe posts that
// open in a new tab). Per-tab isolation (independent proxy + cookie jar) is
// planned as a separate feature using dedicated windows, not tabs.
//
// IMPORTANT: the renderer uses the same string inline as the webview
// `partition` attribute in WebviewTab.tsx — keep the two in sync.

export const SHARED_PARTITION = 'persist:rever-shared'

export function partitionForTab(_tabId: string): string {
  return SHARED_PARTITION
}

// Features that act on the browsing session via the Electron `session.cookies`
// API (sticky-cookie persistence, Chrome cookie import) resolve the partition
// through these helpers. With the shared partition this is now a constant, but
// the API shape is kept so a future isolated-window feature can slot back in.
export function setActivePartition(_partition: string): void {
  // no-op while all tabs share one partition
}

export function getActivePartition(): string {
  return SHARED_PARTITION
}
