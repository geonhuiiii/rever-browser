import { BrowserWindow, ipcMain } from 'electron'

// Request/response bridge from main → renderer. Needed because some state
// (saved workflows) lives in a renderer zustand store, but MCP tools run in
// main. The renderer answers on 'bridge:response' with the matching id.

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

const pending = new Map<number, Pending>()
let nextId = 1
let installed = false

export function initRendererBridge(): void {
  if (installed) return
  installed = true
  ipcMain.on(
    'bridge:response',
    (_event, msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error ?? 'renderer reported an error'))
    }
  )
}

export function askRenderer<T = unknown>(op: string, payload?: unknown, timeoutMs = 5000): Promise<T> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) return Promise.reject(new Error('no renderer window'))
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`renderer did not answer "${op}" in ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    win.webContents.send('bridge:request', { id, op, payload })
  })
}
