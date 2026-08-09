import OpenAI from 'openai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { randomUUID } from 'node:crypto'

import { startMcpServer } from '../mcp/server'
import { getApiKey } from '../settings'
import { capToolsForOpenAI, OPENAI_MAX_TOOLS } from './openai-tool-cap'

import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { Stream } from 'openai/streaming'
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionFunctionTool,
  ChatCompletionMessageToolCall
} from 'openai/resources/chat/completions'

// Google Gemini provider. Google ships an OpenAI-compatible endpoint
// (generativelanguage.googleapis.com/v1beta/openai/), so we reuse the OpenAI
// SDK — same streaming + function-calling agent loop as openai-provider, just a
// different baseURL and API key. No new dependency.

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/'

interface ModelInfo {
  modelId: string
  name: string
  description?: string | null
}

// Latest Gemini line. `gemini-flash-latest` / `gemini-pro-latest` are Google
// aliases that always resolve to the newest release, so the default keeps
// working as Google ships new versions without a code change.
export const GEMINI_MODELS: ModelInfo[] = [
  { modelId: 'gemini-flash-latest', name: 'Gemini Flash (latest)', description: 'Newest Flash — fast, cheap' },
  { modelId: 'gemini-pro-latest', name: 'Gemini Pro (latest)', description: 'Newest Pro — most capable' },
  { modelId: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Pinned 2.5 Flash' },
  { modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Pinned 2.5 Pro' },
  { modelId: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', description: 'Cheapest, lowest latency' }
]

const DEFAULT_MODEL = 'gemini-flash-latest'

interface GeminiSession {
  messages: ChatCompletionMessageParam[]
  modelId: string
  abort: AbortController | null
  dead: boolean
}

const sessions = new Map<string, GeminiSession>()

// MCP 클라이언트/도구는 프로세스당 한 번만 연결한다.
let mcpBridge: Promise<{ client: Client; tools: ChatCompletionTool[] }> | null = null

async function getMcpBridge(): Promise<{ client: Client; tools: ChatCompletionTool[] }> {
  if (mcpBridge) return mcpBridge
  mcpBridge = (async () => {
    const { url } = await startMcpServer()
    const client = new Client({ name: 'rever-gemini', version: '0.1.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
    const listed = await client.listTools()
    const mapped: ChatCompletionFunctionTool[] = listed.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? undefined,
        parameters: t.inputSchema as Record<string, unknown>
      }
    }))
    const { tools, dropped } = capToolsForOpenAI(mapped)
    if (dropped.length) {
      console.warn(
        `[gemini] tool list capped ${mapped.length}→${tools.length} (max ${OPENAI_MAX_TOOLS}); dropped: ${dropped.join(', ')}`
      )
    }
    return { client, tools }
  })()
  return mcpBridge
}

export async function spawnGeminiSession(): Promise<{ sessionId: string }> {
  const sessionId = `gemini:${randomUUID()}`
  sessions.set(sessionId, {
    messages: [],
    modelId: DEFAULT_MODEL,
    abort: null,
    dead: false
  })
  return { sessionId }
}

function emitText(onUpdate: (n: SessionNotification) => void, sessionId: string, text: string): void {
  onUpdate({
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
  } as unknown as SessionNotification)
}

function extractToolText(result: unknown): string {
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const c of content) {
    if (c && typeof c === 'object' && (c as { type?: string }).type === 'text') {
      parts.push(String((c as { text?: string }).text ?? ''))
    }
  }
  return parts.join('\n')
}

interface PartialToolCall {
  id: string
  name: string
  args: string
}

