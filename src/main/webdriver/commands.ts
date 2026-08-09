import {
  getActiveTarget,
  listTargets,
  setActiveTarget,
  waitForSettle,
  armDialogAnswer,
  getDialogHistory
} from '../chrome-cdp'
import { sendBrowserCommand } from '../browser-control'
import {
  humanType,
  humanMouseMove,
  humanPressRelease,
  pressKey,
  thinkingPause
} from '../mcp/human-input'
import { ElementStore } from './elements'
import { WebDriverError, elementHandle, ELEMENT_KEY } from './protocol'

// A WebDriver browsing session bound to Rever's active tab. One of these exists
// per `POST /session`. Every command drives the tab through the SAME CDP +
// human-input stack the AI tools use, so a Selenium-driven click is a real,
// stealthy, trusted mouse event — not a JS `.click()` a bot detector can spot.

interface Timeouts {
  implicit: number
  pageLoad: number
  script: number
}

type CdpResult = { result: { type: string; subtype?: string; className?: string; value?: unknown; objectId?: string; description?: string } }

const LOCATORS = new Set(['css selector', 'link text', 'partial link text', 'tag name', 'xpath'])

// WebDriver Unicode "keys" (PUA) → the named keys human-input understands.
const WD_KEY_MAP: Record<string, string> = {
  "": "Backspace",
  "": "Tab",
  "": "Enter",
  "": "Enter",
  "": "Escape",
  "": " ",
  "": "PageUp",
  "": "PageDown",
  "": "End",
  "": "Home",
  "": "ArrowLeft",
  "": "ArrowUp",
  "": "ArrowRight",
  "": "ArrowDown",
  "": "Delete"
}

// In-page finder: `this` is the search root (a document or an element). Returns
// a live array of matching elements for the given W3C locator strategy.
const FIND_SRC = `function(using, value) {
  const root = this
  const toArr = (nodes) => Array.prototype.slice.call(nodes)
  if (using === 'css selector' || using === 'tag name') return toArr(root.querySelectorAll(value))
  if (using === 'link text' || using === 'partial link text') {
    return toArr(root.querySelectorAll('a')).filter((a) => {
      const t = (a.textContent || '').trim()
      return using === 'link text' ? t === value : t.indexOf(value) !== -1
    })
  }
  if (using === 'xpath') {
    const d = root.nodeType === 9 ? root : (root.ownerDocument || document)
    const r = d.evaluate(value, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
    const out = []
    for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i))
    return out
  }
  throw new Error('invalid locator strategy: ' + using)
}`

