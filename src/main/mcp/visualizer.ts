// Injected at document-start into every webview document. Exposes
// `window.__reverAi` with helpers used by browser_click / browser_type / etc.
// to visualise AI-driven interactions on top of the page.
//
// Uses a closed Shadow DOM so page styles can't leak in/out. All elements live
// inside a single fixed-position host appended to documentElement.
export const VISUALIZER_INIT_SCRIPT = `
(() => {
  if (window.__reverAi) return
  const STYLE = \`
    .cursor {
      position: fixed;
      width: 22px; height: 22px;
      pointer-events: none;
      transform-origin: 2px 2px;
      transition: transform 90ms ease;
      filter: drop-shadow(0 1px 2px rgba(0,0,0,0.45));
      opacity: 0;
    }
    .cursor.visible { opacity: 1; }
    .cursor.press   { transform: scale(0.85); }
    .box {
      position: fixed;
      box-sizing: border-box;
      pointer-events: none;
      border-radius: 6px;
      animation: pop 220ms ease-out, fade 1300ms ease-in 700ms forwards;
    }
    .box.click   { border: 2px solid #ff3b30; box-shadow: 0 0 0 4px rgba(255,59,48,0.18); }
    .box.hover   { border: 2px solid #ffd60a; box-shadow: 0 0 0 4px rgba(255,214,10,0.18); }
    .box.type    { border: 2px solid #0a84ff; box-shadow: 0 0 0 4px rgba(10,132,255,0.18); }
    .box.scroll  { border: 2px solid #30d158; box-shadow: 0 0 0 4px rgba(48,209,88,0.18); }
    .label {
      position: absolute;
      top: -22px; left: -2px;
      background: #111;
      color: #fff;
      font: 600 11px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      padding: 4px 6px;
      border-radius: 4px;
      white-space: nowrap;
      letter-spacing: 0.2px;
    }
    .box.click  .label { background: #ff3b30; }
    .box.hover  .label { background: #ffd60a; color: #111; }
    .box.type   .label { background: #0a84ff; }
    .box.scroll .label { background: #30d158; }
    .pulse {
      position: fixed;
      width: 14px; height: 14px;
      border-radius: 50%;
      background: rgba(255,59,48,0.85);
      box-shadow: 0 0 0 0 rgba(255,59,48,0.6);
      pointer-events: none;
      transform: translate(-50%, -50%);
      animation: ping 900ms ease-out forwards;
    }
    @keyframes pop  { 0% { transform: scale(0.9); opacity: 0 } 100% { transform: scale(1); opacity: 1 } }
    @keyframes fade { to { opacity: 0 } }
    @keyframes ping {
      0%   { box-shadow: 0 0 0 0 rgba(255,59,48,0.6); transform: translate(-50%,-50%) scale(0.6) }
      100% { box-shadow: 0 0 0 24px rgba(255,59,48,0); transform: translate(-50%,-50%) scale(1.4); opacity: 0 }
    }

    /* ── perception actions: navigate / snapshot / screenshot / evaluate / extract ── */
    .navsweep {
      position: fixed; top: 0; bottom: 0; width: 45%; left: -45%;
      pointer-events: none;
      background: linear-gradient(90deg, rgba(168,85,247,0) 0%, rgba(168,85,247,0.09) 55%, rgba(168,85,247,0.28) 92%, rgba(168,85,247,0.95) 100%);
      animation: navsweep 1000ms cubic-bezier(.42,0,.35,1) forwards;
    }
    @keyframes navsweep { to { left: 100% } }

    .scan {
      position: fixed; left: 0; width: 100%; height: 120px; top: -120px;
      pointer-events: none;
      background: linear-gradient(to bottom, rgba(100,210,255,0) 0%, rgba(100,210,255,0.10) 62%, rgba(100,210,255,0.28) 96%, rgba(100,210,255,0.95) 100%);
      animation: scandown 1250ms cubic-bezier(.4,0,.5,1) forwards;
    }
    @keyframes scandown { to { top: 100% } }
    .refbox {
      position: fixed; pointer-events: none; box-sizing: border-box;
      border: 1px dashed rgba(100,210,255,0.9); border-radius: 4px;
      background: rgba(100,210,255,0.07); opacity: 0;
      animation: refin 180ms ease-out forwards, fade 500ms ease-in 900ms forwards;
    }
    @keyframes refin { from { opacity: 0; transform: scale(0.97) } to { opacity: 1; transform: scale(1) } }
    .reftag {
      position: absolute; top: -9px; left: -3px;
      font: 600 9px/1.4 ui-monospace, Menlo, monospace; letter-spacing: 0.3px;
      padding: 0 4px; border-radius: 3px;
      background: rgba(100,210,255,0.92); color: #06222e; white-space: nowrap;
    }

    .flash { position: fixed; inset: 0; background: #fff; opacity: 0; pointer-events: none; animation: flash 620ms ease-out forwards; }
    @keyframes flash { 0% { opacity: 0 } 16% { opacity: 0.78 } 100% { opacity: 0 } }
    .bracket { position: fixed; width: 30px; height: 30px; border: 3px solid #c7c7cc; opacity: 0; pointer-events: none; animation: brk 620ms cubic-bezier(.2,.8,.3,1) forwards; }
    .bracket.tl { top: 14px; left: 14px; border-right: none; border-bottom: none; border-radius: 5px 0 0 0 }
    .bracket.tr { top: 14px; right: 14px; border-left: none; border-bottom: none; border-radius: 0 5px 0 0 }
    .bracket.bl { bottom: 14px; left: 14px; border-right: none; border-top: none; border-radius: 0 0 0 5px }
    .bracket.br { bottom: 14px; right: 14px; border-left: none; border-top: none; border-radius: 0 0 5px 0 }
    @keyframes brk { 0% { opacity: 0; transform: scale(1.5) } 30% { opacity: 1; transform: scale(1) } 70% { opacity: 1 } 100% { opacity: 0 } }

    .hud {
      position: fixed; left: 14px; bottom: 14px; max-width: 74vw; pointer-events: none;
      background: rgba(17,17,19,0.94); border: 1px solid rgba(255,159,10,0.55); border-radius: 7px;
      box-shadow: 0 6px 22px rgba(0,0,0,0.45); overflow: hidden;
      animation: hudin 180ms ease-out;
    }
    .hud.done { animation: hudin 180ms ease-out, fade 420ms ease-in 1600ms forwards; }
    @keyframes hudin { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
    .hud-row { display: flex; align-items: center; gap: 8px; padding: 7px 10px; position: relative; overflow: hidden }
    .hud-tag { background: #ff9f0a; color: #2a1800; font: 800 9px/1 ui-monospace,Menlo,monospace; padding: 3px 5px; border-radius: 3px; letter-spacing: 0.5px }
    .hud-code { font: 12px/1.35 ui-monospace,Menlo,monospace; color: #f2f2f4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
    .hud-scan { position: absolute; inset: 0; width: 40%; background: linear-gradient(90deg, transparent, rgba(255,159,10,0.22), transparent); animation: shimmer 900ms linear infinite }
    @keyframes shimmer { from { transform: translateX(-100%) } to { transform: translateX(350%) } }
    .hud-result { border-top: 1px solid rgba(255,255,255,0.09); padding: 6px 10px; font: 11.5px/1.4 ui-monospace,Menlo,monospace; color: #9be89b; animation: refin 200ms ease-out }
    .hud-result.err { color: #ff8f88 }
    .ctx-ring {
      position: fixed; inset: 0; pointer-events: none; box-sizing: border-box;
      border: 2px solid rgba(255,159,10,0.85);
      box-shadow: inset 0 0 26px rgba(255,159,10,0.16);
      animation: ctxpulse 1500ms ease-out forwards;
    }
    @keyframes ctxpulse { 0% { opacity: 0 } 18% { opacity: 1 } 100% { opacity: 0 } }

    .chip {
      position: fixed; top: 12px; right: 12px; display: flex; align-items: center; gap: 7px; pointer-events: none;
      background: rgba(17,17,19,0.94); border: 1px solid rgba(45,212,191,0.55); border-radius: 999px;
      padding: 5px 11px 5px 7px; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      animation: hudin 180ms ease-out, fade 420ms ease-in 1700ms forwards;
    }
    .chip-tag { background: #2dd4bf; color: #04302b; font: 800 9px/1 ui-monospace,Menlo,monospace; padding: 3px 5px; border-radius: 3px; letter-spacing: 0.5px }
    .chip-txt { font: 11.5px/1 ui-monospace,Menlo,monospace; color: #e8e8ea; max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .chip-count { font: 700 11px/1 -apple-system,BlinkMacSystemFont,sans-serif; color: #2dd4bf }
    .exbox {
      position: fixed; pointer-events: none; box-sizing: border-box;
      border: 2px solid #2dd4bf; border-radius: 5px; background: rgba(45,212,191,0.10); opacity: 0;
      animation: refin 200ms ease-out forwards, fade 500ms ease-in 1200ms forwards;
    }
    .exnum {
      position: absolute; top: -9px; right: -7px; width: 17px; height: 17px; border-radius: 50%;
      background: #2dd4bf; color: #04302b; font: 800 10px/17px -apple-system,BlinkMacSystemFont,sans-serif; text-align: center;
    }
  \`

  let host = null
  let root = null
  function ensure() {
    if (host && host.isConnected) return root
    host = document.createElement('div')
    host.id = '__rever_ai_overlay_host__'
    host.style.cssText = 'position:fixed;inset:0;width:0;height:0;z-index:2147483647;pointer-events:none'
    root = host.attachShadow({ mode: 'closed' })
    const s = document.createElement('style'); s.textContent = STYLE; root.appendChild(s)
    ;(document.documentElement || document.body).appendChild(host)
    return root
  }

  function flashRect(rect, label, action) {
    const r = ensure()
    const box = document.createElement('div')
    box.className = 'box ' + (action || 'click')
    box.style.left   = rect.x + 'px'
    box.style.top    = rect.y + 'px'
    box.style.width  = Math.max(rect.w, 8) + 'px'
    box.style.height = Math.max(rect.h, 8) + 'px'
    if (label) {
      const l = document.createElement('div')
      l.className = 'label'
      l.textContent = label
      box.appendChild(l)
    }
    r.appendChild(box)
    setTimeout(() => box.remove(), 2100)
  }

  function flashElement(el, label, action) {
    if (!el || !el.getBoundingClientRect) return
    const b = el.getBoundingClientRect()
    flashRect({ x: b.left, y: b.top, w: b.width, h: b.height }, label, action)
    pulseAt(b.left + b.width / 2, b.top + b.height / 2)
  }

  function pulseAt(x, y) {
    const r = ensure()
    const p = document.createElement('div')
    p.className = 'pulse'
    p.style.left = x + 'px'
    p.style.top  = y + 'px'
    r.appendChild(p)
    setTimeout(() => p.remove(), 950)
  }

// Fake cursor that follows real mousemove/down/up events. Because click/type
  // dispatch CDP Input.dispatchMouseEvent, those produce native mouse events
  // here — so this listener auto-tracks AI-driven movement without any IPC.
  // macOS-style arrow cursor SVG. The hot-spot is the tip (top-left) at (2,2),
  // which matches transform-origin in CSS so press-scale rotates around the tip.
  const CURSOR_SVG = '<svg viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M2 2 L2 18 L7 13.5 L10 19 L13 17.5 L10 12 L17 12 Z" ' +
    'fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/></svg>'

  let cursorEl = null
  let cursorHideTimer = null
  function getCursor() {
    if (cursorEl && cursorEl.isConnected) return cursorEl
    const r = ensure()
    cursorEl = document.createElement('div')
    cursorEl.className = 'cursor'
    cursorEl.innerHTML = CURSOR_SVG
    r.appendChild(cursorEl)
    return cursorEl
  }
  function showCursorAt(x, y) {
    const c = getCursor()
    c.style.left = x + 'px'
    c.style.top = y + 'px'
    c.classList.add('visible')
    if (cursorHideTimer) clearTimeout(cursorHideTimer)
    cursorHideTimer = setTimeout(() => c.classList.remove('visible'), 1500)
  }
  function setCursorPress(pressed) {
    const c = getCursor()
    if (pressed) c.classList.add('press'); else c.classList.remove('press')
  }

  // ── Perception actions ──────────────────────────────────────────────────
  // These have no target element — they visualise the agent *reading* the page
  // (navigate / snapshot / screenshot / evaluate / extract). All are purely
  // cosmetic and self-removing, and are fired fire-and-forget from the main
  // process so they never delay a tool's response.

  function transient(el, ms) {
    ensure().appendChild(el)
    setTimeout(() => el.remove(), ms)
    return el
  }
  function div(cls) {
    const d = document.createElement('div')
    d.className = cls
    return d
  }

  // Full-viewport wipe, left → right. Fired after a navigation lands, so it
  // doubles as a reveal of the new document.
  function navSweep() {
    transient(div('navsweep'), 1100)
  }

  // Scan line top → bottom + dashed outlines on actionable elements as it
  // passes them. Mirrors what the a11y snapshot is reading, but the outlines
  // are detected page-side (cheap) — they carry no ref numbers, because those
  // come from the AX tree walk in the main process and would not line up.
  // The box a user expects around a link is what they can SEE, which is not
  // always the link's own rect. A block anchor takes its width from the
  // container but its height only from flow content, so an anchor wrapping a
  // photo measures as a full-width, near-zero-height strip whenever the image
  // doesn't contribute height — before it loads, or permanently when it is
  // absolutely positioned. Union in the media descendants to cover that.
  // Off-screen and zero-size ones are excluded so screen-reader-only content
  // (.blind at left:-9999px and friends) can't blow the box up.
  function visualRect(el) {
    const vw = window.innerWidth || 1
    const vh = window.innerHeight || 1
    const b = el.getBoundingClientRect()
    let x1 = b.left, y1 = b.top, x2 = b.right, y2 = b.bottom
    let n = 0
    for (const m of el.querySelectorAll('img, picture, svg, video, canvas')) {
      if (++n > 8) break
      const r = m.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) continue
      if (r.right < 0 || r.left > vw || r.bottom < 0 || r.top > vh) continue
      if (r.left < x1) x1 = r.left
      if (r.top < y1) y1 = r.top
      if (r.right > x2) x2 = r.right
      if (r.bottom > y2) y2 = r.bottom
    }
    return { left: x1, top: y1, width: x2 - x1, height: y2 - y1, right: x2, bottom: y2 }
  }

  // display:none is already excluded by the size check, but visibility:hidden
  // and opacity:0 keep their layout box — outlining those draws a dashed box
  // over empty space. checkVisibility also accounts for a hidden ANCESTOR,
  // which reading the element's own computed style would miss.
  function isVisible(el) {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
        opacityProperty: true,
        visibilityProperty: true
      })
    }
    const s = window.getComputedStyle(el)
    return s.visibility === 'visible' && s.opacity !== '0' && s.display !== 'none'
  }

  // Elements the agent can act on. The CSS selector catches markup that
  // declares itself clickable; a pointer cursor catches the rest, because a
  // div wired up with addEventListener (or a delegated parent handler) leaves
  // no attribute to match on and would otherwise never be outlined.
  function scanCandidates(SEL) {
    const out = []
    const seen = new Set()
    for (const el of document.querySelectorAll(SEL)) {
      seen.add(el)
      out.push(el)
    }
    let examined = 0
    for (const el of document.querySelectorAll('*')) {
      // Bail on pathologically large documents rather than stall the page.
      if (++examined > 4000) break
      if (seen.has(el)) continue
      if (window.getComputedStyle(el).cursor !== 'pointer') continue
      // Only the outermost pointer element. Inherited cursor means every
      // nested span in a clickable card reports pointer too, and boxing all of
      // them buries the one the user actually clicks. Document order
      // guarantees ancestors are seen first.
      let p = el.parentElement
      let nested = false
      while (p) {
        if (seen.has(p)) {
          nested = true
          break
        }
        p = p.parentElement
      }
      if (nested) continue
      seen.add(el)
      out.push(el)
    }
    return out
  }

  function scanPage(boxes) {
    transient(div('scan'), 1350)
    const vh = window.innerHeight || 1

    // Boxes supplied by the snapshot: these are the elements that actually
    // received a ref, tagged with it. The heuristic below re-derives its own
    // guess from the DOM and disagrees with the real set — it outlines things
    // the agent cannot address and misses the click-scan finds it can. Only
    // used as a fallback when no snapshot is driving the animation.
    if (Array.isArray(boxes) && boxes.length) {
      for (const b of boxes) {
        if (!b || b.w < 6 || b.h < 6) continue
        if (b.y + b.h < 0 || b.y > vh) continue
        const delay = 1250 * Math.max(0, Math.min(1, (b.y + b.h / 2) / vh))
        setTimeout(() => {
          const el = div('refbox')
          el.style.left = (b.x - 3) + 'px'
          el.style.top = (b.y - 3) + 'px'
          el.style.width = (b.w + 6) + 'px'
          el.style.height = (b.h + 6) + 'px'
          if (b.ref) {
            const tag = document.createElement('div')
            tag.className = 'reftag'
            tag.textContent = b.ref
            el.appendChild(tag)
          }
          transient(el, 1700)
        }, delay)
      }
      return
    }

    const SEL = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [onclick]'
    // Every visible candidate gets a box — no count cap. A cap would be spent
    // in DOM order, which is roughly top-to-bottom, so a header-heavy page
    // would light up only its top strip. The boxes are staggered by vertical
    // position across the sweep, so even a dense page adds them a few at a
    // time rather than all in one frame.
    for (const el of scanCandidates(SEL)) {
      const b = el.getBoundingClientRect()
      if (b.bottom < 0 || b.top > vh) continue
      const delay = 1250 * Math.max(0, Math.min(1, (b.top + b.height / 2) / vh))
      // The rect above only schedules the box. Measuring is deferred to draw
      // time and then re-checked twice, because a link whose height comes from
      // an <img> (display:block anchors around a photo are the common case)
      // measures as a full-width, zero-height strip until that image loads —
      // freezing the box at that shape draws a flat bar across the picture.
      // Three bounded samples cost far less than tracking every frame.
      let box = null
      for (const at of [delay, delay + 400, delay + 900]) {
        setTimeout(() => {
          if (box && !box.isConnected) return
          if (!isVisible(el)) return
          const r = visualRect(el)
          if (r.width < 8 || r.height < 8) return
          if (r.bottom < 0 || r.top > (window.innerHeight || 1)) return
          // A page-sized clickable wrapper (some overlays set cursor:pointer on
          // a full-screen div) would just outline the whole viewport.
          if (r.width > (window.innerWidth || 1) * 0.9 && r.height > (window.innerHeight || 1) * 0.9) return
          if (!box) {
            box = div('refbox')
            transient(box, 1500)
          }
          box.style.left = (r.left - 3) + 'px'
          box.style.top = (r.top - 3) + 'px'
          box.style.width = (r.width + 6) + 'px'
          box.style.height = (r.height + 6) + 'px'
        }, at)
      }
    }
  }

  // Camera shutter. Fired AFTER the capture so it never lands in the PNG.
  function shutter() {
    transient(div('flash'), 700)
    for (const pos of ['tl', 'tr', 'bl', 'br']) transient(div('bracket ' + pos), 700)
  }

  // Code HUD for browser_evaluate. Two-phase: evalHudStart while the
  // expression runs (shimmer), evalHudDone once it returns.
  let hudEl = null
  function evalHudStart(expr) {
    if (hudEl) hudEl.remove()
    transient(div('ctx-ring'), 1550)
    const hud = div('hud')
    const row = div('hud-row')
    const tag = div('hud-tag'); tag.textContent = 'EVAL'
    const code = div('hud-code'); code.textContent = expr
    row.appendChild(tag); row.appendChild(code); row.appendChild(div('hud-scan'))
    hud.appendChild(row)
    hudEl = hud
    // Self-clean if the result call never arrives (page navigated, eval hung).
    transient(hud, 15000)
  }
  function evalHudDone(preview, isError) {
    const hud = hudEl
    if (!hud || !hud.isConnected) return
    hudEl = null
    const shimmer = hud.querySelector('.hud-scan')
    if (shimmer) shimmer.remove()
    const res = div('hud-result' + (isError ? ' err' : ''))
    res.textContent = (isError ? '✕ ' : '→ ') + preview
    hud.appendChild(res)
    hud.classList.add('done')
    setTimeout(() => hud.remove(), 2100)
  }

  // Selector chip + staggered highlight of matched nodes for dom_extract.
  function extractHighlight(selector, matched) {
    const chip = div('chip')
    const tag = div('chip-tag'); tag.textContent = 'EXTRACT'
    const txt = div('chip-txt'); txt.textContent = selector
    const cnt = div('chip-count'); cnt.textContent = matched + (matched === 1 ? ' match' : ' matches')
    chip.appendChild(tag); chip.appendChild(txt); chip.appendChild(cnt)
    transient(chip, 2200)
    let i = 0
    for (const el of document.querySelectorAll(selector)) {
      if (i >= 30) break
      const b = el.getBoundingClientRect()
      if (b.width < 4 || b.height < 4) continue
      const idx = ++i
      setTimeout(() => {
        const box = div('exbox')
        box.style.left = (b.left - 4) + 'px'
        box.style.top = (b.top - 3) + 'px'
        box.style.width = (b.width + 8) + 'px'
        box.style.height = (b.height + 6) + 'px'
        const num = div('exnum'); num.textContent = String(idx)
        box.appendChild(num)
        transient(box, 1800)
      }, (idx - 1) * 80)
    }
  }

  // Define as non-enumerable so it doesn't appear in for…in / Object.keys.
  // chrome-cdp.ts STEALTH_INIT_SCRIPT additionally filters this key from
  // Object.getOwnPropertyNames / Reflect.ownKeys to hide it from WASM scanners.
  Object.defineProperty(window, '__reverAi', {
    value: {
      flashRect, flashElement, pulseAt, showCursorAt, setCursorPress,
      navSweep, scanPage, shutter, evalHudStart, evalHudDone, extractHighlight
    },
    enumerable: false,
    configurable: true,
    writable: false
  })
})();
`
