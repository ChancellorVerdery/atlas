// Course Planner UI, two pages: the PLANNER (#/course — semesters, classes,
// settings-adjacent entry) and the MAP (#/course/explore, tab-labeled "Map" —
// a zoomable Sankey-style board). Columns are terms in order; each class is a
// box whose height ∝ credit hours; prerequisites flow in as ribbons. Data and
// the route scheduler live in course.js.

import {
  loadCourse, addTerm, setCurrentTerm, removeTerm, addCourse, updateCourse,
  removeCourse, setSetting, toggleDisabledTerm, scheduleDegree,
  SEASONS, SEASON_LABEL, STRATEGIES, termLabel, termRank, parseTerm, nextTermKey, currentTermKey,
} from './course.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const list = (a) => (Array.isArray(a) ? a.join(', ') : '')
// `size` chars for a text input so it fits its content (the subgrid columns then
// size to the widest cell, and typing live-updates size to grow the column).
const fit = (v, ph, min = 4) => Math.max((v || '').length, (ph || '').length, min) + 1

// board geometry
const COL_W = 210, PX_PER_CREDIT = 24, BOX_MIN_H = 42, BOX_GAP = 14, HEADER_H = 46, PAD = 28

let vb = null // current map viewBox {x,y,w,h} — survives re-renders so zoom holds; null = refit

const compute = (s) => {
  const sched = scheduleDegree(s)
  if (localStorage.getItem('atlas.devMode') === '1') window.__cp = { ...sched, courseByCode: Object.fromEntries(s.courses.map((c) => [c.code, c.id])) } // test hook
  return sched
}
const noticesHTML = (sched) => sched.warnings.map((w) => `<p class="lad-notice lad-notice--warn">${esc(w)}</p>`).join('')

// ---- the Planner page (entry) ------------------------------------------------

