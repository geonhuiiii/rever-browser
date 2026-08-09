import { access, constants } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir, platform } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface AgentProbe {
  /** Primary binary to look for. */
  command: string
  /** Drop-in forks tried if `command` isn't on PATH. */
  fallbackBins?: string[]
}

export interface AgentProbeResult {
  /** Original command requested. */
  command: string
  /** Absolute path that was found, or null. */
  resolvedPath: string | null
  /** Which bin actually matched (command or one of the fallbacks). */
  matchedBin: string | null
}

const isWindows = platform() === 'win32'

/** Windows PATHEXT values, lowercased, with '' for already-suffixed names. */
function getWindowsExts(): string[] {
  const raw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
  return ['', ...raw.split(';').map((e) => e.toLowerCase()).filter(Boolean)]
}

function getPathDirs(): string[] {
  const fromEnv = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  return [...fromEnv, ...extraDirs()]
}

/** Augment PATH with locations commonly missing from Electron's env. */
export function extraDirs(): string[] {
  const home = homedir()
  if (isWindows) {
    const appData = process.env.APPDATA
    const programFiles = process.env.ProgramFiles
    const localAppData = process.env.LOCALAPPDATA
    return [
      appData ? join(appData, 'npm') : '',
      join(home, 'AppData', 'Roaming', 'npm'),
      join(home, 'scoop', 'shims'),
      join(home, '.bun', 'bin'),
      // Node.js itself. The agent CLIs install as `.cmd` shims that invoke
      // `node`, so node.exe must be on the child's PATH or the shim dies with
      // "'node' is not recognized" and the ACP connection closes immediately.
      // Electron launched from Explorer/a packaged build does not always
      // inherit the user's node dir, so add the common install locations.
      process.env.NVM_SYMLINK || '', // nvm-windows: active node.exe lives here
      programFiles ? join(programFiles, 'nodejs') : '', // standard MSI installer
      localAppData ? join(localAppData, 'Programs', 'nodejs') : '',
      join(home, 'scoop', 'apps', 'nodejs', 'current'),
      // Git Bash. Claude Code's Bash tool needs a POSIX shell. These dirs go
      // AHEAD of C:\Windows\System32 (added below via the existing PATH), so
      // `bash` resolves to Git Bash — NOT the WSL launcher at
      // System32\bash.exe, which runs commands inside a Linux distro on a
      // different filesystem, so files "vanish" and long commands hang.
      programFiles ? join(programFiles, 'Git', 'usr', 'bin') : '',
      programFiles ? join(programFiles, 'Git', 'bin') : '',
      programFiles ? join(programFiles, 'Git', 'cmd') : '',
      localAppData ? join(localAppData, 'Programs', 'Git', 'usr', 'bin') : '',
      localAppData ? join(localAppData, 'Programs', 'Git', 'bin') : ''
    ].filter(Boolean)
  }
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.npm-global', 'bin')
  ]
}

/**
 * Absolute path to Git Bash's bash.exe, or null. Prefers the real Git Bash over
 * the WSL launcher (System32\bash.exe) so the agent's shell runs on Windows
 * with the expected working directory instead of inside a Linux distro.
 */
export function findGitBash(): string | null {
  if (!isWindows) return null
  const pf = process.env.ProgramFiles
  const lad = process.env.LOCALAPPDATA
  const candidates = [
    pf ? join(pf, 'Git', 'bin', 'bash.exe') : '',
    pf ? join(pf, 'Git', 'usr', 'bin', 'bash.exe') : '',
    lad ? join(lad, 'Programs', 'Git', 'bin', 'bash.exe') : '',
    lad ? join(lad, 'Programs', 'Git', 'usr', 'bin', 'bash.exe') : ''
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) ?? null
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, isWindows ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve a single bin name to an absolute path, or null if not found. */
async function which(bin: string, dirs: string[], exts: string[]): Promise<string | null> {
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext)
      if (await isExecutable(candidate)) return candidate
    }
  }
  return null
}

/**
 * Resolve a list of agent probes against PATH. For each entry, tries
 * `command` first, then `fallbackBins` in order. Pure read — never spawns
 * the binary, just stat-checks files.
 */
export async function detectAgents(probes: AgentProbe[]): Promise<AgentProbeResult[]> {
  const dirs = getPathDirs()
  const exts = isWindows ? getWindowsExts() : ['']

  // Also try `npm prefix -g` once and prepend its bin/ — picks up custom
  // npm prefixes (nvm, volta) that aren't on PATH inside Electron.
  try {
    const { stdout } = await execFileP(isWindows ? 'npm.cmd' : 'npm', ['prefix', '-g'], {
      timeout: 2_000
    })
    const prefix = stdout.trim()
    if (prefix) {
      dirs.unshift(isWindows ? prefix : join(prefix, 'bin'))
    }
  } catch {
    // npm not on PATH — skip silently
  }

  return Promise.all(
    probes.map(async (probe) => {
      const candidates = [probe.command, ...(probe.fallbackBins ?? [])]
      for (const bin of candidates) {
        const resolved = await which(bin, dirs, exts)
        if (resolved) {
          return { command: probe.command, resolvedPath: resolved, matchedBin: bin }
        }
      }
      return { command: probe.command, resolvedPath: null, matchedBin: null }
    })
  )
}