// Page-space centre of an element after scrolling it into view. Sums same-origin
// frame offsets in-page so a click inside an <iframe> lands correctly.
const CENTER_SRC = `function() {
  this.scrollIntoView({ block: 'center', inline: 'center' })
  const r = this.getBoundingClientRect()
  let x = r.left + r.width / 2
  let y = r.top + r.height / 2
  let win = this.ownerDocument && this.ownerDocument.defaultView
  while (win && win.frameElement) {
    const fr = win.frameElement.getBoundingClientRect()
    const cs = getComputedStyle(win.frameElement)
    const n = (v) => parseFloat(v) || 0
    x += fr.left + n(cs.borderLeftWidth) + n(cs.paddingLeft)
    y += fr.top + n(cs.borderTopWidth) + n(cs.paddingTop)
    win = win.parent !== win ? win.parent : null
  }
  return { x, y }
}`

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class WebDriverSession {
  readonly id: string
  private readonly elements = new ElementStore()
  private timeouts: Timeouts = { implicit: 0, pageLoad: 300_000, script: 30_000 }
  // objectId of the document the session is "inside" (frame switching). null =
  // top document, re-resolved fresh each time so a navigation can't leave it stale.
  private docObjectId: string | null = null

  constructor(id: string) {
    this.id = id
  }

  // ── low-level CDP helpers ─────────────────────────────────────────────────

  private target() {
    const t = getActiveTarget()
    if (!t) throw new WebDriverError('noSuchWindow', 'no active browser tab')
    return t
  }

  private async cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.target().dbg.sendCommand(method, params ?? {}) as Promise<T>
  }

  private async callOn(
    objectId: string,
    fnDecl: string,
    args: Array<{ value?: unknown; objectId?: string }> = [],
    opts: { returnByValue?: boolean; awaitPromise?: boolean } = {}
  ): Promise<CdpResult> {
    try {
      return (await this.cdp('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: fnDecl,
        arguments: args,
        returnByValue: opts.returnByValue ?? true,
        awaitPromise: opts.awaitPromise ?? true
      })) as CdpResult
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (
        /Could not find object|Cannot find context|Inspected target navigated|No node with given id|Session with given id|Execution context was destroyed/i.test(
          m
        )
      ) {
        throw new WebDriverError('staleElementReference', m)
      }
      throw new WebDriverError('javascriptError', m)
    }
  }

  private async evaluateObject(expression: string): Promise<CdpResult['result']> {
    const res = (await this.cdp('Runtime.evaluate', {
      expression,
      returnByValue: false
    })) as CdpResult & { exceptionDetails?: { text: string } }
    if ('exceptionDetails' in res && res.exceptionDetails) {
      throw new WebDriverError('javascriptError', res.exceptionDetails.text)
    }
    return res.result
  }

  private async rootObjectId(): Promise<string> {
    if (this.docObjectId) return this.docObjectId
    const doc = await this.evaluateObject('document')
    if (!doc.objectId) throw new WebDriverError('noSuchWindow', 'no document in active tab')
    return doc.objectId
  }

  private resolve(wdId: string): string {
    return this.elements.resolve(wdId)
  }

  // ── session / timeouts ────────────────────────────────────────────────────

  getTimeouts(): Timeouts {
    return { ...this.timeouts }
  }

  setTimeouts(next: Partial<Timeouts>): null {
    if (typeof next.implicit === 'number') this.timeouts.implicit = next.implicit
    if (typeof next.pageLoad === 'number') this.timeouts.pageLoad = next.pageLoad
    if (typeof next.script === 'number') this.timeouts.script = next.script
    return null
  }

  // ── navigation ────────────────────────────────────────────────────────────

  async navigate(url: string): Promise<null> {
    if (typeof url !== 'string') throw new WebDriverError('invalidArgument', 'url must be a string')
    const t = this.target()
    this.docObjectId = null
    try {
      await t.wc.loadURL(url)
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      // loadURL rejects on aborted sub-loads even when the main frame committed;
      // treat only hard failures as errors.
      if (/ERR_ABORTED/i.test(m)) {
        // ignore — navigation committed
      } else {
        throw new WebDriverError('unknownError', m)
      }
    }
    await waitForSettle({ idleMs: 400, timeoutMs: Math.min(this.timeouts.pageLoad, 8000) })
    return null
  }

  async getCurrentUrl(): Promise<string> {
    return this.target().wc.getURL()
  }

  async getTitle(): Promise<string> {
    return this.target().wc.getTitle()
  }

  async back(): Promise<null> {
    this.docObjectId = null
    this.target().wc.navigationHistory.goBack()
    await waitForSettle({ idleMs: 300, timeoutMs: 5000 })
    return null
  }

  async forward(): Promise<null> {
    this.docObjectId = null
    this.target().wc.navigationHistory.goForward()
    await waitForSettle({ idleMs: 300, timeoutMs: 5000 })
    return null
  }

  async refresh(): Promise<null> {
    this.docObjectId = null
    this.target().wc.reload()
    await waitForSettle({ idleMs: 400, timeoutMs: 8000 })
    return null
  }

  async getPageSource(): Promise<string> {
    const res = (await this.cdp('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true
    })) as CdpResult
    return String(res.result.value ?? '')
  }

  // ── window handles ────────────────────────────────────────────────────────

  getWindowHandle(): string {
    const active = listTargets().find((t) => t.active)
    if (!active) throw new WebDriverError('noSuchWindow', 'no active tab')
    return String(active.id)
  }

  getWindowHandles(): string[] {
    return listTargets().map((t) => String(t.id))
  }

  switchToWindow(handle: string): null {
    const id = Number(handle)
    if (!Number.isFinite(id) || !setActiveTarget(id)) {
      throw new WebDriverError('noSuchWindow', `no window with handle ${handle}`)
    }
    this.docObjectId = null
    return null
  }

  async newWindow(): Promise<{ handle: string; type: 'tab' }> {
    const before = new Set(this.getWindowHandles())
    sendBrowserCommand('new-tab')
    const handle = await this.waitForNewHandle(before)
    return { handle, type: 'tab' }
  }

  async closeWindow(): Promise<string[]> {
    sendBrowserCommand('close-tab')
    await sleep(150)
    this.docObjectId = null
    return this.getWindowHandles()
  }

  private async waitForNewHandle(before: Set<string>, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const now = this.getWindowHandles()
      const fresh = now.find((h) => !before.has(h))
      if (fresh) {
        setActiveTarget(Number(fresh))
        this.docObjectId = null
        return fresh
      }
      await sleep(100)
    }
    throw new WebDriverError('timeout', 'no new window appeared')
  }

  // ── frames ────────────────────────────────────────────────────────────────

  async switchToFrame(id: unknown): Promise<null> {
    if (id === null || id === undefined) {
      this.docObjectId = null
      return null
    }
    if (typeof id === 'number') {
      const doc = await this.evaluateObject(
        `(function(){ var f = window.frames[${id}]; if(!f) return null; return f.document })()`
      )
      if (doc.subtype === 'null' || !doc.objectId) {
        throw new WebDriverError('noSuchFrame', `no frame at index ${id}`)
      }
      this.docObjectId = doc.objectId
      return null
    }
    if (id && typeof id === 'object' && ELEMENT_KEY in (id as Record<string, unknown>)) {
      const objectId = this.resolve((id as Record<string, string>)[ELEMENT_KEY])
      const res = await this.callOn(
        objectId,
        'function(){ return this.contentDocument }',
        [],
        { returnByValue: false }
      )
      if (res.result.subtype === 'null' || !res.result.objectId) {
        throw new WebDriverError('noSuchFrame', 'frame element has no accessible document (cross-origin?)')
      }
      this.docObjectId = res.result.objectId
      return null
    }
    throw new WebDriverError('invalidArgument', 'invalid frame identifier')
  }

  switchToParentFrame(): null {
    // Parent-chain tracking is not maintained; resetting to the top document is
    // the common "switch out of the frame" intent and always correct there.
    this.docObjectId = null
    return null
  }

  // ── element finding ───────────────────────────────────────────────────────

  private validateLocator(using: unknown, value: unknown): { using: string; value: string } {
    if (typeof using !== 'string' || !LOCATORS.has(using)) {
      throw new WebDriverError('invalidArgument', `invalid locator strategy: ${String(using)}`)
    }
    if (typeof value !== 'string') {
      throw new WebDriverError('invalidArgument', 'locator value must be a string')
    }
    return { using, value }
  }

  private async findObjectIds(rootObjectId: string, using: string, value: string): Promise<string[]> {
    const arr = await this.callOn(rootObjectId, FIND_SRC, [{ value: using }, { value }], {
      returnByValue: false
    })
    if (!arr.result.objectId) return []
    const props = (await this.cdp('Runtime.getProperties', {
      objectId: arr.result.objectId,
      ownProperties: true
    })) as { result: Array<{ name: string; enumerable: boolean; value?: { objectId?: string; subtype?: string } }> }
    return props.result
      .filter((p) => p.enumerable && /^\d+$/.test(p.name) && p.value?.objectId)
      .sort((a, b) => Number(a.name) - Number(b.name))
      .map((p) => p.value!.objectId!)
  }

  async findElement(using: unknown, value: unknown, fromObjectId?: string): Promise<Record<string, string>> {
    const loc = this.validateLocator(using, value)
    const deadline = Date.now() + this.timeouts.implicit
    for (;;) {
      const root = fromObjectId ?? (await this.rootObjectId())
      const ids = await this.findObjectIds(root, loc.using, loc.value)
      if (ids.length > 0) return elementHandle(this.elements.register(ids[0]))
      if (Date.now() >= deadline) break
      await sleep(200)
    }
    throw new WebDriverError('noSuchElement', `no element for ${loc.using}=${loc.value}`)
  }

  async findElements(using: unknown, value: unknown, fromObjectId?: string): Promise<Array<Record<string, string>>> {
    const loc = this.validateLocator(using, value)
    const deadline = Date.now() + this.timeouts.implicit
    for (;;) {
      const root = fromObjectId ?? (await this.rootObjectId())
      const ids = await this.findObjectIds(root, loc.using, loc.value)
      if (ids.length > 0) return ids.map((oid) => elementHandle(this.elements.register(oid)))
      if (Date.now() >= deadline) break
      await sleep(200)
    }
    return []
  }

  async findElementFromElement(wdId: string, using: unknown, value: unknown): Promise<Record<string, string>> {
    return this.findElement(using, value, this.resolve(wdId))
  }

  async findElementsFromElement(wdId: string, using: unknown, value: unknown): Promise<Array<Record<string, string>>> {
    return this.findElements(using, value, this.resolve(wdId))
  }

  async getActiveElement(): Promise<Record<string, string>> {
    const res = await this.evaluateObject('document.activeElement')
    if (!res.objectId) throw new WebDriverError('noSuchElement', 'no active element')
    return elementHandle(this.elements.register(res.objectId))
  }

  // ── element interaction ───────────────────────────────────────────────────

  // Enable focus emulation and wait until the page actually reports focus.
  // Emulation.setFocusEmulationEnabled resolves before document.hasFocus()
  // flips, so keystrokes dispatched immediately after enabling it are dropped
  // (the first sendKeys after a navigation lost its text). Poll briefly to close
  // that race; idempotent, so calling it on every sendKeys is cheap once warm.
  private async ensureRendererFocus(): Promise<void> {
    await this.cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined)
    const deadline = Date.now() + 800
    for (;;) {
      const res = (await this.cdp('Runtime.evaluate', {
        expression: 'document.hasFocus()',
        returnByValue: true
      })) as CdpResult
      if (res.result.value === true) return
      if (Date.now() >= deadline) return // proceed anyway; better than hanging
      await sleep(40)
    }
  }

  private async centerOf(objectId: string): Promise<{ x: number; y: number }> {
    const res = await this.callOn(objectId, CENTER_SRC, [], { awaitPromise: false })
    const v = res.result.value as { x: number; y: number }
    return v
  }

  async clickElement(wdId: string): Promise<null> {
    const objectId = this.resolve(wdId)
    const { x, y } = await this.centerOf(objectId)
    await thinkingPause()
    await humanMouseMove(x, y)
    // Cosmetic highlight, ignored if the overlay isn't present.
    await this.callOn(
      objectId,
      "function(l){ if (window.__reverAi) window.__reverAi.flashElement(this, l, 'click') }",
      [{ value: 'WebDriver click' }],
      { awaitPromise: false }
    ).catch(() => undefined)
    await humanPressRelease(x, y)
    await waitForSettle({ idleMs: 250, timeoutMs: 3000 })
    return null
  }

  async clearElement(wdId: string): Promise<null> {
    const objectId = this.resolve(wdId)
    await this.callOn(
      objectId,
      `function(){
        this.focus()
        if (this.isContentEditable) { this.textContent = '' }
        else if ('value' in this) { this.value = '' }
        this.dispatchEvent(new Event('input', { bubbles: true }))
        this.dispatchEvent(new Event('change', { bubbles: true }))
      }`,
      [],
      { awaitPromise: false }
    )
    return null
  }

  async sendKeysToElement(wdId: string, text: string): Promise<null> {
    if (typeof text !== 'string') throw new WebDriverError('invalidArgument', 'text must be a string')
    const objectId = this.resolve(wdId)
    // Grant the renderer keyboard focus. An automated browser is usually not the
    // frontmost OS window (backgrounded, minimised, headless), and Chromium
    // DROPS dispatched key events when the page is deemed unfocused — the typed
    // text silently never arrives. Focus emulation makes it behave as frontmost.
    await this.ensureRendererFocus()
    // Focus first so a leading special key (e.g. Enter) lands in the element.
    await this.callOn(objectId, 'function(){ this.focus() }', [], { awaitPromise: false })

    // Split into runs of ordinary text (typed with human timing) and special
    // keys (dispatched as real keydown/keyup).
    let buf = ''
    const flush = async (): Promise<void> => {
      if (!buf) return
      await humanType(objectId, buf, false)
      buf = ''
    }
    for (const ch of Array.from(text)) {
      const mapped = WD_KEY_MAP[ch]
      if (mapped === undefined) {
        buf += ch
        continue
      }
      await flush()
      if (mapped === ' ') buf += ' '
      else await pressKey(mapped)
    }
    await flush()
    return null
  }

  async getElementText(wdId: string): Promise<string> {
    const res = await this.callOn(
      this.resolve(wdId),
      'function(){ return (this.innerText !== undefined ? this.innerText : this.textContent) || "" }'
    )
    return String(res.result.value ?? '')
  }

  async getElementTagName(wdId: string): Promise<string> {
    const res = await this.callOn(this.resolve(wdId), 'function(){ return this.tagName.toLowerCase() }')
    return String(res.result.value ?? '')
  }

  async getElementAttribute(wdId: string, name: string): Promise<string | null> {
    const res = await this.callOn(
      this.resolve(wdId),
      `function(n){
        if (n in this && typeof this[n] === 'boolean') return this[n] ? 'true' : null
        const a = this.getAttribute(n)
        return a
      }`,
      [{ value: name }]
    )
    const v = res.result.value
    return v == null ? null : String(v)
  }

  async getElementProperty(wdId: string, name: string): Promise<unknown> {
    const res = await this.callOn(
      this.resolve(wdId),
      'function(n){ const v = this[n]; return (v === undefined || typeof v === "function" || typeof v === "object") ? (v == null ? null : String(v)) : v }',
      [{ value: name }]
    )
    return res.result.value ?? null
  }

  async getElementCssValue(wdId: string, prop: string): Promise<string> {
    const res = await this.callOn(
      this.resolve(wdId),
      'function(p){ return getComputedStyle(this).getPropertyValue(p) }',
      [{ value: prop }]
    )
    return String(res.result.value ?? '')
  }

  async getElementRect(wdId: string): Promise<{ x: number; y: number; width: number; height: number }> {
    const res = await this.callOn(
      this.resolve(wdId),
      `function(){
        const r = this.getBoundingClientRect()
        return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height }
      }`
    )
    return res.result.value as { x: number; y: number; width: number; height: number }
  }

  async isElementEnabled(wdId: string): Promise<boolean> {
    const res = await this.callOn(this.resolve(wdId), 'function(){ return !this.disabled }')
    return Boolean(res.result.value)
  }

  async isElementSelected(wdId: string): Promise<boolean> {
    const res = await this.callOn(
      this.resolve(wdId),
      'function(){ return !!(this.checked || this.selected) }'
    )
    return Boolean(res.result.value)
  }

  async isElementDisplayed(wdId: string): Promise<boolean> {
    const res = await this.callOn(
      this.resolve(wdId),
      `function(){
        const s = getComputedStyle(this)
        if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false
        if (parseFloat(s.opacity) === 0) return false
        const r = this.getBoundingClientRect()
        if (r.width === 0 && r.height === 0 && this.getClientRects().length === 0) return false
        return true
      }`
    )
    return Boolean(res.result.value)
  }

  // ── script execution ──────────────────────────────────────────────────────

  private async serialiseArgs(
    args: unknown[]
  ): Promise<Array<{ value?: unknown; objectId?: string }>> {
    return args.map((a) => {
      if (a && typeof a === 'object' && ELEMENT_KEY in (a as Record<string, unknown>)) {
        return { objectId: this.resolve((a as Record<string, string>)[ELEMENT_KEY]) }
      }
      return { value: a }
    })
  }

  // Recursively convert a CDP RemoteObject back to a JSON value, turning DOM
  // nodes into WebDriver element handles so `return document.body` works.
  private async deserialise(remote: CdpResult['result']): Promise<unknown> {
    if (remote.subtype === 'node' && remote.objectId) {
      return elementHandle(this.elements.register(remote.objectId))
    }
    if (remote.subtype === 'null' || remote.type === 'undefined') return null
    if (remote.type !== 'object') return remote.value
    if (!remote.objectId) return remote.value ?? null
    const props = (await this.cdp('Runtime.getProperties', {
      objectId: remote.objectId,
      ownProperties: true
    })) as { result: Array<{ name: string; enumerable: boolean; value?: CdpResult['result'] }> }
    const enumer = props.result.filter((p) => p.enumerable && p.value)
    if (remote.className === 'Array') {
      const items = enumer.filter((p) => /^\d+$/.test(p.name)).sort((a, b) => Number(a.name) - Number(b.name))
      return Promise.all(items.map((p) => this.deserialise(p.value!)))
    }
    const out: Record<string, unknown> = {}
    for (const p of enumer) out[p.name] = await this.deserialise(p.value!)
    return out
  }

  async executeScript(script: string, args: unknown[]): Promise<unknown> {
    if (typeof script !== 'string') throw new WebDriverError('invalidArgument', 'script must be a string')
    const win = await this.evaluateObject('window')
    if (!win.objectId) throw new WebDriverError('javascriptError', 'no window object')
    const converted = await this.serialiseArgs(Array.isArray(args) ? args : [])
    const res = await this.callOn(win.objectId, `function(){ ${script} }`, converted, {
      returnByValue: false,
      awaitPromise: true
    })
    return this.deserialise(res.result)
  }

  async executeAsyncScript(script: string, args: unknown[]): Promise<unknown> {
    if (typeof script !== 'string') throw new WebDriverError('invalidArgument', 'script must be a string')
    const win = await this.evaluateObject('window')
    if (!win.objectId) throw new WebDriverError('javascriptError', 'no window object')
    const converted = await this.serialiseArgs(Array.isArray(args) ? args : [])
    // The last argument the page sees is the completion callback (W3C async).
    const wrapper = `function(){
      const __args = Array.prototype.slice.call(arguments)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('script timeout')), ${this.timeouts.script})
        const done = (v) => { clearTimeout(timer); resolve(v) }
        __args.push(done)
        try { (function(){ ${script} }).apply(window, __args) }
        catch (e) { clearTimeout(timer); reject(e) }
      })
    }`
    try {
      const res = await this.callOn(win.objectId, wrapper, converted, {
        returnByValue: false,
        awaitPromise: true
      })
      return this.deserialise(res.result)
    } catch (e) {
      if (e instanceof WebDriverError && /script timeout/i.test(e.message)) {
        throw new WebDriverError('scriptTimeout', 'async script timed out')
      }
      throw e
    }
  }

  // ── cookies ───────────────────────────────────────────────────────────────

  async getCookies(): Promise<Array<Record<string, unknown>>> {
    const url = await this.getCurrentUrl()
    const res = (await this.cdp('Network.getCookies', { urls: [url] })) as {
      cookies: Array<Record<string, unknown>>
    }
    return res.cookies.map((c) => this.toWdCookie(c))
  }

  async getNamedCookie(name: string): Promise<Record<string, unknown>> {
    const all = await this.getCookies()
    const found = all.find((c) => c.name === name)
    if (!found) throw new WebDriverError('noSuchCookie', `no cookie named ${name}`)
    return found
  }

  async addCookie(cookie: Record<string, unknown>): Promise<null> {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') {
      throw new WebDriverError('invalidArgument', 'cookie requires string name and value')
    }
    const url = await this.getCurrentUrl()
    const params: Record<string, unknown> = {
      name: cookie.name,
      value: cookie.value,
      url,
      ...(typeof cookie.path === 'string' ? { path: cookie.path } : {}),
      ...(typeof cookie.domain === 'string' ? { domain: cookie.domain } : {}),
      ...(typeof cookie.secure === 'boolean' ? { secure: cookie.secure } : {}),
      ...(typeof cookie.httpOnly === 'boolean' ? { httpOnly: cookie.httpOnly } : {}),
      ...(typeof cookie.sameSite === 'string' ? { sameSite: this.toCdpSameSite(cookie.sameSite) } : {}),
      ...(typeof cookie.expiry === 'number' ? { expires: cookie.expiry } : {})
    }
    const res = (await this.cdp('Network.setCookie', params)) as { success?: boolean }
    if (res && res.success === false) {
      throw new WebDriverError('unableToSetCookie', `could not set cookie ${cookie.name}`)
    }
    return null
  }

  async deleteCookie(name: string): Promise<null> {
    const url = await this.getCurrentUrl()
    await this.cdp('Network.deleteCookies', { name, url })
    return null
  }

  async deleteAllCookies(): Promise<null> {
    const cookies = await this.getCookies()
    const url = await this.getCurrentUrl()
    for (const c of cookies) {
      await this.cdp('Network.deleteCookies', { name: c.name, url })
    }
    return null
  }

  private toWdCookie(c: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {
      name: c.name,
      value: c.value,
      path: c.path ?? '/',
      domain: c.domain ?? '',
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly)
    }
    if (typeof c.expires === 'number' && c.expires > 0) out.expiry = Math.floor(c.expires)
    if (typeof c.sameSite === 'string') out.sameSite = c.sameSite
    return out
  }

  private toCdpSameSite(v: string): string {
    const l = v.toLowerCase()
    if (l === 'lax') return 'Lax'
    if (l === 'strict') return 'Strict'
    if (l === 'none') return 'None'
    return 'Lax'
  }

  // ── screenshots ───────────────────────────────────────────────────────────

  async screenshot(): Promise<string> {
    const img = await this.target().wc.capturePage()
    return img.toPNG().toString('base64')
  }

  async elementScreenshot(wdId: string): Promise<string> {
    const objectId = this.resolve(wdId)
    const res = await this.callOn(
      objectId,
      `function(){
        this.scrollIntoView({ block: 'center', inline: 'center' })
        const r = this.getBoundingClientRect()
        return { x: r.left, y: r.top, width: r.width, height: r.height }
      }`
    )
    const rect = res.result.value as { x: number; y: number; width: number; height: number }
    const img = await this.target().wc.capturePage({
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height))
    })
    return img.toPNG().toString('base64')
  }

  // ── alerts (best-effort) ──────────────────────────────────────────────────
  // Rever answers JS dialogs in-page (they never block the renderer), so there
  // is no live modal to accept/dismiss. We expose the spec surface: arm the
  // answer the NEXT dialog will get, and read the most recent dialog's text.

  async getAlertText(): Promise<string> {
    const hist = getDialogHistory(1)
    if (!hist.length) throw new WebDriverError('noSuchAlert', 'no dialog has appeared')
    return hist[0].message ?? ''
  }

  async acceptAlert(): Promise<null> {
    await armDialogAnswer(true)
    return null
  }

  async dismissAlert(): Promise<null> {
    await armDialogAnswer(false)
    return null
  }

  async sendAlertText(text: string): Promise<null> {
    await armDialogAnswer(true, text)
    return null
  }

  // ── actions (minimal) ─────────────────────────────────────────────────────
  // Enough of the Actions API for ActionChains: pointer move (to element or by
  // offset), pointer down/up, pause, and key down/up. Wheel and multi-device
  // choreography beyond this are not modelled.

  async performActions(actions: Array<Record<string, unknown>>): Promise<null> {
    for (const source of actions) {
      const type = source.type
      const items = Array.isArray(source.actions) ? (source.actions as Array<Record<string, unknown>>) : []
      if (type === 'pointer') await this.runPointerActions(items)
      else if (type === 'key') await this.runKeyActions(items)
      else if (type === 'none') await this.runPauses(items)
    }
    return null
  }

  releaseActions(): null {
    return null
  }

  private async runPauses(items: Array<Record<string, unknown>>): Promise<void> {
    for (const a of items) {
      if (a.type === 'pause' && typeof a.duration === 'number') await sleep(a.duration)
    }
  }

  private async runPointerActions(items: Array<Record<string, unknown>>): Promise<void> {
    let cur = { x: 0, y: 0 }
    for (const a of items) {
      const kind = a.type
      if (kind === 'pause') {
        if (typeof a.duration === 'number') await sleep(a.duration)
      } else if (kind === 'pointerMove') {
        const origin = a.origin
        let x = typeof a.x === 'number' ? a.x : 0
        let y = typeof a.y === 'number' ? a.y : 0
        if (origin && typeof origin === 'object' && ELEMENT_KEY in (origin as Record<string, unknown>)) {
          const c = await this.centerOf(this.resolve((origin as Record<string, string>)[ELEMENT_KEY]))
          x += c.x
          y += c.y
        } else if (origin === 'pointer') {
          x += cur.x
          y += cur.y
        }
        cur = { x, y }
        await humanMouseMove(x, y)
      } else if (kind === 'pointerDown') {
        await this.cdp('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: cur.x,
          y: cur.y,
          button: 'left',
          clickCount: 1
        })
      } else if (kind === 'pointerUp') {
        await this.cdp('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: cur.x,
          y: cur.y,
          button: 'left',
          clickCount: 1
        })
      }
    }
  }

  private async runKeyActions(items: Array<Record<string, unknown>>): Promise<void> {
    for (const a of items) {
      if (a.type === 'pause') {
        if (typeof a.duration === 'number') await sleep(a.duration)
      } else if ((a.type === 'keyDown' || a.type === 'keyUp') && typeof a.value === 'string') {
        // Map through the same table; only fire on keyDown to avoid double input.
        if (a.type !== 'keyDown') continue
        const mapped = WD_KEY_MAP[a.value] ?? a.value
        if (mapped === ' ') await pressKey(' ')
        else await pressKey(mapped)
      }
    }
  }
}