export function renderCoursePage(root, rerender) {
  const s = loadCourse()
  const sched = compute(s)
  const summers = upcomingSummers(s)

  root.innerHTML = `<div class="cp">
    <div class="cp-bar">
      <button type="button" class="gym-btn" data-cp="add-class">+ Class</button>
      <button type="button" class="gym-btn gym-btn--ghost" data-cp="add-term">+ Semester</button>
      <button type="button" class="gym-btn cp-calc" data-cp="calc" title="Compute the route and open the map">Calculate route</button>
      <span class="gf-status" id="cp-status">${planStatus(s, sched)}</span>
    </div>
    <div class="cp-notices">${noticesHTML(sched)}</div>
    <div class="cp-panel">
      <div class="cp-group">
        <div class="cp-group__head">Semesters<span class="gym-sub">Your past &amp; current terms — the classes you’ve taken.</span></div>
        <div class="cp-terms">${termChips(s)}</div>
        <form class="cp-addterm" data-cp="term-form" hidden>
          <select class="pw-field" name="season">${SEASONS.map((k) => `<option value="${k}">${SEASON_LABEL[k]}</option>`).join('')}</select>
          <input class="pw-field wk-num" name="year" type="number" min="2000" max="2100" placeholder="year" value="${new Date().getFullYear()}">
          <label class="gym-check"><input type="checkbox" name="current"> current</label>
          <button type="submit" class="gym-btn">Add</button>
        </form>
      </div>
      ${summers.length ? `<div class="cp-group">
        <div class="cp-group__head">Summer terms<span class="gym-sub">Toggle a summer off (internship, travel) to keep the planner out of it.</span></div>
        <div class="cp-summers">${summers.map((k) => `<label class="cp-summer${s.disabledTerms.includes(k) ? ' is-off' : ''}"><input type="checkbox" data-cp="toggle-summer" data-key="${k}"${s.disabledTerms.includes(k) ? '' : ' checked'}> ${esc(termLabel(k))}</label>`).join('')}</div>
      </div>` : ''}
      <div class="cp-group">
        <div class="cp-group__head">Classes<span class="gym-sub">Set the term for taken classes; leave “To take” for the planner to place.</span></div>
        <div class="cp-classes">${classTable(s)}</div>
      </div>
    </div>
  </div>`

  root.querySelector('[data-cp="term-form"]').addEventListener('submit', (e) => {
    e.preventDefault()
    const f = e.target
    addTerm(loadCourse(), { season: f.season.value, year: Number(f.year.value), current: f.current.checked })
    renderCoursePage(root, rerender)
  })

  root.onclick = (e) => {
    const el = e.target.closest('[data-cp]')
    if (!el) return
    const act = el.dataset.cp
    const cur = loadCourse()
    if (act === 'add-class') { addCourse(cur, { code: '', title: 'New class', credits: 3 }); renderCoursePage(root, rerender) }
    else if (act === 'add-term') { const f = root.querySelector('[data-cp="term-form"]'); f.hidden = !f.hidden; if (!f.hidden) f.querySelector('[name=year]').focus() }
    else if (act === 'calc') { vb = null; location.hash = '#/course/explore' } // route recomputes on render; the map opens fitted
    else if (act === 'del-term') { removeTerm(cur, el.dataset.key); renderCoursePage(root, rerender) }
    else if (act === 'set-current') { setCurrentTerm(cur, el.dataset.key); renderCoursePage(root, rerender) }
    else if (act === 'del-class') { removeCourse(cur, el.dataset.cid); renderCoursePage(root, rerender) }
    else if (act === 'toggle-summer') { toggleDisabledTerm(cur, el.dataset.key); vb = null; renderCoursePage(root, rerender) }
  }

  // inline edits: text/number save silently (keep focus); selects/checkboxes re-render
  root.oninput = (e) => {
    const el = e.target.closest('[data-cid][data-field]')
    if (!el || el.tagName === 'SELECT' || el.type === 'checkbox') return
    if (el.hasAttribute('size')) el.size = fit(el.value, el.placeholder, el.dataset.field === 'title' ? 10 : 4) // grow to fit; the subgrid widens the whole column
    const f = el.dataset.field
    const val = ['prereqs', 'coreqs'].includes(f) ? el.value.split(',').map((x) => x.trim()).filter(Boolean) : el.value
    updateCourse(loadCourse(), el.dataset.cid, { [f]: val })
  }
  root.onchange = (e) => {
    const el = e.target.closest('[data-cid][data-field]')
    if (!el || (el.tagName !== 'SELECT' && el.type !== 'checkbox')) return
    const val = el.type === 'checkbox' ? el.checked : el.value
    updateCourse(loadCourse(), el.dataset.cid, { [el.dataset.field]: el.dataset.field === 'term' ? (val || null) : val })
    renderCoursePage(root, rerender)
  }
}

const termChips = (s) => s.terms.length
  ? s.terms.map((t) => `<span class="cp-term${t.current ? ' is-current' : ''}">
      <button type="button" class="cp-term__name" data-cp="set-current" data-key="${t.key}" title="Mark as current semester">${esc(termLabel(t.key))}${t.current ? ' ·now' : ''}</button>
      <button type="button" class="cp-term__x" data-cp="del-term" data-key="${t.key}" title="Remove semester">×</button>
    </span>`).join('')
  : '<span class="gym-sub">No semesters yet — add your past &amp; current terms.</span>'

