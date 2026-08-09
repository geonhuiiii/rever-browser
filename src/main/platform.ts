// Per-OS filesystem facts the rest of main/ needs. Everything that used to be
// a hardcoded `/Applications/...` or `~/Library/Application Support/...` string
// lives here, so adding an OS is one edit in one file rather than a grep for
// `darwin` across the tree.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const IS_MAC = process.platform === 'darwin'
export const IS_WINDOWS = process.platform === 'win32'
export const IS_LINUX = !IS_MAC && !IS_WINDOWS

/** Windows-only env dirs, empty string when the variable is unset. */
function winDir(envName: string, ...rest: string[]): string {
  const base = process.env[envName]
  return base ? join(base, ...rest) : ''
}

// ── Chrome user-data directories ────────────────────────────────────────────
// Layout is identical across platforms once you have the root: profile
// subdirectories (`Default`, `Profile 1`, …) each holding a `Cookies` SQLite
// db, plus a `Local State` JSON file at the root. Only the root differs.

/**
 * Candidate Chrome/Chromium user-data roots for this OS, most-preferred first.
 * Several are returned because a machine may have Chrome, Chrome Beta or
 * Chromium installed, and the caller wants the first one that exists.
 */
export function chromeUserDataDirs(): string[] {
  const home = homedir()
  if (IS_MAC) {
    const support = join(home, 'Library', 'Application Support')
    return [
      join(support, 'Google', 'Chrome'),
      join(support, 'Google', 'Chrome Beta'),
      join(support, 'Chromium')
    ]
  }
  if (IS_WINDOWS) {
    return [
      winDir('LOCALAPPDATA', 'Google', 'Chrome', 'User Data'),
      winDir('LOCALAPPDATA', 'Google', 'Chrome Beta', 'User Data'),
      winDir('LOCALAPPDATA', 'Chromium', 'User Data')
    ].filter(Boolean)
  }
  return [
    join(home, '.config', 'google-chrome'),
    join(home, '.config', 'google-chrome-beta'),
    join(home, '.config', 'chromium')
  ]
}

/** First existing Chrome user-data root, or null when Chrome isn't installed. */
export function chromeUserDataDir(): string | null {
  return chromeUserDataDirs().find((d) => existsSync(d)) ?? null
}

// ── Chrome executable ───────────────────────────────────────────────────────

/**
 * Candidate Chrome/Chromium executables for this OS, most-preferred first.
 * On Windows both Program Files roots are probed because a 32-bit Chrome on a
 * 64-bit machine installs under `Program Files (x86)`, and per-user installs
 * land in `%LOCALAPPDATA%`.
 */
export function chromeBinaryCandidates(): string[] {
  if (IS_MAC) {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      join(
        homedir(),
        'Applications',
        'Google Chrome.app',
        'Contents',
        'MacOS',
        'Google Chrome'
      )
    ]
  }
  if (IS_WINDOWS) {
    const rel = ['Google', 'Chrome', 'Application', 'chrome.exe']
    return [
      winDir('ProgramFiles', ...rel),
      winDir('ProgramFiles(x86)', ...rel),
      winDir('LOCALAPPDATA', ...rel),
      winDir('ProgramFiles', 'Chromium', 'Application', 'chrome.exe'),
      winDir('LOCALAPPDATA', 'Chromium', 'Application', 'chrome.exe')
    ].filter(Boolean)
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium'
  ]
}

/** Human-readable install hint used in "Chrome not found" errors. */
export function chromeInstallHint(): string {
  if (IS_MAC) return 'Install Chrome at /Applications/Google Chrome.app'
  if (IS_WINDOWS) {
    return 'Install Chrome at %ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe'
  }
  return 'Install Chrome (google-chrome) or Chromium via your package manager'
}
