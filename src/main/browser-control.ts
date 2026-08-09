import type { BrowserWindow } from 'electron'

// Single source of truth for the main window + the renderer command channel.
// index.ts owns window creation; anything else that needs to drive the tab
// strip (the WebDriver server, future automation) goes through here instead of
// importing index.ts, which would be a cycle.

let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/**
 * Forward a browser-level command (new tab, close tab, tab switching, address
 * focus, …) to the renderer, which owns the tab store. No-op when the window
 * is gone.
 */
export function sendBrowserCommand(cmd: string, extra?: { index?: number; url?: string }): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('browser-command', { cmd, ...extra })
  }
}
