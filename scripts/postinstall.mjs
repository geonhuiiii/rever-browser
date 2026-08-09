#!/usr/bin/env node
// Cross-platform postinstall shim. The only postinstall work is a macOS-only
// Info.plist rename of the dev Electron.app (see patch-electron-name.sh), which
// needs bash + PlistBuddy + codesign — all macOS-only. On Windows/Linux there
// is nothing to do, and `bash` may not even be on PATH, so short-circuit here
// instead of forcing every platform through a shell script.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  process.exit(0)
}

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'patch-electron-name.sh')
const res = spawnSync('bash', [script], { stdio: 'inherit' })
// Never fail the install over a cosmetic dev-only rename.
process.exit(res.status === null ? 0 : res.status)
