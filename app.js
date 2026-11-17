'use strict';
/* =====================================================================
   NANNA - tracker sonno / pasti / cacche
   Dati: Firebase (login + Firestore). Se config.js non è compilato,
   parte in MODALITÀ PROVA con i dati solo sul telefono.
   ===================================================================== */
const VERSION = '1.1.0';
const NOTES = [ // dalla più recente
  { v: '1.1.0', t: [
    'Note del giorno (si salvano da sole), visibili anche nel recap settimanale.',
    'Suggerimento non vincolante per il prossimo pisolino o la buonanotte, calcolato sulle ultime giornate.',
    'In Oggi: da quanto tempo è sveglio.',
    'Documento per l\'assistente integrato nell\'app (Altro), per far modificare l\'app a un\'AI.'
  ] },
  { v: '1.0.0', t: ['Prima versione: pisolini, notte con risvegli e allattamento, contatori pasti e cacche, recap giornaliero e settimanale, modifica manuale.'] }
];
const FIREBASE_VERSION = '10.14.1';

/* ---------- utilità ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const MIN = 60e3, HOUR = 3600e3;
const ymd = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const dayStart = (s) => parseYmd(s).getTime();
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d.getTime()); };
const dayEnd = (s) => dayStart(addDays(s, 1));
const mondayOf = (s) => { const d = parseYmd(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d.getTime()); };
const fmtT = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDur = (ms) => { const m = Math.max(0, Math.round(ms / MIN)); const h = Math.floor(m / 60); return h ? `${h}h ${pad(m % 60)}m` : `${m}m`; };
const fmtClock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`; };
const toLocalInput = (ts) => `${ymd(ts)}T${fmtT(ts)}`;
const fromInput = (v) => (v ? new Date(v).getTime() : null);
const sum = (iv) => iv.reduce((a, i) => a + (i[1] - i[0]), 0);
const hoursStr = (ms) => (ms / HOUR).toFixed(1).replace('.', ',');
const WD = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
const dayLong = (s) => parseYmd(s).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
const dayShort = (s) => parseYmd(s).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
const todayStr = () => ymd(Date.now());
const buzz = () => { try { navigator.vibrate && navigator.vibrate(25); } catch (e) { /* noop */ } };

/* ---------- stato ---------- */
const S = {
  sleeps: [], events: [], notes: [], settings: { childName: '' },
  tab: 'today', day: todayStr(), weekStart: mondayOf(todayStr()),
  user: null, mode: 'demo', ready: false
};
let api = null;
let fb = null; // moduli firebase

/* =====================================================================
   LAYER DATI  (api.add / set / update / remove / saveSettings)
   ===================================================================== */
function makeDemoApi(onData) {
  const KEY = 'nanna_demo_v1';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const state = Object.assign({ sleeps: {}, events: {}, notes: {}, settings: {} }, load());
  const save = () => localStorage.setItem(KEY, JSON.stringify(state));
  const list = (o) => Object.entries(o).map(([id, v]) => ({ id, ...v }));
  const push = () => onData({ sleeps: list(state.sleeps), events: list(state.events), notes: list(state.notes), settings: state.settings });
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  setTimeout(push, 0);
  return {
    add(col, data) { const id = uid(); state[col][id] = data; save(); push(); return id; },
    set(col, id, data) { state[col][id] = { ...(state[col][id] || {}), ...data }; save(); push(); },
    update(col, id, patch) { if (state[col][id]) { state[col][id] = { ...state[col][id], ...patch }; save(); push(); } },
    remove(col, id) { delete state[col][id]; save(); push(); },
    saveSettings(obj) { state.settings = { ...state.settings, ...obj }; save(); push(); }
  };
}

async function initFirebase(config) {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const [appM, authM, fsM] = await Promise.all([
    import(`${base}/firebase-app.js`), import(`${base}/firebase-auth.js`), import(`${base}/firebase-firestore.js`)
  ]);
  fb = { authM, fsM };
  const app = appM.initializeApp(config);
  const auth = authM.getAuth(app);
  let db;
  try {
    db = fsM.initializeFirestore(app, { localCache: fsM.persistentLocalCache({ tabManager: fsM.persistentMultipleTabManager() }) });
  } catch (e) { db = fsM.getFirestore(app); }
  fb.auth = auth; fb.db = db;

  const onErr = (e) => {
    console.error(e);
    if (e && e.code === 'permission-denied') toast('Permesso negato: controlla le regole di Firestore e l\'email usata.');
    else toast('Errore di sincronizzazione');
  };
  api = {
    add(col, data) { const ref = fsM.doc(fsM.collection(db, col)); fsM.setDoc(ref, data).catch(onErr); return ref.id; },
    set(col, id, data) { fsM.setDoc(fsM.doc(db, col, id), data, { merge: true }).catch(onErr); },
    update(col, id, patch) { fsM.updateDoc(fsM.doc(db, col, id), patch).catch(onErr); },
    remove(col, id) { fsM.deleteDoc(fsM.doc(db, col, id)).catch(onErr); },
    saveSettings(obj) { fsM.setDoc(fsM.doc(db, 'settings', 'main'), obj, { merge: true }).catch(onErr); }
  };

  let unsubs = [];
  const stop = () => { unsubs.forEach((u) => u()); unsubs = []; };
  const start = () => {
    stop();
    const mapDocs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    unsubs.push(fsM.onSnapshot(fsM.collection(db, 'sleeps'), (s) => { S.sleeps = mapDocs(s); S.ready = true; render(); }, onErr));
    unsubs.push(fsM.onSnapshot(fsM.collection(db, 'events'), (s) => { S.events = mapDocs(s); render(); }, onErr));
    unsubs.push(fsM.onSnapshot(fsM.collection(db, 'notes'), (s) => { S.notes = mapDocs(s); render(); }, onErr));
    unsubs.push(fsM.onSnapshot(fsM.doc(db, 'settings', 'main'), (s) => { S.settings = s.exists() ? s.data() : { childName: '' }; render(); }, onErr));
  };
  authM.onAuthStateChanged(auth, (user) => {
    S.user = user;
    $('#boot').hidden = true;
    if (user) { $('#login').hidden = true; $('#app').hidden = false; start(); }
    else { stop(); S.sleeps = []; S.events = []; S.notes = []; S.ready = false; $('#app').hidden = true; showLogin(); }
  });
}

/* =====================================================================
   LOGICA SONNO
   ===================================================================== */
const activeSleep = () => S.sleeps.filter((s) => s.end == null).sort((a, b) => b.start - a.start)[0];
const nightWakesOf = (s) => (s.wakes || []).filter((w) => !(w.end == null && s.end != null)); // esclude il risveglio "finale" del mattino
const noteOf = (d) => { const n = S.notes.find((x) => x.id === d); return n ? (n.text || '') : ''; };

