/* ==========================================================================
   MERD Console — front end
   --------------------------------------------------------------------------
   This file renders what the backend computed. It does NOT decide field
   states, source policy, conflicts or category colours: all of that arrives in
   the payload from acquisition_report.py via the node. If you ever find
   yourself re-deriving MERD semantics in here, the answer belongs on the
   Python side — the whole point of the four-state report was to have one place
   that knows.
   ========================================================================== */
'use strict';

const API = '/ant_merd/api';
const $  = (s) => document.querySelector(s);

const state = {
  boot: null,
  view: null,          // current config payload
  category: null,      // selected category key
  edits: new Map(),    // path -> value   (typed, not yet confirmed)
  armed: new Map(),    // path -> value   (tick pressed, will be saved)
  filter: '',          // model/config search text
  problemOnly: false,  // SHOW PROBLEMATIC ONLY (user 2026-09-24, default off)
};

/* --- tiny helpers -------------------------------------------------------- */

function toast(msg, kind) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, kind === 'bad' ? 9000 : 4200);
}

async function api(path, opts) {
  const res = await fetch(API + path, Object.assign({
    headers: { 'Content-Type': 'application/json' },
  }, opts || {}));
  let body;
  try { body = await res.json(); }
  catch (e) { throw new Error(`${res.status} ${res.statusText} (non-JSON reply)`); }
  if (!res.ok || body.ok === false) {
    const err = new Error(body.error || `${res.status}`);
    err.body = body;   // callers may need more than the message (search_links)
    throw err;
  }
  return body;
}

