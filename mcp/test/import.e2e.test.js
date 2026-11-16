// import_history over MCP HTTP against the real api/server.js, with a scoped token the way an
// assistant's connector holds one: the import lands in the profile, the server's scope check lets
// it through (and only with workouts:apply), and nothing outside the token's categories changes.
// Needs api/'s dependencies, like log-workout.e2e.test.js.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'api')
const HAVE_API = fs.existsSync(path.join(API, 'node_modules', '@simplewebauthn', 'server'))
if (!HAVE_API && process.env.CI) throw new Error('api/node_modules is missing: run `npm ci` in api/ before the MCP tests in CI')

const SECRET = crypto.randomBytes(32).toString('hex')
const A = 'u_imp_a'
const cookie = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`
  return 'gymsid=' + payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
}
const DOC = {
  unit: 'kg', restSec: 120,
  routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 5, weight: 100, mode: 'reps' }], _ts: 1000 }],
  week: { 1: ['r1'] },
  workouts: [{ id: 'w-old', d: '2026-08-21', start: 1755799200000, end: 1755802800000, routineIds: ['r1'], routineId: 'r1', name: 'Mine', prs: [], entries: [{ id: '0025', sets: [{ w: 100, r: 5, done: true }], topW: 100, target: null }] }],
  exWeights: {}, customEx: [], bodyweight: [{ d: '2026-08-01', w: 80, t: 1000 }],
  coach: { chat: [{ text: 'private' }] }, _rev: 5, _wid: 'w-seed', _ts: 1000,
}
const CSV = [
  'workout name,exercise,date,weight kg,reps,rpe',
  'Leg Day,Squat,2026-08-21,120,5,8',
  'Push,Bench Press,2026-08-23,80,8,',
  'Push,Bench Press,2026-08-23,80,7,9',
  'Pull,Grip Wizard 3000,2026-08-25,20,10,',
  'Pull,Pull Up,2026-08-25,0,8,',
].join('\n')

let child, dataDir, apiBase, mcp, mcpUrl, log = ''
const stored = () => JSON.parse(fs.readFileSync(path.join(dataDir, `state-${A}.json`), 'utf8'))
async function makeToken(scopes) {
  const r = await fetch(apiBase + '/api/tokens', { method: 'POST', headers: { Cookie: cookie(A), 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'test', scopes }) })
  return (await r.json()).token
}
async function connect(token) {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }))
  return client
}
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  const text = r.content[0].text
  return r.isError ? { error: text } : JSON.parse(text)
}

describe.skipIf(!HAVE_API)('import_history through a scoped token, against the real api', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-mcp-import-'))
    fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 })
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: A, name: A, created: new Date().toISOString() }], creds: [], subs: [], invites: [] }))
    fs.writeFileSync(path.join(dataDir, `state-${A}.json`), JSON.stringify(DOC))
    child = spawn(process.execPath, ['server.js'], {
      cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', MCP: 'on' },
    })
    child.stderr.on('data', d => { log += d })
    const port = await new Promise((resolve, reject) => {
      const give = setTimeout(() => reject(new Error('server never announced a port:\n' + log)), 20000)
      child.stdout.on('data', d => { log += d; const m = /gym-api on :(\d+)/.exec(log); if (m) { clearTimeout(give); resolve(+m[1]) } })
      child.once('exit', code => { clearTimeout(give); reject(new Error(`server exited (${code}):\n${log}`)) })
    })
    apiBase = `http://127.0.0.1:${port}`
    delete process.env.OPENGYM_DATA
    const { createMcpHandler } = await import('../src/http.js')
    const handle = createMcpHandler({ apiUrl: apiBase, allowedOrigins: ['https://gym.example.com'] })
    mcp = http.createServer((req, res) => handle(req, res))
    await new Promise(r => mcp.listen(0, '127.0.0.1', r))
    mcpUrl = `http://127.0.0.1:${mcp.address().port}/mcp`
  }, 30000)
  afterAll(() => { child?.kill('SIGKILL'); mcp?.close(); fs.rmSync(dataDir, { recursive: true, force: true }) })

  test('not offered to a token that may only see workouts', async () => {
    const c = await connect(await makeToken({ workouts: 'view', plans: 'apply' }))
    const names = (await c.listTools()).tools.map(t => t.name)
    expect(names).not.toContain('import_history')
    await c.close()
  })

  test('preview, then import: in the profile, the day already logged kept, nothing else touched', async () => {
    const c = await connect(await makeToken({ workouts: 'apply', plans: 'apply', bodyweight: 'view' }))
    expect((await c.listTools()).tools.map(t => t.name)).toContain('import_history')

    const dry = await call(c, 'import_history', { file: CSV, dry_run: true })
    expect(dry).toMatchObject({ dry_run: true, workouts_in_file: 3, workouts_added: 2, days_already_logged: 1 })
    expect(stored()._rev).toBe(5)

    const r = await call(c, 'import_history', { file: CSV })
    expect(r).toMatchObject({ imported: true, workouts_added: 2 })
    const after = stored()
    expect(after.workouts.map(w => w.d)).toEqual(['2026-08-21', '2026-08-23', '2026-08-25'])
    expect(after.workouts[0].id).toBe('w-old')
    expect(after.customEx.map(c => c.n.toLowerCase())).toEqual(['grip wizard 3000'])
    for (const k of ['routines', 'week', 'bodyweight', 'coach', 'restSec', 'unit']) expect(after[k]).toEqual(DOC[k])

    // read back through the read tools, over the same token
    const list = await call(c, 'list_workouts', { from: '2026-08-01', to: '2026-08-31' })
    expect(JSON.stringify(list)).toContain('2026-08-25')

    const again = await call(c, 'import_history', { file: CSV })
    expect(again).toMatchObject({ imported: false, nothing_new: true })
    await c.close()
  })
})
