import { session } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pbkdf2Sync, createDecipheriv } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  chmodSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getActivePartition } from './tab-partition'
import { chromeUserDataDir, IS_MAC, IS_WINDOWS } from './platform'

// Import session cookies from the real desktop Chrome profile into the active
// tab's partition. This is the single biggest lever for WAF / CAPTCHA
// avoidance: a brand-new partition with zero cookies looks like a first-time
// visitor and gets the strictest treatment. Re-using a logged-in Chrome
// session makes us look like a returning, trusted user.
//
// Chrome cookie values are encrypted, but the scheme differs per OS:
//   • macOS  — AES-128-CBC, key = PBKDF2-SHA1(Keychain "Chrome Safe Storage"
//              password, 'saltysalt', 1003). One-time Keychain prompt.
//   • Windows — AES-256-GCM, key = DPAPI-unprotect(Local State
//              os_crypt.encrypted_key). No prompt (CurrentUser scope).
//   • Linux  — AES-128-CBC, key = PBKDF2-SHA1('peanuts', 'saltysalt', 1) for
//              the basic/plaintext store (the common headless case). The
//              gnome-keyring path is not handled.
// Modern Chrome (all OSes) prepends a 32-byte SHA256(host) hash to the
// plaintext — detected and stripped adaptively. App-bound `v20`/`v11` values
// (newest Windows/Chrome) need a key we cannot reach and are reported, not
// faked.

const execFileAsync = promisify(execFile)

const MAC_LINUX_IV = Buffer.alloc(16, 0x20) // 16 spaces
const DOMAIN_HASH_LEN = 32
// Chrome stores expires_utc as microseconds since 1601-01-01 (Windows epoch).
const WINDOWS_EPOCH_OFFSET_SECONDS = 11_644_473_600

export interface ChromeImportOptions {
  profile?: string
  // Substring filters on the cookie host (e.g. ['yes24.com', 'google']). When
  // omitted, every cookie in the profile is imported.
  hosts?: string[]
}

export interface ChromeImportResult {
  ok: boolean
  imported: number
  skipped: number
  undecryptable: number
  total: number
  error?: string
}

interface RawCookie {
  host: string
  name: string
  path: string | null
  secure: number
  httpOnly: number
  expires: number
  enc: Buffer
}

/** A per-cookie decryptor bound to the OS-specific key + algorithm. */
type Decryptor = (encrypted: Buffer) => string | null

// ── Profile discovery ───────────────────────────────────────────────────────

function chromeBaseDir(): string | null {
  return chromeUserDataDir()
}

// Modern Chrome moved the cookie db under a `Network/` subdirectory; older
// builds kept it directly in the profile dir. Check both so we work across
// Chrome versions on every OS.
function cookieDbPath(profileDir: string): string | null {
  for (const rel of [join('Network', 'Cookies'), 'Cookies']) {
    const p = join(profileDir, rel)
    if (existsSync(p)) return p
  }
  return null
}