function sleepIntervals(s, now) {
  const endT = s.end ?? now;
  if (s.type !== 'night') return endT > s.start ? [[s.start, endT]] : [];
  const out = [];
  let cur = s.start;
  const ws = [...(s.wakes || [])].sort((a, b) => a.start - b.start);
  for (const w of ws) {
    if (cur != null) out.push([cur, Math.min(w.start, endT)]);
    cur = w.end ?? null;
    if (cur == null) break;
  }
  if (cur != null && cur < endT) out.push([cur, endT]);
  return out.filter((i) => i[1] > i[0]);
}

// La notte viene conteggiata nel giorno del risveglio (inizio + 12h cade nel giorno dopo se si parte la sera)
const nightDay = (s) => ymd(s.start + 12 * HOUR);

function dayStats(d) {
  const now = Date.now();
  const naps = S.sleeps.filter((s) => s.type === 'nap' && ymd(s.start) === d);
  const nights = S.sleeps.filter((s) => s.type === 'night' && nightDay(s) === d);
  const evs = S.events.filter((e) => ymd(e.ts) === d);
  let napMs = 0, longestNap = 0, nightMs = 0, longestStretch = 0, wakes = 0, wakeMs = 0, nightFed = 0;
  naps.forEach((s) => { const l = sum(sleepIntervals(s, now)); napMs += l; longestNap = Math.max(longestNap, l); });
  nights.forEach((s) => {
    const iv = sleepIntervals(s, now);
    nightMs += sum(iv);
    iv.forEach((i) => { longestStretch = Math.max(longestStretch, i[1] - i[0]); });
    const nw = nightWakesOf(s);
    wakes += nw.length;
    nw.forEach((w) => { if (w.end != null) wakeMs += w.end - w.start; });
    nightFed += (s.wakes || []).filter((w) => w.fed).length;
  });
  const bedtime = nights.length ? Math.min(...nights.map((s) => s.start)) : null;
  const ended = nights.filter((s) => s.end != null);
  const wakeup = ended.length ? Math.max(...ended.map((s) => s.end)) : null;
  const breast = evs.filter((e) => e.kind === 'breast').length;
  const meal = evs.filter((e) => e.kind === 'meal').length;
  const poop = evs.filter((e) => e.kind === 'poop').length;
  return {
    d, naps, nights, evs,
    napMs, napCount: naps.length, longestNap, nightMs, longestStretch, wakes, wakeMs, nightFed,
    bedtime, wakeup, breast, meal, poop,
    totalMs: napMs + nightMs, feedsTotal: breast + nightFed,
    has: naps.length + nights.length + evs.length > 0
  };
}

/* =====================================================================
   SUGGERIMENTO PROSSIMO PISOLINO (indicativo, non vincolante)
   Si basa sugli ultimi 7 giorni completi: mediana delle finestre di
   veglia prima di ogni pisolino, durata dei pisolini, buonanotte.
   ===================================================================== */
const median = (a) => { if (!a.length) return null; const t = [...a].sort((x, y) => x - y), m = t.length >> 1; return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2; };
const quant = (a, p) => { const t = [...a].sort((x, y) => x - y), i = (t.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return t[lo] + (t[hi] - t[lo]) * (i - lo); };
const spread = (a) => (a.length >= 4 ? [quant(a, 0.25), quant(a, 0.75)] : [Math.min(...a), Math.max(...a)]);
const lastWakeTs = () => { const e = S.sleeps.filter((s) => s.end != null).map((s) => s.end); const m = e.length ? Math.max(...e) : null; return m && Date.now() - m < 14 * HOUR ? m : null; };

function history() {
  const out = [];
  for (let i = 1; i <= 7; i++) {
    const d = addDays(todayStr(), -i);
    const naps = S.sleeps.filter((s) => s.type === 'nap' && s.end != null && ymd(s.start) === d).sort((a, b) => a.start - b.start);
    if (!naps.length) continue;
    const morning = S.sleeps.filter((s) => s.type === 'night' && s.end != null && nightDay(s) === d).map((s) => s.end).sort((a, b) => b - a)[0];
    const lastEnd = naps[naps.length - 1].end;
    const eve = S.sleeps.filter((s) => s.type === 'night' && ymd(s.start) === d && s.start > lastEnd).sort((a, b) => a.start - b.start)[0];
    out.push({
      naps: naps.length,
      dur: naps.map((n) => n.end - n.start),
      win: naps.map((n, k) => { const from = k === 0 ? morning : naps[k - 1].end; return from != null ? n.start - from : null; }),
      bed: eve ? eve.start - lastEnd : null,
      bedClock: eve ? eve.start - dayStart(d) : null
    });
  }
  return out;
}

function suggestion() {
  if (localStorage.getItem('nanna_sugg_off') === '1') return null;
  const valid = history().filter((x) => x.naps >= 2);
  if (valid.length < 3) return { title: 'Suggerimenti', soft: true, lines: [`Servono almeno 3 giorni completi con i pisolini per calcolare i suoi ritmi (finora ${valid.length}).`] };
  const foot = `Indicativo e non vincolante · basato sugli ultimi ${valid.length} giorni.`;
  const typicalNaps = Math.round(median(valid.map((x) => x.naps)));
  const pick = (key, i) => { const a = valid.map((x) => x[key][i]).filter((v) => v != null); return a.length >= 2 ? a : valid.flatMap((x) => x[key]).filter((v) => v != null); };
  const a = activeSleep();
  const todayNaps = S.sleeps.filter((s) => s.type === 'nap' && s.start >= dayStart(todayStr())).sort((x, y) => x.start - y.start);

  if (a && a.type === 'nap') {
    const k = Math.max(0, todayNaps.findIndex((s) => s.id === a.id));
    const d = pick('dur', k); if (!d.length) return null;
    const med = median(d), [lo, hi] = spread(d);
    return { title: `Pisolino n. ${k + 1} in corso`, foot, lines: [`Di solito dura circa ${fmtDur(med)}: sveglia verso le ${fmtT(a.start + med)} (tra le ${fmtT(a.start + lo)} e le ${fmtT(a.start + hi)}).`] };
  }
  if (a) return null; // di notte nessun suggerimento
  const last = lastWakeTs(); if (!last) return null;
  const k = todayNaps.length;
  if (k < typicalNaps) {
    const w = pick('win', k); if (!w.length) return null;
    const med = median(w), [lo, hi] = spread(w);
    return { title: `Prossimo pisolino (n. ${k + 1})`, foot, lines: [`Di solito dopo circa ${fmtDur(med)} di veglia: verso le ${fmtT(last + med)} (tra le ${fmtT(last + lo)} e le ${fmtT(last + hi)}).`] };
  }
  const b = valid.map((x) => x.bed).filter((v) => v != null), c = valid.map((x) => x.bedClock).filter((v) => v != null);
  const lines = [];
  if (b.length >= 2) { const [lo, hi] = spread(b); lines.push(`Buonanotte: di solito circa ${fmtDur(median(b))} dopo l'ultimo pisolino, quindi verso le ${fmtT(last + median(b))} (tra le ${fmtT(last + lo)} e le ${fmtT(last + hi)}).`); }
  if (c.length >= 2) lines.push(`Orario tipico di buonanotte: ${fmtT(dayStart(todayStr()) + median(c))}.`);
  if (!lines.length) lines.push('Pisolini tipici della giornata completati.');
  return { title: 'Verso la notte', foot, lines };
}

function suggestionHTML() {
  const s = suggestion(); if (!s) return '';
  return `<div class="card sugg ${s.soft ? 'soft' : ''}"><h2>💡 ${esc(s.title)}</h2>${s.lines.map((l) => `<p class="sl">${esc(l)}</p>`).join('')}${s.foot ? `<p class="muted small" style="margin-bottom:0">${esc(s.foot)}</p>` : ''}</div>`;
}

/* =====================================================================
   AZIONI
   ===================================================================== */
const who = () => (S.user && S.user.email) || 'demo';
let toastTimer = null;
function toast(msg, undo) {
  const el = $('#toast');
  el.innerHTML = `<div class="t"><span>${esc(msg)}</span>${undo ? '<button data-act="undo">ANNULLA</button>' : ''}</div>`;
  el.hidden = false;
  toast.undo = undo || null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; toast.undo = null; }, undo ? 7000 : 4000);
}

