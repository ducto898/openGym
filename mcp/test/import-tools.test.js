// import_history against a stand-in for the api (as write-tools.test.js): what it reads, what it
// would import, and the one PUT it makes. The reading and merging themselves are the app's own
// (frontend/src/lib/import-apps.js, import-csv.js) and tested there.
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { importHistory, getImportFormat, IMPORT_FORMAT, FORMAT_EXAMPLE, BODYWEIGHT_EXAMPLE, MAX_FILE_CHARS } from '../src/import-tools.js'
import { parseImportFile } from '../../frontend/src/lib/import-apps.js'
import { EXIDX } from '../../frontend/src/lib/exercises.js'
import { _resetWriteWindow } from '../src/write-tools.js'
import { toolAllowed } from '../src/server.js'

const TOKEN = 'tok.secret-value'

let api
function stubApi(doc, script = {}) {
  const s = { doc: structuredClone(doc), rev: 7, puts: [], script }
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(401, { error: 'not signed in' })
    if (req.url === '/api/me') return send(200, { user: { id: 'u1', name: 'Matt' }, ...(script.scopes ? { token: { scopes: script.scopes } } : {}) })
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
    expect(toolAllowed('get_import_format', { workouts: 'apply' })).toBe(true)
    expect(toolAllowed('get_import_format', { workouts: 'view' })).toBe(false)
  })
})

