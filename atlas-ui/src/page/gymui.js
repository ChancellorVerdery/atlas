// Gym plugin UI: widget bodies (rendered from view.js), view-mode logging,
// the exercise modal (strength graph + set history + editing), and the
// gym-scoped Settings tab. Data/scoring lives in gym.js.

import {
  loadGym, saveGym, DAYS, DAY_LABELS, todayKey, toDisplayWeight, toKgWeight,
  addWorkout, removeWorkout, addExercise, removeExercise,
  workoutById, exerciseById, exercisesOf,
  logSet, removeSetAt, removeLogsForDate, logsFor, est1RM,
  exerciseSeries, generalScore, generalSeries,
  currentWorkout, upcomingWorkouts, completeWorkout,
  SKIP, dayOverride, setDayOverride,
} from './gym.js'
import { lineChart } from './chart.js'
import { confirmDelete } from './confirm.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const GYM_KINDS = ['gymcurrent', 'gymnext', 'gymscore', 'gymscoregraph', 'gymexercises', 'gymvolume']

const fmt1 = (n) => (Math.round(n * 10) / 10).toString()
const setChip = (s, unit) => (s.weight > 0 ? `${toDisplayWeight(s.weight, unit)}×${s.reps}` : `${s.reps} reps`)
const shortDate = (d) => d.slice(5).replace('-', '/')

// ---- widget bodies ----------------------------------------------------------

