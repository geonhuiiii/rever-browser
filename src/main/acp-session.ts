import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { appendFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { app } from 'electron'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification
} from '@agentclientprotocol/sdk'
import type { WebContents } from 'electron'

import { startMcpServer } from './mcp/server'
import { extraDirs, findGitBash } from './acp-detect'

export interface AgentDef {
  id: string
  command: string
  args: string[]
}

interface ModelInfo {
  modelId: string
  name: string
  description?: string | null
}

interface SessionEntry {
  agentDef: AgentDef
  child: ChildProcessByStdio<Writable, Readable, Readable>
  connection: ClientSideConnection
  sessionId: string
  onUpdate: ((n: SessionNotification) => void) | null
  requestPermission:
    | ((req: RequestPermissionRequest) => Promise<RequestPermissionResponse>)
    | null
  dead: boolean
  // True once rever explicitly asked to kill this session (reset/New chat/agent
  // switch/abort). Lets the close handler distinguish an intentional teardown
  // from a spontaneous agent crash.
  killRequested: boolean
  availableModels: ModelInfo[]
  currentModelId: string | null
  // Settle-tracking promise for the in-flight prompt (null when idle). Used to
  // avoid issuing concurrent prompts on one ACP session after a Stop.
  activePrompt: Promise<void> | null
}

const sessions = new Map<string, SessionEntry>()

// Persistent ACP lifecycle log. Console output is invisible in a packaged
// build; this file (userData/acp-diagnostic.log) captures spawn / child-death /
// kill / stderr so a hang can be diagnosed after the fact.
function acpLog(msg: string): void {
  try {
    appendFileSync(
      join(app.getPath('userData'), 'acp-diagnostic.log'),
      `[${new Date().toISOString()}] ${msg}\n`
    )
  } catch {}
}

// Claude Code CLI가 부모 프로세스에서 물려받은 CLAUDECODE / CLAUDE_CODE_* 변수를
// 보고 "nested session"으로 판단해 기동을 거부한다 (rever-browser 자체를 Claude
// Code 세션 안에서 실행한 경우). 에이전트 자식 프로세스는 독립 세션이어야 하므로
// 해당 변수들을 제거한 env를 만들어 넘긴다.
function agentEnv(command: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const isClaudeSessionVar = (name: string): boolean =>
    name === 'CLAUDECODE' || name.startsWith('CLAUDE_CODE_')
  if (process.platform === 'win32') {
    // Windows는 환경변수 이름이 대소문자를 구분하지 않아 'ClaudeCode' 같은
    // 변형 표기로도 상속될 수 있다. 대문자로 정규화해 비교한다.
    for (const key of Object.keys(env)) {
      if (isClaudeSessionVar(key.toUpperCase())) delete env[key]
    }
  } else {
    for (const key of Object.keys(env)) {
      if (isClaudeSessionVar(key)) delete env[key]
    }
  }

  // Finder에서 실행된 패키지 앱은 로그인 셸의 PATH를 물려받지 못해
  // `/usr/bin:/bin`만 남는다. 이러면 에이전트 바이너리(절대경로로 넘어옴)의
  // `#!/usr/bin/env node` shebang이 node를 못 찾아 spawn이 즉시 죽는다.
  // node는 보통 에이전트 바이너리와 같은 bin/에 있으므로(nvm/volta) 그 디렉터리와
  // 흔한 설치 위치들을 PATH 앞에 붙여 shebang이 항상 해석되게 한다.
  const prepend: string[] = []
  if (command && isAbsolute(command)) prepend.push(dirname(command))
  prepend.push(...extraDirs())
  const existing = (env.PATH ?? '').split(delimiter).filter(Boolean)
  const seen = new Set<string>()
  env.PATH = [...prepend, ...existing].filter((d) => d && !seen.has(d) && seen.add(d)).join(delimiter)

  // On Windows, point the agent's Bash tool at Git Bash rather than letting it
  // fall back to the WSL launcher (System32\bash.exe) — which runs inside a
  // Linux distro on a different filesystem, so agent-created files land where
  // the user can't see them and long commands hang. Also nudge tools toward
  // UTF-8 so Korean output isn't mojibaked by the CP949 console codepage.
  if (process.platform === 'win32') {
    const gitBash = findGitBash()
    if (gitBash) env.SHELL = gitBash
    env.LANG = env.LANG || 'C.UTF-8'
    env.LC_ALL = env.LC_ALL || 'C.UTF-8'
    // Make Python-based tools default to UTF-8 too.
    env.PYTHONUTF8 = env.PYTHONUTF8 || '1'
  }
  return env
}

function pickAutoApproveOption(req: RequestPermissionRequest): string {
  const allowAlways = req.options.find((o) => o.kind === 'allow_always')
  if (allowAlways) return allowAlways.optionId
  const allow = req.options.find((o) => o.kind.startsWith('allow'))
  return allow?.optionId ?? req.options[0]?.optionId ?? ''
}