// The guide get_import_format hands out is read back through the app's reader: every column and
// trap it describes is what the reader really does.
describe('get_import_format: the guide matches the reader', () => {
  const parse = csv => parseImportFile(csv, { unit: 'kg' })
  const setsOf = (w, name) => w.entries.find(e => (EXIDX[e.id]?.n || '').includes(name))?.sets

  test('the example file reads as the guide says, column by column', async () => {
    const guide = await getImportFormat.handler({})
    expect(guide.example_csv).toBe(FORMAT_EXAMPLE)
    const p = parse(FORMAT_EXAMPLE)
    expect(p.error).toBeUndefined()
    expect(p.skipped).toBe(0)
    expect(p.workouts.map(w => [w.d, w.name])).toEqual([['2026-11-10', 'Push day'], ['2026-11-12', 'Pull day']])
    const [push, pull] = p.workouts
    const hhmm = t => new Date(t).toTimeString().slice(0, 5)
    expect([hhmm(push.start), hhmm(push.end)]).toEqual(['18:30', '19:45'])
    expect(push.note).toBe('Felt strong')
    const bench = setsOf(push, 'bench press')
    expect(bench).toEqual([
      { w: 40, r: 12, done: true, phase: 'warmup' },
      { w: 60, r: 10, done: true, rpe: 8, tempo: '3-1-1-0' },
      { w: 60, r: 9, done: true, failure: true, rir: 0 },
    ])
    expect(push.entries.find(e => e.sets === bench).note).toBe('last rep slow')
    expect(setsOf(push, 'push-up')).toEqual([{ w: 0, r: 20, done: true }])
    expect(setsOf(push, 'plank')).toEqual([{ sec: 60, w: 0, done: true }])
    expect(setsOf(push, 'treadmill')).toEqual([{ min: 20, speed: 9.6, incline: 5, done: true, rpe: 7 }])
    expect(setsOf(push, 'stationary bike')[0]).toMatchObject({ min: 15, speed: 24, level: 8 })
    expect(setsOf(pull, 'pull-up')).toEqual([{ w: 10, r: 6, done: true }])
    // the one name the library lacks became the user's own, with the body part given
    expect(p.customEx.map(c => [c.n, c.bp])).toEqual([['gym hammer row machine', 'back']])
    expect(p.fileUnit).toBe('kg')
    // nothing in the example trips a warning
    api = await stubApi(DOC())
    expect((await call({ file: FORMAT_EXAMPLE, dry_run: true })).warnings).toEqual([])
  })

  test('the body-weight example reads as weigh-ins', () => {
    const p = parse(BODYWEIGHT_EXAMPLE)
    expect(p.kind).toBe('bodyweight')
    expect(p.bodyweight.map(b => [b.d, b.w, b.at || null])).toEqual([['2026-11-10', 80.4, '07:05'], ['2026-11-11', 80.1, null]])
  })

  test('every column the guide names is one the reader maps', () => {
    for (const c of IMPORT_FORMAT.columns) {
      const csv = `date,exercise,${c.header === 'date' || c.header === 'exercise' ? 'reps' : c.header},reps\n2026-11-10,Squat,${c.example},5\n`
      expect(parse(csv).error, c.header).toBeUndefined()
    }
  })

  test('the alternatives the guide names: weight lbs, weight + unit, distance m and mi, duration forms', () => {
    expect(parse('date,exercise,weight lbs,reps\n2026-11-10,Squat,100,5\n').workouts[0].entries[0].sets[0].w).toBeCloseTo(45.36, 1)
    expect(parse('date,exercise,weight,weight unit,reps\n2026-11-10,Squat,100,lb,5\n').workouts[0].entries[0].sets[0].w).toBeCloseTo(45.36, 1)
    expect(parse('date,exercise,distance m,duration\n2026-11-10,Rowing Machine,2000,8\n').workouts[0].entries[0].sets[0]).toMatchObject({ min: 8, speed: 15 })
    expect(parse('date,exercise,distance,distance unit,duration\n2026-11-10,Treadmill,3,mi,30\n').workouts[0].entries[0].sets[0].speed).toBeCloseTo(9.7, 0)
    for (const [d, min] of [['20', 20], ['20:00', 20], ['1:05:00', 65]]) {
      expect(parse(`date,exercise,duration,distance km\n2026-11-10,Treadmill,${d},5\n`).workouts[0].entries[0].sets[0].min).toBe(min)
    }
  })

  test('the traps the guide warns about are real', () => {
    // day-first, month-first only when day-first cannot be, and a future date skipped
    const dates = parse('date,exercise,weight kg,reps\n03/04/2026,Squat,100,5\n12/31/2025,Squat,100,5\n2099-01-01,Squat,100,5\n')
    expect(dates.workouts.map(w => w.d)).toEqual(['2025-12-31', '2026-04-03'])
    expect(dates.skipped).toBe(1)
    // a separate start time is ignored next to a date; an end time without its date too
    const t = parse('date,start time,end time,exercise,weight kg,reps\n2026-11-10,2026-11-10 07:00,19:30,Squat,100,5\n').workouts[0]
    expect(new Date(t.start).getHours()).toBe(18)
    expect(t.end).toBe(t.start)
    // seconds on a row with reps are dropped; a carry loses its weight
    expect(parse('date,exercise,weight kg,reps,seconds\n2026-11-10,Squat,100,5,30\n').workouts[0].entries[0].sets[0]).toEqual({ w: 100, r: 5, done: true })
    expect(parse('date,exercise,weight kg,distance m\n2026-11-10,Farmer Carry,40,30\n').workouts[0].entries[0].sets[0]).toMatchObject({ min: 0, speed: 0 })
    // a superset id groups exercises
    const ss = parse('date,exercise,weight kg,reps,superset id\n2026-11-10,Squat,100,5,1\n2026-11-10,Bench Press,60,5,1\n').workouts[0].entries
    expect(ss[0].sg).toBeTruthy()
    expect(ss[1].sg).toBe(ss[0].sg)
    // a weight unit column makes the file a FitNotes one
    expect(parse('date,exercise,weight,weight unit,reps\n2026-11-10,Squat,100,kg,5\n').source).toBe('FitNotes')
    // AM/PM is not read as such
    expect(new Date(parse('date,exercise,weight kg,reps\n2026-11-10 6:30 PM,Squat,100,5\n').workouts[0].start).getHours()).toBe(6)
    // one workout per day
    expect(parse('date,workout name,exercise,weight kg,reps\n2026-11-10 07:00,AM,Squat,100,5\n2026-11-10 18:00,PM,Squat,100,5\n').workouts).toHaveLength(1)
    // a hold other than a plank becomes cardio minutes
    expect(parse('date,exercise,seconds\n2026-11-10,Dead Hang,45\n').workouts[0].entries[0].sets[0]).toMatchObject({ min: 0.8, speed: 0 })
    // a distance alone is 0 minutes
    expect(parse('date,exercise,distance km\n2026-11-10,Treadmill,5\n').workouts[0].entries[0].sets[0].min).toBe(0)
    // "category" makes the reader take the file for FitNotes
    expect(parse('date,exercise,category,weight kg,reps\n2026-11-10,Squat,Legs,100,5\n').source).toBe('FitNotes')
  })
})

describe('import_history warnings', () => {
  beforeEach(async () => { api = await stubApi(DOC()) })
  const warn = async file => (await call({ file, dry_run: true })).warnings

  test('a hold read as cardio, cardio with no time, no unit, no end time, AM/PM, skipped rows', async () => {
    const w = await warn([
      'date,exercise,weight,reps,seconds,distance km',
      '2026-11-10 6:30 PM,Dead Hang,,,45,',
      '2026-11-10 6:30 PM,Treadmill,,,,5',
      '2026-11-10 6:30 PM,Squat,100,5,,',
      '2099-12-31,Squat,100,5,,',
    ].join('\n'))
    expect(w.some(x => /"dead hang".*read as minutes of cardio/i.test(x))).toBe(true)
    expect(w.some(x => /treadmill.*0 minutes/i.test(x))).toBe(true)
    expect(w.some(x => /no unit/.test(x))).toBe(true)
    expect(w.some(x => /no end time/.test(x))).toBe(true)
    expect(w.some(x => /AM\/PM/.test(x))).toBe(true)
    expect(w.some(x => /1 row\(s\) were skipped/.test(x))).toBe(true)
  })

  test('real cardio with a time and no distance is not taken for a hold', async () => {
    const w = await warn('date,end time,exercise,duration\n2026-11-10 07:00,2026-11-10 08:00,Stationary Bike,30\n')
    expect(w).toEqual([])
  })

  test('a body-weight file has no workout warnings', async () => {
    const r = await call({ file: BODYWEIGHT_EXAMPLE, dry_run: true })
    expect(r.kind).toBe('body weight')
    expect(r.warnings).toBeUndefined()
  })
})

