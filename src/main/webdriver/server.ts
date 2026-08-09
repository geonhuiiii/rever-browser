import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import { getMainWindow } from '../browser-control'
import { SPOOFED_CHROME_VERSION } from '../stealth-init'
import { WebDriverSession } from './commands'
import { ok, errorResponse, WebDriverError, type WdResponse } from './protocol'

// A W3C-conformant WebDriver HTTP endpoint in front of Rever's tabs. Point any
// Selenium client's Remote executor at the published URL and it drives the real
// browser — every action flows through the same stealthy CDP + human-input path
// the AI tools use, so a Selenium test is indistinguishable from a person.
//
// Loopback-only, and off unless REVER_WEBDRIVER=1 (see index.ts) so the port
// never opens without the user asking. The chosen port is published to
// userData/webdriver-endpoint.json since it is OS-assigned.

interface RunningServer {
  url: string
  close: () => Promise<void>
}

type Handler = (
  session: WebDriverSession,
  params: Record<string, string>,
  body: Record<string, unknown>
) => Promise<unknown> | unknown

interface Route {
  method: string
  tokens: string[] // path segments; ':name' captures
  handler: Handler
}

const READ_BODY_LIMIT = 32 * 1024 * 1024

const sessions = new Map<string, WebDriverSession>()

// ── route table ──────────────────────────────────────────────────────────────

const routes: Route[] = []
function route(method: string, template: string, handler: Handler): void {
  routes.push({ method, tokens: template.split('/').filter(Boolean), handler })
}

// Navigation
route('POST', '/session/:sessionId/url', (s, _p, b) => s.navigate(b.url as string))
route('GET', '/session/:sessionId/url', (s) => s.getCurrentUrl())
route('GET', '/session/:sessionId/title', (s) => s.getTitle())
route('POST', '/session/:sessionId/back', (s) => s.back())
route('POST', '/session/:sessionId/forward', (s) => s.forward())
route('POST', '/session/:sessionId/refresh', (s) => s.refresh())
route('GET', '/session/:sessionId/source', (s) => s.getPageSource())

// Timeouts
route('GET', '/session/:sessionId/timeouts', (s) => s.getTimeouts())
route('POST', '/session/:sessionId/timeouts', (s, _p, b) => s.setTimeouts(b))

// Windows
route('GET', '/session/:sessionId/window', (s) => s.getWindowHandle())
route('DELETE', '/session/:sessionId/window', (s) => s.closeWindow())
route('POST', '/session/:sessionId/window', (s, _p, b) => s.switchToWindow(b.handle as string))
route('GET', '/session/:sessionId/window/handles', (s) => s.getWindowHandles())
route('POST', '/session/:sessionId/window/new', (s) => s.newWindow())
route('GET', '/session/:sessionId/window/rect', () => windowRect())
route('POST', '/session/:sessionId/window/rect', (_s, _p, b) => setWindowRect(b))
route('POST', '/session/:sessionId/window/maximize', () => windowOp('maximize'))
route('POST', '/session/:sessionId/window/minimize', () => windowOp('minimize'))
route('POST', '/session/:sessionId/window/fullscreen', () => windowOp('fullscreen'))

// Frames
route('POST', '/session/:sessionId/frame', (s, _p, b) => s.switchToFrame(b.id))
route('POST', '/session/:sessionId/frame/parent', (s) => s.switchToParentFrame())

// Finding
route('POST', '/session/:sessionId/element', (s, _p, b) => s.findElement(b.using, b.value))
route('POST', '/session/:sessionId/elements', (s, _p, b) => s.findElements(b.using, b.value))
route('POST', '/session/:sessionId/element/:elementId/element', (s, p, b) =>
  s.findElementFromElement(p.elementId, b.using, b.value)
)
route('POST', '/session/:sessionId/element/:elementId/elements', (s, p, b) =>
  s.findElementsFromElement(p.elementId, b.using, b.value)
)
route('GET', '/session/:sessionId/element/active', (s) => s.getActiveElement())

