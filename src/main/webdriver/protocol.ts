// W3C WebDriver protocol primitives: the error taxonomy and the JSON envelopes
// every endpoint returns. Kept dependency-free so both the server and the
// command handlers can throw/return these without importing Electron.
//
// Spec: https://www.w3.org/TR/webdriver2/

/** The `element-6066-11e4-a52e-4f735466cecf` key that tags an element handle. */
export const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'
/** The analogous key for a shadow-root handle. */
export const SHADOW_KEY = 'shadow-6066-11e4-a52e-4f735466cecf'

// Each WebDriver error maps to a stable string ("error code") and an HTTP
// status. Clients (Selenium et al.) switch on the code, not the message.
interface ErrorSpec {
  status: number
  code: string
}

export const WD_ERRORS = {
  elementClickIntercepted: { status: 400, code: 'element click intercepted' },
  elementNotInteractable: { status: 400, code: 'element not interactable' },
  insecureCertificate: { status: 400, code: 'insecure certificate' },
  invalidArgument: { status: 400, code: 'invalid argument' },
  invalidCookieDomain: { status: 400, code: 'invalid cookie domain' },
  invalidElementState: { status: 400, code: 'invalid element state' },
  invalidSelector: { status: 400, code: 'invalid selector' },
  invalidSessionId: { status: 404, code: 'invalid session id' },
  javascriptError: { status: 500, code: 'javascript error' },
  moveTargetOutOfBounds: { status: 500, code: 'move target out of bounds' },
  noSuchAlert: { status: 404, code: 'no such alert' },
  noSuchCookie: { status: 404, code: 'no such cookie' },
  noSuchElement: { status: 404, code: 'no such element' },
  noSuchFrame: { status: 404, code: 'no such frame' },
  noSuchWindow: { status: 404, code: 'no such window' },
  scriptTimeout: { status: 500, code: 'script timeout' },
  sessionNotCreated: { status: 500, code: 'session not created' },
  staleElementReference: { status: 404, code: 'stale element reference' },
  timeout: { status: 500, code: 'timeout' },
  unableToSetCookie: { status: 500, code: 'unable to set cookie' },
  unknownCommand: { status: 404, code: 'unknown command' },
  unknownError: { status: 500, code: 'unknown error' },
  unknownMethod: { status: 405, code: 'unknown method' },
  unsupportedOperation: { status: 500, code: 'unsupported operation' }
} as const satisfies Record<string, ErrorSpec>

export type WdErrorName = keyof typeof WD_ERRORS

/**
 * A WebDriver-typed error. Handlers throw these; the server turns them into the
 * spec's `{ value: { error, message, stacktrace } }` body with the right HTTP
 * status. Any non-WebDriverError that escapes a handler becomes `unknown error`.
 */
export class WebDriverError extends Error {
  readonly wdError: WdErrorName
  readonly data?: Record<string, unknown>
  constructor(wdError: WdErrorName, message?: string, data?: Record<string, unknown>) {
    super(message ?? WD_ERRORS[wdError].code)
    this.name = 'WebDriverError'
    this.wdError = wdError
    this.data = data
  }
}

export interface WdResponse {
  status: number
  body: unknown
}

/** Wrap a command's return value in the `{ value }` envelope with HTTP 200. */
export function ok(value: unknown): WdResponse {
  return { status: 200, body: { value: value === undefined ? null : value } }
}

/** Turn any thrown value into the spec error envelope. */
export function errorResponse(err: unknown): WdResponse {
  if (err instanceof WebDriverError) {
    const spec = WD_ERRORS[err.wdError]
    return {
      status: spec.status,
      body: {
        value: {
          error: spec.code,
          message: err.message,
          stacktrace: err.stack ?? '',
          ...(err.data ? { data: err.data } : {})
        }
      }
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  const stacktrace = err instanceof Error ? (err.stack ?? '') : ''
  return {
    status: WD_ERRORS.unknownError.status,
    body: { value: { error: WD_ERRORS.unknownError.code, message, stacktrace } }
  }
}

/** Build an element handle object for a registered element id. */
export function elementHandle(id: string): Record<string, string> {
  return { [ELEMENT_KEY]: id }
}

/** Build a shadow-root handle object. */
export function shadowHandle(id: string): Record<string, string> {
  return { [SHADOW_KEY]: id }
}
