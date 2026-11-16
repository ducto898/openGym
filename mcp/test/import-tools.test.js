// import_history against a stand-in for the api (as write-tools.test.js): what it reads, what it
// would import, and the one PUT it makes. The reading and merging themselves are the app's own
// (frontend/src/lib/import-apps.js, import-csv.js) and tested there.
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { importHistory } from '../src/import-tools.js'
import { _resetWriteWindow } from '../src/write-tools.js'
import { toolAllowed } from '../src/server.js'

const TOKEN = 'tok.secret-value'

let api
function stubApi(doc, script = {}) {
  const s = { doc: structuredClone(doc), rev: 7, puts: [], script }
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(401, { error: 'not signed in' })
    if (req.url === '/api/me') return send(200, { user: { id: 'u1', name: 'Matt' } })
    if (req.url === '/api/data' && req.method === 'GET') return send(200, { state: s.doc, rev: s.rev })
    if (req.url === '/api/data' && req.method === 'PUT') {
      let raw = ''
      for await (const c of req) raw += c
      const body = JSON.parse(raw)
      s.puts.push(body)
      const next = (script.put || [])[s.puts.length - 1]
      if (next) return next(send, s)
      if (body.baseRev !== s.rev) return send(409, { error: 'conflict', rev: s.rev, state: s.doc })
      s.doc = body.state
      s.rev++
      return send(200, { ok: true, rev: s.rev })
    }
    send(404, { error: 'not found' })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    s.server = server
    s.env = { OPENGYM_URL: `http://127.0.0.1:${server.address().port}`, OPENGYM_TOKEN: TOKEN }
    resolve(s)
  }))
}
afterEach(() => api?.server.close())
beforeEach(() => _resetWriteWindow())

const DOC = () => ({ unit: 'kg', workouts: [], customEx: [], exWeights: {}, restSec: 120, _wid: 'w-abc', _ts: 1 })
const CSV = [
  'workout name,exercise,date,weight kg,reps',
  'Leg Day,Squat,2026-08-21,120,5',
  'Leg Day,Squat,2026-08-21,125,4',
  'Leg Day,Grip Wizard 3000,2026-08-21,20,10',
  'Push,Bench Press,2026-08-23,80,8',
  'Push,Bench Press,2026-08-23,80,7',
].join('\n')
const call = (params, env = api.env) => importHistory.handler(params, { env })

