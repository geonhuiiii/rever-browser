import { z } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { getActiveTarget } from '../../chrome-cdp'
import { evalInPage } from '../cdp-eval'
import { ok, err, errorMessage } from '../utils'

// In-page hook: wraps Web Crypto (crypto.subtle.*) so every importKey / sign /
// verify / digest / encrypt call records its inputs and outputs into a
// window.__revCrypto buffer. No debugger pause needed — this reveals the HMAC
// key, the signed message, and the resulting signature at call time. Guarded
// against double-install; stops pushing once the buffer is deleted.
const HOOK = String.raw`(() => {
  if (window.__revCrypto) return 'already-installed';
  window.__revCrypto = [];
  var MAX = 200;
  function preview(data) {
    try {
      if (data == null) return null;
      if (typeof data === 'string')
        return data.length > 160 ? data.slice(0, 160) + '… (' + data.length + ' chars)' : data;
      var u8;
      if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else if (typeof data === 'object') return JSON.stringify(data).slice(0, 200);
      else return String(data);
      var slice = u8.slice(0, 96);
      var bytes = Array.prototype.slice.call(slice);
      var printable = bytes.every(function (b) { return b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127); });
      var repr = printable
        ? new TextDecoder().decode(slice)
        : bytes.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      if (u8.length > 96) repr += '…';
      return repr + ' (' + u8.length + ' bytes)';
    } catch (e) { return '(unreadable)'; }
  }
  function stackOf() {
    return (new Error().stack || '').split('\n').slice(3, 8).map(function (l) { return l.trim(); });
  }
  function push(rec) {
    var b = window.__revCrypto;
    if (!b || b.length >= MAX) return;
    rec.t = Date.now();
    b.push(rec);
  }
  var S = window.crypto && window.crypto.subtle;
  if (S) {
    function wrap(name, argFn, captureResult) {
      var orig = S[name];
      if (typeof orig !== 'function') return;
      S[name] = function () {
        var args = arguments;
        try { push(Object.assign({ op: 'subtle.' + name, stack: stackOf() }, argFn(args))); } catch (e) {}
        var p = orig.apply(this, args);
        if (captureResult && p && typeof p.then === 'function') {
          return p.then(function (r) {
            try { push({ op: 'subtle.' + name + ':result', result: preview(r), stack: [] }); } catch (e) {}
            return r;
          });
        }
        return p;
      };
    }
    wrap('importKey', function (a) { return { format: a[0], keyMaterial: preview(a[1]), algorithm: JSON.stringify(a[2]) }; }, false);
    wrap('sign', function (a) { return { algorithm: JSON.stringify(a[0]), message: preview(a[2]) }; }, true);
    wrap('verify', function (a) { return { algorithm: JSON.stringify(a[0]), message: preview(a[3]) }; }, false);
    wrap('digest', function (a) { return { algorithm: JSON.stringify(a[0]), message: preview(a[1]) }; }, true);
    wrap('encrypt', function (a) { return { algorithm: JSON.stringify(a[0]), message: preview(a[2]) }; }, true);
  }
  return 'installed';
})();`

let persistentScriptId: string | null = null

export function registerCryptoTraceTools(mcp: McpServer) {
  mcp.registerTool(
    'crypto_trace_start',
    {
      description:
        'Instrument the page Web Crypto API without a debugger: wraps crypto.subtle importKey / sign / verify / digest / encrypt so their inputs and outputs are recorded. Reveals the HMAC/AES secret key (from importKey), the signed message, and the resulting signature at call time — the pause-free way to recover how a request is signed. Install it, then trigger the signing action, then crypto_trace_list. Only catches Web Crypto (and misses hand-rolled pure-JS crypto).'
    },
    async () => {
      const target = getActiveTarget()
      if (!target) return err('no active browser target')
      try {
        // Survive reloads / run before page scripts on the next navigation.
        const res = (await target.dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: HOOK
        })) as { identifier: string }
        persistentScriptId = res.identifier
        // Also install into the already-loaded page right now.
        const now = await evalInPage<string>(HOOK)
        return ok(
          JSON.stringify({
            installed: true,
            currentPage: now,
            note: 'Hook active for this page and all future loads until crypto_trace_stop. Now trigger the signing action, then call crypto_trace_list.'
          })
        )
      } catch (e) {
        return err(errorMessage(e))
      }
    }
  )

  mcp.registerTool(
    'crypto_trace_list',
    {
      description:
        'Return the Web Crypto calls captured since crypto_trace_start — each with operation, algorithm, and previewed key material / message / result (printable bytes shown as text, otherwise hex; truncated). Read this after triggering the signing action.'
    },
    async () => {
      try {
        const raw = await evalInPage<string>('JSON.stringify(window.__revCrypto || [])')
        const records = JSON.parse(raw || '[]')
        return ok(JSON.stringify({ count: records.length, records }, null, 2))
      } catch (e) {
        return err(errorMessage(e))
      }
    }
  )

  mcp.registerTool(
    'crypto_trace_stop',
    {
      description: 'Stop Web Crypto tracing: remove the persistent hook and clear the captured buffer.'
    },
    async () => {
      const target = getActiveTarget()
      if (!target) return err('no active browser target')
      try {
        if (persistentScriptId) {
          await target.dbg
            .sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: persistentScriptId })
            .catch(() => {})
          persistentScriptId = null
        }
        await evalInPage<unknown>('void (delete window.__revCrypto)')
        return ok('crypto trace stopped and buffer cleared')
      } catch (e) {
        return err(errorMessage(e))
      }
    }
  )
}