const A = {
  tab(el) { S.tab = el.dataset.v; render(); window.scrollTo(0, 0); },
  undo() { if (toast.undo) toast.undo(); $('#toast').hidden = true; toast.undo = null; },

  startNap() { const id = api.add('sleeps', { type: 'nap', start: Date.now(), end: null, by: who() }); buzz(); toast('Pisolino iniziato', () => api.remove('sleeps', id)); },
  endNap() { const a = activeSleep(); if (!a) return; api.update('sleeps', a.id, { end: Date.now() }); buzz(); toast('Pisolino terminato', () => api.update('sleeps', a.id, { end: null })); },

  startNight() { const id = api.add('sleeps', { type: 'night', start: Date.now(), end: null, wakes: [], by: who() }); buzz(); toast('Notte iniziata 🌙', () => api.remove('sleeps', id)); },
  wake() {
    const a = activeSleep(); if (!a) return;
    const prev = a.wakes || [];
    api.update('sleeps', a.id, { wakes: [...prev, { start: Date.now(), end: null, fed: false }] }); buzz();
    toast('Risveglio segnato', () => api.update('sleeps', a.id, { wakes: prev }));
  },
  resleep() {
    const a = activeSleep(); if (!a) return;
    const prev = a.wakes || [];
    api.update('sleeps', a.id, { wakes: prev.map((w) => (w.end == null ? { ...w, end: Date.now() } : w)) }); buzz();
    toast('Riaddormentato', () => api.update('sleeps', a.id, { wakes: prev }));
  },
  fed(el) {
    const a = activeSleep(); if (!a) return;
    const val = el.dataset.v === '1';
    api.update('sleeps', a.id, { wakes: (a.wakes || []).map((w) => (w.end == null ? { ...w, fed: val } : w)) }); buzz();
  },
  endNight() {
    const a = activeSleep(); if (!a) return;
    const open = (a.wakes || []).find((w) => w.end == null);
    api.update('sleeps', a.id, { end: open ? open.start : Date.now() }); buzz();
    toast('Notte terminata ☀️', () => api.update('sleeps', a.id, { end: null }));
  },

  add(el) {
    const kind = el.dataset.k;
    const id = api.add('events', { kind, ts: Date.now(), by: who() }); buzz();
    toast({ breast: 'Allattamento +1', meal: 'Pasto +1', poop: 'Cacca +1' }[kind], () => api.remove('events', id));
  },
  sub(el) {
    const kind = el.dataset.k, d = todayStr();
    const last = S.events.filter((e) => e.kind === kind && ymd(e.ts) === d).sort((a, b) => b.ts - a.ts)[0];
    if (!last) return;
    api.remove('events', last.id);
    toast('Rimosso l\'ultimo', () => api.add('events', { kind: last.kind, ts: last.ts, by: last.by || who() }));
  },

  dayPrev() { S.day = addDays(S.day, -1); render(); },
  dayNext() { S.day = addDays(S.day, 1); render(); },
  dayToday() { S.day = todayStr(); render(); },
  openDay(el) { S.day = el.dataset.d; S.tab = 'days'; render(); window.scrollTo(0, 0); },
  weekPrev() { S.weekStart = addDays(S.weekStart, -7); render(); },
  weekNext() { S.weekStart = addDays(S.weekStart, 7); render(); },
  weekToday() { S.weekStart = mondayOf(todayStr()); render(); },

  editSleep(el) { const s = S.sleeps.find((x) => x.id === el.dataset.id); if (s) openSleepModal(s); },
  editEvent(el) { const e = S.events.find((x) => x.id === el.dataset.id); if (e) openEventModal(e); },
  manual() { openChooser(); },
  saveName() { const v = $('#nameInput').value.trim(); api.saveSettings({ childName: v }); toast('Nome salvato'); },
  logout() { fb.authM.signOut(fb.auth); },
  async copyDoc() {
    const t = await loadDoc(); if (!t) return;
    try { await navigator.clipboard.writeText(t); toast('Documento copiato ✅'); } catch (e) { A.showDoc(); }
  },
  async showDoc() {
    const t = await loadDoc(); if (!t) return;
    openModal(`<h3>Documento per l'assistente</h3><textarea class="docbox" readonly>${esc(t)}</textarea>
      <div class="btns"><button class="btn" data-m="close">Chiudi</button><button class="btn primary" data-m="copy">📋 Copia</button></div>`, {
      copy() {
        const ta = $('.docbox'); ta.select(); ta.setSelectionRange(0, 999999);
        let ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* noop */ }
        toast(ok ? 'Copiato ✅' : 'Seleziona il testo e copialo a mano');
      }
    });
  },
  export() {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), settings: S.settings, sleeps: S.sleeps, events: S.events, notes: S.notes }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `nanna-backup-${todayStr()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
};

async function loadDoc() {
  try { const r = await fetch('assistente.md', { cache: 'no-store' }); if (!r.ok) throw new Error('x'); return await r.text(); }
  catch (e) { toast('Documento non disponibile (serve la connessione)'); return null; }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && A[el.dataset.act]) { e.preventDefault(); A[el.dataset.act](el); }
});

/* note del giorno: salvataggio automatico (dopo 1,2 s senza digitare, e all'uscita dal campo) */
let noteTimer = null;
function saveNote(el, quiet) {
  const d = el.dataset.d, text = el.value.trim();
  if (noteOf(d) === text) return;
  if (text) api.set('notes', d, { text, by: who(), updated: Date.now() }); else api.remove('notes', d);
  if (!quiet) toast('Nota salvata');
}
document.addEventListener('input', (e) => {
  const note = e.target.closest('textarea.note');
  if (!note) return;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => saveNote(note, true), 1200);
});
document.addEventListener('change', (e) => {
  const pick = e.target.closest('[data-change="pickDay"]');
  if (pick && pick.value) { S.day = pick.value; render(); return; }
  const note = e.target.closest('textarea.note');
  if (note) { clearTimeout(noteTimer); saveNote(note, false); return; }
  if (e.target.matches('[data-change="toggleSugg"]')) { localStorage.setItem('nanna_sugg_off', e.target.checked ? '0' : '1'); render(); }
});

/* =====================================================================
   RENDER
   ===================================================================== */
function setHTML(el, html) { if (el.__h !== html) { el.innerHTML = html; el.__h = html; } }

function render() {
  if (!api) return;
  const view = $('#view');
  if (!view) return;
  const focused = document.activeElement;
  if (focused && view.contains(focused) && (focused.tagName === 'TEXTAREA' || (focused.tagName === 'INPUT' && focused.type === 'text'))) return; // non disturbare chi sta scrivendo
  const y = window.scrollY;
  const active = activeSleep();
  document.body.classList.toggle('night', !!(active && active.type === 'night'));

  const name = (S.settings.childName || '').trim();
  setHTML($('#hdr'), `<div><h1>🌙 ${esc(name || 'Nanna')}</h1><div class="sub">${esc(dayLong(todayStr()))}</div></div>
    <span class="badge ${S.mode === 'firebase' ? 'ok' : ''}">${S.mode === 'firebase' ? 'sincronizzato' : 'modalità prova'}</span>`);

  setHTML($('#nav'), [['today', '🏠', 'Oggi'], ['days', '📅', 'Giorni'], ['week', '📊', 'Settimana'], ['more', '⚙️', 'Altro']]
    .map(([v, i, l]) => `<button data-act="tab" data-v="${v}" class="${S.tab === v ? 'on' : ''}"><span>${i}</span>${l}</button>`).join(''));

  let html = '';
  if (S.tab === 'today') html = todayHTML();
  else if (S.tab === 'days') html = daysHTML();
  else if (S.tab === 'week') html = weekHTML();
  else html = moreHTML();
  setHTML(view, html);
  window.scrollTo(0, y);
  tick();
}

function tick() {
  const now = Date.now();
  document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = fmtClock(now - Number(el.dataset.since)); });
}

/* ---------- Oggi ---------- */
function heroHTML() {
  const a = activeSleep();
  if (!a) {
    const lw = lastWakeTs();
    return `<div class="card hero"><div class="state">${lw ? `Sveglio da <b data-since="${lw}">0:00</b>` : 'Al momento è sveglio'}</div>
      <div class="stack" style="margin-top:12px">
        <button class="btn nap big" data-act="startNap">☀️ Inizia pisolino</button>
        <button class="btn primary big" data-act="startNight">🌙 Inizia notte (si addormenta)</button>
      </div></div>`;
  }
  if (a.type === 'nap') {
    return `<div class="card hero"><div class="state">☀️ Pisolino in corso dalle ${fmtT(a.start)}</div>
      <div class="timer" data-since="${a.start}">00:00</div>
      <div class="stack"><button class="btn nap big" data-act="endNap">⏰ Fine pisolino (si è svegliato)</button></div></div>`;
  }
  const ws = a.wakes || [];
  const open = ws.find((w) => w.end == null);
  const nW = ws.length;
  if (open) {
    return `<div class="card hero"><div class="state">🔔 Sveglio di notte dalle ${fmtT(open.start)}</div>
      <div class="timer" data-since="${open.start}">00:00</div>
      <div class="meta">Notte iniziata alle ${fmtT(a.start)} · risveglio n. ${nW}</div>
      <div class="muted small" style="margin-bottom:6px">Allattato in questo risveglio?</div>
      <div class="seg-toggle">
        <button class="${open.fed ? 'on' : ''}" data-act="fed" data-v="1">🤱 Sì</button>
        <button class="off ${!open.fed ? 'on' : ''}" data-act="fed" data-v="0">No</button>
      </div>
      <div class="stack">
        <button class="btn primary big" data-act="resleep">😴 Si è riaddormentato</button>
        <button class="btn" data-act="endNight">☀️ Fine notte (risveglio del mattino)</button>
      </div></div>`;
  }
  return `<div class="card hero"><div class="state">🌙 Dorme dalle ${fmtT(a.start)}</div>
    <div class="timer" data-since="${a.start}">00:00</div>
    <div class="meta">${nW ? `${nW} risvegli finora` : 'Nessun risveglio finora'}</div>
    <div class="stack">
      <button class="btn primary big" data-act="wake">🔔 Si è svegliato</button>
      <button class="btn" data-act="endNight">☀️ Fine notte (risveglio del mattino)</button>
    </div></div>`;
}

function countersHTML() {
  const st = dayStats(todayStr());
  const c = (k, ic, n, l) => `<div class="cwrap"><button class="counter" data-act="add" data-k="${k}"><div class="ic">${ic}</div><div class="n">${n}</div><div class="l">${l}</div></button>
    <button class="minus" data-act="sub" data-k="${k}" aria-label="Togli l'ultimo">−</button></div>`;
  return `<div class="card"><h2>Oggi, tocca per aggiungere</h2><div class="row3">
    ${c('breast', '🤱', st.breast, 'Allattamento')}${c('meal', '🥣', st.meal, 'Pasto')}${c('poop', '💩', st.poop, 'Cacca')}</div></div>`;
}

function todayHTML() {
  const name = (S.settings.childName || '').trim();
  const nameCard = name ? '' : `<div class="card"><h2>Benvenuto!</h2><label>Come si chiama il piccolo?<input type="text" id="nameInput" placeholder="Nome" maxlength="30"></label><button class="btn primary block" data-act="saveName">Salva</button></div>`;
  const banner = S.mode === 'demo' ? `<div class="card small muted">⚠️ Modalità prova: i dati restano solo su questo telefono. Compila <b>config.js</b> con i dati Firebase per condividerli con tua moglie.</div>` : '';
  return nameCard + banner + heroHTML() + suggestionHTML() + countersHTML() + recapHTML(todayStr(), true);
}

/* ---------- recap giornaliero ---------- */
function noteCardHTML(d) {
  return `<div class="card"><h2>📝 Note del giorno</h2>
    <textarea class="note" rows="3" data-d="${d}" placeholder="Es. primi dentini, vaccino, giornata agitata, nuovo alimento…">${esc(noteOf(d))}</textarea>
    <p class="muted small" style="margin-bottom:0">Si salva da sola.</p></div>`;
}

function barHTML(d) {
  const now = Date.now(), a = dayStart(d), b = dayEnd(d), span = b - a;
  let h = '';
  S.sleeps.forEach((s) => sleepIntervals(s, now).forEach(([x, y]) => {
    const lo = Math.max(x, a), hi = Math.min(y, b);
    if (hi > lo) h += `<div class="s ${s.type === 'night' ? 'night' : 'nap'}" style="left:${((lo - a) / span * 100).toFixed(2)}%;width:${((hi - lo) / span * 100).toFixed(2)}%"></div>`;
  }));
  S.events.forEach((e) => { if (e.ts >= a && e.ts < b) h += `<div class="m ${e.kind}" style="left:${((e.ts - a) / span * 100).toFixed(2)}%"></div>`; });
  return `<div class="bar">${h}</div><div class="ticks"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>`;
}

function recapHTML(d, withList) {
  const st = dayStats(d);
  if (!st.has) {
    return `<div class="card"><h2>Recap ${d === todayStr() ? 'di oggi' : esc(dayShort(d))}</h2><p class="muted">Ancora nessun dato per questo giorno.</p>${barHTML(d)}</div>${withList ? noteCardHTML(d) : ''}`;
  }
  const stat = (k, v, dsc = '') => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${dsc ? `<div class="d">${dsc}</div>` : ''}</div>`;
  return `<div class="card"><h2>Recap ${d === todayStr() ? 'di oggi' : esc(dayShort(d))}</h2>
    <div class="total"><span class="v">${fmtDur(st.totalMs)}</span><span class="muted">di sonno</span></div>
    <div class="legend"><span><i class="dot night"></i>Notte ${fmtDur(st.nightMs)}</span><span><i class="dot nap"></i>Pisolini ${fmtDur(st.napMs)} (${st.napCount})</span></div>
    ${barHTML(d)}
    <div class="legend"><span><i class="dot feed"></i>Allattamento</span><span><i class="dot meal"></i>Pasto</span><span><i class="dot poop"></i>Cacca</span></div>
    <div class="grid">
      ${stat('🔔 Risvegli di notte', st.wakes, st.wakeMs ? `svegli per ${fmtDur(st.wakeMs)}` : '')}
      ${stat('🤱 Allattato di notte', `${st.nightFed}`, 'volte nei risvegli')}
      ${stat('🌙 Tratto più lungo', st.longestStretch ? fmtDur(st.longestStretch) : '–')}
      ${stat('☀️ Pisolino più lungo', st.longestNap ? fmtDur(st.longestNap) : '–')}
      ${stat('🤱 Allattamenti giorno', st.breast, `totale con la notte: ${st.feedsTotal}`)}
      ${stat('🥣 Pasti', st.meal)}
      ${stat('💩 Cacche', st.poop)}
      ${stat('🛏️ Buonanotte / sveglia', `${st.bedtime ? fmtT(st.bedtime) : '–'} → ${st.wakeup ? fmtT(st.wakeup) : '–'}`, 'notte conteggiata nel giorno del risveglio')}
    </div></div>
    ${withList ? noteCardHTML(d) + timelineHTML(d, d === todayStr() ? 'desc' : 'asc') : ''}`;
}