describe('import_history', () => {
  beforeEach(async () => { api = await stubApi(DOC()) })

  test('dry_run reads the file and says what would happen, saving nothing', async () => {
    const r = await call({ file: CSV, dry_run: true })
    expect(r).toMatchObject({ imported: false, dry_run: true, kind: 'workouts', from: '2026-08-21', to: '2026-08-23', workouts_in_file: 2, workouts_added: 2, days_already_logged: 0, sets: 5 })
    expect(r.new_own_exercises).toEqual(['Grip Wizard 3000'])
    const squat = r.exercises.find(e => e.in_file === 'Squat')
    expect(squat).toMatchObject({ becomes: 'library exercise', sets: 2 })
    expect(squat.exercise_id).toBeTruthy()
    expect(r.exercises.find(e => e.in_file === 'Grip Wizard 3000').becomes).toBe('your own exercise')
    expect(api.puts).toHaveLength(0)
  })

  test('imports in one PUT on the revision it read: workouts, the new own exercise, the weight suggestions', async () => {
    const r = await call({ file: CSV })
    expect(r).toMatchObject({ imported: true, workouts_added: 2, revision: 8 })
    expect(api.puts).toHaveLength(1)
    const { state, baseRev, baseWid } = api.puts[0]
    expect(baseRev).toBe(7)
    expect(baseWid).toBe('w-abc')
    expect(state.workouts.map(w => w.d)).toEqual(['2026-08-21', '2026-08-23'])
    expect(state.customEx.map(c => c.n.toLowerCase())).toEqual(['grip wizard 3000'])
    expect(Object.keys(state.exWeights).length).toBeGreaterThan(0)
    expect(state.restSec).toBe(120)
    expect(state._ts).toBeGreaterThan(1)
  })

  test('the same file twice adds nothing and makes no second save', async () => {
    await call({ file: CSV })
    const again = await call({ file: CSV })
    expect(again).toMatchObject({ imported: false, nothing_new: true, workouts_added: 0, days_already_logged: 2 })
    expect(api.puts).toHaveLength(1)
  })

  test('a day that already has a workout keeps it', async () => {
    api.server.close()
    api = await stubApi({ ...DOC(), workouts: [{ id: 'mine', d: '2026-08-21', start: 1, end: 2, name: 'Mine', entries: [], prs: [] }] })
    const r = await call({ file: CSV })
    expect(r).toMatchObject({ imported: true, workouts_added: 1, days_already_logged: 1 })
    const ws = api.puts[0].state.workouts
    expect(ws.filter(w => w.d === '2026-08-21').map(w => w.id)).toEqual(['mine'])
  })

  test('picks move a name to another exercise, or keep it as the user\'s own', async () => {
    const dry = await call({ file: CSV, dry_run: true })
    const benchId = dry.exercises.find(e => e.in_file === 'Bench Press').exercise_id
    const r = await call({ file: CSV, dry_run: true, picks: [{ name: 'Grip Wizard 3000', exercise_id: benchId }, { name: 'squat', exercise_id: null }] })
    expect(r.exercises.find(e => e.in_file === 'Grip Wizard 3000')).toMatchObject({ exercise_id: benchId, becomes: 'library exercise' })
    expect(r.exercises.find(e => e.in_file === 'Squat').becomes).toBe('your own exercise')
  })

  test('a pick naming no exercise is refused before anything is read into the profile', async () => {
    await expect(call({ file: CSV, picks: [{ name: 'Squat', exercise_id: 'nope-123' }] })).rejects.toMatchObject({ code: 'EINPUT' })
    expect(api.puts).toHaveLength(0)
  })

  test('a file that is not an export says so', async () => {
    const r = await call({ file: 'hello,world\n1,2\n' })
    expect(r.imported).toBe(false)
    expect(r.problem).toMatch(/does not read as a workout/)
    expect(api.puts).toHaveLength(0)
  })

  test('an openGym backup is sent to the app\'s own restore', async () => {
    const r = await call({ file: JSON.stringify({ workouts: [], routines: [] }) })
    expect(r.problem).toMatch(/Import backup/)
  })

  test('from/to keep the import to a date range', async () => {
    const r = await call({ file: CSV, from: '2026-08-22', dry_run: true })
    expect(r).toMatchObject({ workouts_in_file: 1, workouts_added: 1, from: '2026-08-23' })
  })

  test('another device writing in between: rebuilt on the server\'s copy, still imported once', async () => {
    api.server.close()
    api = await stubApi(DOC(), {
      put: [(send, s) => {
        s.doc = { ...s.doc, workouts: [{ id: 'phone', d: '2026-08-23', start: 1, end: 2, name: 'Phone', entries: [], prs: [] }] }
        s.rev = 9
        send(409, { error: 'conflict', rev: s.rev, state: s.doc })
      }],
    })
    const r = await call({ file: CSV })
    expect(r).toMatchObject({ imported: true, workouts_added: 1, days_already_logged: 1 })
    expect(api.puts).toHaveLength(2)
    expect(api.puts[1].baseRev).toBe(9)
    expect(api.puts[1].state.workouts.map(w => w.id)).toContain('phone')
  })

  test('offered only to a token that may change workouts', () => {
    expect(toolAllowed('import_history', { workouts: 'apply' })).toBe(true)
    expect(toolAllowed('import_history', { workouts: 'view', plans: 'apply' })).toBe(false)
    expect(toolAllowed('import_history', null)).toBe(true)
  })
})