// Element state
route('GET', '/session/:sessionId/element/:elementId/text', (s, p) => s.getElementText(p.elementId))
route('GET', '/session/:sessionId/element/:elementId/name', (s, p) => s.getElementTagName(p.elementId))
route('GET', '/session/:sessionId/element/:elementId/attribute/:name', (s, p) =>
  s.getElementAttribute(p.elementId, p.name)
)
route('GET', '/session/:sessionId/element/:elementId/property/:name', (s, p) =>
  s.getElementProperty(p.elementId, p.name)
)
route('GET', '/session/:sessionId/element/:elementId/css/:name', (s, p) =>
  s.getElementCssValue(p.elementId, p.name)
)
route('GET', '/session/:sessionId/element/:elementId/rect', (s, p) => s.getElementRect(p.elementId))
route('GET', '/session/:sessionId/element/:elementId/enabled', (s, p) => s.isElementEnabled(p.elementId))
route('GET', '/session/:sessionId/element/:elementId/selected', (s, p) => s.isElementSelected(p.elementId))
route('GET', '/session/:sessionId/element/:elementId/displayed', (s, p) => s.isElementDisplayed(p.elementId))
route('GET', '/session/:sessionId/element/:elementId/screenshot', (s, p) => s.elementScreenshot(p.elementId))

// Element interaction
route('POST', '/session/:sessionId/element/:elementId/click', (s, p) => s.clickElement(p.elementId))
route('POST', '/session/:sessionId/element/:elementId/clear', (s, p) => s.clearElement(p.elementId))
route('POST', '/session/:sessionId/element/:elementId/value', (s, p, b) =>
  s.sendKeysToElement(p.elementId, b.text as string)
)

// Scripts
route('POST', '/session/:sessionId/execute/sync', (s, _p, b) =>
  s.executeScript(b.script as string, (b.args as unknown[]) ?? [])
)
route('POST', '/session/:sessionId/execute/async', (s, _p, b) =>
  s.executeAsyncScript(b.script as string, (b.args as unknown[]) ?? [])
)

// Cookies
route('GET', '/session/:sessionId/cookie', (s) => s.getCookies())
route('POST', '/session/:sessionId/cookie', (s, _p, b) => s.addCookie(b.cookie as Record<string, unknown>))
route('GET', '/session/:sessionId/cookie/:name', (s, p) => s.getNamedCookie(p.name))
route('DELETE', '/session/:sessionId/cookie/:name', (s, p) => s.deleteCookie(p.name))
route('DELETE', '/session/:sessionId/cookie', (s) => s.deleteAllCookies())

// Screenshot
route('GET', '/session/:sessionId/screenshot', (s) => s.screenshot())

// Actions
route('POST', '/session/:sessionId/actions', (s, _p, b) =>
  s.performActions((b.actions as Array<Record<string, unknown>>) ?? [])
)
route('DELETE', '/session/:sessionId/actions', (s) => s.releaseActions())

// Alerts
route('GET', '/session/:sessionId/alert/text', (s) => s.getAlertText())
route('POST', '/session/:sessionId/alert/text', (s, _p, b) => s.sendAlertText(b.text as string))
route('POST', '/session/:sessionId/alert/accept', (s) => s.acceptAlert())
route('POST', '/session/:sessionId/alert/dismiss', (s) => s.dismissAlert())

// ── window helpers (app window, not the webview) ─────────────────────────────

function windowRect(): Record<string, number> {
  const win = getMainWindow()
  if (!win) throw new WebDriverError('noSuchWindow', 'no app window')
  const b = win.getBounds()
  return { x: b.x, y: b.y, width: b.width, height: b.height }
}

function setWindowRect(body: Record<string, unknown>): Record<string, number> {
  const win = getMainWindow()
  if (!win) throw new WebDriverError('noSuchWindow', 'no app window')
  const cur = win.getBounds()
  win.setBounds({
    x: typeof body.x === 'number' ? body.x : cur.x,
    y: typeof body.y === 'number' ? body.y : cur.y,
    width: typeof body.width === 'number' ? body.width : cur.width,
    height: typeof body.height === 'number' ? body.height : cur.height
  })
  return windowRect()
}

function windowOp(op: 'maximize' | 'minimize' | 'fullscreen'): Record<string, number> {
  const win = getMainWindow()
  if (!win) throw new WebDriverError('noSuchWindow', 'no app window')
  if (op === 'maximize') win.maximize()
  else if (op === 'minimize') win.minimize()
  else win.setFullScreen(!win.isFullScreen())
  return windowRect()
}