function timelineHTML(d, order) {
  const now = Date.now();
  const items = [];
  const st = dayStats(d);
  st.naps.forEach((s) => items.push({ t: s.start, html: napRow(s, now) }));
  st.nights.forEach((s) => {
    items.push({ t: s.start, html: nightRow(s, d, now) });
    [...(s.wakes || [])].sort((a, b) => a.start - b.start).forEach((w) => items.push({ t: w.start, html: wakeRow(s, w) }));
  });
  st.evs.forEach((e) => items.push({ t: e.ts, html: eventRow(e) }));
  if (!items.length) return '';
  items.sort((a, b) => (order === 'desc' ? b.t - a.t : a.t - b.t));
  return `<div class="card"><h2>Cronologia · tocca per modificare</h2><ul class="tl">${items.map((i) => i.html).join('')}</ul></div>`;
}
const napRow = (s, now) => `<li data-act="editSleep" data-id="${s.id}"><span class="ic">☀️</span><div><div class="t">Pisolino</div>
  <div class="sub">${fmtT(s.start)} → ${s.end ? fmtT(s.end) : 'in corso'} · ${fmtDur((s.end ?? now) - s.start)}</div></div></li>`;
const nightRow = (s, d, now) => {
  const dur = sum(sleepIntervals(s, now));
  const startLbl = ymd(s.start) !== d ? `${esc(dayShort(ymd(s.start)))} ${fmtT(s.start)}` : fmtT(s.start);
  return `<li data-act="editSleep" data-id="${s.id}"><span class="ic">🌙</span><div><div class="t">Notte</div>
  <div class="sub">${startLbl} → ${s.end ? fmtT(s.end) : 'in corso'} · ${fmtDur(dur)} di sonno effettivo</div></div></li>`;
};
const wakeRow = (s, w) => `<li class="child" data-act="editSleep" data-id="${s.id}"><span class="ic">🔔</span><div><div class="t">Risveglio ${fmtT(w.start)}${w.end ? ' → ' + fmtT(w.end) : ''}</div>
  <div class="sub">${w.end ? 'sveglio per ' + fmtDur(w.end - w.start) : (s.end != null ? 'risveglio del mattino' : 'ancora sveglio')} · ${w.fed ? '🤱 allattato' : 'non allattato'}</div></div></li>`;