function classTable(s) {
  const termOpts = (sel) => `<option value=""${!sel ? ' selected' : ''}>To take</option>` +
    s.terms.map((t) => `<option value="${t.key}"${sel === t.key ? ' selected' : ''}>${esc(termLabel(t.key))}</option>`).join('')
  const req = (c, f, ph, title) => `<input class="pw-field cp-req" data-cid="${c.id}" data-field="${f}" value="${esc(list(c[f]))}" size="${fit(list(c[f]), ph)}" placeholder="${ph}" title="${title}">`
  const row = (c) => `<div class="cp-row" data-cid="${c.id}">
    <input class="pw-field cp-code" data-cid="${c.id}" data-field="code" value="${esc(c.code)}" size="${fit(c.code, 'CODE')}" placeholder="CODE" aria-label="Class code">
    <input class="pw-field cp-title" data-cid="${c.id}" data-field="title" value="${esc(c.title)}" size="${fit(c.title, 'Title', 10)}" placeholder="Title" aria-label="Class title">
    <input class="pw-field cp-cr wk-num" data-cid="${c.id}" data-field="credits" type="number" min="0" max="24" value="${c.credits}" title="Credit hours" aria-label="Credits">
    ${req(c, 'prereqs', 'prereqs', 'Prerequisites (codes, comma-separated) — must be an EARLIER term')}
    ${req(c, 'coreqs', 'coreqs', 'Corequisites — same term or earlier')}
    <span class="cp-reqgap" aria-hidden="true"></span>
    <label class="gym-check cp-su" title="Offered in summer"><input type="checkbox" data-cid="${c.id}" data-field="summerOk"${c.summerOk ? ' checked' : ''}> su</label>
    <select class="pw-field cp-term" data-cid="${c.id}" data-field="term" title="Which term (or leave To take)">${termOpts(c.term)}</select>
    <button type="button" class="pw-item-remove" data-cp="del-class" data-cid="${c.id}" title="Remove class">×</button>
  </div>`
  // ponytail: dropped the Pre/Co column (see course.js) but kept its grid track as an
  // empty spacer in header+row rather than editing styles.css's cp-classes
  // grid-template-columns (owned by another agent in this pass). A follow-up styles.css
  // edit could drop that 6th `max-content` track and the two blank spans below for a
  // fully clean 8-column table.
  return `<div class="cp-rowhead"><span>Code</span><span>Title</span><span>Cr</span><span>Prereq</span><span title="Same term or earlier">Coreq</span><span></span><span></span><span>Term</span><span></span></div>` +
    (s.courses.length ? s.courses.map(row).join('') : '<p class="gym-sub cp-emptyrow">No classes yet — click “+ Class”.</p>')
}

// summer terms in the planning horizon (current term forward a few years) + any
// already toggled off, so the user can disable one before it's even scheduled.
function upcomingSummers(s) {
  const start = s.terms.length ? s.terms[s.terms.length - 1].key : currentTermKey()
  const out = new Set(s.disabledTerms.filter((k) => parseTerm(k).season === 'summer'))
  let cur = start
  for (let i = 0; i < 15; i++) { cur = nextTermKey(cur); if (parseTerm(cur).season === 'summer') out.add(cur) }
  return [...out].sort((a, b) => termRank(a) - termRank(b)).slice(0, 5)
}

function planStatus(s, sched) {
  const remaining = s.courses.filter((c) => !c.term)
  const cr = remaining.reduce((t, c) => t + c.credits, 0)
  if (!remaining.length) return `${s.courses.length} classes · nothing left to schedule`
  const grad = sched.gradTerm && sched.termsToFinish ? ` · finishes ${termLabel(sched.gradTerm)}` : ''
  return `${remaining.length} to take · ${cr} credits · ${sched.termsToFinish} more term${sched.termsToFinish === 1 ? '' : 's'}${grad}`
}

// ---- the Map page (board) -----------------------------------------------------

export function renderCourseMap(root, rerender) {
  const s = loadCourse()
  const sched = compute(s)
  root.innerHTML = `<div class="cp">
    <div class="cp-bar">
      <button type="button" class="gym-btn gym-btn--ghost" data-cp="fit" title="Zoom back out to the whole route">Fit</button>
      <span class="gf-status" id="cp-status">${planStatus(s, sched)}</span>
    </div>
    <div class="cp-notices">${noticesHTML(sched)}</div>
    <div class="cp-boardwrap"><div class="cp-board">${boardSVG(s, sched)}</div></div>
  </div>`
  wireBoard(root)
  root.onclick = (e) => {
    const el = e.target.closest('[data-cp]')
    if (!el) return
    if (el.dataset.cp === 'box') openClassModal(root, el.dataset.cid)
    else if (el.dataset.cp === 'fit') { vb = null; renderCourseMap(root, rerender) }
    else if (el.dataset.cp === 'modal-close') root.querySelector('.cp-modal')?.remove()
  }
}