// ── new session / status / quit ──────────────────────────────────────────────

function buildCapabilities(): Record<string, unknown> {
  return {
    browserName: 'chrome',
    browserVersion: SPOOFED_CHROME_VERSION,
    platformName: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
    acceptInsecureCerts: false,
    pageLoadStrategy: 'normal',
    setWindowRect: true,
    strictFileInteractability: false,
    unhandledPromptBehavior: 'dismiss and notify',
    'rever:browser': 'rever-browser'
  }
}

function newSession(): WdResponse {
  const id = randomUUID()
  sessions.set(id, new WebDriverSession(id))
  return ok({ sessionId: id, capabilities: buildCapabilities() })
}

function quitSession(sessionId: string): WdResponse {
  sessions.delete(sessionId)
  return ok(null)
}

function status(): WdResponse {
  return ok({ ready: true, message: 'Rever WebDriver ready' })
}

// ── request handling ─────────────────────────────────────────────────────────

function matchRoute(method: string, segments: string[]): { route: Route; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method || r.tokens.length !== segments.length) continue
    const params: Record<string, string> = {}
    let good = true
    for (let i = 0; i < r.tokens.length; i++) {
      const tok = r.tokens[i]
      if (tok.startsWith(':')) params[tok.slice(1)] = decodeURIComponent(segments[i])
      else if (tok !== segments[i]) {
        good = false
        break
      }
    }
    if (good) return { route: r, params }
  }
  return null
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > READ_BODY_LIMIT) {
        reject(new WebDriverError('invalidArgument', 'request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {})
      } catch {
        reject(new WebDriverError('invalidArgument', 'body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, r: WdResponse): void {
  const payload = JSON.stringify(r.body)
  res.statusCode = r.status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.end(payload)
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const segments = url.pathname.split('/').filter(Boolean)
  const method = (req.method ?? 'GET').toUpperCase()

  // Special, session-independent endpoints.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'status') {
    return send(res, status())
  }
  if (method === 'POST' && segments.length === 1 && segments[0] === 'session') {
    // Body is read (and ignored beyond validation) so the socket drains.
    try {
      await readBody(req)
    } catch (e) {
      return send(res, errorResponse(e))
    }
    return send(res, newSession())
  }
  if (method === 'DELETE' && segments.length === 2 && segments[0] === 'session') {
    return send(res, quitSession(decodeURIComponent(segments[1])))
  }

  const match = matchRoute(method, segments)
  if (!match) {
    return send(res, errorResponse(new WebDriverError('unknownCommand', `${method} ${url.pathname}`)))
  }

  const session = sessions.get(match.params.sessionId)
  if (!session) {
    return send(res, errorResponse(new WebDriverError('invalidSessionId', 'no such session')))
  }

  let body: Record<string, unknown> = {}
  if (method === 'POST') {
    try {
      body = await readBody(req)
    } catch (e) {
      return send(res, errorResponse(e))
    }
  }

  try {
    const value = await match.route.handler(session, match.params, body)
    return send(res, ok(value))
  } catch (e) {
    return send(res, errorResponse(e))
  }
}

// ── lifecycle ────────────────────────────────────────────────────────────────

function endpointFilePath(): string {
  return path.join(app.getPath('userData'), 'webdriver-endpoint.json')
}

let cached: Promise<RunningServer> | null = null

export function startWebDriverServer(): Promise<RunningServer> {
  if (cached) return cached
  cached = (async () => {
    const server = createServer((req, res) => {
      handle(req, res).catch((e) => {
        if (!res.headersSent) send(res, errorResponse(e))
      })
    })

    const preferred = Number(process.env.REVER_WEBDRIVER_PORT) || 0
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(preferred, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('failed to bind WebDriver server')
    const url = `http://127.0.0.1:${addr.port}`
    console.log('[webdriver] listening on', url)
    try {
      writeFileSync(
        endpointFilePath(),
        JSON.stringify({ url, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)
      )
    } catch (e) {
      console.warn('[webdriver] could not publish endpoint file:', e)
    }

    app.on('before-quit', () => {
      try {
        rmSync(endpointFilePath(), { force: true })
      } catch {}
    })

    return {
      url,
      async close() {
        try {
          rmSync(endpointFilePath(), { force: true })
        } catch {}
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  })()
  return cached
}