// What the audit found, kept found.
describe('found in review', () => {
  test('a body-weight file with a token that may not change body weight: refused in the preview, not at the save', async () => {
    api = await stubApi({ ...DOC(), bodyweight: [] }, { scopes: { workouts: 'apply', bodyweight: 'view' } })
    const r = await call({ file: BODYWEIGHT_EXAMPLE, dry_run: true })
    expect(r.imported).toBe(false)
    expect(r.problem).toMatch(/Body weight: Change/)
    expect(api.puts).toHaveLength(0)
  })

  test('a body-weight file with the permission: saved, from/to respected, labelled as a CSV', async () => {
    api = await stubApi({ ...DOC(), bodyweight: [] }, { scopes: { workouts: 'apply', bodyweight: 'apply' } })
    const file = 'date,weight kg\n2026-01-10,82\n2026-11-10,80.4\n'
    const dry = await call({ file, dry_run: true, from: '2026-11-01' })
    expect(dry).toMatchObject({ kind: 'body weight', source: 'CSV', weigh_ins_in_file: 1, weigh_ins_added: 1 })
    const r = await call({ file, from: '2026-11-01' })
    expect(r.imported).toBe(true)
    expect(api.puts[0].state.bodyweight.map(b => b.d)).toEqual(['2026-11-10'])
  })

  test('a band the profile lacks is not added, and leaves no dangling id on the sets', async () => {
    api = await stubApi(DOC())
    const file = 'date,exercise,exercise id,set type,weight kg,reps,bands\n2026-11-10,Squat,0043,normal,100,5,Red\n'
    const r = await call({ file })
    expect(r.imported).toBe(true)
    expect(r.bands_not_added).toEqual({ bands: ['Red'], sets_without_their_band: 1 })
    const sets = api.puts[0].state.workouts[0].entries[0].sets
    expect(sets.every(s => !('bands' in s))).toBe(true)
    expect(api.puts[0].state.bands).toBeUndefined()
  })

  test('a file of plans only says so instead of "nothing new"', async () => {
    api = await stubApi(DOC())
    // Liftoff's routines export (the fixture of frontend/src/lib/import-apps.test.js)
    const liftoff = JSON.stringify({ folders: [{ id: 'f', name: 'Push', presetsOrder: [], presets: [
      { id: 'r1', name: 'Push A', exerciseData: [{ exerciseName: 'Dumbbell Bench Press', exerciseTypes: 'WR', superset: null, setsData: [{ setType: 'normal', inputOne: 30, inputTwo: 8 }] }] }] }], presetsWithoutFolder: [] })
    const r = await call({ file: liftoff })
    expect(r.imported).toBe(false)
    expect(r.problem).toMatch(/holds plans \(1 routines\)/)
    expect(api.puts).toHaveLength(0)
  })

  test('no false warnings: mixed kg/lb, AM in a note, an own cardio exercise, real cardio', async () => {
    api = await stubApi(DOC())
    const w = (await call({ dry_run: true, file: [
      'date,end time,exercise,body part,weight,weight unit,reps,duration,notes',
      '2026-11-10 07:00,2026-11-10 08:00,Squat,,100,kg,5,,woke at 6:00 am',
      '2026-11-10 07:00,2026-11-10 08:00,Bench Press,,135,lb,5,,',
      '2026-11-10 07:00,2026-11-10 08:00,Zone Two Erg Session,cardio,,,,30,',
      '2026-11-10 07:00,2026-11-10 08:00,Stationary Bike,,,,,20,',
    ].join('\n') })).warnings
    expect(w).toEqual([])
  })

  test('an own exercise whose name says it is held still is still warned about', async () => {
    api = await stubApi(DOC())
    const w = (await call({ dry_run: true, file: 'date,end time,exercise,seconds\n2026-11-10 07:00,2026-11-10 08:00,Dead Hang,45\n' })).warnings
    expect(w.some(x => /dead hang.*read as minutes of cardio/i.test(x))).toBe(true)
  })

  test('warnings speak of what would be saved: a day already logged brings none', async () => {
    api = await stubApi({ ...DOC(), workouts: [{ id: 'mine', d: '2026-11-10', start: 1, end: 2, name: 'Mine', entries: [], prs: [] }] })
    const r = await call({ dry_run: true, file: 'date,exercise,distance km\n2026-11-10,Treadmill,5\n' })
    expect(r.workouts_added).toBe(0)
    expect(r.warnings).toEqual([])
  })

  test('the file size limit leaves room in the 1 MiB request', () => {
    expect(MAX_FILE_CHARS * 1.6).toBeLessThan(1024 * 1024)
  })
})