const eventRow = (e) => {
  const m = { breast: ['🤱', 'Allattamento'], meal: ['🥣', 'Pasto'], poop: ['💩', 'Cacca'] }[e.kind] || ['•', e.kind];
  return `<li data-act="editEvent" data-id="${e.id}"><span class="ic">${m[0]}</span><div><div class="t">${m[1]}</div><div class="sub">${fmtT(e.ts)}</div></div></li>`;
};

/* ---------- Giorni ---------- */
function daysHTML() {
  const d = S.day, isToday = d === todayStr();
  return `<div class="nav-row">
      <button class="iconbtn" data-act="dayPrev" aria-label="Giorno precedente">◀</button>
      <div class="mid">${isToday ? 'Oggi' : esc(dayLong(d))}<input type="date" value="${d}" data-change="pickDay"></div>
      <button class="iconbtn" data-act="dayNext" aria-label="Giorno successivo">▶</button>
    </div>
    ${isToday ? '' : '<button class="btn small block" data-act="dayToday">Torna a oggi</button>'}
    ${recapHTML(d, true)}
    <button class="btn block" data-act="manual">➕ Aggiungi a mano</button>`;
}

/* ---------- Settimana ---------- */
function weekAgg(start) {
  const days = Array.from({ length: 7 }, (_, i) => dayStats(addDays(start, i)));
  const today = todayStr();
  let valid = days.filter((x) => x.has && x.d < today);
  if (!valid.length) valid = days.filter((x) => x.has && x.d <= today);
  const avg = (f) => (valid.length ? valid.reduce((a, x) => a + f(x), 0) / valid.length : null);
  return {
    days, n: valid.length,
    total: avg((x) => x.totalMs), night: avg((x) => x.nightMs), nap: avg((x) => x.napMs), napCount: avg((x) => x.napCount),
    wakes: avg((x) => x.wakes), feeds: avg((x) => x.feedsTotal), meal: avg((x) => x.meal), poop: avg((x) => x.poop),
    longest: avg((x) => x.longestStretch)
  };
}