export function listChromeProfiles(): string[] {
  const base = chromeBaseDir()
  if (!base) return []
  try {
    return readdirSync(base).filter((name) => {
      try {
        return statSync(join(base, name)).isDirectory() && cookieDbPath(join(base, name)) != null
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

// ── Key acquisition (per OS) ─────────────────────────────────────────────────

async function getMacKey(): Promise<Buffer> {
  // Triggers a one-time macOS Keychain access prompt the user must allow.
  const { stdout } = await execFileAsync('security', ['find-generic-password', '-wa', 'Chrome'])
  const password = stdout.trim()
  if (!password) throw new Error('empty Chrome Safe Storage password')
  return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
}

// DPAPI-unprotect via PowerShell — no native module needed. Base64 in/out so no
// binary escaping is required. CurrentUser scope, so no prompt.
async function dpapiUnprotect(data: Buffer): Promise<Buffer> {
  const b64 = data.toString('base64')
  const script =
    'Add-Type -AssemblyName System.Security;' +
    `$in=[Convert]::FromBase64String('${b64}');` +
    "$out=[System.Security.Cryptography.ProtectedData]::Unprotect($in,$null,'CurrentUser');" +
    '[Convert]::ToBase64String($out)'
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { maxBuffer: 1024 * 1024, windowsHide: true }
  )
  return Buffer.from(stdout.trim(), 'base64')
}

async function getWindowsKey(base: string): Promise<Buffer> {
  const localStatePath = join(base, 'Local State')
  if (!existsSync(localStatePath)) throw new Error('Chrome "Local State" file not found')
  const parsed = JSON.parse(readFileSync(localStatePath, 'utf8')) as {
    os_crypt?: { encrypted_key?: string }
  }
  const b64Key = parsed.os_crypt?.encrypted_key
  if (!b64Key) throw new Error('no os_crypt.encrypted_key in Local State')
  let encKey = Buffer.from(b64Key, 'base64')
  // Key blob is prefixed with the ASCII marker "DPAPI"; strip it before unprotect.
  if (encKey.subarray(0, 5).toString('latin1') === 'DPAPI') encKey = encKey.subarray(5)
  const key = await dpapiUnprotect(encKey)
  if (key.length !== 32) throw new Error(`unexpected AES key length ${key.length}`)
  return key
}

function getLinuxKey(): Buffer {
  // 'basic'/plaintext store — the reliable, prompt-free case. gnome-keyring
  // (--password-store=gnome) would need a libsecret round-trip we don't do.
  return pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1')
}

// ── Decryption (per OS) ──────────────────────────────────────────────────────

function isMostlyPrintable(buf: Buffer): boolean {
  if (buf.length === 0) return true
  let printable = 0
  for (const b of buf) if (b >= 0x20 && b < 0x7f) printable++
  return printable / buf.length > 0.85
}

// Strip the SHA256(host) prefix modern Chrome prepends to the plaintext. The
// hash is 32 random bytes (non-printable); a bare value starts printable.
function stripDomainHash(pt: Buffer): Buffer {
  if (pt.length >= DOMAIN_HASH_LEN && !isMostlyPrintable(pt.subarray(0, DOMAIN_HASH_LEN))) {
    return pt.subarray(DOMAIN_HASH_LEN)
  }
  return pt
}

// macOS / Linux: AES-128-CBC with a fixed 16-space IV, "v10" prefix.
function decryptCbc(encrypted: Buffer, key: Buffer): string | null {
  if (encrypted.length <= 3) return null
  const prefix = encrypted.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10' && prefix !== 'v11') return null
  const ct = encrypted.subarray(3)
  if (ct.length === 0 || ct.length % 16 !== 0) return null
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, MAC_LINUX_IV)
    decipher.setAutoPadding(true)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return stripDomainHash(pt).toString('utf8')
  } catch {
    return null
  }
}

// Windows: AES-256-GCM, "v10" prefix, layout [v10][12B nonce][ct][16B tag].
// "v20" is app-bound (key sealed to the browser via SYSTEM DPAPI) — unreachable.
function decryptGcm(encrypted: Buffer, key: Buffer): string | null {
  if (encrypted.length < 3 + 12 + 16) return null
  const prefix = encrypted.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10') return null
  const nonce = encrypted.subarray(3, 15)
  const tag = encrypted.subarray(encrypted.length - 16)
  const ct = encrypted.subarray(15, encrypted.length - 16)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return stripDomainHash(pt).toString('utf8')
  } catch {
    return null
  }
}

async function buildDecryptor(base: string): Promise<Decryptor> {
  if (IS_MAC) {
    const key = await getMacKey()
    return (enc) => decryptCbc(enc, key)
  }
  if (IS_WINDOWS) {
    const key = await getWindowsKey(base)
    return (enc) => decryptGcm(enc, key)
  }
  const key = getLinuxKey()
  return (enc) => decryptCbc(enc, key)
}

// ── SQLite read ──────────────────────────────────────────────────────────────

const COOKIE_QUERY =
  'SELECT host_key AS host, name, path, is_secure AS secure, is_httponly AS httpOnly, ' +
  'expires_utc AS expires, encrypted_value AS enc FROM cookies;'

// Prefer the built-in node:sqlite (no external binary); fall back to the
// `sqlite3` CLI where node:sqlite is unavailable. Chrome holds the live db
// locked, so callers pass a temp-copied snapshot path.
async function queryCookies(dbPath: string): Promise<RawCookie[]> {
  try {
    return await queryViaNodeSqlite(dbPath)
  } catch (e) {
    try {
      return await queryViaCli(dbPath)
    } catch (cliErr) {
      throw new Error(
        `could not read cookie db (node:sqlite: ${e instanceof Error ? e.message : e}; ` +
          `sqlite3 CLI: ${cliErr instanceof Error ? cliErr.message : cliErr})`
      )
    }
  }
}

async function queryViaNodeSqlite(dbPath: string): Promise<RawCookie[]> {
  const { DatabaseSync } = (await import('node:sqlite')) as typeof import('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db.prepare(COOKIE_QUERY).all() as Array<Record<string, unknown>>
    return rows.map((r) => ({
      host: String(r.host ?? ''),
      name: String(r.name ?? ''),
      path: r.path == null ? null : String(r.path),
      secure: Number(r.secure ?? 0),
      httpOnly: Number(r.httpOnly ?? 0),
      expires: Number(r.expires ?? 0),
      enc: Buffer.isBuffer(r.enc)
        ? r.enc
        : r.enc instanceof Uint8Array
          ? Buffer.from(r.enc)
          : Buffer.alloc(0)
    }))
  } finally {
    db.close()
  }
}

async function queryViaCli(dbPath: string): Promise<RawCookie[]> {
  const sqlite3Bin = IS_WINDOWS ? 'sqlite3.exe' : 'sqlite3'
  const { stdout } = await execFileAsync(
    sqlite3Bin,
    [
      '-json',
      dbPath,
      'SELECT host_key AS host, name, path, is_secure AS secure, is_httponly AS httpOnly, ' +
        'expires_utc AS expires, hex(encrypted_value) AS enc FROM cookies;'
    ],
    { maxBuffer: 128 * 1024 * 1024, windowsHide: true }
  )
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as Array<Record<string, unknown>>
  return parsed.map((r) => ({
    host: String(r.host ?? ''),
    name: String(r.name ?? ''),
    path: r.path == null ? null : String(r.path),
    secure: Number(r.secure ?? 0),
    httpOnly: Number(r.httpOnly ?? 0),
    expires: Number(r.expires ?? 0),
    enc: Buffer.from(String(r.enc ?? ''), 'hex')
  }))
}

// Copy one db file to `dst`. On Windows, Chrome holds the running cookie db
// with an exclusive lock that a plain copy hits as EBUSY/EPERM — retry through
// a Win32 shared-mode open, which succeeds if this Chrome permits read sharing.
async function copyDbFile(src: string, dst: string): Promise<void> {
  try {
    copyFileSync(src, dst)
    return
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (!IS_WINDOWS || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw e
  }
  // Shared-mode fallback: FileShare.ReadWrite | Delete.
  const script =
    `$fs=[System.IO.File]::Open('${src}',[System.IO.FileMode]::Open,` +
    `[System.IO.FileAccess]::Read,([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete));` +
    `$out=[System.IO.File]::Create('${dst}');$fs.CopyTo($out);$out.Close();$fs.Close()`
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true
  })
}

