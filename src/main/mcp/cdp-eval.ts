import { getActiveTarget } from '../chrome-cdp'

interface CdpEvalResult {
  result: { type: string; value?: unknown }
  exceptionDetails?: { text: string; exception?: { description?: string } }
}

export async function evalInPage<T>(expression: string): Promise<T> {
  const target = getActiveTarget()
  if (!target) throw new Error('no active browser target — open a page first')
  const res = (await target.dbg.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  })) as CdpEvalResult
  if (res.exceptionDetails) {
    const desc =
      res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'eval failed'
    throw new Error(desc)
  }
  return res.result.value as T
}

export function jsLiteral(s: string): string {
  return JSON.stringify(s)
}

/**
 * Fire a `window.__reverAi.<fn>(...)` overlay call into the active page without
 * waiting for it or letting it fail a tool. Purely cosmetic, so a missing
 * target / not-yet-injected visualizer is silently ignored.
 */
export function visualize(fn: string, ...args: unknown[]): void {
  const target = getActiveTarget()
  if (!target) return
  const argList = args.map((a) => JSON.stringify(a ?? null)).join(',')
  void target.dbg
    .sendCommand('Runtime.evaluate', {
      expression: `window.__reverAi && window.__reverAi.${fn}(${argList})`
    })
    .catch(() => null)
}
