export type ACPAgentID = 'claude-code' | 'codex' | 'anthropic' | 'openai' | 'gemini'

export interface ACPAgentDef {
  id: ACPAgentID
  name: string
  /** Primary CLI binary to look for on PATH. */
  command: string
  /** Drop-in forks tried if `command` isn't on PATH. */
  fallbackBins?: string[]
  /** Argv passed to the binary at spawn time. */
  args: string[]
  /** True if this binary speaks ACP and can drive our MCP tool loop. */
  acpSupported: boolean
  /**
   * How the agent loop runs. 'acp' spawns an external ACP binary; 'anthropic'
   * and 'openai' call their respective APIs directly in-process and are gated on
   * an API key instead of a PATH binary.
   */
  provider?: 'acp' | 'anthropic' | 'openai' | 'gemini'
  /** Short hint shown in the picker when the binary isn't found. */
  installHint: string
  /** Single character used in the picker tile. */
  icon: string
}

export const ACP_AGENTS: ACPAgentDef[] = [
  {
    id: 'anthropic',
    name: 'Claude (API)',
    command: '',
    args: [],
    acpSupported: true,
    provider: 'anthropic',
    installHint: 'Add an Anthropic API key in settings',
    icon: 'A'
  },
  {
    id: 'openai',
    name: 'OpenAI (API)',
    command: '',
    args: [],
    acpSupported: true,
    provider: 'openai',
    installHint: 'Add an OpenAI API key in settings',
    icon: 'O'
  },
  {
    id: 'gemini',
    name: 'Gemini (API)',
    command: '',
    args: [],
    acpSupported: true,
    provider: 'gemini',
    installHint: 'Add a Gemini API key in settings',
    icon: 'G'
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude-agent-acp',
    fallbackBins: ['claude-code-acp'],
    args: [],
    acpSupported: true,
    provider: 'acp',
    installHint: 'npm i -g @agentclientprotocol/claude-agent-acp',
    icon: 'C'
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex-acp',
    args: [],
    acpSupported: true,
    installHint: 'npm i -g @agentclientprotocol/codex-acp',
    icon: 'X'
  }
]

export const ACP_PERMISSION_TIMEOUT_MS = 60_000
