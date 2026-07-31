# Testing browser tools without a human

An agent working on this repo can drive the running app itself. Do that instead
of writing test steps for the user to run and paste back — the loop is faster,
and it removes the transcription gap where a real failure gets summarised away.

## Why this works

`src/main/index.ts` starts the MCP server when the app becomes ready, and
`src/main/mcp/server.ts` publishes its address to:

```
~/Library/Application Support/rever-browser/mcp-endpoint.json
```

The port is OS-assigned, so that file is the only way in from outside. The
server used to start lazily on the first agent spawn, which meant the in-app
chat panel was the sole entry point.

## The loop

```bash
# 1. Start the app. Main- and preload-process changes need a full restart;
#    HMR does not pick them up.
pgrep -f "Electron|electron-vite" | xargs -r kill -9
bun run dev > /tmp/rever-dev.log 2>&1 &

# 2. Wait for the endpoint to appear (about a second).
E="$HOME/Library/Application Support/rever-browser/mcp-endpoint.json"
for i in $(seq 1 40); do [ -f "$E" ] && break; sleep 1; done

# 3. Drive it.
python3 scripts/mcp-call.py browser_navigate '{"url":"https://example.com"}'
python3 scripts/mcp-call.py browser_snapshot '{"full":true}'
python3 scripts/mcp-call.py browser_click '{"ref":"r4"}'
python3 scripts/mcp-call.py list_requests
python3 scripts/mcp-call.py --list          # every registered tool
```

Any tool in `src/main/mcp/tools/` is reachable this way, not just the browser
ones — `list_requests`, `grep_scripts`, `repeater_send`, and the rest all work.

## Fixtures

`test-fixtures/` holds pages whose expected result is printed on the page next
to each group, so checking a run is mechanical rather than a judgement call.
Serve them on two origins — the second one exists so cross-origin and cross-site
frames can be told apart:

```bash
cd test-fixtures
python3 -m http.server 8777 --bind 127.0.0.1 &
python3 -m http.server 8778 --bind 0.0.0.0 &
```

| Fixture | URL | Covers |
|---|---|---|
| `snapshot-fixture.html` | `http://127.0.0.1:8777/snapshot-fixture.html` | viewport filtering, hidden/occluded nodes, off-screen scroll hints, click-scan detection and over-detection guards |
| `iframe-fixture.html` | `http://127.0.0.1:8777/iframe-fixture.html` | same-origin, cross-origin and cross-site (OOPIF) frames |
| `shadow-fixture.html` | `http://127.0.0.1:8777/shadow-fixture.html` | open/closed/nested shadow roots, inner scroll containers, `*new` node marking |
| `api-target/` (see below) | `http://127.0.0.1:8779/` | the API-analysis tools — traffic capture, scripts, sourcemaps, crypto, replay/repeater, fuzz probes, WebSocket, storage |

The API target is a Bun server, not a static page, because it needs to sign
requests, upgrade WebSockets, and register a service worker. Every secret it
uses is printed in the file header, so a tool's answer is checkable:

```bash
bun test-fixtures/api-target/server.ts   # listens on 8779
# rebuild the bundle + source map after editing src/:
cd test-fixtures/api-target && bun build src/app.ts --outdir public --minify --sourcemap=linked --entry-naming app.js
```

Its service worker caches `app.js`, so a second load serves the bundle from
cache — which is exactly the path that exercises the response-refetch fallback
in `chrome-cdp.ts`. The `§` fuzz marker is captured percent-encoded (`%C2%A7`);
the fuzz tools decode it, so a captured `?name=§` request is a valid base.

Clicking a fixture target fires a distinctly-named `fetch`, so `list_requests`
proves a trusted click actually reached the handler. That matters: a click with
a wrong coordinate offset does not error, it silently hits something else.

## When the app is not enough

Some questions are about CDP itself rather than about this app — "does
`Accessibility.getFullAXTree({frameId})` return content for a cross-origin
frame?", "do `DOMSnapshot` bounds share a coordinate space with
`getBoundingClientRect`?". Drive a real Chrome directly for those:

```js
// node probe.mjs — chrome-remote-interface is already a dependency
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const CDP = createRequire(process.cwd() + '/').call(null, 'chrome-remote-interface')

spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--remote-debugging-port=9333', '--headless=new', '--no-first-run',
  '--user-data-dir=/tmp/cdp-probe', 'about:blank'
], { stdio: 'ignore' })
```

Answering the CDP question first has repeatedly turned out cheaper than
implementing against an assumption and debugging the result.

## Gotchas

- **Refs go stale after every action.** `browser_click`, `browser_type` and
  `browser_navigate` all return a fresh snapshot; ref numbers from before the
  action point at different elements afterwards. Re-read them from the response.
- **Main-process edits need a restart.** Renderer changes hot-reload; anything
  under `src/main/` does not.
- **A silent miss is the failure mode to design for.** Prefer a check that
  proves the effect (a captured request, a changed count) over one that merely
  shows no error.