async function readEncryptedCookies(base: string, profile: string): Promise<RawCookie[]> {
  const profileDir = join(base, profile)
  const src = cookieDbPath(profileDir)
  if (!src) throw new Error(`no Cookies db for profile "${profile}"`)

  // Copy the db (+ WAL sidecars) so we read a consistent snapshot while Chrome
  // holds the live file locked. 0700 dir so other users can't read the cookies.
  const tmpDir = mkdtempSync(join(tmpdir(), 'rev-chrome-cookies-'))
  try {
    mkdirSync(tmpDir, { recursive: true })
    chmodSync(tmpDir, 0o700)
  } catch {}
  const tmp = join(tmpDir, 'Cookies.db')
  try {
    await copyDbFile(src, tmp)
  } catch (e) {
    rmSync(tmpDir, { force: true, recursive: true })
    const code = (e as NodeJS.ErrnoException).code
    if (IS_WINDOWS && (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || /being used by another process/i.test(String(e)))) {
      throw new Error(
        'Windows locks the Chrome cookie database while Chrome is running. Quit Chrome completely (check the tray icon) and try again.'
      )
    }
    throw e
  }
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(src + ext)) {
      try {
        await copyDbFile(src + ext, tmp + ext)
      } catch {
        // Sidecars are best-effort; the main db alone still reads.
      }
    }
  }

  try {
    return await queryCookies(tmp)
  } finally {
    rmSync(tmpDir, { force: true, recursive: true })
  }
}