// secCtx is per-SECTION render state: several "upcoming workout" widgets in
// one section show successive upcoming workouts, not the same one.
export function gymWidgetHTML(w, cz, secCtx) {
  const g = loadGym()
  const head = (t) => `<p class="gym-head">${t}</p>`
  if (w.kind === 'gymnext') {
    const offset = secCtx.gymnext = (secCtx.gymnext || 0) + 1
    const up = upcomingWorkouts(g, offset)
    const item = up[offset - 1]
    return head('Up next') + (item
      ? `<div class="gym-big">${esc(item.workout.name)}</div><p class="gym-sub">${esc(item.label)}</p>`
      : `<p class="gym-empty">No upcoming workouts — set up your plan in Gym → Settings.</p>`)
  }
  if (w.kind === 'gymscore') {
    const s = generalScore(g)
    return head('Strength score') + (s != null
      ? `<div class="gym-big gym-big--num">${fmt1(s)}</div><p class="gym-sub">progress index · 100 = first logged session</p>`
      : `<p class="gym-empty">Log some sets to build a score.</p>`)
  }
  if (w.kind === 'gymscoregraph') {
    return head('Strength over time') + `<div class="chart-mount" data-widget-id="${esc(w.id)}"></div>`
  }
  if (w.kind === 'gymvolume') {
    const monday = new Date()
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
    const weekStart = todayKey(monday)
    let vol = 0
    for (const l of g.logs) if (l.date >= weekStart) for (const s of l.sets) vol += (s.weight || 0) * s.reps
    const sessions = new Set(g.completions.filter((c) => c.date >= weekStart).map((c) => c.date + c.workoutId)).size
    return head('This week') + `<div class="gym-big gym-big--num">${fmt1(toDisplayWeight(vol, g.unit))}</div>
      <p class="gym-sub">total volume (${g.unit} × reps) · ${sessions} workout${sessions === 1 ? '' : 's'} completed</p>`
  }
  if (w.kind === 'gymexercises') {
    const groups = g.workouts.map((wk) => ({ wk, exs: exercisesOf(g, wk.id) })).filter((x) => x.exs.length)
    if (!groups.length) return head('Exercises') + `<p class="gym-empty">No exercises yet — add them in Gym → Settings.</p>`
    return head('Exercises') + groups.map(({ wk, exs }) =>
      `<p class="gym-group">${esc(wk.name)}</p>` + exs.map((e) => {
        const series = exerciseSeries(g, e.id)
        const idx = series.length && series[0].score > 0 ? (100 * series[series.length - 1].score) / series[0].score : null
        return `<div class="gym-ex-row" data-ex-id="${esc(e.id)}" title="Strength history & edit">
          <span class="gym-ex-name">${esc(e.name)}${e.unilateral ? ' <span class="gym-uni">L/R</span>' : ''}</span>
          <span class="gym-ex-idx">${idx != null ? fmt1(idx) : '—'}</span>
        </div>`
      }).join('')
    ).join('')
  }
  // gymcurrent
  const ov = dayOverride(g)
  if (ov === SKIP) {
    return head('Current workout') + `<div class="gym-big">Skipped</div>
      <p class="gym-sub">Today is off — the plan stays where it was, so nothing is lost.</p>` +
      (cz ? '' : `<button type="button" class="gym-btn gym-btn--ghost" data-gym-act="unskip">Undo skip</button>`)
  }
  const w0 = currentWorkout(g)
  if (!w0) {
    return head('Current workout') + `<p class="gym-empty">No workout scheduled — set up your plan in Gym → Settings.</p>`
      + (cz ? '' : dayPicker(g, ov))
  }
  if (w0.rest) {
    return head('Current workout') + `<div class="gym-big">${esc(w0.name)}</div>
      <p class="gym-sub">Rest day${w0.flex ? ' · flex' : ''} — recovery counts as training.</p>` +
      (cz ? '' : `<button type="button" class="btn-gym-complete" data-gym-act="complete">Complete rest day</button>`
        + dayPicker(g, ov))
  }
  const exs = exercisesOf(g, w0.id)
  const today = todayKey()
  const logRow = (e, side) => {
    const entry = logsFor(g, e.id, today, side)
    const sets = entry?.sets ?? []
    const sideAttr = side ? ` data-side="${side}"` : ''
    // Input controls sit LEFT-aligned (no flex:1 spacer in this row now).
    // The side reads as a full word ABOVE the inputs — a bare "L"/"R" beside
    // the field was easy to misread as part of the input.
    const inputRow = (side ? `<p class="gym-side">${side === 'L' ? 'Left' : 'Right'}</p>` : '') +
      `<div class="gym-log-row" data-ex-id="${esc(e.id)}"${sideAttr}>
      ${cz ? '' : `<input class="pw-field gym-w" type="number" min="0" step="0.5" placeholder="${g.unit}" aria-label="Weight (${g.unit})">
      <input class="pw-field gym-r" type="number" min="1" step="1" placeholder="reps" aria-label="Reps">
      <button type="button" class="gym-btn" data-gym-act="log-set">Log</button>`}
    </div>`
    // One row per set (weight | reps), each with its own plain-x delete.
    const rows = sets.map((s, i) => `<div class="gym-set-row">
      <span class="gym-set-w">${s.weight > 0 ? `${toDisplayWeight(s.weight, g.unit)} ${g.unit}` : 'body'}</span>
      <span class="gym-set-r">${s.reps} reps</span>
      ${cz ? '' : `<button type="button" class="pw-item-remove" data-gym-act="del-set" data-ex-id="${esc(e.id)}"${sideAttr} data-date="${today}" data-idx="${i}" title="Remove set">x</button>`}
    </div>`).join('')
    const list = sets.length
      ? `<div class="gym-sets">${rows}</div>`
      : `<p class="gym-chips--none">no sets yet</p>`
    return inputRow + list
  }
  return head('Current workout') + `<div class="gym-big">${esc(w0.name)}</div>` +
    (exs.length ? exs.map((e) =>
      `<div class="gym-exercise">
        <p class="gym-ex-title">${esc(e.name)}${e.target ? ` <span class="gym-target">${esc(e.target)}</span>` : ''}${e.unilateral ? ' <span class="gym-uni">L/R</span>' : ''}</p>
        ${e.unilateral ? logRow(e, 'L') + logRow(e, 'R') : logRow(e, null)}
      </div>`
    ).join('') : `<p class="gym-empty">No exercises in this workout yet.</p>`) +
    (cz ? '' : `<div class="gym-times">
      <input class="pw-field gym-time-in" type="time" title="Session start" aria-label="Session start time">
      <span class="wk-or">→</span>
      <input class="pw-field gym-time-out" type="time" title="Session end" aria-label="Session end time">
      <span class="gym-times-hint">session times (feeds the planner)</span>
    </div>
    <button type="button" class="btn-gym-complete" data-gym-act="complete">Complete workout</button>`
    + dayPicker(g, ov))
}