function boardSVG(s, sched) {
  const byId = new Map(s.courses.map((c) => [c.id, c]))
  const cols = sched.board.filter((t) => t.courseIds.length)
  if (!cols.length) return `<div class="cp-empty">Add classes on the Planner tab — the route draws here.</div>`

  // layout: a box per course, stacked in its term column; height ∝ credits
  const box = new Map()
  let maxBottom = 0
  cols.forEach((t, ci) => {
    const x = PAD + ci * COL_W
    let y = HEADER_H + PAD
    for (const id of t.courseIds) {
      const c = byId.get(id); if (!c) continue
      const h = Math.max(BOX_MIN_H, c.credits * PX_PER_CREDIT)
      box.set(id, { x, y, w: COL_W - 40, h, c, kind: t.kind })
      y += h + BOX_GAP
    }
    maxBottom = Math.max(maxBottom, y)
  })
  const width = PAD * 2 + cols.length * COL_W
  const height = maxBottom + PAD

  // ribbons: prereq/coreq flow from source box's right edge to target's left
  const ribbons = sched.edges.map((e) => {
    const a = box.get(e.from), b = box.get(e.to)
    if (!a || !b) return ''
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2
    const mx = (x1 + x2) / 2
    return `<path class="cp-ribbon cp-ribbon--${e.kind}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`
  }).join('')

  const columns = cols.map((t, ci) => {
    const x = PAD + ci * COL_W
    return `<g class="cp-col cp-col--${t.kind}">
      <rect class="cp-col__bg" x="${x - 14}" y="${HEADER_H}" width="${COL_W - 12}" height="${height - HEADER_H - PAD / 2}"/>
      <text class="cp-col__label" x="${x + (COL_W - 40) / 2}" y="${HEADER_H - 18}" text-anchor="middle">${esc(termLabel(t.key))}</text>
      <text class="cp-col__sub" x="${x + (COL_W - 40) / 2}" y="${HEADER_H - 4}" text-anchor="middle">${t.kind === 'future' ? `${t.credits} cr · planned` : t.kind === 'current' ? `${t.credits} cr · current` : `${t.credits} cr · done`}</text>
    </g>`
  }).join('')

  const boxes = [...box.entries()].map(([id, b]) => `<g class="cp-box cp-box--${b.kind}" data-cp="box" data-cid="${id}" transform="translate(${b.x},${b.y})">
      <rect class="cp-box__bg" width="${b.w}" height="${b.h}" rx="7"/>
      <text class="cp-box__code" x="10" y="18">${esc(b.c.code || '—')}</text>
      <text class="cp-box__title" x="10" y="33">${esc(clip(b.c.title, 22))}</text>
      <text class="cp-box__cr" x="${b.w - 8}" y="18" text-anchor="end">${b.c.credits}</text>
    </g>`).join('')

  if (!vb) vb = { x: 0, y: 0, w: width, h: height } // fit whole board on (re)calc
  return `<svg class="cp-svg" id="cp-svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" data-w="${width}" data-h="${height}" preserveAspectRatio="xMidYMid meet">
    <g class="cp-ribbons">${ribbons}</g>${columns}${boxes}
  </svg>`
}

const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t)