// ── Public entry ─────────────────────────────────────────────────────────────

export async function importChromeCookies(
  opts: ChromeImportOptions = {}
): Promise<ChromeImportResult> {
  const empty: ChromeImportResult = {
    ok: false,
    imported: 0,
    skipped: 0,
    undecryptable: 0,
    total: 0
  }

  const base = chromeBaseDir()
  if (!base) {
    return { ...empty, error: 'No Chrome/Chromium profile found on this machine.' }
  }

  const profile = opts.profile || 'Default'
  const hostFilters = (opts.hosts ?? []).map((h) => h.toLowerCase()).filter(Boolean)

  // An empty host filter injects the entire Chrome cookie jar into the app.
  // That is a security risk; we warn rather than error to keep existing
  // IPC/UI callers working. A future UI should require explicit confirmation.
  if (hostFilters.length === 0) {
    console.warn(
      '[chrome-cookie-import] WARNING: no host filter specified — importing ALL cookies from profile. This is a security risk.'
    )
  }

  let decrypt: Decryptor
  try {
    decrypt = await buildDecryptor(base)
  } catch (e) {
    const hint = IS_MAC
      ? ' (allow "Chrome Safe Storage" when prompted)'
      : IS_WINDOWS
        ? ' (DPAPI decrypt failed — is this the same Windows user that runs Chrome?)'
        : ''
    return {
      ...empty,
      error: `Cookie key acquisition failed${hint}: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  let raw: RawCookie[]
  try {
    raw = await readEncryptedCookies(base, profile)
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) }
  }

  const matched = hostFilters.length
    ? raw.filter((c) => hostFilters.some((f) => c.host.toLowerCase().includes(f)))
    : raw

  const sess = session.fromPartition(getActivePartition())
  const nowSec = Date.now() / 1000
  let imported = 0
  let skipped = 0
  let undecryptable = 0

  for (const c of matched) {
    const value = decrypt(c.enc)
    if (value == null) {
      undecryptable++
      continue
    }
    const expiresSec = c.expires > 0 ? c.expires / 1e6 - WINDOWS_EPOCH_OFFSET_SECONDS : 0
    if (expiresSec > 0 && expiresSec <= nowSec) {
      skipped++ // already expired
      continue
    }
    const isDomainCookie = c.host.startsWith('.')
    const cookieHost = c.host.replace(/^\./, '')
    const cookiePath = c.path || '/'
    const url = `${c.secure ? 'https' : 'http'}://${cookieHost}${cookiePath}`
    try {
      await sess.cookies.set({
        url,
        name: c.name,
        value,
        path: cookiePath,
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        ...(isDomainCookie ? { domain: c.host } : {}),
        ...(expiresSec > 0 ? { expirationDate: expiresSec } : {})
      })
      imported++
    } catch {
      skipped++
    }
  }

  return { ok: true, imported, skipped, undecryptable, total: matched.length }
}