// Today only: do a different workout than the plan picked, or take the day off.
// Both write a date-keyed override (gym.js), so tomorrow is the plan's again
// without anything to undo.
const dayPicker = (g, ov) => (g.workouts.length ? `<div class="gym-pick">
  <select class="pw-field pw-field--select gym-pick-sel" data-gym-act="pick" aria-label="Workout for today">
    <option value=""${ov ? '' : ' selected'}>Today: as planned</option>
    ${g.workouts.map((w) =>
      `<option value="${esc(w.id)}"${w.id === ov ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}
  </select>
  <button type="button" class="gym-btn gym-btn--ghost" data-gym-act="skip">Skip today</button>
</div>` : '')

// Line chart of the general strength score, drawn by view.js's ResizeObserver.
export function gymScoreGraphSVG(w, h) {
  const pts = generalSeries(loadGym()).map((p) => ({ label: shortDate(p.date), value: Math.round(p.score * 10) / 10 }))
  return lineChart(pts, { w, h, xLabel: '', yLabel: 'Index' })
}

// ---- view-mode interactions (logging, complete, exercise modal) -------------

let rerenderApp = null

export function bindGym(rerender) {
  rerenderApp = rerender
  document.body.addEventListener('click', onGymClick)
  // The workout picker is a <select>, so it reports on change, not on click.
  document.body.addEventListener('change', onGymChange)
}

function onGymChange(e) {
  const sel = e.target.closest('select[data-gym-act="pick"]')
  if (!sel) return
  setDayOverride(loadGym(), sel.value || null)
  rerenderApp?.()
}

async function onGymClick(e) {
  const act = e.target.closest('[data-gym-act]')
  if (act) {
    const g = loadGym()
    const a = act.dataset.gymAct
    if (a === 'log-set') {
      const row = act.closest('.gym-log-row')
      const side = row.dataset.side || null
      const weight = toKgWeight(row.querySelector('.gym-w').value, g.unit) // canonical kg
      const reps = row.querySelector('.gym-r').value
      if (!Number(reps)) return
      logSet(g, row.dataset.exId, side, weight, reps)
      rerenderApp?.()
    } else if (a === 'del-set') {
      if (!(await confirmDelete('Delete this set?'))) return
      removeSetAt(loadGym(), act.dataset.exId, act.dataset.side || null, act.dataset.date, Number(act.dataset.idx))
      rerenderApp?.()
    } else if (a === 'skip') {
      setDayOverride(g, SKIP)
      rerenderApp?.()
    } else if (a === 'unskip') {
      setDayOverride(g, null)
      rerenderApp?.()
    } else if (a === 'complete') {
      const card = act.closest('.pwidget')
      completeWorkout(g, new Date(), {
        start: card?.querySelector('.gym-time-in')?.value || '',
        end: card?.querySelector('.gym-time-out')?.value || '',
      })
      rerenderApp?.()
    }
    return
  }
  if (document.body.classList.contains('customizing')) return
  const exRow = e.target.closest('.gym-ex-row')
  if (exRow) openExerciseModal(exRow.dataset.exId)
}

// ---- exercise modal: strength graph + set/rep history + edit ----------------

function openExerciseModal(exId) {
  document.getElementById('app-modal')?.remove()
  const g = loadGym()
  const ex = exerciseById(g, exId)
  if (!ex) return
  const series = exerciseSeries(g, exId)
  const logs = g.logs.filter((l) => l.exerciseId === exId).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 20)
  const byDate = new Map()
  for (const l of logs) {
    if (!byDate.has(l.date)) byDate.set(l.date, [])
    byDate.get(l.date).push(l)
  }
  // Each day = a row: date + set summary on the left, a small chart of that
  // day's sets (est. 1RM per set) on the right, plus a delete for bad logs.
  const history = [...byDate.entries()].map(([date, entries]) => {
    const ordered = entries.sort((a, b) => ((a.side ?? '') < (b.side ?? '') ? -1 : 1))
    const summary = ordered
      .map((l) => `${l.side ? `<b>${l.side}:</b> ` : ''}${esc(l.sets.map((x) => setChip(x, g.unit)).join(', '))}`)
      .join(' &nbsp; ')
    const daySets = ordered.flatMap((l) => l.sets)
    const pts = daySets.map((s, i) => ({ label: `${i + 1}`, value: toDisplayWeight(est1RM(s), g.unit) }))
    const chart = pts.length ? lineChart(pts, { w: 150, h: 46, xLabel: '', yLabel: '' }) : ''
    return `<div class="gym-history-row" data-date="${esc(date)}">
      <div class="gym-history-when"><span class="gym-history-date">${esc(shortDate(date))}</span>
        <span class="gym-history-sets">${summary}</span></div>
      <div class="gym-history-chart">${chart}</div>
      <button type="button" class="pw-item-remove" data-gym-act="del-log-date" data-date="${esc(date)}" title="Delete this day">x</button>
    </div>`
  }).join('')

  const o = document.createElement('div')
  o.className = 'modal-overlay'
  o.id = 'app-modal'
  o.innerHTML = `<div class="modal modal--gym" role="dialog" aria-modal="true">
    <h2 class="modal__title">${esc(ex.name)}</h2>
    <div class="modal__body">
      <div class="gym-modal-chart"></div>
      <p class="gym-group">Set history</p>
      ${history ? `<div class="gym-history">${history}</div>` : `<p class="gym-empty">No sets logged yet.</p>`}
      <p class="gym-group">Edit exercise</p>
      <div class="gym-edit">
        <input class="pw-field gym-edit-name" value="${esc(ex.name)}" aria-label="Exercise name">
        <select class="pw-field pw-field--select gym-edit-workout" aria-label="Workout">
          ${g.workouts.map((w) => `<option value="${esc(w.id)}"${w.id === ex.workoutId ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}
        </select>
        <label class="gym-check"><input type="checkbox" class="gym-edit-uni"${ex.unilateral ? ' checked' : ''}> Unilateral (log L/R separately)</label>
        <div class="gym-edit-actions">
          <button type="button" class="gym-btn gym-btn--ghost gym-edit-delete">Delete exercise</button>
          <button type="button" class="gym-btn gym-edit-save">Save</button>
        </div>
      </div>
    </div>
  </div>`
  document.body.appendChild(o)
  // draw the strength chart at the modal's real width
  const mount = o.querySelector('.gym-modal-chart')
  const pts = series.map((p) => ({ label: shortDate(p.date), value: toDisplayWeight(p.score, g.unit) }))
  mount.innerHTML = pts.length
    ? lineChart(pts, { w: mount.clientWidth || 640, h: 200, xLabel: '', yLabel: `Score (est. 1RM, ${g.unit})` })
    : `<p class="gym-empty">Log sets to chart this exercise's strength.</p>`

  const close = () => { o.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = (e) => { if (e.key === 'Escape') close() }
  o.addEventListener('click', (e) => { if (e.target === o) close() })
  o.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-gym-act="del-log-date"]')
    if (!del) return
    if (!(await confirmDelete("Delete this day's logs?"))) return
    removeLogsForDate(loadGym(), exId, del.dataset.date)
    close()
    openExerciseModal(exId) // re-render the modal with the day removed
    rerenderApp?.()
  })
  document.addEventListener('keydown', onKey)
  o.querySelector('.gym-edit-save').addEventListener('click', () => {
    const g2 = loadGym()
    const e2 = exerciseById(g2, exId)
    if (e2) {
      e2.name = o.querySelector('.gym-edit-name').value.trim() || e2.name
      e2.workoutId = o.querySelector('.gym-edit-workout').value
      e2.unilateral = o.querySelector('.gym-edit-uni').checked
      saveGym(g2)
    }
    close()
    rerenderApp?.()
  })
  o.querySelector('.gym-edit-delete').addEventListener('click', () => {
    const g2 = loadGym()
    removeExercise(g2, exId)
    close()
    rerenderApp?.()
  })
}

