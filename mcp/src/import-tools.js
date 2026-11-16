/* import_history: a whole exported history (Strong, Hevy, FitNotes, Fitbod, JEFIT, Liftosaur,
   StrongLifts, Gravl, openGym's own CSV, any CSV with a date, an exercise and something measured)
   brought into the profile in one save, the way Settings → Data & backup → Import from another
   app brings it: the same reader (frontend/src/lib/import-apps.js parseImportFile) and the same
   merge (import-csv.js mergeImport), so a day that already has a workout keeps it and importing the
   same file twice adds nothing.

   The assistant hands over the file's text as the user gave it; it does not retype the sets. A
   preview (dry_run) comes first: how many workouts, which names matched which exercise, what
   becomes one of the user's own exercises. A name matched wrongly is corrected with `picks` and
   the preview asked for again. Plans in the file (Liftosaur, Liftoff) are not imported here: they
   are routines, a different permission, and create_routine is the tool for them.

   It writes the way log_workout does: PUT /api/data (or /api/token/data) with the revision it
   read, rebuilt on top of the server's copy after a 409. */
import crypto from 'node:crypto'
import { z } from 'zod'
import { isoDate } from './tools.js'
import { localUid, invalidate } from './state.js'
import { apiConfig, apiFetch, profilePaths } from './api-client.js'
import { savesOf, WRITE_LIMIT } from './write-tools.js'
import { parseImportFile } from '../../frontend/src/lib/import-apps.js'
import { mergeImport, parseCSV } from '../../frontend/src/lib/import-csv.js'
import { choiceOpts, nameKey } from '../../frontend/src/lib/import-choices.js'
import { EXIDX, isCardio } from '../../frontend/src/lib/exercises.js'

const MAX_ATTEMPTS = 3
// What fits in one MCP request: http.js MAX_BODY is 1 MiB of JSON, and escaping (\r\n, quotes) and
// multi-byte text make a file's character count an underestimate of its bytes there.
export const MAX_FILE_CHARS = 600_000
// Names listed in a preview: enough to check a whole history, short enough to read.
const MAX_NAMES = 150

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

const READ_ERRORS = {
  empty: 'the file is empty, or has a header and no rows',
  unrecognised: 'this does not read as a workout or body-weight export: it needs one row per set with a date, an exercise and something measured (weight and reps, a time or a distance)',
  opengym: 'this is an openGym backup or plan file: restore it in the app under Settings → Data & backup → Import backup instead',
}
function readError(parsed) {
  if (parsed?.error === 'format') return `this looks like a ${parsed.app || 'known app'}'s export but does not read as one; nothing was imported. Export it again from the app, unedited`
  return READ_ERRORS[parsed?.error] || `the file could not be read (${String(parsed?.error || 'unknown')})`
}

/* The format a CSV written for this tool should take: what the app's own reader understands
   (import-csv.js COLUMNS and parseWorkoutRows), with the traps found by reading files through it.
   The examples are parsed in import-tools.test.js, so the guide cannot drift from the reader. */
export const FORMAT_EXAMPLE = [
  'date,end time,workout name,workout notes,exercise,body part,weight kg,reps,seconds,duration,distance km,incline,resistance level,rpe,rir,set type,tempo,notes',
  '2026-11-10 18:30,2026-11-10 19:45,Push day,Felt strong,Barbell Bench Press,,40,12,,,,,,,,warmup,,',
  '2026-11-10 18:30,2026-11-10 19:45,Push day,,Barbell Bench Press,,60,10,,,,,,8,,,3-1-1-0,',
  '2026-11-10 18:30,2026-11-10 19:45,Push day,,Barbell Bench Press,,60,9,,,,,,,0,failure,,last rep slow',
  '2026-11-10 18:30,2026-11-10 19:45,Push day,,Dumbbell Shoulder Press,,16,12,,,,,,,,,,',
  '2026-11-10 18:30,2026-11-10 19:45,Push day,,Push Up,,0,20,,,,,,,,,,',
  '2026-11-10 18:30,2026-11-10 19:45,Push day,,Plank,,,,60,,,,,,,,,',
  '2026-11-10 18:30,2026-11-10 19:45,Push day,,Treadmill,,,,,20:00,3.2,5,,7,,,,',
  '2026-11-10 18:30,2026-11-10 19:45,Push day,,Stationary Bike,,,,,15,6,,8,,,,,',
  '2026-11-12 07:00,2026-11-12 08:00,Pull day,,Pull Up,,10,6,,,,,,,,,,',
  '2026-11-12 07:00,2026-11-12 08:00,Pull day,,Lat Pulldown (Cable),,50,12,,,,,,,,,,',
  '2026-11-12 07:00,2026-11-12 08:00,Pull day,,Gym Hammer Row Machine,back,40,10,,,,,,,,,,',
].join('\n')
export const BODYWEIGHT_EXAMPLE = ['date,weight kg', '2026-11-10 07:05,80.4', '2026-11-11,80.1'].join('\n')

