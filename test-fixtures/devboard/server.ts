/**
 * DevBoard — a deliberately vulnerable community board, for demoing
 * rever-browser (browser control + traffic analysis + exploit).
 *
 * Run:  bun test-fixtures/devboard/server.ts        (listens on 8780)
 *
 * The write path has two planted flaws a reverser is meant to find from the
 * captured POST /api/posts request:
 *
 *   1. Author spoofing  — the server uses `author` from the request body when
 *      present, instead of deriving it from the session token. So anyone who
 *      has seen the API can post under any name, including "admin".
 *   2. No rate limit     — POST /api/posts has no throttle or CAPTCHA, so the
 *      same call can be looped to flood the board.
 *
 * Everything is in-memory and resets on restart.
 */

const PORT = 8780

interface Post {
  id: number
  author: string
  role: 'admin' | 'member'
  title: string
  body: string
  ts: number
  likes: number
}

let nextId = 100
function mk(author: string, role: Post['role'], title: string, body: string, agoMin: number): Post {
  return { id: nextId++, author, role, title, body, ts: Date.now() - agoMin * 60_000, likes: 0 }
}

// Newest first — matches the unshift order new posts arrive in.
const posts: Post[] = [
  mk('sena', 'member', 'Anyone using bun for prod servers?', 'Loving the DX but curious about long-running stability.', 42),
  mk('admin', 'admin', 'Welcome to DevBoard', 'Be kind, stay on topic. Report abuse to the mods.', 1440),
]

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...headers }
  })
}

/** A trivial, readable session token — identifies the user, nothing more. */
function makeToken(id: string, name: string): string {
  return btoa(JSON.stringify({ id, name }))
}
function readToken(auth: string | null): { id: string; name: string } | null {
  if (!auth || !auth.startsWith('Bearer ')) return null
  try {
    return JSON.parse(atob(auth.slice(7)))
  } catch {
    return null
  }
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname
    const method = req.method

    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type,authorization'
        }
      })
    }

    // ── static ──────────────────────────────────────────────────────────
    if (p === '/' || p === '/index.html') {
      return new Response(Bun.file(`${import.meta.dir}/public/index.html`), {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    }
    if (p === '/login') {
      return new Response(Bun.file(`${import.meta.dir}/public/login.html`), {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    }

    // ── auth ────────────────────────────────────────────────────────────
    if (p === '/api/login' && method === 'POST') {
      const b = (await req.json().catch(() => ({}))) as { user?: string; pass?: string }
      if (b.user !== 'rever' || b.pass !== '123123') {
        return json({ error: 'invalid_credentials' }, 401)
      }
      return json({ token: makeToken('u_rever', 'rever'), user: { id: 'u_rever', name: 'rever' } })
    }

    // ── posts ───────────────────────────────────────────────────────────
    if (p === '/api/posts' && method === 'GET') {
      return json({ total: posts.length, posts })
    }

    if (p === '/api/posts' && method === 'POST') {
      const b = (await req.json().catch(() => ({}))) as {
        title?: string
        body?: string
        author?: string
      }
      const who = readToken(req.headers.get('authorization'))

      // FLAW 1 — trusts body.author over the token identity (author spoofing).
      // FLAW 2 — no rate limit / CAPTCHA anywhere on this route (flooding).
      const author = (b.author ?? who?.name ?? 'anonymous').toString().slice(0, 40)
      const role: Post['role'] = author === 'admin' ? 'admin' : 'member'

      const post = mk(author, role, (b.title ?? '(untitled)').slice(0, 140), (b.body ?? '').slice(0, 2000), 0)
      posts.unshift(post)
      return json(post, 201)
    }

    return new Response('not found', { status: 404 })
  }
})

console.log(`devboard listening on http://127.0.0.1:${PORT}`)
console.log('  planted flaws: author spoofing (body.author) + no rate limit on POST /api/posts')