// pan (drag) + zoom (wheel) by mutating the SVG viewBox — same feel as the graph board
function wireBoard(root) {
  const svg = root.querySelector('#cp-svg')
  if (!svg) return
  const W = Number(svg.dataset.w), H = Number(svg.dataset.h)
  let drag = null
  svg.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-cp="box"]')) return // let clicks open the modal
    drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y }
    svg.setPointerCapture(e.pointerId); svg.classList.add('is-drag')
  })
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return
    vb.x = drag.vx - (e.clientX - drag.x) * (vb.w / svg.clientWidth)
    vb.y = drag.vy - (e.clientY - drag.y) * (vb.h / svg.clientHeight)
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`)
  })
  const end = (e) => { drag = null; svg.classList.remove('is-drag'); try { svg.releasePointerCapture(e.pointerId) } catch {} }
  svg.addEventListener('pointerup', end)
  svg.addEventListener('pointercancel', end)
  svg.addEventListener('wheel', (e) => {
    e.preventDefault()
    const rect = svg.getBoundingClientRect()
    const px = vb.x + ((e.clientX - rect.left) / rect.width) * vb.w
    const py = vb.y + ((e.clientY - rect.top) / rect.height) * vb.h
    const f = e.deltaY < 0 ? 0.88 : 1.14
    const nw = Math.min(W * 2.5, Math.max(W * 0.15, vb.w * f))
    const nh = nw * (H / W)
    vb.x = px - ((px - vb.x) * nw) / vb.w
    vb.y = py - ((py - vb.y) * nh) / vb.h
    vb.w = nw; vb.h = nh
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`)
  }, { passive: false })
}

function openClassModal(root, id) {
  root.querySelector('.cp-modal')?.remove()
  const s = loadCourse()
  const c = s.courses.find((x) => x.id === id)
  if (!c) return
  const byCode = new Map(s.courses.map((x) => [x.code.toLowerCase(), x]))
  const resolve = (refs) => refs.length
    ? refs.map((r) => { const m = byCode.get(r.toLowerCase()); return `<li>${esc(r)}${m && m.title ? ` <span class="cp-mut">— ${esc(m.title)}</span>` : ''}</li>` }).join('')
    : '<li class="cp-mut">none</li>'
  const el = document.createElement('div')
  el.className = 'cp-modal'
  el.innerHTML = `<div class="cp-modal__box" role="dialog" aria-modal="true">
    <button type="button" class="cp-modal__x" data-cp="modal-close" aria-label="Close">×</button>
    <h3 class="cp-modal__code">${esc(c.code || '—')} <span class="cp-modal__cr">${c.credits} cr</span></h3>
    <p class="cp-modal__title">${esc(c.title || '')}</p>
    <div class="cp-modal__reqs">
      <div><h4>Prerequisites <span class="cp-mut">(earlier term)</span></h4><ul>${resolve(c.prereqs)}</ul></div>
      <div><h4>Corequisites <span class="cp-mut">(same term or earlier)</span></h4><ul>${resolve(c.coreqs)}</ul></div>
    </div>
  </div>`
  el.addEventListener('click', (e) => { if (e.target === el) el.remove() })
  root.querySelector('.cp')?.appendChild(el)
}

// ---- settings ---------------------------------------------------------------

export function renderCourseSettings(container, rerender) {
  const s = loadCourse()
  container.innerHTML = `<div class="page gym-settings">
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Max credits per semester</span>
        <span class="set-row__sub">The most credit hours the planner will pack into a fall or spring term.</span></div>
      <input class="pw-field wk-num" id="cp-max" type="number" min="1" max="30" value="${s.settings.maxCredits}">
    </div>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Max credits in summer</span>
        <span class="set-row__sub">Summers usually carry a lighter cap.</span></div>
      <input class="pw-field wk-num" id="cp-sumax" type="number" min="0" max="30" value="${s.settings.summerMax}">
    </div>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Route strategy</span>
        <span class="set-row__sub">How the planner trades off finishing fast against a lighter load.</span></div>
      <select class="pw-field" id="cp-strat">${STRATEGIES.map(([k, l]) => `<option value="${k}"${s.settings.strategy === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
    </div>
  </div>`
  container.oninput = (e) => {
    const t = e.target
    if (t.id === 'cp-max') setSetting(loadCourse(), 'maxCredits', t.value)
    else if (t.id === 'cp-sumax') setSetting(loadCourse(), 'summerMax', t.value)
  }
  container.onchange = (e) => { if (e.target.id === 'cp-strat') { setSetting(loadCourse(), 'strategy', e.target.value); rerender?.() } }
}