export const IMPORT_FORMAT = {
  summary: 'One row per set, one header row, comma (or semicolon) separated. Headers are matched ignoring case and punctuation, in any order; unknown columns are ignored. Only `date` and `exercise` are required, plus something measured (weight and reps, seconds, a duration or a distance).',
  columns: [
    { header: 'date', required: true, example: '2026-11-10 18:30', meaning: 'Day of the session, YYYY-MM-DD. A time after it (24-hour HH:MM) is the session start; without one the session starts at 18:00. Put the time here: a separate "start time" column is ignored when there is a date column.' },
    { header: 'end time', example: '2026-11-10 19:45', meaning: 'When the session ended, with its date ("2026-11-10 19:45"; a bare "19:45" is ignored). Without it the session is saved with no length.' },
    { header: 'workout name', example: 'Push day', meaning: 'The session name (also accepted: title, workout). Defaults to "Imported".' },
    { header: 'workout notes', example: 'Felt strong', meaning: 'A note on the whole session (also: description). The first non-empty one per session is kept.' },
    { header: 'exercise', required: true, example: 'Barbell Bench Press', meaning: 'Exercise name, best in English the way gym apps write it ("Bench Press (Barbell)", "DB Curl", "Lat Pulldown (Cable)" all match). A name the library does not know becomes one of the user\'s own exercises.' },
    { header: 'body part', example: 'back', meaning: 'Only used for a new own exercise: chest, back, lats, shoulders, biceps, triceps, forearms, abs, core, obliques, quads, hamstrings, glutes, legs, calves, cardio, full body, neck. Do not name this column "category".' },
    { header: 'weight kg', example: '60', meaning: 'Load in kg, or a `weight lbs` column for pounds (prefer these two to `weight` plus `weight unit`, which also works). Blank or 0 is body weight. Without any unit the profile\'s unit is assumed.' },
    { header: 'reps', example: '10', meaning: 'Reps, a whole number.' },
    { header: 'seconds', example: '60', meaning: 'The set\'s own time in seconds: a plank hold, or a cardio interval (with a distance). Not on a row with reps (the seconds are dropped). See traps for other holds.' },
    { header: 'duration', example: '20:00', meaning: 'Cardio time: "20" is 20 minutes, "20:00" is mm:ss, "1:05:00" is h:mm:ss (also accepted: time).' },
    { header: 'distance km', example: '3.2', meaning: 'Cardio distance in km. Or `distance m` in metres, or `distance` plus `distance unit` (km, m, mi). Give a duration too: a distance alone is saved as 0 minutes.' },
    { header: 'incline', example: '5', meaning: 'Treadmill grade in percent.' },
    { header: 'resistance level', example: '8', meaning: 'A bike\'s or rower\'s resistance, 1 to 30.' },
    { header: 'rpe', example: '8', meaning: 'RPE 1 to 10 for the set. Give rpe or rir, not both (rir wins).' },
    { header: 'rir', example: '1', meaning: 'Reps in reserve, 0 to 10 (0 is a set to failure).' },
    { header: 'set type', example: 'warmup', meaning: '"warmup" for a warm-up set (kept out of volume and PRs), "failure" for a set taken to failure. Anything else is a normal set.' },
    { header: 'tempo', example: '3-1-1-0', meaning: 'Lifting tempo of the set.' },
    { header: 'superset id', example: '1', meaning: 'Exercises of one session that share a number were done as a superset.' },
    { header: 'notes', example: 'last rep slow', meaning: 'A note on the exercise that day (also: note, comment). Notes of several sets are joined.' },
  ],
  traps: [
    'Dates: write YYYY-MM-DD. A numeric date like 03/04/2026 is read day-first (3 April); one that only works month-first (12/31/2025) is read month-first. Dates in the future are skipped.',
    'Times are 24-hour: "6:30 PM" is read as 06:30.',
    'All rows of one day become one workout (the first workout name wins). A second session on the same day: log it with log_workout instead.',
    'A day that already has a workout in openGym is skipped entirely, so the same file twice adds nothing.',
    'Timed holds: plank and side plank are read as holds from `seconds`. Other holds (dead hang, wall sit, L-sit, hollow hold) are read as minutes of cardio: log those with log_workout and `seconds` instead. The preview warns when this happens.',
    'Cardio needs a duration (or seconds); a distance alone is saved as 0 minutes. The preview warns.',
    'Check the preview\'s exercise matches: a short name like "Running" or "Stationary Bike" can land on an odd library variant. Fix it with picks (exercise_id from search_exercises).',
    'Loaded carries (a weight and a distance, like a farmer\'s carry) are not read: the weight is lost and the set becomes 0 minutes of cardio. Leave them out.',
    'Not in this format: drop sets, left/right sides. Plans are not imported.',
    'Do not name a column "category" or add a "weight unit" column without need: either makes the reader take the file for a FitNotes export.',
    'Body weight is its own file: a `date` column and a `weight kg` (or `weight lbs`) column; other columns are ignored. Importing it needs the Body weight: Change permission.',
  ],
  example_csv: FORMAT_EXAMPLE,
  example_bodyweight_csv: BODYWEIGHT_EXAMPLE,
}