export async function spawnAcpSession(
  agentDef: AgentDef,
  cwd: string
): Promise<{ sessionId: string }> {
  // On Windows, npm installs the agent CLI as a `.cmd` shim. Node 22's
  // CVE-2024-27980 patch refuses to spawn `.cmd`/`.bat` without `shell: true`
  // (throws EINVAL). Setting shell on Windows lets the resolved absolute
  // path execute cleanly. On POSIX the binary is a real executable / JS
  // shebang, so we leave shell off to avoid quoting surprises.
  const child = spawn(agentDef.command, agentDef.args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: agentEnv(agentDef.command),
    shell: process.platform === 'win32'
  }) as ChildProcessByStdio<Writable, Readable, Readable>

  // Keep the last few stderr lines so we can explain WHY the child died when it
  // closes (agents often print the reason to stderr right before exiting).
  acpLog(`spawn id=${agentDef.id} command=${agentDef.command} cwd=${cwd} shell=${process.platform === 'win32'}`)
  const stderrTail: string[] = []
  child.stderr.on('data', (buf: Buffer) => {
    const text = buf.toString()
    console.error(`[ACP ${agentDef.id}]`, text)
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        stderrTail.push(line)
        acpLog(`stderr[${agentDef.id}] ${line}`)
      }
    }
    while (stderrTail.length > 20) stderrTail.shift()
  })

  // PATH에 바이너리가 없거나 실행 권한이 없을 때 ENOENT/EACCES 에러가 발생한다.
  // 핸들러 없이 방치하면 main 프로세스가 죽으므로 반드시 등록한다.
  let childError: Error | null = null
  child.on('error', (e) => {
    childError = e
    console.error(`[ACP ${agentDef.id}] spawn error:`, e.message)
  })

  const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  const stream = ndJsonStream(input, output)

  let entryRef: SessionEntry | null = null

  const clientImpl: Client = {
    async requestPermission(
      params: RequestPermissionRequest
    ): Promise<RequestPermissionResponse> {
      // Route to the renderer's permission UI when a prompt is in flight.
      // Falls back to auto-approve if no handler is attached or the round-trip
      // fails/times out — so the agent loop can never deadlock on a missing UI.
      const toolTitle =
        (params as unknown as { toolCall?: { title?: string } }).toolCall?.title ?? '?'
      acpLog(`requestPermission id=${agentDef.id} tool=${toolTitle} hasHandler=${!!entryRef?.requestPermission}`)
      const started = Date.now()
      const handler = entryRef?.requestPermission
      if (handler) {
        try {
          const r = await handler(params)
          acpLog(`requestPermission RESOLVED id=${agentDef.id} tool=${toolTitle} waitedMs=${Date.now() - started}`)
          return r
        } catch (e) {
          console.error('[acp] permission round-trip failed, auto-approving:', e)
          acpLog(`requestPermission FAILED id=${agentDef.id} tool=${toolTitle} err=${e instanceof Error ? e.message : String(e)}`)
        }
      }
      return {
        outcome: { outcome: 'selected', optionId: pickAutoApproveOption(params) }
      }
    },
    async sessionUpdate(params: SessionNotification): Promise<void> {
      entryRef?.onUpdate?.(params)
    }
  }

  const connection = new ClientSideConnection((_agent: Agent) => clientImpl, stream)

  // 바이너리가 없거나 stdio가 끊겼을 때 영원히 pending되는 것을 방지하기 위해
  // initialize / newSession 모두 10초 타임아웃을 적용한다.
  function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`ACP ${label} timed out after ${ms}ms`)), ms)
      )
    ])
  }

  await withTimeout(
    connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
    10_000,
    'initialize'
  ).catch((e) => {
    // childError가 있으면 더 구체적인 메시지를 포함해 던진다.
    if (childError) throw new Error(`Failed to spawn agent "${agentDef.command}": ${childError.message}`)
    throw e
  })

  const mcp = await startMcpServer()
  const result = await withTimeout(
    connection.newSession({
      cwd,
      mcpServers: [
        {
          type: 'http',
          name: 'rever-traffic',
          url: mcp.url,
          headers: []
        }
      ],
      // settingSources를 빈 배열로 두지 않으면 claude-agent-acp가 사용자의
      // ~/.claude.json에 등록된 모든 개인 MCP 서버(playwright/notion/postgres 등
      // 20여 개)를 매 세션마다 띄운다. 이 부팅이 ~9.5초 걸려 아래 newSession
      // 10초 타임아웃을 자주 넘긴다("ACP newSession timed out"). 에이전트에는
      // 위에서 명시한 rever-traffic MCP만 있으면 되므로 개인 설정 로딩을 끈다.
      // (인증은 settingSources와 무관하게 유지된다.)
      _meta: { claudeCode: { options: { settingSources: [] } } }
    }),
    10_000,
    'newSession'
  )

  console.log('[acp:newSession] result keys:', Object.keys(result), 'models:', JSON.stringify((result as { models?: unknown }).models))
  const modelState = (result as { models?: { availableModels?: ModelInfo[]; currentModelId?: string } | null }).models
  const entry: SessionEntry = {
    agentDef,
    child,
    connection,
    sessionId: result.sessionId,
    onUpdate: null,
    requestPermission: null,
    dead: false,
    killRequested: false,
    availableModels: modelState?.availableModels ?? [],
    currentModelId: modelState?.currentModelId ?? null,
    activePrompt: null
  }
  entryRef = entry
  sessions.set(result.sessionId, entry)

  // child가 닫히면 세션을 dead로 표시한다. 진행 중인 prompt는 connection
  // 레벨에서 끊기므로 promptAcpSession 내의 connection.prompt()가 자연스럽게
  // reject된다 (ndJsonStream이 closed stream에서 에러를 던진다).
  child.on('close', (code, signal) => {
    entry.dead = true
    sessions.delete(result.sessionId)
    const killedBy = entry.killRequested ? ' (rever called kill)' : ''
    console.warn(
      `[ACP ${agentDef.id}] child closed — code=${code} signal=${signal}${killedBy}`
    )
    acpLog(
      `child closed id=${agentDef.id} code=${code} signal=${signal} killRequested=${entry.killRequested} lastStderr="${stderrTail.slice(-5).join(' | ')}"`
    )
    if (code !== 0 && stderrTail.length) {
      console.warn(`[ACP ${agentDef.id}] last stderr:\n  ${stderrTail.slice(-8).join('\n  ')}`)
    }
  })

  return { sessionId: result.sessionId }
}

