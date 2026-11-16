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
import { mergeImport } from '../../frontend/src/lib/import-csv.js'
import { choiceOpts, nameKey } from '../../frontend/src/lib/import-choices.js'
import { EXIDX } from '../../frontend/src/lib/exercises.js'

const MAX_ATTEMPTS = 3
// What fits in one MCP request (http.js MAX_BODY is 1 MB of JSON) with room for the rest.
export const MAX_FILE_CHARS = 900_000
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

const exName = (S, parsed, id) =>
  (S.customEx || []).find(c => c?.id === id)?.n || parsed.customEx?.find(c => c.id === id)?.n || EXIDX[id]?.n || null

// What the file holds and what the import would do to this profile, in the words the user needs
// to say yes: counts, the date range, and every exercise name with what it became.
function summaryOf(S, parsed, res) {
  if (parsed.kind === 'bodyweight') {
    return {
      kind: 'body weight',
      source: parsed.source || null,
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
  }
}

export const importHistory = {
  name: 'import_history',
  description: [
    'Import a workout history the user exported from another app (Strong, Hevy, FitNotes, Fitbod, JEFIT, Liftosaur, StrongLifts, Gravl, Liftoff JSON) or any CSV with one row per set (headers such as date, workout name, exercise, weight kg / weight lbs, reps, seconds, distance km, rpe, notes), or a body-weight CSV / Apple Health export.',
    'Pass the file\'s text exactly as the user gave it in `file`; do not retype or reformat the rows.',
    'Always call with dry_run: true first and show the user the summary: how many workouts would be added, the date range, the unit, and the exercise names with what each became (a library exercise, or the user\'s own).',
    'If a name matched the wrong exercise, find the right one with search_exercises and pass it in `picks` ({name, exercise_id}); exercise_id null keeps the name as the user\'s own exercise. Preview again, then import once the user agrees.',
    'Days that already have a workout are left alone, so importing the same file twice adds nothing. Plans in the file are not imported. Logged history cannot be edited or deleted with this tool.',
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
      // Bands the file names are a setting of the profile, which a connector may not change: the
      // sets come in without a new band added to the list.
      const bands = parsed.bands?.length || 0
      const toMerge = { ...parsed, bands: [] }

      // The merge on a copy first: the preview says exactly what the save would do.
      const copy = structuredClone(S)
      if (parsed.kind === 'workouts') prepare(copy)
      const preview = mergeImport(copy, toMerge)
      const summary = { ...summaryOf(S, parsed, preview), ...(bands ? { bands_not_added: bands } : {}) }
      if (params.dry_run) return { imported: false, dry_run: true, ...summary }
      if (!preview.added && !preview.measurements && !preview.activities) {
        return { imported: false, nothing_new: true, ...summary, message: 'Everything in the file is already in the history (or outside the dates asked for); nothing was saved.' }
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

export const IMPORT_TOOLS = [importHistory]
