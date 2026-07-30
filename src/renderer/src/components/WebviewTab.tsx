import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

import { useHistoryStore } from '@/stores/history'
import type { Tab } from '@/stores/tabs'
import { useTabsStore } from '@/stores/tabs'
import { useAppThemeStore } from '@/stores/app-theme'
import {
  originFromUrl,
  resolveWebviewTheme,
  useWebviewThemeStore
} from '@/stores/webview-theme'

interface Props {
  tab: Tab
  active: boolean
}

export interface WebviewTabHandle {
  loadURL: (url: string) => void
  goBack: () => void
  goForward: () => void
  reload: (ignoreCache?: boolean) => void
}

interface PageTitleEvent extends Event {
  title: string
}

export const WebviewTab = forwardRef<WebviewTabHandle, Props>(function WebviewTab(
  { tab, active },
  ref
) {
  const wvRef = useRef<Electron.WebviewTag>(null)
  const updateTab = useTabsStore((s) => s.updateTab)

  useImperativeHandle(
    ref,
    () => ({
      loadURL: (url) => {
        const wv = wvRef.current
        if (!wv) {
          console.warn('[webview] loadURL skipped: ref is null', url)
          return
        }
        // isLoading() throws or returns undefined before dom-ready/attach.
        // In that case defer until dom-ready fires.
        let ready = false
        try {
          ready = wv.isLoading?.() !== undefined
        } catch {
          ready = false
        }
        if (!ready) {
          const onReady = () => {
            wv.removeEventListener('dom-ready', onReady)
            wv.loadURL(url).catch((e) => console.error('[webview] loadURL failed', e))
          }
          wv.addEventListener('dom-ready', onReady)
          return
        }
        wv.loadURL(url).catch((e) => console.error('[webview] loadURL failed', e))
      },
      goBack: () => wvRef.current?.goBack(),
      goForward: () => wvRef.current?.goForward(),
      reload: (ignoreCache = false) => {
        const wv = wvRef.current
        if (!wv) return
        ignoreCache ? wv.reloadIgnoringCache() : wv.reload()
      }
    }),
    []
  )

  useEffect(() => {
    const wv = wvRef.current
    if (!wv) return
    let attached = false
    // tryAttach 성공 시 실제 id를 저장해 cleanup에서 올바르게 detach
    let attachedId: number | null = null

    const tryAttach = async () => {
      if (attached) return
      let id: number
      try {
        id = wv.getWebContentsId()
      } catch {
        return
      }
      if (!id || id <= 0) return
      const ok = await window.rev.cdp.attach(id)
      if (ok) {
        attached = true
        attachedId = id
        updateTab(tab.id, { webContentsId: id })
        void applyTheme()
      }
    }

    const pushHistory = useHistoryStore.getState().push
    const updateHistoryTitle = useHistoryStore.getState().updateTitle

    // Emulate `prefers-color-scheme` via CDP so the site serves its own
    // light/dark stylesheet. Needs the debugger attached, so this is a no-op
    // until tryAttach succeeds (which then calls it).
    const applyTheme = async () => {
      if (attachedId == null) return
      const url = useTabsStore.getState().tabs.find((t) => t.id === tab.id)?.url
      const origin = url ? originFromUrl(url) : null
      const pref = origin ? useWebviewThemeStore.getState().get(origin) : 'auto'
      await window.rev.theme.setWebviewScheme(attachedId, resolveWebviewTheme(pref))
    }

    const onNavigate = (e: Electron.DidNavigateEvent) => {
      updateTab(tab.id, { url: e.url })
      pushHistory({ tabId: tab.id, url: e.url, title: '' })
      void applyTheme()
    }
    const onNavigateInPage = (e: Electron.DidNavigateInPageEvent) => {
      updateTab(tab.id, { url: e.url })
      pushHistory({ tabId: tab.id, url: e.url, title: '' })
      void applyTheme()
    }
    const onTitle = (e: Event) => {
      const ev = e as PageTitleEvent
      if (ev.title) {
        updateTab(tab.id, { title: ev.title })
        const currentUrl = useTabsStore.getState().tabs.find((t) => t.id === tab.id)?.url
        if (currentUrl) updateHistoryTitle(tab.id, currentUrl, ev.title)
      }
    }

    const onDomReady = () => {
      void applyTheme()
    }

    const unsubTheme = useWebviewThemeStore.subscribe((state, prev) => {
      const currentUrl = useTabsStore.getState().tabs.find((t) => t.id === tab.id)?.url
      const origin = currentUrl ? originFromUrl(currentUrl) : null
      if (!origin) return
      if (state.byOrigin[origin] === prev.byOrigin[origin]) return
      void applyTheme()
    })

    // 'auto' follows the app theme, so app-theme changes must repaint the page.
    const unsubAppTheme = useAppThemeStore.subscribe((state, prev) => {
      if (state.mode === prev.mode) return
      void applyTheme()
    })
    // …and while the app theme is 'system', an OS switch changes it too.
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onSystemScheme = () => {
      if (useAppThemeStore.getState().mode === 'system') void applyTheme()
    }
    mq.addEventListener('change', onSystemScheme)

    wv.addEventListener('dom-ready', tryAttach)
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('did-attach', tryAttach)
    wv.addEventListener('did-finish-load', tryAttach)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigateInPage)
    wv.addEventListener('page-title-updated', onTitle)

    return () => {
      wv.removeEventListener('dom-ready', tryAttach)
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('did-attach', tryAttach)
      wv.removeEventListener('did-finish-load', tryAttach)
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigateInPage)
      wv.removeEventListener('page-title-updated', onTitle)
      unsubTheme()
      unsubAppTheme()
      mq.removeEventListener('change', onSystemScheme)

      // Best-effort detach when the tab unmounts (closed).
      // attachedId는 tryAttach 성공 시 기록한 실제 id (tab.webContentsId는 마운트 시점 null일 수 있음)
      if (attachedId) void window.rev.cdp.detach(attachedId)
    }
    // tab.id is stable for a tab's lifetime; don't depend on tab.url which
    // would tear down listeners on every navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])

  return (
    <webview
      ref={wvRef as unknown as React.Ref<HTMLElement>}
      src={tab.initialUrl}
      style={
        {
          flex: 1,
          minWidth: 0,
          background: 'var(--viewport-bg)',
          display: active ? 'flex' : 'none'
        } as React.CSSProperties
      }
      allowpopups={'true' as unknown as boolean}
      // Per-tab partition → isolated cookies/storage + independent proxy.
      // Must match partitionForTab() in main/tab-partition.ts.
      partition={`persist:rever-${tab.id}`}
    />
  )
})