export const getImportFormat = {
  name: 'get_import_format',
  description: 'The CSV format import_history reads: every column it understands, an example file and the traps to avoid. Call it before writing a CSV yourself (from notes, a spreadsheet in another layout, a photo of a training log). Not needed for an unedited export from the apps import_history names.',
  schema: {},
  handler: async () => IMPORT_FORMAT,
}

// A name that says it is held still: what an own exercise read as cardio from `seconds` really is.
const HOLD_RE = /\b(hang|hangs|hold|holds|wall sit|l sit|v sit|bridge|support|static|isometric|iso|plank|lever)\b/

// The time columns of a CSV (the reader's names for them, import-csv.js COLUMNS), for the AM/PM
// check: notes saying "woke at 6:00 am" are not times the reader parses.
const TIME_HEADERS = new Set(['date', 'workout date', 'start time', 'start date', 'end time'])
function amPmTimes(file) {
  if (/^\s*[[{<]/.test(file)) return false
  const rows = parseCSV(file.length > 200_000 ? file.slice(0, 200_000) : file)
  const head = (rows[0] || []).map(h => String(h).toLowerCase().replace(/#/g, ' no ').replace(/[^a-z0-9]+/g, ' ').trim())
  const cols = head.map((h, i) => (TIME_HEADERS.has(h) ? i : -1)).filter(i => i >= 0)
  return rows.slice(1).some(r => cols.some(i => /\d{1,2}:\d{2}(:\d{2})?\s*[ap]\.?m\b/i.test(String(r[i] ?? ''))))
}

// What the user should hear before saying yes: things the reader did that are easy to miss in
// the numbers (import-csv.js reads them the same way for the app's own import). `added` is what
// the save would add (after days already logged and sport-only sessions are taken out).
function warningsOf(S, parsed, added, file) {
  const out = []
  const zeroCardio = new Map(), heldAsCardio = new Map()
  const own = id => parsed.customEx?.find(c => c.id === id) || (S.customEx || []).find(c => c?.id === id)
  const nameOf = id => own(id)?.n || EXIDX[id]?.n || id
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1)
  for (const w of added) {
    for (const e of w.entries || []) {
      // A library exercise that is not cardio, or one of the user's own whose name says it is held.
      const held = EXIDX[e.id] ? !isCardio(e.id) : HOLD_RE.test(String(nameOf(e.id)).toLowerCase().replace(/[-_/]+/g, ' '))
      for (const s of e.sets || []) {
        if (s.min == null) continue
        if (!(s.min > 0)) bump(zeroCardio, nameOf(e.id))
        else if (!s.speed && !s.km && held) bump(heldAsCardio, nameOf(e.id))
      }
    }
  }
  for (const [n, k] of heldAsCardio) out.push(`"${n}": ${k} set(s) of time with no distance were read as minutes of cardio. If it is a timed hold (dead hang, wall sit), leave those rows out and log them with log_workout using seconds.`)
  for (const [n, k] of zeroCardio) out.push(`"${n}": ${k} cardio set(s) have no duration and would be saved as 0 minutes. Add a duration column.`)
  const loaded = added.some(w => (w.entries || []).some(e => (e.sets || []).some(s => s.w > 0)))
  if (loaded && !parsed.fileUnit && !parsed.mixedUnits) out.push('The weights have no unit (no "weight kg" / "weight lbs" column, no unit column): they are read in the profile\'s unit.')
  const noLength = added.filter(w => !(w.end > w.start)).length
  if (noLength) out.push(`${noLength} workout(s) have no end time, so they are saved with no length. Add an "end time" column if the length matters.`)
  if (amPmTimes(file)) out.push('The file has AM/PM times: they are read as 24-hour, so 6:30 PM becomes 06:30. If the user wrote this file, rewrite them as 24-hour times.')
  if (parsed.skipped) out.push(`${parsed.skipped} row(s) were skipped: no date or exercise, nothing measured, an impossible value, a date in the future, or a date that could not be read.`)
  return out
}

const exName = (S, parsed, id) =>
  (S.customEx || []).find(c => c?.id === id)?.n || parsed.customEx?.find(c => c.id === id)?.n || EXIDX[id]?.n || null

// What the file holds and what the import would do to this profile, in the words the user needs
// to say yes: counts, the date range, and every exercise name with what it became.
function summaryOf(S, parsed, res, added, file = '') {
  if (parsed.kind === 'bodyweight') {
    return {
      kind: 'body weight',
      // parseBodyweight names every file Apple Health; only the XML export is.
      source: /HKQuantityTypeIdentifier|^\s*</.test(file) ? 'Apple Health' : 'CSV',
      from: parsed.bodyweight[0]?.d || null,
      to: parsed.bodyweight.at(-1)?.d || null,
      weigh_ins_in_file: parsed.bodyweight.length,
      weigh_ins_added: res.added,
      weigh_ins_already_there: res.skipped,
      ...(res.measurements ? { measurement_check_ins_added: res.measurements } : {}),
      ...(res.activities ? { activities_added: res.activities } : {}),
    }
  }
  const names = (parsed.names || []).map(n => {
    const id = n.id
    const own = id && !EXIDX[id]
    return {
      in_file: n.name,
      ...(id ? { exercise_id: id, exercise: exName(S, parsed, id) } : {}),
      becomes: !id ? 'left out' : own ? 'your own exercise' : 'library exercise',
      sets: n.sets,
    }
  })
  return {
    kind: 'workouts',
    source: parsed.source || null,
    from: parsed.from,
    to: parsed.to,
    workouts_in_file: parsed.workouts.length,
    workouts_added: res.added,
    // A day that already has a workout keeps it and brings nothing from the file (mergeImport).
    days_already_logged: res.skipped,
    ...(res.activities ? { activities_added: res.activities } : {}),
    sets: parsed.sets,
    warmup_sets: parsed.warmups || 0,
    rows_skipped: parsed.skipped || 0,
    unit: {
      file: parsed.fileUnit || null,
      profile: S.unit === 'lb' ? 'lb' : 'kg',
      converted: parsed.converted === true,
      ...(parsed.mixedUnits ? { mixed: true } : {}),
    },
    library_matches: parsed.matched,
    new_own_exercises: parsed.unmatchedNames || [],
    exercises: names.slice(0, MAX_NAMES),
    ...(names.length > MAX_NAMES ? { exercises_not_listed: names.length - MAX_NAMES } : {}),
    ...(parsed.routines?.routines?.length ? { plans_not_imported: parsed.routines.routines.length } : {}),
    warnings: warningsOf(S, parsed, added, file),
  }
}

export const importHistory = {
  name: 'import_history',
  description: [
    'Import a workout history the user exported from another app (Strong, Hevy, FitNotes, Fitbod, JEFIT, Liftosaur, StrongLifts, Gravl, Liftoff JSON) or any CSV with one row per set, or a body-weight CSV / Apple Health export.',
    'Pass an export\'s text exactly as the user gave it in `file`; do not retype or reformat it.',
    'A CSV you write yourself: call get_import_format first. In short: header row, one row per set; columns date (YYYY-MM-DD, optional 24-hour HH:MM start), end time, workout name, exercise, weight kg (or weight lbs), reps, seconds, duration, distance km, rpe or rir, set type (warmup / failure), notes. All rows of one day become one workout.',
    'Always call with dry_run: true first and show the user the summary: how many workouts would be added, the date range, the unit, the exercise names with what each became (a library exercise, or the user\'s own), and every entry in `warnings`.',
    'If a name matched the wrong exercise, find the right one with search_exercises and pass it in `picks` ({name, exercise_id}); exercise_id null keeps the name as the user\'s own exercise. Preview again, then import once the user agrees.',
    'Days that already have a workout are left alone, so importing the same file twice adds nothing. Plans in the file are not imported. A body-weight file also needs the Body weight: Change permission. Logged history cannot be edited or deleted with this tool.',
  ].join(' '),
  schema: {
    file: z.string().min(1).max(MAX_FILE_CHARS).describe('The exported file\'s full text (CSV or JSON), unchanged.'),
    picks: z.array(z.object({
      name: z.string().min(1).max(120).describe('The exercise name as it is written in the file.'),
      exercise_id: z.string().max(80).nullable().describe('The exercise it means (an id from search_exercises), or null to keep it as the user\'s own exercise.'),
    })).max(300).optional().describe('Corrections to the automatic exercise matching, from the preview.'),
    from: isoDate().optional().describe('Only import days on or after this date (YYYY-MM-DD).'),
    to: isoDate().optional().describe('Only import days on or before this date (YYYY-MM-DD).'),
    dry_run: z.boolean().optional().describe('Read the file and return the summary without saving anything. Use it first.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    const cfg = apiConfig(env)
    const opts = fetchImpl ? { fetchImpl } : {}
    const now = Date.now()
    const paths = profilePaths(cfg)
    const saves = savesOf(crypto.createHash('sha256').update(cfg.token).digest('hex'), now)
    if (!params.dry_run && saves.length >= WRITE_LIMIT) {
      throw fail('ERATE', `${WRITE_LIMIT} saves in the last hour already, the most this server takes; nothing was imported. Try again later.`)
    }
    if (params.from && params.to && params.from > params.to) throw fail('EINPUT', '`from` is after `to`')
    const picks = new Map((params.picks || []).map(p => [nameKey(p.name), { name: p.name, id: p.exercise_id ?? null }]))

    const me = await apiFetch(cfg, paths.me, opts)
    const uid = me.body?.user?.id
    if (typeof uid !== 'string' || !uid) throw fail('EAPI', `the openGym server did not say which profile the token belongs to (GET ${paths.me}); nothing was imported`)
    // A scoped token's categories (null: a paired session, which may change everything). Checked
    // here so a preview never promises what the server would refuse to save.
    const scopes = me.body?.token?.scopes || null
    const mayChange = cat => !scopes || scopes[cat] === 'apply'
    const local = localUid()
    if (local && local !== uid) {
      console.error(`[opengym-mcp] OPENGYM_TOKEN is for profile ${uid}, this server reads ${local}`)
      throw fail('EPROFILE', 'OPENGYM_TOKEN belongs to another profile than the one this server reads: pair again from the right profile, or set OPENGYM_UID to match (the ids are on the server\'s stderr)')
    }

    let got = await apiFetch(cfg, paths.data, opts)
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const doc = got.body?.state
      if (!doc || typeof doc !== 'object') {
        throw fail('ENOSTATE', 'this profile has no synced data on the server yet: open openGym and sign in on a device once, then try again')
      }
      const S = structuredClone(doc)
      // A pick naming an exercise that is neither in the library nor the profile's own would file
      // sets under an id nothing can show.
      for (const p of picks.values()) {
        if (p.id && !EXIDX[p.id] && !(S.customEx || []).some(c => c?.id === p.id)) {
          throw fail('EINPUT', `picks: no exercise has the id ${JSON.stringify(p.id).slice(0, 60)}; find it with search_exercises`)
        }
      }
      const parsed = parseImportFile(params.file, choiceOpts(S, { picks, from: params.from, to: params.to }))
      if (!parsed || parsed.error) return { imported: false, problem: readError(parsed) }
      if (parsed.kind === 'workouts' && !parsed.workouts.length && parsed.routines?.routines?.length) {
        return { imported: false, problem: `this file holds plans (${parsed.routines.routines.length} routines) and no workout history; plans are not imported here. Build them with create_routine, or import the file in the app (Settings → Data & backup → Import from another app).` }
      }
      let toMerge = parsed
      const notes = {}
      if (parsed.kind === 'bodyweight') {
        if (!mayChange('bodyweight')) {
          return { imported: false, problem: 'this is a body-weight file, and this connection may not change body weight. Reconnect openGym and allow Body weight: Change, or import the file in the app (Settings → Data & backup → Import from another app).' }
        }
        // The reader takes no date range for weigh-ins: kept to the days asked for here.
        const inRange = d => (!params.from || d >= params.from) && (!params.to || d <= params.to)
        const keep = list => (Array.isArray(list) ? list.filter(x => inRange(String(x?.d || ''))) : list)
        toMerge = { ...parsed, bodyweight: keep(parsed.bodyweight), measurements: keep(parsed.measurements), activities: keep(parsed.activities) }
        // Our own body CSV brings measurement check-ins too, another permission.
        if (toMerge.measurements?.length && !mayChange('measurements')) {
          notes.measurements_not_imported = toMerge.measurements.length
          toMerge.measurements = []
        }
      } else {
        // Bands are a setting of the profile, which a connection may not change: a band the file
        // names that the profile lacks is not added, and taken off the sets that used it.
        const known = new Set((Array.isArray(S.bands) ? S.bands : []).map(b => b?.id))
        let dropped = 0
        const strip = set => {
          if (!Array.isArray(set?.bands)) return set
          const ids = set.bands.filter(id => known.has(id))
          if (ids.length === set.bands.length) return set
          dropped++
          const { bands, ...rest } = set
          return ids.length ? { ...rest, bands: ids } : rest
        }
        const workouts = parsed.bands?.length
          ? parsed.workouts.map(w => ({ ...w, entries: w.entries.map(e => ({ ...e, sets: (e.sets || []).map(strip) })) }))
          : parsed.workouts
        toMerge = { ...parsed, workouts, bands: [] }
        if (parsed.bands?.length) notes.bands_not_added = { bands: parsed.bands.map(b => b?.name || b?.id).filter(Boolean), sets_without_their_band: dropped }
      }

      // The merge on a copy first: the preview says exactly what the save would do.
      const copy = structuredClone(S)
      if (parsed.kind === 'workouts') prepare(copy)
      const before = new Set((copy.workouts || []).map(w => w?.id))
      const preview = mergeImport(copy, toMerge)
      const added = (copy.workouts || []).filter(w => w && !before.has(w.id))
      const summary = { ...summaryOf(S, toMerge, preview, added, params.file), ...notes }
      if (params.dry_run) return { imported: false, dry_run: true, ...summary }
      if (!preview.added && !preview.measurements && !preview.activities) {
        return { imported: false, nothing_new: true, ...summary, message: 'Nothing in the file is new: it is already in the history, or outside the dates asked for. Nothing was saved.' }
      }

      if (parsed.kind === 'workouts') prepare(S)
      mergeImport(S, toMerge)
      S._ts = Math.max(now, (Number(S._ts) || 0) + 1)
      const put = await apiFetch(cfg, paths.data, { ...opts, method: 'PUT', body: { state: S, baseRev: got.body.rev ?? 0, ...(typeof doc._wid === 'string' ? { baseWid: doc._wid } : {}) } })
      if (put.status !== 409) {
        invalidate()
        saves.push(now)
        console.error(`[opengym-mcp] import_history saved ${summary.workouts_added ?? summary.weigh_ins_added ?? 0} ${summary.kind} from ${summary.source || 'a file'}, rev ${put.body?.rev ?? '?'}`)
        return { imported: true, ...summary, revision: put.body?.rev ?? null }
      }
      if (!put.body?.state || typeof put.body.state !== 'object' || typeof put.body.rev !== 'number') {
        throw fail('EAPI', 'the openGym server answered 409 without the current profile; nothing was imported')
      }
      got = { status: 200, body: { state: put.body.state, rev: put.body.rev } }
    }
    throw fail('ECONFLICT', `the profile kept changing on the server (${MAX_ATTEMPTS} attempts); nothing was imported, try again in a moment`)
  },
}

// mergeImport expects the lists the app always has; a scoped read leaves out what the token
// cannot see, and a new profile may not have them yet.
function prepare(S) {
  if (!Array.isArray(S.workouts)) S.workouts = []
  if (!Array.isArray(S.customEx)) S.customEx = []
  if (!S.exWeights || typeof S.exWeights !== 'object') S.exWeights = {}
}

export const IMPORT_TOOLS = [importHistory, getImportFormat]
