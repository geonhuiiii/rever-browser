import { z } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { getRequest } from '../../traffic-store'
import { ok, err, errorMessage } from '../utils'

const INTROSPECTION_QUERY =
  'query IntrospectionQuery { __schema { queryType { name } mutationType { name } types { kind name fields { name args { name } type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } }'

interface TypeRef {
  kind: string
  name?: string
  ofType?: TypeRef
}
interface Field {
  name: string
  args?: Array<{ name: string }>
  type: TypeRef
}
interface GqlType {
  kind: string
  name: string
  fields?: Field[] | null
}

function renderRef(t: TypeRef | undefined): string {
  if (!t) return '?'
  if (t.kind === 'NON_NULL') return renderRef(t.ofType) + '!'
  if (t.kind === 'LIST') return '[' + renderRef(t.ofType) + ']'
  return t.name || '?'
}

function buildSdl(types: GqlType[]): string {
  const out: string[] = []
  for (const t of types) {
    if (!t.name || t.name.startsWith('__')) continue
    if ((t.kind === 'OBJECT' || t.kind === 'INTERFACE' || t.kind === 'INPUT_OBJECT') && t.fields) {
      const kw = t.kind === 'INPUT_OBJECT' ? 'input' : t.kind === 'INTERFACE' ? 'interface' : 'type'
      const fields = t.fields
        .map((f) => {
          const args =
            f.args && f.args.length ? '(' + f.args.map((a) => a.name).join(', ') + ')' : ''
          return `  ${f.name}${args}: ${renderRef(f.type)}`
        })
        .join('\n')
      out.push(`${kw} ${t.name} {\n${fields}\n}`)
    }
  }
  return out.join('\n\n')
}

export function registerGraphqlTools(mcp: McpServer) {
  mcp.registerTool(
    'graphql_introspect',
    {
      description:
        'Run a GraphQL introspection query against an endpoint and reconstruct its schema (SDL: types, fields, and arguments). The fastest way to map a GraphQL API surface. Optionally reuse a captured request\'s headers (auth) by passing its requestId. If introspection is disabled the server will say so — that itself is a useful finding.',
      inputSchema: {
        url: z.string().describe('GraphQL endpoint URL (e.g. https://site/graphql)'),
        requestId: z
          .string()
          .optional()
          .describe('Optional: reuse this captured request\'s headers (cookies/authorization)')
      }
    },
    async ({ url, requestId }) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (requestId) {
        const entry = getRequest(requestId)
        for (const [k, v] of Object.entries(entry?.requestHeaders ?? {})) {
          if (/^(authorization|cookie|x-api-key|x-auth-token)$/i.test(k)) headers[k] = v
        }
      }
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query: INTROSPECTION_QUERY })
        })
        const text = await r.text()
        let json: {
          data?: { __schema?: { types?: GqlType[]; queryType?: { name?: string }; mutationType?: { name?: string } } }
          errors?: unknown
        }
        try {
          json = JSON.parse(text)
        } catch {
          return err(`response was not JSON (status ${r.status}): ${text.slice(0, 300)}`)
        }
        const schema = json?.data?.__schema
        if (!schema || !schema.types) {
          return ok(
            JSON.stringify({
              introspectionEnabled: false,
              status: r.status,
              note: 'No __schema in the response — introspection appears disabled or blocked (a finding in itself).',
              serverErrors: json?.errors ?? null,
              raw: text.slice(0, 400)
            })
          )
        }
        const userTypes = schema.types.filter((t) => t.name && !t.name.startsWith('__'))
        return ok(
          JSON.stringify(
            {
              introspectionEnabled: true,
              queryType: schema.queryType?.name,
              mutationType: schema.mutationType?.name,
              typeCount: userTypes.length,
              typeNames: userTypes.map((t) => `${t.kind} ${t.name}`),
              sdl: buildSdl(schema.types)
            },
            null,
            2
          )
        )
      } catch (e) {
        return err(errorMessage(e))
      }
    }
  )
}
