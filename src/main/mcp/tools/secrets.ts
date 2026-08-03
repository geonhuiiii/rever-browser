import { z } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { listRequests, type StoredRequest } from '../../traffic-store'
import { ok } from '../utils'

// Credential / secret patterns. Each is anchored enough to keep false positives
// low; generic assignments are gated on a key name so we don't flag every long
// string. Ordered most-specific first.
const SECRET_PATTERNS: Array<{ type: string; re: RegExp }> = [
  { type: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { type: 'jwt', re: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g },
  { type: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'github-token', re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/g },
  { type: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { type: 'stripe-key', re: /\b[sprk]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { type: 'supabase-publishable', re: /\bsb_publishable_[0-9A-Za-z_-]{16,}\b/g },
  { type: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  {
    type: 'generic-secret-assignment',
    re: /["']?(?:api[_-]?key|apikey|secret|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/gi
  }
]

// Request headers that routinely carry credentials.
const SENSITIVE_HEADERS = /^(authorization|cookie|x-api-key|x-auth-token|x-csrf-token|proxy-authorization)$/i

function mask(s: string): string {
  const t = s.trim()
  if (t.length <= 10) return '****'
  return `${t.slice(0, 4)}…${t.slice(-4)} (${t.length} chars)`
}

interface Hit {
  type: string
  where: string
  masked: string
}

function scanText(text: string, where: string): Hit[] {
  const hits: Hit[] = []
  for (const { type, re } of SECRET_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      hits.push({ type, where, masked: mask(m[0]) })
      if (hits.length > 50) return hits // per-source cap
    }
  }
  return hits
}

function scanRequest(e: StoredRequest): Hit[] {
  const hits: Hit[] = []
  // Response body (text only — skip binary/base64).
  if (e.responseBody && !e.responseBodyBase64) {
    hits.push(...scanText(e.responseBody, 'response-body'))
  }
  // Request post data.
  if (e.requestPostData) hits.push(...scanText(e.requestPostData, 'request-body'))
  // Sensitive request headers, reported by name regardless of value shape.
  for (const [name, value] of Object.entries(e.requestHeaders ?? {})) {
    if (SENSITIVE_HEADERS.test(name) && value) {
      hits.push({ type: `header:${name.toLowerCase()}`, where: 'request-header', masked: mask(value) })
    }
  }
  // Dedupe identical (type, masked) pairs within one request.
  const seen = new Set<string>()
  return hits.filter((h) => {
    const k = `${h.type}|${h.where}|${h.masked}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function registerSecretTools(mcp: McpServer) {
  mcp.registerTool(
    'scan_secrets',
    {
      description:
        'Sweep captured traffic for embedded credentials and secrets — JWTs, API keys (Google/AWS/GitHub/Slack/Stripe), private keys, Bearer tokens, and api_key/secret/password assignments — across response bodies, request bodies, and sensitive request headers (Authorization/Cookie/x-api-key…). Values are masked (first/last 4 chars). A quick way to find a hardcoded key or endpoint that shortcuts the whole reversing effort. Filter by host / since to scope the sweep.',
      inputSchema: {
        host: z.string().optional().describe('Substring host filter (e.g. "example.com")'),
        since: z.number().optional().describe('Only scan requests started after this epoch ms')
      }
    },
    async ({ host, since }) => {
      const rows = listRequests({ host, since, limit: 200 })
      const results = rows
        .map((e) => ({ requestId: e.requestId, url: e.url, hits: scanRequest(e) }))
        .filter((r) => r.hits.length > 0)
      const total = results.reduce((n, r) => n + r.hits.length, 0)
      return ok(
        JSON.stringify(
          {
            scanned: rows.length,
            requestsWithSecrets: results.length,
            totalHits: total,
            results
          },
          null,
          2
        )
      )
    }
  )
}