export async function promptAcpSession(
  sessionId: string,
  text: string,
  onUpdate: (n: SessionNotification) => void,
  requestPermission?: (req: RequestPermissionRequest) => Promise<RequestPermissionResponse>
): Promise<{ stopReason: string }> {
  const entry = sessions.get(sessionId)
  if (!entry) throw new Error(`unknown ACP session: ${sessionId}`)
  if (entry.dead) throw new Error(`ACP session is dead: ${sessionId}`)

  // A previous turn may still be in flight (user hit Stop, then sent a new
  // message before the agent honoured session/cancel). ACP allows one prompt
  // per session at a time — re-cancel and wait (bounded) for it to settle.
  if (entry.activePrompt) {
    await entry.connection.cancel({ sessionId: entry.sessionId }).catch(() => null)
    await Promise.race([
      entry.activePrompt,
      new Promise<void>((resolve) => setTimeout(resolve, 6_000))
    ])
  }

  // Wrap onUpdate to log each tool call + completion, so the diagnostic file
  // shows the LAST tool before a stall (e.g. a Write that never completes).
  entry.onUpdate = (n) => {
    const u = (n as unknown as { update?: { sessionUpdate?: string; title?: string; status?: string } }).update
    if (u?.sessionUpdate === 'tool_call') acpLog(`tool_call id=${entry.agentDef.id} title=${u.title ?? '?'}`)
    else if (u?.sessionUpdate === 'tool_call_update') acpLog(`tool_call_update id=${entry.agentDef.id} status=${u.status ?? '?'}`)
    onUpdate(n)
  }
  entry.requestPermission = requestPermission ?? null
  acpLog(`prompt start id=${entry.agentDef.id} textLen=${text.length}`)
  const p = entry.connection.prompt({
    sessionId: entry.sessionId,
    prompt: [{ type: 'text', text }]
  })
  entry.activePrompt = p.then(
    () => undefined,
    () => undefined
  )
  try {
    const res = await p
    acpLog(`prompt settled id=${entry.agentDef.id} stopReason=${res.stopReason}`)
    return { stopReason: res.stopReason }
  } catch (e) {
    acpLog(`prompt THREW id=${entry.agentDef.id} err=${e instanceof Error ? e.message : String(e)}`)
    throw e
  } finally {
    entry.activePrompt = null
    entry.onUpdate = null
    entry.requestPermission = null
  }
}

export async function cancelAcpSession(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId)
  if (!entry || entry.dead) return
  await entry.connection.cancel({ sessionId: entry.sessionId }).catch(() => null)
}

export async function killAcpSession(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId)
  if (!entry) return
  console.warn(`[ACP ${entry.agentDef.id}] killAcpSession requested for ${sessionId}`)
  acpLog(`killAcpSession requested id=${entry.agentDef.id} sessionId=${sessionId}`)
  entry.dead = true
  entry.killRequested = true
  sessions.delete(sessionId)
  entry.child.kill()
}

export function getSessionModelState(
  sessionId: string
): { availableModels: ModelInfo[]; currentModelId: string | null } | null {
  const entry = sessions.get(sessionId)
  if (!entry) return null
  return {
    availableModels: entry.availableModels,
    currentModelId: entry.currentModelId
  }
}

export async function setSessionModel(sessionId: string, modelId: string): Promise<void> {
  const entry = sessions.get(sessionId)
  if (!entry) throw new Error(`unknown ACP session: ${sessionId}`)
  if (entry.dead) throw new Error(`ACP session is dead: ${sessionId}`)
  const conn = entry.connection as unknown as {
    unstable_setSessionModel?: (params: { sessionId: string; modelId: string }) => Promise<unknown>
  }
  if (!conn.unstable_setSessionModel) {
    throw new Error('ACP SDK does not expose unstable_setSessionModel on this connection')
  }
  await conn.unstable_setSessionModel({ sessionId: entry.sessionId, modelId })
  entry.currentModelId = modelId
}
