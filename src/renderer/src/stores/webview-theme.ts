import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { resolveTheme, useAppThemeStore, type ResolvedTheme } from './app-theme'

export type WebviewTheme = 'auto' | 'light' | 'dark'

interface WebviewThemeState {
  byOrigin: Record<string, WebviewTheme>
  get: (origin: string) => WebviewTheme
  set: (origin: string, theme: WebviewTheme) => void
  cycle: (origin: string) => WebviewTheme
}

const ORDER: WebviewTheme[] = ['auto', 'light', 'dark']

export function originFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (!u.protocol.startsWith('http')) return null
    return u.origin
  } catch {
    return null
  }
}

export const useWebviewThemeStore = create<WebviewThemeState>()(
  persist(
    (set, get) => ({
      byOrigin: {},
      get: (origin) => get().byOrigin[origin] ?? 'auto',
      set: (origin, theme) =>
        set((s) => {
          const next = { ...s.byOrigin }
          if (theme === 'auto') delete next[origin]
          else next[origin] = theme
          return { byOrigin: next }
        }),
      cycle: (origin) => {
        const current = get().byOrigin[origin] ?? 'auto'
        const idx = ORDER.indexOf(current)
        const next = ORDER[(idx + 1) % ORDER.length]
        get().set(origin, next)
        return next
      }
    }),
    { name: 'rev:webview-theme' }
  )
)

/**
 * The `prefers-color-scheme` to emulate inside the webview. 'auto' follows the
 * app's own theme (not the OS) so an app in light mode doesn't show a dark site.
 */
export function resolveWebviewTheme(theme: WebviewTheme): ResolvedTheme {
  if (theme === 'auto') return resolveTheme(useAppThemeStore.getState().mode)
  return theme
}