export async function promptGeminiSession(
  sessionId: string,
  text: string,
  onUpdate: (n: SessionNotification) => void
): Promise<{ stopReason: string }> {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`unknown Gemini session: ${sessionId}`)
  if (session.dead) throw new Error(`Gemini session is dead: ${sessionId}`)

  const apiKey = getApiKey('gemini')
  if (!apiKey) {
    throw new Error('No Gemini API key set. Add one in settings (Gemini API key).')
  }

  const gemini = new OpenAI({ apiKey, baseURL: GEMINI_BASE_URL })
  const { client: mcp, tools } = await getMcpBridge()

  session.messages.push({ role: 'user', content: text })
  const abort = new AbortController()
  session.abort = abort

  // Gemini's OpenAI-compat endpoint chokes on huge tool payloads (a full
  // browser_snapshot is tens of KB); cap what we feed back so the follow-up
  // request stays within limits instead of stalling.
  const MAX_TOOL_CHARS = 24_000
  // Hard stop on the agent loop so a model that keeps calling tools without
  // ever answering can't spin forever.
  const MAX_ROUNDS = 16
  let totalText = 0

  try {
    for (let round = 0; ; round++) {
      if (round >= MAX_ROUNDS) {
        emitText(
          onUpdate,
          sessionId,
          `\n\n_(stopped after ${MAX_ROUNDS} tool rounds without a final answer)_`
        )
        return { stopReason: 'end_turn' }
      }

      const stream = await createStream(gemini, session.modelId, session.messages, tools, abort.signal)

      let assembledText = ''
      const partials = new Map<number, PartialToolCall>()
      let finishReason: string | null = null

      for await (const chunk of stream) {
        const choice = chunk.choices[0]
        if (!choice) continue
        const delta = choice.delta
        if (delta?.content) {
          assembledText += delta.content
          totalText += delta.content.length
          emitText(onUpdate, sessionId, delta.content)
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = partials.get(tc.index) ?? { id: '', name: '', args: '' }
            if (tc.id) existing.id = tc.id
            if (tc.function?.name) existing.name = tc.function.name
            if (tc.function?.arguments) existing.args += tc.function.arguments
            partials.set(tc.index, existing)
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason
      }

      console.log(
        `[gemini] round ${round}: ${assembledText.length} text chars, ${partials.size} tool call(s), finish=${finishReason}`
      )

      // Run tools whenever the model emitted any — do NOT gate on
      // finish_reason === 'tool_calls'. OpenAI always sets that, but Gemini's
      // OpenAI-compatible endpoint frequently streams tool_calls while
      // reporting finish_reason 'stop', which used to make the loop bail out
      // with no tools run and no text. If there are no tool calls, the turn is
      // complete.
      if (partials.size === 0) {
        // Nothing came back at all across the whole prompt — tell the user
        // rather than leaving a blank bubble.
        if (totalText === 0) {
          emitText(
            onUpdate,
            sessionId,
            `_(Gemini returned an empty response — finish_reason: ${finishReason ?? 'unknown'}. Try a different Gemini model in the picker.)_`
          )
        }
        return { stopReason: 'end_turn' }
      }

      // Gemini may omit tool-call ids; synthesise stable ones IN PLACE so the
      // assistant message and the tool_result follow-ups reference the same id.
      const orderedPartials = [...partials.values()]
      orderedPartials.forEach((p, i) => {
        if (!p.id) p.id = `call_${i}`
      })

      const toolCalls: ChatCompletionMessageToolCall[] = orderedPartials.map((p) => ({
        id: p.id,
        type: 'function',
        function: { name: p.name, arguments: p.args || '{}' }
      }))
      // Omit `content` entirely when the model produced no text alongside the
      // tool calls. Gemini's OpenAI-compat endpoint 400s on an assistant
      // message that carries tool_calls with an empty-string (or null) content
      // — the field must be absent. This was the cause of the round-1 400.
      session.messages.push(
        assembledText
          ? { role: 'assistant', content: assembledText, tool_calls: toolCalls }
          : { role: 'assistant', tool_calls: toolCalls }
      )

      for (const p of orderedPartials) {
        onUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: p.id,
            title: p.name,
            rawInput: safeParse(p.args)
          }
        } as unknown as SessionNotification)

        try {
          const result = await mcp.callTool({ name: p.name, arguments: safeParse(p.args) })
          const outText = extractToolText(result)
          const isError = (result as { isError?: boolean }).isError === true
          onUpdate({
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: p.id,
              status: isError ? 'failed' : 'completed',
              rawOutput: outText
            }
          } as unknown as SessionNotification)
          session.messages.push({
            role: 'tool',
            tool_call_id: p.id,
            // Non-empty + capped: Gemini rejects empty tool content and stalls
            // on very large payloads.
            content: clampToolOutput(outText, MAX_TOOL_CHARS)
          })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          onUpdate({
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: p.id,
              status: 'failed',
              rawOutput: msg
            }
          } as unknown as SessionNotification)
          session.messages.push({ role: 'tool', tool_call_id: p.id, content: msg || 'tool error' })
        }
      }
    }
  } finally {
    session.abort = null
  }
}

function clampToolOutput(text: string, max: number): string {
  const t = text && text.length ? text : '(no textual output)'
  if (t.length <= max) return t
  return t.slice(0, max) + `\n…[truncated ${t.length - max} chars]`
}

// Open a streaming completion. If Gemini's compat endpoint 400s while tools are
// attached (its function-calling round-trip is finicky), retry once WITHOUT
// tools so the model can still answer in prose from the tool results already in
// the history — a usable degradation instead of a hard failure.
async function createStream(
  gemini: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  signal: AbortSignal
): Promise<Stream<ChatCompletionChunk>> {
  try {
    return await gemini.chat.completions.create({ model, messages, tools, stream: true }, { signal })
  } catch (e) {
    const status = (e as { status?: number }).status
    if (status === 400) {
      console.warn('[gemini] 400 with tools attached — retrying without tools')
      return await gemini.chat.completions.create({ model, messages, stream: true }, { signal })
    }
    throw e
  }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json || '{}')
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function cancelGeminiSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  session?.abort?.abort()
}

export async function killGeminiSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) return
  session.abort?.abort()
  session.dead = true
  sessions.delete(sessionId)
}

export function getGeminiModelState(
  sessionId: string
): { availableModels: ModelInfo[]; currentModelId: string | null } | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  return { availableModels: GEMINI_MODELS, currentModelId: session.modelId }
}

export async function setGeminiModel(sessionId: string, modelId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`unknown Gemini session: ${sessionId}`)
  session.modelId = modelId
}

export function isGeminiSession(sessionId: string): boolean {
  return sessionId.startsWith('gemini:')
}