// ---- gym settings tab ---------------------------------------------------------

export function renderGymSettings(container, rerender) {
  const g = loadGym()
  const wkOptions = (sel) => `<option value=""${!sel ? ' selected' : ''}>— Rest —</option>` +
    g.workouts.map((w) => `<option value="${esc(w.id)}"${w.id === sel ? ' selected' : ''}>${esc(w.name)}</option>`).join('')

  container.innerHTML = `<div class="page gym-settings">
    <p class="gym-group">Plan type</p>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Weight unit</span>
        <span class="set-row__sub">Stored values convert automatically — history and scores are unaffected.</span></div>
      <select class="pw-field pw-field--select" data-gym-set="unit">
        <option value="kg"${g.unit === 'kg' ? ' selected' : ''}>kg</option>
        <option value="lbs"${g.unit === 'lbs' ? ' selected' : ''}>lbs</option>
      </select>
    </div>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Schedule</span>
        <span class="set-row__sub">Weekly assigns a workout to each weekday; Cycle runs an ordered list — completing one advances to the next.</span></div>
      <select class="pw-field pw-field--select" data-gym-set="plan-type">
        <option value="weekly"${g.plan.type === 'weekly' ? ' selected' : ''}>Weekly</option>
        <option value="cycle"${g.plan.type === 'cycle' ? ' selected' : ''}>Cycle</option>
      </select>
    </div>

    ${g.plan.type === 'weekly' ? `
    <p class="gym-group">Weekly schedule</p>
    ${DAYS.map((d) => `<div class="set-row gym-day-row">
      <span class="set-row__name">${DAY_LABELS[d]}</span>
      <select class="pw-field pw-field--select" data-gym-set="day" data-day="${d}">${wkOptions(g.plan.weekly[d])}</select>
    </div>`).join('')}` : `
    <p class="gym-group">Cycle order</p>
    ${g.plan.cycle.order.map((id, i) => `<div class="set-row gym-cycle-row">
      <span class="set-row__name">${i + 1}. ${esc(workoutById(g, id)?.name ?? '?')}${i === g.plan.cycle.position ? ' <span class="gym-uni">current</span>' : ''}</span>
      <span class="gym-cycle-tools">
        <button type="button" class="pw-item-remove" data-gym-set="cycle-up" data-i="${i}" title="Earlier"${i === 0 ? ' disabled' : ''}>↑</button>
        <button type="button" class="pw-item-remove" data-gym-set="cycle-down" data-i="${i}" title="Later"${i === g.plan.cycle.order.length - 1 ? ' disabled' : ''}>↓</button>
        <button type="button" class="pw-item-remove" data-gym-set="cycle-remove" data-i="${i}" title="Remove">×</button>
      </span>
    </div>`).join('')}
    <div class="gym-add-row">
      <select class="pw-field pw-field--select gym-cycle-add-sel">${g.workouts.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')}</select>
      <button type="button" class="gym-btn" data-gym-set="cycle-add">Add to cycle</button>
      <button type="button" class="gym-btn gym-btn--ghost" data-gym-set="cycle-reset">Reset position</button>
    </div>`}

    <p class="gym-group">Location & hours (used by the Ladder planner)</p>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Gym address</span>
        <span class="set-row__sub">The planner uses it for drive times to and from the gym.</span></div>
      <input class="pw-field gym-addr-in" data-gym-set="address" value="${esc(g.address)}" placeholder="Street, city…" aria-label="Gym address">
    </div>
    <p class="gym-group">Gym hours (the gym's actual open/close times — blank = any time you're awake)</p>
    ${DAYS.map((d) => `<div class="set-row gym-day-row">
      <span class="set-row__name">${DAY_LABELS[d]}</span>
      <span class="gym-hours">
        <input class="pw-field" type="time" data-gym-set="hours-open" data-day="${d}" value="${esc(g.hours[d].open)}" aria-label="${DAY_LABELS[d]} opens">
        <span class="wk-or">→</span>
        <input class="pw-field" type="time" data-gym-set="hours-close" data-day="${d}" value="${esc(g.hours[d].close)}" aria-label="${DAY_LABELS[d]} closes">
      </span>
    </div>`).join('')}
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Default session length</span>
        <span class="set-row__sub">Minutes, used until a workout has timed completions — then its own historic average takes over.</span></div>
      <input class="pw-field wk-num" type="number" min="10" step="5" data-gym-set="default-duration" value="${esc(g.defaultDuration)}" aria-label="Default session minutes">
    </div>

    <p class="gym-group">Workouts & exercises</p>
    ${g.workouts.map((w) => `<div class="gym-workout-block" data-workout-id="${esc(w.id)}">
      <div class="gym-add-row">
        <input class="pw-field gym-wk-name" data-gym-set="workout-name" data-id="${esc(w.id)}" value="${esc(w.name)}" aria-label="Workout name">
        <label class="gym-check" title="A rest day: no exercises, completing it just advances the plan"><input type="checkbox" data-gym-set="workout-rest" data-id="${esc(w.id)}"${w.rest ? ' checked' : ''}> Rest day</label>
        <label class="gym-check" title="Reserved for a future plugin"><input type="checkbox" data-gym-set="workout-flex" data-id="${esc(w.id)}"${w.flex ? ' checked' : ''}> Flex day</label>
        <button type="button" class="pw-item-remove" data-gym-set="workout-remove" data-id="${esc(w.id)}" title="Delete workout">×</button>
      </div>
      ${exercisesOf(g, w.id).map((e) => `<div class="gym-add-row gym-ex-edit">
        <input class="pw-field" data-gym-set="exercise-name" data-id="${esc(e.id)}" value="${esc(e.name)}" aria-label="Exercise name">
        <input class="pw-field gym-target-in" data-gym-set="exercise-target" data-id="${esc(e.id)}" value="${esc(e.target ?? '')}" placeholder="3×8" aria-label="Target sets × reps">
        <label class="gym-check"><input type="checkbox" data-gym-set="exercise-uni" data-id="${esc(e.id)}"${e.unilateral ? ' checked' : ''}> L/R</label>
        <button type="button" class="pw-item-remove" data-gym-set="exercise-remove" data-id="${esc(e.id)}" title="Delete exercise">×</button>
      </div>`).join('')}
      <div class="gym-add-row">
        <input class="pw-field gym-new-ex" placeholder="New exercise name" aria-label="New exercise name">
        <label class="gym-check"><input type="checkbox" class="gym-new-ex-uni"> L/R</label>
        <button type="button" class="gym-btn" data-gym-set="exercise-add" data-workout="${esc(w.id)}">Add exercise</button>
      </div>
    </div>`).join('')}
    <div class="gym-add-row">
      <input class="pw-field gym-new-workout" placeholder="New workout name (e.g. Chest & Back)" aria-label="New workout name">
      <button type="button" class="gym-btn" data-gym-set="workout-add">Add workout</button>
    </div>
  </div>`

  const refresh = () => renderGymSettings(container, rerender)
  // property assignment (not addEventListener): re-renders must not stack handlers
  container.onclick = (e) => {
    const el = e.target.closest('[data-gym-set]')
    if (!el) return
    const g2 = loadGym()
    const k = el.dataset.gymSet
    const order = g2.plan.cycle.order
    if (k === 'workout-add') {
      const name = container.querySelector('.gym-new-workout').value.trim()
      if (name) addWorkout(g2, name)
    } else if (k === 'workout-remove') removeWorkout(g2, el.dataset.id)
    else if (k === 'exercise-add') {
      const block = el.closest('.gym-workout-block')
      const name = block.querySelector('.gym-new-ex').value.trim()
      if (name) addExercise(g2, el.dataset.workout, name, block.querySelector('.gym-new-ex-uni').checked)
    } else if (k === 'exercise-remove') removeExercise(g2, el.dataset.id)
    else if (k === 'cycle-add') {
      const sel = container.querySelector('.gym-cycle-add-sel')
      if (sel?.value) { order.push(sel.value); saveGym(g2) }
    } else if (k === 'cycle-remove') {
      order.splice(Number(el.dataset.i), 1)
      g2.plan.cycle.position = Math.min(g2.plan.cycle.position, Math.max(0, order.length - 1))
      saveGym(g2)
    } else if (k === 'cycle-up' || k === 'cycle-down') {
      const i = Number(el.dataset.i)
      const j = k === 'cycle-up' ? i - 1 : i + 1
      if (j < 0 || j >= order.length) return
      ;[order[i], order[j]] = [order[j], order[i]]
      saveGym(g2)
    } else if (k === 'cycle-reset') { g2.plan.cycle.position = 0; saveGym(g2) }
    else return
    refresh()
    rerender?.()
  }
  container.oninput = (e) => {
    const el = e.target.closest('[data-gym-set]')
    if (!el) return
    const g2 = loadGym()
    const k = el.dataset.gymSet
    if (k === 'plan-type') { g2.plan.type = el.value; saveGym(g2); refresh(); rerender?.(); return }
    if (k === 'unit') { g2.unit = el.value === 'lbs' ? 'lbs' : 'kg'; saveGym(g2); refresh(); rerender?.(); return }
    if (k === 'day') { g2.plan.weekly[el.dataset.day] = el.value || null; saveGym(g2); rerender?.(); return }
    if (k === 'workout-name') { const w = workoutById(g2, el.dataset.id); if (w) { w.name = el.value; saveGym(g2) } return }
    if (k === 'exercise-name') { const x = exerciseById(g2, el.dataset.id); if (x) { x.name = el.value; saveGym(g2) } return }
    if (k === 'exercise-target') { const x = exerciseById(g2, el.dataset.id); if (x) { x.target = el.value.trim(); saveGym(g2) } return }
    if (k === 'workout-rest' || k === 'workout-flex') {
      const w2 = workoutById(g2, el.dataset.id)
      if (w2) { w2[k === 'workout-rest' ? 'rest' : 'flex'] = el.checked; saveGym(g2); rerender?.() }
      return
    }
    if (k === 'exercise-uni') { const x = exerciseById(g2, el.dataset.id); if (x) { x.unilateral = el.target?.checked ?? el.checked; saveGym(g2) } return }
    if (k === 'address') { g2.address = el.value; saveGym(g2); return }
    if (k === 'hours-open') { g2.hours[el.dataset.day].open = el.value; saveGym(g2); return }
    if (k === 'hours-close') { g2.hours[el.dataset.day].close = el.value; saveGym(g2); return }
    if (k === 'default-duration') { g2.defaultDuration = Math.max(10, Number(el.value) || 75); saveGym(g2) }
  }
}