function delta(cur, prev, type) {
  if (cur == null || prev == null) return '';
  const diff = cur - prev;
  if (type === 'dur') {
    if (Math.abs(diff) < 5 * MIN) return '<span class="delta">= come sett. prec.</span>';
    return `<span class="delta">${diff > 0 ? '▲ +' : '▼ −'}${fmtDur(Math.abs(diff))} vs sett. prec.</span>`;
  }
  if (Math.abs(diff) < 0.05) return '<span class="delta">= come sett. prec.</span>';
  return `<span class="delta">${diff > 0 ? '▲ +' : '▼ −'}${Math.abs(diff).toFixed(1).replace('.', ',')} vs sett. prec.</span>`;
}

function miniChart(days, f, color, fmt) {
  const vals = days.map(f);
  const max = Math.max(...vals, 1);
  return `<div class="chart mini">${days.map((x, i) => `<div class="col" data-act="openDay" data-d="${x.d}"><div class="val">${vals[i] ? fmt(vals[i]) : ''}</div>
    <div class="stack single" style="--c:${color}"><div style="height:${(vals[i] / max * 100).toFixed(0)}%"></div></div><div class="lbl">${WD[parseYmd(x.d).getDay()]}</div></div>`).join('')}</div>`;
}

function weekHTML() {
  const w = weekAgg(S.weekStart), p = weekAgg(addDays(S.weekStart, -7));
  const isCur = S.weekStart === mondayOf(todayStr());
  const label = `${dayShort(S.weekStart)} – ${dayShort(addDays(S.weekStart, 6))}`;
  const scale = Math.max(...w.days.map((x) => x.totalMs), 12 * HOUR);
  const chart = `<div class="chart">${w.days.map((x) => `<div class="col" data-act="openDay" data-d="${x.d}">
    <div class="val">${x.totalMs ? hoursStr(x.totalMs) : ''}</div>
    <div class="stack"><div class="nap" style="height:${(x.napMs / scale * 100).toFixed(1)}%"></div><div class="night" style="height:${(x.nightMs / scale * 100).toFixed(1)}%"></div></div>
    <div class="lbl">${WD[parseYmd(x.d).getDay()]} ${parseYmd(x.d).getDate()}</div></div>`).join('')}</div>`;
  const stat = (k, v, dl) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${dl}</div>`;
  const num = (v) => (v == null ? '–' : v.toFixed(1).replace('.', ','));
  const dur = (v) => (v == null ? '–' : fmtDur(v));
  const hasPrev = p.n > 0;
  const noteItems = w.days.filter((x) => noteOf(x.d)).map((x) => `<li data-act="openDay" data-d="${x.d}"><span class="ic">📝</span><div><div class="t">${WD[parseYmd(x.d).getDay()]} ${parseYmd(x.d).getDate()}</div><div class="sub pre">${esc(noteOf(x.d))}</div></div></li>`).join('');
  const notesCard = noteItems ? `<div class="card"><h2>Note della settimana</h2><ul class="tl">${noteItems}</ul></div>` : '';
  const rows = w.days.map((x) => `<tr class="clk" data-act="openDay" data-d="${x.d}"><td>${WD[parseYmd(x.d).getDay()]} ${parseYmd(x.d).getDate()}</td>
    <td>${x.has ? fmtDur(x.totalMs) : '–'}</td><td>${x.has ? fmtDur(x.nightMs) : '–'}</td><td>${x.has ? x.napCount : '–'}</td>
    <td>${x.has ? x.wakes : '–'}</td><td>${x.has ? x.feedsTotal : '–'}</td><td>${x.has ? x.meal : '–'}</td><td>${x.has ? x.poop : '–'}</td></tr>`).join('');
  return `<div class="nav-row">
      <button class="iconbtn" data-act="weekPrev" aria-label="Settimana precedente">◀</button>
      <div class="mid">${isCur ? 'Questa settimana' : 'Settimana'}<div class="muted small" style="font-weight:400">${esc(label)}</div></div>
      <button class="iconbtn" data-act="weekNext" aria-label="Settimana successiva">▶</button>
    </div>
    ${isCur ? '' : '<button class="btn small block" data-act="weekToday">Torna a questa settimana</button>'}
    ${w.n === 0 ? `<div class="card"><p class="muted">Nessun dato in questa settimana.</p></div>${notesCard}` : `
    <div class="card"><h2>Medie giornaliere (${w.n} ${w.n === 1 ? 'giorno' : 'giorni'}${isCur ? ', oggi escluso' : ''})</h2>
      <div class="grid">
        ${stat('😴 Sonno totale', dur(w.total), hasPrev ? delta(w.total, p.total, 'dur') : '')}
        ${stat('🌙 Notte', dur(w.night), hasPrev ? delta(w.night, p.night, 'dur') : '')}
        ${stat('☀️ Pisolini (durata)', dur(w.nap), hasPrev ? delta(w.nap, p.nap, 'dur') : '')}
        ${stat('☀️ Pisolini (numero)', num(w.napCount), hasPrev ? delta(w.napCount, p.napCount, 'num') : '')}
        ${stat('🔔 Risvegli di notte', num(w.wakes), hasPrev ? delta(w.wakes, p.wakes, 'num') : '')}
        ${stat('🌙 Tratto più lungo', dur(w.longest), hasPrev ? delta(w.longest, p.longest, 'dur') : '')}
        ${stat('🤱 Allattamenti (giorno+notte)', num(w.feeds), hasPrev ? delta(w.feeds, p.feeds, 'num') : '')}
        ${stat('🥣 Pasti', num(w.meal), hasPrev ? delta(w.meal, p.meal, 'num') : '')}
        ${stat('💩 Cacche', num(w.poop), hasPrev ? delta(w.poop, p.poop, 'num') : '')}
      </div></div>
    ${notesCard}
    <div class="card"><h2>Ore di sonno per giorno</h2>${chart}
      <div class="legend"><span><i class="dot night"></i>Notte</span><span><i class="dot nap"></i>Pisolini</span></div></div>
    <div class="card"><h2>Risvegli di notte</h2>${miniChart(w.days, (x) => x.wakes, 'var(--night)', (v) => v)}</div>
    <div class="card"><h2>Allattamenti (giorno + notte)</h2>${miniChart(w.days, (x) => x.feedsTotal, 'var(--feed)', (v) => v)}</div>
    <div class="card"><h2>Cacche</h2>${miniChart(w.days, (x) => x.poop, 'var(--poop)', (v) => v)}</div>
    <div class="card"><h2>Tabella della settimana</h2>
      <table><thead><tr><th>Giorno</th><th>Totale</th><th>Notte</th><th>Pisol.</th><th>🔔</th><th>🤱</th><th>🥣</th><th>💩</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="muted small">🔔 risvegli notte · 🤱 allattamenti giorno+notte · 🥣 pasti · 💩 cacche. Tocca una riga per aprire il giorno.</p></div>`}`;
}

/* ---------- Altro ---------- */
function moreHTML() {
  return `<div class="card"><h2>Nome del piccolo</h2>
      <label><input type="text" id="nameInput" value="${esc(S.settings.childName || '')}" maxlength="30" placeholder="Nome"></label>
      <button class="btn primary block" data-act="saveName">Salva nome</button></div>
    <div class="card"><h2>Suggerimenti</h2>
      <label class="chk"><input type="checkbox" data-change="toggleSugg" ${localStorage.getItem('nanna_sugg_off') === '1' ? '' : 'checked'}> Mostra il suggerimento sul prossimo pisolino (solo su questo telefono)</label></div>
    <div class="card"><h2>Account</h2>
      <p>${S.mode === 'firebase' ? `Collegato come <b>${esc(who())}</b>` : 'Modalità prova (nessun account)'}</p>
      ${S.mode === 'firebase' ? '<button class="btn block" data-act="logout">Esci</button>' : ''}</div>
    <div class="card"><h2>Documento per l'assistente</h2><p class="muted small">Descrive come è fatta l'app. Dallo a un'AI insieme ai file quando vuoi farla modificare.</p>
      <div class="row2"><button class="btn" data-act="copyDoc">📋 Copia</button><button class="btn" data-act="showDoc">👁️ Leggi</button></div></div>
    <div class="card"><h2>Backup</h2><p class="muted small">Scarica una copia di tutti i dati in un file.</p>
      <button class="btn block" data-act="export">⬇️ Scarica backup (JSON)</button></div>
    <div class="card"><h2>Novità · versione ${VERSION}</h2>
      ${NOTES.map((n) => `<p><b>v${n.v}</b></p><ul>${n.t.map((t) => `<li class="small">${esc(t)}</li>`).join('')}</ul>`).join('')}</div>`;
}

/* =====================================================================
   MODALI
   ===================================================================== */
const modalEl = () => $('#modal');
let M = {};
function openModal(html, handlers) {
  M = handlers || {};
  modalEl().innerHTML = `<div class="sheet">${html}</div>`;
  modalEl().hidden = false;
}
function closeModal() { modalEl().hidden = true; modalEl().innerHTML = ''; M = {}; render(); }

document.addEventListener('click', (e) => {
  const m = e.target.closest('[data-m]');
  if (m) {
    const k = m.dataset.m;
    if (k === 'close') closeModal();
    else if (k === 'save') M.save && M.save();
    else if (k === 'del') M.del && M.del();
    else if (k === 'copy') M.copy && M.copy();
    else if (k === 'addwake') { $('#wakes').insertAdjacentHTML('beforeend', wakeEditRow({ start: Date.now(), end: null, fed: false })); }
    else if (k === 'rmwake') m.closest('.wrow').remove();
    else if (k === 'new') { const kind = m.dataset.k; modalEl().hidden = true; newItem(kind); }
    return;
  }
  if (e.target === modalEl()) closeModal();
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'f-type') $('#wakes-box').hidden = e.target.value !== 'night';
});

const wakeEditRow = (w) => `<div class="wrow">
  <div class="r2"><label>Sveglio da<input type="datetime-local" class="w-s" value="${w.start ? toLocalInput(w.start) : ''}"></label>
  <label>Riaddormentato<input type="datetime-local" class="w-e" value="${w.end ? toLocalInput(w.end) : ''}"></label></div>
  <div class="r2"><label class="chk"><input type="checkbox" class="w-f" ${w.fed ? 'checked' : ''}> 🤱 Allattato</label>
  <button type="button" class="btn small danger" data-m="rmwake">Rimuovi</button></div></div>`;

function openSleepModal(s, defaults) {
  const isNew = !s;
  const cur = s || defaults;
  openModal(`<h3>${isNew ? 'Aggiungi sonno' : 'Modifica sonno'}</h3>
    <label>Tipo<select id="f-type"><option value="nap" ${cur.type === 'nap' ? 'selected' : ''}>☀️ Pisolino</option><option value="night" ${cur.type === 'night' ? 'selected' : ''}>🌙 Notte</option></select></label>
    <div class="r2"><label>Inizio (si addormenta)<input type="datetime-local" id="f-start" value="${toLocalInput(cur.start)}"></label>
    <label>Fine (si sveglia)<input type="datetime-local" id="f-end" value="${cur.end ? toLocalInput(cur.end) : ''}"></label></div>
    <p class="muted small" style="margin-top:-4px">Lascia la fine vuota se sta ancora dormendo.</p>
    <div id="wakes-box" ${cur.type === 'night' ? '' : 'hidden'}><h3 style="font-size:15px">Risvegli notturni</h3>
      <div id="wakes">${(cur.wakes || []).slice().sort((a, b) => a.start - b.start).map(wakeEditRow).join('')}</div>
      <button type="button" class="btn small block" data-m="addwake">➕ Aggiungi risveglio</button></div>
    <div class="btns">${isNew ? '' : '<button class="btn danger" data-m="del">Elimina</button>'}<button class="btn" data-m="close">Annulla</button><button class="btn primary" data-m="save">Salva</button></div>`, {
    save() {
      const type = $('#f-type').value, start = fromInput($('#f-start').value), end = fromInput($('#f-end').value);
      if (!start) return alert('Inserisci l\'ora di inizio.');
      if (end && end <= start) return alert('La fine deve essere dopo l\'inizio.');
      let wakes = [];
      if (type === 'night') {
        for (const row of document.querySelectorAll('#wakes .wrow')) {
          const ws = fromInput($('.w-s', row).value), we = fromInput($('.w-e', row).value);
          if (!ws) return alert('Ogni risveglio deve avere l\'ora di inizio.');
          if (we && we <= ws) return alert('Un risveglio finisce prima di iniziare.');
          wakes.push({ start: ws, end: we, fed: $('.w-f', row).checked });
        }
        wakes.sort((a, b) => a.start - b.start);
      }
      const data = type === 'night' ? { type, start, end, wakes } : { type, start, end };
      if (isNew) api.add('sleeps', { ...data, by: who() });
      else api.update('sleeps', s.id, type === 'nap' ? { ...data, wakes: [] } : data);
      closeModal();
    },
    del() { if (confirm('Eliminare questo sonno?')) { api.remove('sleeps', s.id); closeModal(); } }
  });
}

function openEventModal(e, defaults) {
  const isNew = !e;
  const cur = e || defaults;
  openModal(`<h3>${isNew ? 'Aggiungi' : 'Modifica'}</h3>
    <label>Tipo<select id="f-kind"><option value="breast" ${cur.kind === 'breast' ? 'selected' : ''}>🤱 Allattamento</option><option value="meal" ${cur.kind === 'meal' ? 'selected' : ''}>🥣 Pasto</option><option value="poop" ${cur.kind === 'poop' ? 'selected' : ''}>💩 Cacca</option></select></label>
    <label>Ora<input type="datetime-local" id="f-ts" value="${toLocalInput(cur.ts)}"></label>
    <div class="btns">${isNew ? '' : '<button class="btn danger" data-m="del">Elimina</button>'}<button class="btn" data-m="close">Annulla</button><button class="btn primary" data-m="save">Salva</button></div>`, {
    save() {
      const kind = $('#f-kind').value, ts = fromInput($('#f-ts').value);
      if (!ts) return alert('Inserisci l\'ora.');
      if (isNew) api.add('events', { kind, ts, by: who() }); else api.update('events', e.id, { kind, ts });
      closeModal();
    },
    del() { if (confirm('Eliminare?')) { api.remove('events', e.id); closeModal(); } }
  });
}

function openChooser() {
  openModal(`<h3>Aggiungi a mano</h3><p class="muted small">Per il giorno ${esc(dayLong(S.day))}</p>
    <div class="stack" style="display:grid;gap:10px">
      <button class="btn big" style="min-height:56px;font-size:17px" data-m="new" data-k="nap">☀️ Pisolino</button>
      <button class="btn big" style="min-height:56px;font-size:17px" data-m="new" data-k="night">🌙 Notte</button>
      <button class="btn big" style="min-height:56px;font-size:17px" data-m="new" data-k="breast">🤱 Allattamento</button>
      <button class="btn big" style="min-height:56px;font-size:17px" data-m="new" data-k="meal">🥣 Pasto</button>
      <button class="btn big" style="min-height:56px;font-size:17px" data-m="new" data-k="poop">💩 Cacca</button>
    </div><div class="btns"><button class="btn" data-m="close">Annulla</button></div>`, {});
}

function newItem(kind) {
  const d = S.day;
  const baseTs = d === todayStr() ? Date.now() : dayStart(d) + 12 * HOUR;
  if (kind === 'nap') openSleepModal(null, { type: 'nap', start: baseTs - HOUR, end: baseTs, wakes: [] });
  else if (kind === 'night') openSleepModal(null, { type: 'night', start: dayStart(addDays(d, -1)) + 20 * HOUR, end: dayStart(d) + 7 * HOUR, wakes: [] });
  else openEventModal(null, { kind, ts: baseTs });
}

/* =====================================================================
   LOGIN
   ===================================================================== */
function showLogin() {
  const el = $('#login');
  el.hidden = false;
  el.innerHTML = `<form id="loginForm"><div class="moon">🌙</div><h1>Nanna</h1>
    <label>Email<input type="email" id="lg-email" autocomplete="username" required></label>
    <label>Password<input type="password" id="lg-pass" autocomplete="current-password" required></label>
    <div class="err" id="lg-err"></div>
    <button class="btn primary block" type="submit">Entra</button>
    <p class="muted small" style="text-align:center">Accesso riservato alla famiglia.</p></form>`;
  $('#loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('#lg-err').textContent = '';
    try {
      await fb.authM.signInWithEmailAndPassword(fb.auth, $('#lg-email').value.trim(), $('#lg-pass').value);
    } catch (e) {
      const m = { 'auth/invalid-credential': 'Email o password non corrette.', 'auth/wrong-password': 'Password non corretta.', 'auth/user-not-found': 'Utente non trovato.', 'auth/too-many-requests': 'Troppi tentativi, riprova tra poco.', 'auth/network-request-failed': 'Nessuna connessione.' };
      $('#lg-err').textContent = m[e.code] || `Errore: ${e.code || e.message}`;
    }
  });
}

/* =====================================================================
   AVVIO
   ===================================================================== */
async function boot() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  let config = null;
  try { config = (await import('./config.js')).firebaseConfig; } catch (e) { console.warn('config.js non trovato', e); }
  const configured = config && config.apiKey && !String(config.apiKey).startsWith('INCOLLA');
  if (configured) {
    S.mode = 'firebase';
    try { await initFirebase(config); }
    catch (e) {
      console.error(e);
      $('#boot').innerHTML = '<div class="moon">📡</div><p style="padding:0 30px;text-align:center">Non riesco a caricare Firebase.<br>Serve la connessione la prima volta. Riprova.</p>';
    }
  } else {
    S.mode = 'demo';
    api = makeDemoApi((data) => { S.sleeps = data.sleeps; S.events = data.events; S.notes = data.notes; S.settings = data.settings; S.ready = true; render(); });
    $('#boot').hidden = true;
    $('#app').hidden = false;
  }
  setInterval(tick, 1000);
  setInterval(() => { if (!modalEl().hidden) return; render(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && modalEl().hidden) render(); });
}
boot();
