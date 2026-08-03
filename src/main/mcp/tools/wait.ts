import { z } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { evalInPage, jsLiteral } from '../cdp-eval'
import { ok, err } from '../utils'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function registerWaitTools(mcp: McpServer) {
  mcp.registerTool(
    'browser_wait_for',
    {
      description:
        'Wait until the page settles before you read it — poll until a CSS selector is present (and visible) and/or a piece of text appears in the DOM. Use this on SPA / JS-rendered pages where the first snapshot shows a spinner or empty list because content arrives via a later XHR, instead of snapshotting repeatedly. Give at least one of selector / text; when both are given, both must hold.',
      inputSchema: {
        selector: z
          .string()
          .optional()
          .describe('CSS selector to wait for (must exist and be visible)'),
        text: z.string().optional().describe('Substring to wait for anywhere in the page text'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(30000)
          .optional()
          .describe('Give up after this many ms (default 8000)')
      }
    },
    async ({ selector, text, timeoutMs = 8000 }) => {
      if (!selector && !text) return err('give at least one of `selector` or `text`')
      const checks: string[] = []
      if (selector) {
        // present AND visible (has layout boxes)
        checks.push(
          `(() => { const el = document.querySelector(${jsLiteral(selector)}); return !!el && el.getClientRects().length > 0; })()`
        )
      }
      if (text) {
        checks.push(`(document.body ? document.body.innerText : '').includes(${jsLiteral(text)})`)
      }
      const expr = checks.join(' && ')
      const start = Date.now()
      let polls = 0
      while (Date.now() - start < timeoutMs) {
        polls++
        let satisfied = false
        try {
          satisfied = await evalInPage<boolean>(expr)
        } catch (e) {
          return err(`wait failed: ${(e as Error).message}`)
        }
        if (satisfied) {
          return ok(
            JSON.stringify({
              ready: true,
              waitedMs: Date.now() - start,
              polls,
              waitedFor: { selector, text }
            })
          )
        }
        await sleep(250)
      }
      return ok(
        JSON.stringify({
          ready: false,
          timedOut: true,
          waitedMs: Date.now() - start,
          waitedFor: { selector, text },
          note: 'Condition never became true within timeoutMs. The content may not load, the selector/text may be wrong, or it needs longer.'
        })
      )
    }
  )
}
