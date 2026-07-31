import { API_BASE, signedHeaders } from './signing'

const out = (msg: string): void => {
  const el = document.getElementById('log')
  if (el) el.textContent = `${msg}\n${el.textContent ?? ''}`.slice(0, 4000)
}

let token = ''

async function login(): Promise<void> {
  const r = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'u42', pass: 'hunter2' })
  })
  const data = await r.json()
  token = data.token
  localStorage.setItem('auth.token', token)
  localStorage.setItem('auth.user', JSON.stringify(data.user))
  sessionStorage.setItem('session.started', String(Date.now()))
  out(`login ok, token ${token.slice(0, 24)}...`)
}

async function callApi(path: string): Promise<void> {
  if (!token) token = localStorage.getItem('auth.token') ?? ''
  const headers = await signedHeaders('GET', `${API_BASE}${path}`, '', token)
  const r = await fetch(`${API_BASE}${path}`, { headers })
  out(`GET ${path} -> ${r.status} ${(await r.text()).slice(0, 120)}`)
}

function openSocket(): void {
  const ws = new WebSocket(`ws://${location.host}/ws`)
  ws.onopen = () => {
    out('ws open')
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'ticks' }))
  }
  ws.onmessage = (e) => out(`ws <- ${String(e.data).slice(0, 120)}`)
}

const on = (id: string, fn: () => void): void => {
  document.getElementById(id)?.addEventListener('click', fn)
}

on('btn-login', () => void login())
on('btn-profile', () => void callApi('/profile'))
on('btn-items', () => void callApi('/items?page=1'))
on('btn-ws', openSocket)
on('btn-echo', () => void fetch(`${API_BASE}/echo?name=rever`).then(() => out('echo sent')))

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => out('sw registration failed'))
}