/** Render a value the way the YAML holds it, never as "" for null. */
function show(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** Parse what the user typed back into a YAML-ish value.
 *  An empty box is NOT a value — it means "I have not decided", which is why
 *  an untouched box can never turn a category red. Clearing a value on purpose
 *  is what the null button is for. */
function parseInput(raw) {
  const t = (raw || '').trim();
  if (t === '') return undefined;
  if (t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
  if (t[0] === '[' || t[0] === '{') { try { return JSON.parse(t); } catch (e) { /* keep string */ } }
  return t;
}

function sameValue(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/** The verdict colour for a value the user just typed, against what the config
 *  already knows. Green when it agrees with something we hold, amber when it
 *  contradicts a source that is allowed to differ, red when it matches nothing
 *  at all. */
function verdictFor(row, value) {
  const known = [];
  ['telemetry', 'official', 'derived'].forEach((s) => {
    if (row.slots[s] !== null && row.slots[s] !== undefined) known.push(row.slots[s]);
  });
  (row.provenance || []).forEach((p) => known.push(p.value));
  if (!known.length) return 'agree';                 // nothing to contradict
  if (known.some((k) => sameValue(k, value))) return 'agree';
  if ((row.divergent_ok || []).length) return 'divergent';
  return 'conflict';
}

/* --- boot ---------------------------------------------------------------- */

async function boot() {
  restoreRailWidths();
  wireSplitters();
  wireProblemToggle();
  try {
    state.boot = await api('/bootstrap');
  } catch (e) {
    toast('Could not reach the MERD backend: ' + e.message, 'bad');
    return;
  }
  const help = state.boot.link_help || {};
  $('#help-hf').href = help.huggingface || '#';
  $('#help-diffusers').href = help.diffusers || '#';
  renderLoader();
  watchLoader();
  renderParked();
  renderConfigs();
  refreshMerdButton();
  $('#scan-note').textContent = state.boot.scan_ok
    ? `${state.boot.scanned.length} ComfyUI model families\n` +
      `${state.boot.configs.length} config(s) in the registry`
    : 'scan failed:\n' + (state.boot.scan_error || 'unknown');
}

/* --- rail widths: 1.5x by default, draggable, remembered ----------------- */

const RAIL_DEFAULTS = { '--rail-l': 354, '--rail-r': 390 };

function restoreRailWidths() {
  Object.keys(RAIL_DEFAULTS).forEach((v) => {
    let px = RAIL_DEFAULTS[v];
    try {
      const saved = parseInt(localStorage.getItem('merd' + v), 10);
      if (Number.isFinite(saved)) px = saved;
    } catch (e) { /* private mode: keep the default */ }
    setRail(v, px);
  });
}

function setRail(cssVar, px) {
  const root = document.documentElement;
  const min = 200, max = 620;
  const clamped = Math.max(min, Math.min(max, px));
  root.style.setProperty(cssVar, clamped + 'px');
  try { localStorage.setItem('merd' + cssVar, String(clamped)); } catch (e) { /* ignore */ }
}

function wireSplitters() {
  [['#split-left', '--rail-l', 1], ['#split-right', '--rail-r', -1]]
    .forEach(([sel, cssVar, sign]) => {
      const el = $(sel);
      if (!el) return;
      el.addEventListener('dblclick', () => setRail(cssVar, RAIL_DEFAULTS[cssVar]));
      el.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        el.setPointerCapture(ev.pointerId);
        el.classList.add('dragging');
        document.body.classList.add('resizing');
        const startX = ev.clientX;
        const startW = parseInt(
          getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10);
        const move = (e) => setRail(cssVar, startW + sign * (e.clientX - startX));
        const up = () => {
          el.classList.remove('dragging');
          document.body.classList.remove('resizing');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    });
}

/* --- the loader panel: ComfyUI's own loaders, mirrored ------------------- */
/*
   Every control below is built from `loader_widgets`, which the backend reads
   out of ComfyUI's UNETLoader / VAELoader / CLIPLoader / CheckpointLoaderSimple
   at request time. Nothing here knows what a weight dtype or an encoder type
   is, and nothing here may ever learn: the day this file contains a list of
   model families is the day it starts being wrong about them.

   The same settings drive the NODE's widgets. Both post to /api/loader and both
   read `rev`, so changing one moves the other and neither is the master.
*/

function loaderWidgets() { return state.boot.loader_widgets || []; }

function renderLoader() {
  const modeSel = $('#loader-mode');
  if (!modeSel) return;
  const loader = state.boot.loader || {};

  if (!modeSel.options.length) {
    (state.boot.loader_modes || []).forEach((m) => {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      modeSel.appendChild(o);
    });
    modeSel.onchange = () => { pushLoader({ loader_mode: modeSel.value }); };
  }
  if (loader.loader_mode) modeSel.value = loader.loader_mode;

  const host = $('#loader-widgets');
  if (!host.dataset.built) {
    host.innerHTML = '';
    loaderWidgets().forEach((w) => host.appendChild(loaderField(w)));
    host.dataset.built = '1';
  }
  loaderWidgets().forEach((w) => {
    const el = document.getElementById('lw-' + w.name);
    if (!el) return;
    const val = loader[w.name];
    if (val !== undefined && val !== null && el.value !== val) {
      // Only assign a value the control actually offers: a stale saved pick
      // for a file that has since been deleted must not silently become
      // whatever happens to sit first in the list.
      if (el.tagName !== 'SELECT' ||
          [...el.options].some((o) => o.value === val)) el.value = val;
    }
  });
  applyMode(modeSel.value);
}

function loaderField(w) {
  const wrap = document.createElement('label');
  wrap.className = 'loaderfield';
  wrap.id = 'lf-' + w.name;
  const lab = document.createElement('span');
  lab.className = 'lwlabel';
  lab.textContent = w.name.replace(/_/g, ' ');
  wrap.appendChild(lab);

  let el;
  if (w.kind === 'combo') {
    el = document.createElement('select');
    w.choices.forEach((c) => {
      const o = document.createElement('option');
      o.value = c; o.textContent = c;
      el.appendChild(o);
    });
    if (w.default !== null && w.default !== undefined) el.value = w.default;
  } else {
    // Their widget is not a choice list (a string or number field). Mirror it
    // as a plain input rather than pretending it has options.
    el = document.createElement('input');
    el.type = 'text';
    if (w.default !== null && w.default !== undefined) el.value = w.default;
  }
  el.id = 'lw-' + w.name;
  el.disabled = !w.available;
  el.title = (w.tooltip || '') +
    (w.available ? '' : '\nComfyUI\'s loader could not be read, so there is ' +
                        'nothing to offer. Nothing here is guessed.');
  el.onchange = () => { pushLoader({ [w.name]: el.value }); };
  wrap.appendChild(el);
  return wrap;
}

/** Grey what this mode does not use. The widgets stay VISIBLE and keep their
 *  values — switching mode must not lose the pick you made in the other one. */
function applyMode(mode) {
  const used = new Set();
  loaderWidgets().forEach((w) => {
    if ((w.modes || []).includes(mode)) used.add(w.name);
  });
  loaderWidgets().forEach((w) => {
    const field = document.getElementById('lf-' + w.name);
    const el = document.getElementById('lw-' + w.name);
    if (!field || !el) return;
    const on = used.has(w.name) && w.available;
    field.classList.toggle('off', !on);
    el.disabled = !on;
  });
  const note = $('#loader-panel');
  if (note) note.classList.toggle('passive', !used.size);
}

/** Read the panel back into a settings object — OUR widget names, their values. */
function collectLoader() {
  const out = { loader_mode: ($('#loader-mode') || {}).value };
  loaderWidgets().forEach((w) => {
    const el = document.getElementById('lw-' + w.name);
    if (el) out[w.name] = el.value;
  });
  return out;
}

/** Send a change to the backend, which is also what the node reads. */
async function pushLoader(change) {
  const next = Object.assign(collectLoader(), change || {});
  state.boot.loader = Object.assign({}, state.boot.loader, next);
  renderLoader();
  try {
    const r = await api('/loader', {
      method: 'POST',
      body: JSON.stringify({ loader: next, origin: 'console' }),
    });
    state.boot.loader = r.loader;
    loaderPoll.rev = r.loader.rev;
  } catch (e) {
    toast('Could not save the loader settings: ' + e.message, 'bad');
  }
}

/** Notice a change made on the NODE. Cheap (localhost, one small dict) and it
 *  is the only way this page can see a widget the user just turned in the
 *  graph editor — nothing pushes to a browser tab. */
const loaderPoll = { rev: -1, timer: null };

function watchLoader() {
  if (loaderPoll.timer) return;
  loaderPoll.timer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const r = await api('/loader');
      if (r.loader.rev === loaderPoll.rev) return;
      loaderPoll.rev = r.loader.rev;
      if (r.loader.origin === 'console') return;   // our own echo
      state.boot.loader = r.loader;
      state.boot.loader_widgets = r.widgets;
      renderLoader();
    } catch (e) { /* the server going away is not worth a toast every 3s */ }
  }, 3000);
}

function renderParked() {
  const note = $('#parked-note');
  const p = state.boot.parked || {};
  if (p.parked) {
    note.textContent = 'parked: ' + (p.class || 'a MODEL');
    note.title = 'The graph handed this node a MODEL at ' + p.at +
                 '. The probe will use it and load nothing.';
    note.style.color = 'var(--green)';
  } else {
    note.textContent = 'none parked';
    note.title = 'No MODEL has been handed to the node — which is fine. Pick a '
      + 'file here and MERD IT UP loads it directly, without running your '
      + 'graph. (Parking only happens if a graph containing the node is '
      + 'queued, and is purely a way to reuse a model already in VRAM.)';
    note.style.color = 'var(--ash)';
  }
}

function matchesFilter(text) {
  if (!state.filter) return true;
  return String(text).toLowerCase().includes(state.filter);
}

function renderConfigs() {
  const saved = $('#configs');
  const cand  = $('#candidates');
  saved.innerHTML = '';
  cand.innerHTML  = '';

  const configs = state.boot.configs || [];
  let nSaved = 0;
  configs.forEach((c) => {
    if (!matchesFilter(c.name)) return;
    nSaved++;
    const li = document.createElement('li');
    li.innerHTML = `<span class="name">${esc(c.name)}</span>` +
                   `<span class="meta">${Math.round(c.bytes / 1024)}k</span>`;
    li.dataset.name = c.name;
    li.title = c.name;
    li.onclick = () => openConfig(c.name);
    if (state.view && state.view.name === c.name) li.classList.add('on');
    saved.appendChild(li);
  });
  $('#count-saved').textContent =
    state.filter ? `${nSaved}/${configs.length}` : `${configs.length}`;

  // A ComfyUI supported_models family with no config is a candidate to CREATE.
  // One that already joined to a config is not shown here — it is in the list
  // above, and offering it twice invites a duplicate.
  const news = (state.boot.scanned || []).filter((m) => !m.has_config);
  let nNew = 0;
  news.forEach((m) => {
    if (!matchesFilter(m.name)) return;
    nNew++;
    const li = document.createElement('li');
    li.className = 'new';
    const fmt = (m.latent_format || '').replace('latent_formats.', '');
    li.innerHTML = `<span class="name">${esc(m.name)}</span>` +
                   `<span class="meta">${esc(fmt || 'new')}</span>`;
    li.title = `ComfyUI family "${m.name}"` +
               (m.base_class ? `, base ${m.base_class}` : '') +
               '\nNo MERD config yet — click to start one.';
    li.onclick = () => startNew(m.name);
    cand.appendChild(li);
  });
  $('#count-new').textContent =
    state.filter ? `${nNew}/${news.length}` : `${news.length}`;

  if (!nSaved) saved.innerHTML = emptyRow(configs.length ? 'no match' : 'none');
  if (!nNew) cand.innerHTML = emptyRow(news.length ? 'no match' : 'nothing unconfigured');
}

function emptyRow(text) {
  return `<li style="cursor:default"><span class="meta">${esc(text)}</span></li>`;
}

/* --- opening a config ---------------------------------------------------- */

async function openConfig(name) {
  try {
    setView(await api('/config/' + encodeURIComponent(name)), false);
  } catch (e) {
    toast('Could not open ' + name + ': ' + e.message, 'bad');
  }
}

function startNew(modelName) {
  // Nothing exists yet, so there is no payload to render. Set the header up and
  // let MERD IT UP create it — deliberately NOT a blank fake config, which
  // would look identical to a real one that failed to populate.
  state.view = { name: modelName, display_name: modelName, isNew: true,
                 categories: [], links: { huggingface: '', diffusers: '' } };
  state.edits.clear(); state.armed.clear();
  $('#config-name').textContent = modelName;
  $('#config-name').classList.remove('placeholder');
  $('#config-sub').textContent = 'no config yet — fill in the links and press MERD IT UP';
  $('#link-hf').value = '';
  $('#link-diffusers').value = '';
  $('#stats').innerHTML = '';
  $('#categories').innerHTML = '';
  $('#rows').innerHTML = '<p class="empty">No config exists for this model yet.</p>';
  $('#pane-head').innerHTML = '';
  $('#btn-save').disabled = true;
  renderConfigs();
  refreshMerdButton();
}

function setView(view, keepCategory) {
  state.view = view;
  state.edits.clear();
  state.armed.clear();

  $('#config-name').textContent = view.display_name || view.name;
  $('#config-name').classList.remove('placeholder');
  $('#config-sub').textContent =
    view.name + (view.staged ? '  ·  staged, not yet written to disk' : '');

  $('#link-hf').value = (view.links && view.links.huggingface) || '';
  $('#link-diffusers').value = (view.links && view.links.diffusers) || '';
  if (view.link_help) {
    $('#help-hf').href = view.link_help.huggingface || '#';
    $('#help-diffusers').href = view.link_help.diffusers || '#';
  }

  renderStats(view);
  renderValidation(view.validation);
  renderCategories(view, keepCategory);
  renderConfigs();
  refreshMerdButton();
  refreshSaveButton();

  const d = (view.derived || {}).training_sequence_length;
  $('#derived').textContent = d
    ? `train_seq_len ${d.total === null ? 'UNDERIVABLE' : d.total}\n` +
      `  image ${d.image_tokens}  text ${d.text_tokens}` +
      (d.missing && d.missing.length ? '\n  missing: ' + d.missing.join(', ') : '')
    : '';
}

function renderStats(view) {
  const c = view.counts || {};
  const cells = [
    ['populated', c.populated || 0, 'good'],
    ['gaps', (view.actionable || []).length, (view.actionable || []).length ? 'bad' : ''],
    ['expected empty', (view.opportunistic || []).length, ''],
    ['no policy', (view.backlog || []).length, (view.backlog || []).length ? 'warn' : ''],
    ['n/a', c.not_applicable || 0, ''],
  ];
  $('#stats').innerHTML = cells.map(([k, v, kind]) =>
    `<span class="stat ${kind}">${k} <b>${v}</b></span>`).join('');
}

/** Schema validation, from merd_checks.validate_doc().
 *
 *  It NEVER blocks a save. A half-repaired config is a normal thing to want to
 *  save, and refusing would trap someone mid-edit; showing exactly what is
 *  wrong is the honest version of the same information.
 *
 *  "unavailable" is its own state on purpose — "validation was skipped" and
 *  "validation passed" must never look the same next to a SAVE button. */
function renderValidation(v) {
  const el = $('#validation');
  if (!el) return;
  if (!v) { el.className = 'validation'; el.innerHTML = ''; return; }

  if (!v.available) {
    el.className = 'validation unk';
    el.innerHTML = `<span class="vhead" title="${esc(v.error || '')}">` +
                   `schema not checked</span>`;
    return;
  }
  const errs = v.errors || [];
  const warns = v.warnings || [];
  const kind = errs.length ? 'fail' : (warns.length ? 'warn' : 'pass');
  const label = errs.length
    ? `${errs.length} schema error${errs.length === 1 ? '' : 's'}`
    : (warns.length
        ? `${warns.length} schema warning${warns.length === 1 ? '' : 's'}`
        : 'schema valid');
  el.className = 'validation ' + kind;
  el.innerHTML = `<span class="vhead">${label}</span>` +
    (errs.length || warns.length
      ? '<ul>' + errs.map((m) => `<li class="e">${esc(m)}</li>`).join('')
              + warns.map((m) => `<li class="w">${esc(m)}</li>`).join('') + '</ul>'
      : '');
}

/* --- SHOW PROBLEMATIC ONLY ------------------------------------------------
   `row.problem` is computed by the node (same rule as the category colours);
   this only hides what is not a problem. Remembered per browser. */
function wireProblemToggle() {
  const box = $('#problem-only');
  if (!box) return;
  try { state.problemOnly = localStorage.getItem('merdProblemOnly') === '1'; }
  catch (e) { state.problemOnly = false; }
  box.checked = state.problemOnly;
  box.onchange = () => {
    state.problemOnly = box.checked;
    try { localStorage.setItem('merdProblemOnly', box.checked ? '1' : '0'); }
    catch (e) { /* ignore */ }
    if (state.view) renderCategories(state.view, true);
  };
}

function problemCount(cat) {
  if (cat.counts && typeof cat.counts.problems === 'number') return cat.counts.problems;
  return (cat.rows || []).filter((r) => r.problem).length;
}

function visibleCategories(view) {
  const cats = view.categories || [];
  return state.problemOnly ? cats.filter((c) => problemCount(c) > 0) : cats;
}

function renderCategories(view, keepCategory) {
  const ul = $('#categories');
  ul.innerHTML = '';
  const total = (view.categories || []).reduce((n, c) => n + problemCount(c), 0);
  const tally = $('#problem-tally');
  if (tally) tally.textContent = total ? String(total) : '0';
  const cats = visibleCategories(view);
  if (state.problemOnly && !cats.length) {
    ul.innerHTML = '<li class="none">no problems in this config</li>';
    $('#pane-head').innerHTML = '<h2>No problems</h2>';
    renderRows([]);
    return;
  }
  cats.forEach((cat) => {
    const li = document.createElement('li');
    li.dataset.key = cat.key;
    li.innerHTML =
      `<img class="caticon" src="/ant_merd/web/${cat.icon}" alt="" ` +
      `onerror="this.style.visibility='hidden'">` +
      `<span class="catname ${cat.status}">${cat.label}</span>` +
      (state.problemOnly
        ? `<span class="catcount bad">${problemCount(cat)}</span>`
        : `<span class="catcount">${cat.counts.populated}/${cat.counts.total}</span>`);
    li.title = `${cat.counts.actionable} gap(s), ${cat.counts.conflicts} conflict(s)`;
    li.onclick = () => selectCategory(cat.key);
    ul.appendChild(li);
  });
  const first = cats[0];
  const kept = keepCategory && cats.find((c) => c.key === state.category);
  const want = (kept && kept.key) ||
    (first ? ((cats.find((c) => c.status === 'red') ||
               cats.find((c) => c.status === 'amber') || first).key) : null);
  if (want) selectCategory(want);
}

function selectCategory(key) {
  state.category = key;
  document.querySelectorAll('#categories li').forEach(
    (li) => li.classList.toggle('on', li.dataset.key === key));
  const cat = (state.view.categories || []).find((c) => c.key === key);
  if (!cat) return;
  $('#pane-head').innerHTML =
    `<h2>${cat.label}</h2>` +
    `<span class="why">${cat.counts.populated} of ${cat.counts.total} populated` +
    (cat.counts.actionable ? ` · ${cat.counts.actionable} gap(s)` : '') +
    (cat.counts.conflicts ? ` · ${cat.counts.conflicts} conflict(s)` : '') +
    (state.problemOnly ? ` · showing ${problemCount(cat)} problematic` : '') + `</span>`;
  renderRows(state.problemOnly ? cat.rows.filter((r) => r.problem) : cat.rows);
}

/* --- field rows ---------------------------------------------------------- */

const SLOT_ORDER = ['override', 'telemetry', 'official', 'derived'];

function renderRows(rows) {
  const host = $('#rows');
  host.innerHTML = '';
  if (!rows.length) { host.innerHTML = '<p class="empty">No fields here.</p>'; return; }
  rows.forEach((row) => host.appendChild(renderRow(row)));
}

function renderRow(row) {
  const el = document.createElement('div');
  el.className = 'row' + (row.critical ? ' critical' : '');

  const tags = [];
  if (row.critical) tags.push('<span class="tag crit">execution critical</span>');
  if (row.state === 'populated') {
    tags.push(`<span class="tag">${row.source_used || 'set'}</span>`);
  } else if (row.state === 'not_applicable') {
    tags.push('<span class="tag opp">not applicable</span>');
  } else if (row.state === 'attempted_failed') {
    tags.push('<span class="tag conflict">fetch failed</span>');
  } else {
    tags.push(row.severity === 'required'
      ? '<span class="tag req">gap</span>'
      : '<span class="tag opp">expected empty</span>');
  }
  if (row.verdict === 'conflict')  tags.push('<span class="tag conflict">conflict</span>');
  if (row.verdict === 'divergent_by_design')
    tags.push('<span class="tag divergent">divergent by design</span>');
  if (row.verdict === 'agree')     tags.push('<span class="tag agree">sources agree</span>');

  el.innerHTML =
    `<div class="row-top">
       <span class="row-name"><span class="sec">${row.section}.</span>${row.label}</span>
       ${tags.join('')}
     </div>
     <div class="chain">` +
    SLOT_ORDER.map((s) => {
      const v = show(row.slots[s]);
      const wins = row.source_used === s && v !== null;
      return `<div class="slot${wins ? ' wins' : ''}">
                <span class="k">${s}</span>
                <span class="v${v === null ? ' null' : ''}">${v === null ? '—' : esc(v)}</span>
                <span class="k">${wins ? 'effective' : ''}</span>
              </div>`;
    }).join('') +
    `</div>`;

  // provenance readings, when there is more than the chain to show
  if ((row.provenance || []).length) {
    const p = document.createElement('div');
    p.className = 'note';
    p.textContent = 'sources: ' + row.provenance
      .map((r) => `${r.source} = ${JSON.stringify(r.value)}`).join('   ');
    el.appendChild(p);
  }

  // why it is empty / what disagrees
  if (row.verdict === 'conflict') {
    add(el, 'note bad', 'CONFLICT — ' + row.verdict_detail +
        '. Pick one below; your choice is written as an override.');
  } else if (row.verdict === 'divergent_by_design') {
    add(el, 'note warn', row.verdict_detail);
  } else if (row.state !== 'populated' && row.reason) {
    add(el, row.state === 'attempted_failed' ? 'note bad' : 'note', row.reason);
  }
  if (row.expected_source) {
    add(el, 'note', `expected source: ${row.expected_source}` +
        (row.corroborating.length ? ` (corroborated by ${row.corroborating.join(', ')})` : ''));
  }

  el.appendChild(editor(row));
  return el;
}

function add(parent, cls, text) {
  const d = document.createElement('div');
  d.className = cls; d.textContent = text;
  parent.appendChild(d);
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function editor(row) {
  const wrap = document.createElement('div');
  wrap.className = 'editrow';

  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = row.locked ? 'locked — press the padlock to edit'
                                 : 'type a value, or leave blank to decide later';
  const current = show(row.slots.override);
  if (current !== null) input.value = current;
  input.disabled = !!row.locked;

  const lock = document.createElement('button');
  lock.className = 'icon-btn lock' + (row.locked ? '' : ' open');
  lock.textContent = row.locked ? '\u{1F512}' : '\u{1F513}';
  lock.title = row.locked
    ? 'This value came from a source we trust. Press to edit anyway.'
    : 'Unlocked — press to lock again.';

  const nul = document.createElement('button');
  nul.className = 'icon-btn nullbtn';
  nul.textContent = 'null';
  nul.title = 'Clear the override. What was underneath it comes back.';

  const tick = document.createElement('button');
  tick.className = 'icon-btn tick';
  tick.textContent = '✓';
  tick.title = 'Confirm this value so SAVE THE MERD writes it.';

  lock.onclick = () => {
    row.locked = !row.locked;
    input.disabled = row.locked;
    lock.classList.toggle('open', !row.locked);
    lock.textContent = row.locked ? '\u{1F512}' : '\u{1F513}';
    if (!row.locked) input.focus();
  };

  nul.onclick = () => {
    if (row.locked) { toast('Unlock the field first.', ''); return; }
    input.value = 'null';
    onType();
  };

  tick.onclick = () => {
    const value = parseInput(input.value);
    if (value === undefined) return;
    if (state.armed.has(row.path)) {
      state.armed.delete(row.path);
      tick.classList.remove('armed');
    } else {
      state.armed.set(row.path, value);
      tick.classList.add('armed');
    }
    refreshSaveButton();
  };

  function onType() {
    const value = parseInput(input.value);
    // Untouched box: no edit, no tick, nothing turns red. An empty user input
    // is not a decision.
    if (value === undefined) {
      state.edits.delete(row.path);
      state.armed.delete(row.path);
      tick.className = 'icon-btn tick';
      refreshSaveButton();
      return;
    }
    if (sameValue(value, row.slots.override)) {
      state.edits.delete(row.path);
      state.armed.delete(row.path);
      tick.className = 'icon-btn tick';
      refreshSaveButton();
      return;
    }
    state.edits.set(row.path, value);
    if (state.armed.has(row.path) && !sameValue(state.armed.get(row.path), value)) {
      state.armed.delete(row.path);          // changed after arming: re-confirm
    }
    const v = value === null ? 'agree' : verdictFor(row, value);
    tick.className = 'icon-btn tick show v-' + v +
      (state.armed.has(row.path) ? ' armed' : '');
    tick.title = {
      agree:     'Matches what the other sources say. Confirm to save.',
      divergent: 'Differs from a source that is allowed to differ. Confirm to save.',
      conflict:  'Matches nothing else we hold. Confirm only if you are sure.',
    }[v];
    refreshSaveButton();
  }

  input.oninput = onType;
  wrap.append(input, lock, nul, tick);
  return wrap;
}

function refreshSaveButton() {
  const btn = $('#btn-save');
  const n = state.armed.size;
  const staged = !!(state.view && state.view.staged);
  btn.disabled = !state.view || (!n && !staged);
  btn.classList.toggle('armed', n > 0 || staged);
  btn.textContent = n ? `SAVE THE MERD (${n})` : 'SAVE THE MERD';
}

/* --- the two verbs ------------------------------------------------------- */

/** MERD IT UP is enabled whenever there is ANYTHING to build from: a selected
 *  config, a scanned family, or just a HuggingFace URL in the box. Requiring a
 *  selection first made the button dead for exactly the case it matters most —
 *  a model ComfyUI has no separate family for (LTX-2.5 lives inside LTX), which
 *  by definition cannot be selected anywhere. */
function refreshMerdButton() {
  const hf = $('#link-hf').value.trim();
  const btn = $('#btn-merd');
  btn.disabled = !hf && !state.view;
  btn.title = btn.disabled
    ? 'Paste a HuggingFace or ModelScope repo URL, or pick a config or scanned model.'
    : (state.view ? `Build/refresh ${state.view.name}` : 'Build a new config from this repo');
}

$('#link-hf').addEventListener('input', refreshMerdButton);

/** "Where else to look" — shown when neither HuggingFace nor ModelScope had
 *  the configs. MERD cannot read torrents or GitHub itself: the user finds the
 *  config files there and gives MERD a local folder laid out like the
 *  diffusers repo. */
function renderLookup(links) {
  const el = $('#lookup');
  if (!links || !links.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.innerHTML =
    '<span class="lookuphead">No configs on HuggingFace or ModelScope. Look for ' +
    'the model\'s repo folder here, download it (the weights can be left out — ' +
    'MERD reads only the config files) and paste the folder\'s path above. ' +
    '<b>Keep its structure exactly as downloaded</b>: model_index.json, ' +
    'transformer/, vae/, scheduler/, text_encoder/… — do not rename, flatten ' +
    'or move its subfolders.</span>' +
    links.map((l) => `<a class="lookupbtn" target="_blank" rel="noopener" ` +
      `href="${esc(l.url)}">${esc(l.label)}&nbsp;&#8599;</a>`).join('');
  el.hidden = false;
}

$('#btn-merd').onclick = async () => {
  const links = {
    huggingface: $('#link-hf').value.trim(),
    diffusers: $('#link-diffusers').value.trim(),
  };
  if (!links.huggingface) {
    toast('The model repo (HuggingFace or ModelScope URL, or a local folder) is the mandatory source — paste it first.', 'bad');
    $('#link-hf').focus();
    return;
  }
  const btn = $('#btn-merd');
  btn.disabled = true;
  btn.textContent = 'MERDING…';
  try {
    const view = await api('/merd_it_up', {
      method: 'POST',
      body: JSON.stringify({
        // All three may be absent. The backend derives the canonical name from
        // acquisition when nothing is selected.
        config: state.view ? state.view.name : null,
        is_new: state.view ? !!state.view.isNew : true,
        links: links,
        // The loader panel, verbatim. The backend adopts it as the shared
        // settings, so the node ends up pointing at the same thing.
        loader: collectLoader(),
      }),
    });
    setView(view, true);
    renderLookup(view.search_links);
    if (view.parked) { state.boot.parked = view.parked; renderParked(); }
    if (view.loader) { state.boot.loader = view.loader; renderLoader(); }
    const failed = (view.steps || []).filter((s) => !s.ok);
    toast(
      (view.steps || []).map((s) => `${s.ok ? '✓' : '✗'} ${s.step}: ${s.detail}`)
        .join('\n') + '\n\nNothing is written until you press SAVE THE MERD.',
      failed.length ? 'bad' : 'good');
    state.boot = await api('/bootstrap');
    renderLoader(); renderParked(); renderConfigs();
  } catch (e) {
    renderLookup(e.body && e.body.search_links);
    toast('MERD IT UP failed: ' + e.message, 'bad');
  } finally {
    btn.textContent = 'MERD IT UP';
    refreshMerdButton();
  }
};

$('#btn-save').onclick = async () => {
  if (!state.view) return;
  const edits = [...state.armed.entries()].map(([path, value]) => ({ path, value }));
  const btn = $('#btn-save');
  btn.disabled = true;
  try {
    const view = await api('/save', {
      method: 'POST',
      body: JSON.stringify({
        config: state.view.name,
        edits: edits,
        links: { huggingface: $('#link-hf').value.trim(),
                 diffusers: $('#link-diffusers').value.trim() },
      }),
    });
    setView(view, true);
    const v = view.validation || {};
    const vmsg = !v.available ? '\nschema NOT checked'
      : (v.errors && v.errors.length
          ? `\nschema: ${v.errors.length} error(s) — see the header`
          : (v.warnings && v.warnings.length
              ? `\nschema: ${v.warnings.length} warning(s)` : '\nschema valid'));
    const msg = `Wrote ${view.written}` +
      (view.applied.length ? `\n${view.applied.length} override(s) applied` : '') +
      (view.rejected.length ? `\nREJECTED (not a field): ${view.rejected.join(', ')}` : '') +
      vmsg;
    const bad = view.rejected.length || !v.available
                || (v.errors && v.errors.length);
    toast(msg, bad ? 'bad' : 'good');
    state.boot = await api('/bootstrap');
    renderConfigs();
  } catch (e) {
    toast('Save failed: ' + e.message, 'bad');
    btn.disabled = false;
  }
};

/* "test load" — prove the loader settings work before a whole build depends on
   them. Loads through ComfyUI, reports what happened, writes nothing. */
$('#btn-testload').onclick = async () => {
  const btn = $('#btn-testload');
  const mode = ($('#loader-mode') || {}).value;
  btn.disabled = true;
  btn.textContent = 'loading…';
  try {
    await pushLoader({});
    const lines = [];
    const wanted = mode === 'checkpoint' ? ['model'] : ['model', 'vae', 'clip'];
    for (const component of wanted) {
      const r = (await api('/probe', {
        method: 'POST',
        body: JSON.stringify({ component: component, loader: collectLoader() }),
      })).result || {};
      // The backend says so explicitly; never infer a skip from message text.
      if (r.skipped) continue;
      const n = Object.keys(r.telemetry || {}).length;
      lines.push(`${r.ok ? '✓' : '✗'} ${component}: ` +
                 (r.error || `${n} reading(s) — ` + (r.log || []).slice(-1)));
    }
    toast(lines.length
      ? lines.join('\n') + '\n\nNothing was written: this only proves the ' +
        'loader settings work.'
      : 'Nothing is selected to load.', lines.some((l) => l[0] === '✗')
      ? 'bad' : 'good');
    state.boot.parked = (await api('/bootstrap')).parked;
    renderParked();
  } catch (e) {
    toast('test load failed: ' + e.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = 'test load';
  }
};

$('#btn-scan').onclick = async () => {
  const btn = $('#btn-scan');
  btn.disabled = true; btn.textContent = 'scanning…';
  try {
    const r = await api('/scan', { method: 'POST' });
    state.boot.scanned = r.models;
    state.boot.scan_ok = r.ok;
    state.boot.scan_error = r.error;
    renderConfigs();
    $('#scan-note').textContent = r.ok
      ? `${r.models.length} ComfyUI model families`
      : 'scan failed:\n' + (r.error || 'unknown');
    toast(r.ok ? `Scan complete — ${r.models.length} model families.`
               : 'Scan failed: ' + r.error, r.ok ? 'good' : 'bad');
  } catch (e) {
    toast('Scan failed: ' + e.message, 'bad');
  } finally {
    btn.disabled = false; btn.textContent = 'rescan';
  }
};

// Links are remembered per config, so persist them the moment focus leaves the
// box: a build that fails must never cost the user the URL they went and found.
['#link-hf', '#link-diffusers'].forEach((sel) => {
  $(sel).onblur = async () => {
    if (!state.view || state.view.isNew) return;
    try {
      await api('/links', {
        method: 'POST',
        body: JSON.stringify({
          config: state.view.name,
          links: { huggingface: $('#link-hf').value.trim(),
                   diffusers: $('#link-diffusers').value.trim() },
        }),
      });
    } catch (e) { /* non-fatal: the save path writes them too */ }
  };
});

$('#search').addEventListener('input', (e) => {
  state.filter = e.target.value.trim().toLowerCase();
  renderConfigs();
});

boot();
