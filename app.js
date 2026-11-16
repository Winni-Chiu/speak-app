'use strict';
/* 說說看 — 失語症說話練習 (離線 PWA)，給長者獨立使用 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ---------- 儲存 ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 無法儲存時仍可使用 */ } },
};

const DEFAULT_WORDS = [
  ['💧', '水'], ['🍚', '吃飯'], ['🥤', '喝水'], ['🙏', '謝謝'], ['👋', '你好'], ['🌅', '早安'],
  ['🚻', '廁所'], ['😣', '好痛'], ['👩', '媽媽'], ['👨', '爸爸'], ['👩‍⚕️', '醫生'], ['🛌', '睡覺'],
  ['📺', '看電視'], ['🍎', '蘋果'], ['🙆', '我要'], ['🙅', '不要'], ['😊', '我很好'], ['🏠', '回家'],
];
// status：'new' 還沒練、'good' 念對、'bad' 念錯（以最近一次為準）
const STATUS_OK = ['new', 'good', 'bad'];
const uid = () => Math.random().toString(36).slice(2, 10);
const makeWord = (text, emoji = '', accept = [], status = 'new') =>
  ({ id: uid(), text, emoji, accept, status: STATUS_OK.includes(status) ? status : 'new' });

let words = store.get('words', null);
if (!Array.isArray(words) || !words.length) words = DEFAULT_WORDS.map(([e, t]) => makeWord(t, e));
// 舊版資料轉換（舊版用次數與星星）
words.forEach((w) => {
  if (!STATUS_OK.includes(w.status)) w.status = w.ok > 0 ? 'good' : w.tries > 0 ? 'bad' : 'new';
  delete w.tries; delete w.ok;
  if (!w.id) w.id = uid();
});

const settings = Object.assign(
  { rate: 0.7, strict: 'normal', size: 'XL', lang: 'zh-TW', shuffle: false,
    autoReplay: true, autoNext: true, voiceFeedback: true, autoSpeak: true },
  store.get('settings', {})
);
const saveWords = () => store.set('words', words);
const saveSettings = () => store.set('settings', settings);
saveWords();

/* ---------- 提示訊息 ---------- */
let toastTimer;
function toast(msg, ms = 3000) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- 文字轉語音 (TTS) ---------- */
let voices = [];
function loadVoices() { try { voices = speechSynthesis.getVoices(); } catch (e) { voices = []; } }
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

function pickVoice() {
  const L = settings.lang.toLowerCase();
  const fix = (v) => v.lang.toLowerCase().replace('_', '-');
  let c = voices.filter((v) => fix(v) === L);
  if (!c.length) c = voices.filter((v) => fix(v).startsWith(L.slice(0, 2)));
  return c.find((v) => v.localService) || c[0] || null;
}

function speak(text, rate) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) { toast('這台裝置不支援發音'); return resolve(); }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = settings.lang;
    const v = pickVoice(); if (v) u.voice = v;
    u.rate = rate || settings.rate;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    u.onend = finish; u.onerror = finish;
    setTimeout(finish, 1500 + text.length * 900 / u.rate); // 部分瀏覽器不觸發 onend
    speechSynthesis.speak(u);
  });
}
const speakSlow = (text) => speak(Array.from(norm(text) || text).join('，'), Math.max(0.4, settings.rate - 0.2));

/* ---------- 音效 ---------- */
let actx;
function chime(good) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = good ? [660, 880, 1100] : [440, 370];
    notes.forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const t = actx.currentTime + i * 0.13;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.32);
    });
  } catch (e) { /* 無音效 */ }
}

/* ---------- 語音鼓勵 ---------- */
const PRAISE = ['說對了，很棒！', '太好了，說對了！', '好厲害，完全正確！', '說得很好！', '對了！你做到了！'];
const CLOSE = ['很接近了，很棒！', '差一點點就完美了！', '說得不錯喔！'];
const RETRY = ['沒關係，再試一次。', '慢慢來，我們再說一次。', '加油，再試一次就好。', '你可以的，再來一次。'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
let voiceToken = 0; // 換題時中止還沒說完的語音
const cancelVoice = () => { voiceToken++; if ('speechSynthesis' in window) speechSynthesis.cancel(); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// kind: 'ok' | 'close' | 'retry'
async function voiceFeedback(kind, word) {
  const my = ++voiceToken;
  await wait(450); // 先讓音效響完
  if (my !== voiceToken) return false;
  if (settings.voiceFeedback) {
    const phrase = kind === 'ok' ? pick(PRAISE) : kind === 'close' ? pick(CLOSE) : pick(RETRY);
    await speak(phrase, Math.min(1, settings.rate + 0.2));
    if (my !== voiceToken) return false;
  }
  if (kind !== 'ok' && settings.autoReplay) {
    if (settings.voiceFeedback && kind === 'retry') {
      await speak('聽我唸', Math.min(1, settings.rate + 0.2));
      if (my !== voiceToken) return false;
    }
    await wait(250);
    if (my !== voiceToken) return false;
    await speak(word);
  }
  return my === voiceToken;
}

/* ---------- 拼音比對 ---------- */
const DIGITS = '零一二三四五六七八九';
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/[0-9]/g, (d) => DIGITS[d])
    .replace(/[\s\p{P}\p{S}]/gu, '');
}
/* 同音字算對；只差聲調、或台灣常見的近似音 (zh/z、sh/s、ch/c、n/l、in/ing、en/eng) 算「接近」 */
const usePinyin = () => typeof pinyinPro !== 'undefined' && /^zh-(TW|CN)$/i.test(settings.lang);
const fuzzy = (b) => b.replace(/^([zcs])h/, '$1').replace(/^l/, 'n').replace(/ing$/, 'in').replace(/eng$/, 'en');

function toUnits(text) {
  const chars = Array.from(norm(text));
  let pys = chars;
  if (usePinyin()) {
    try {
      const arr = pinyinPro.pinyin(chars.join(''), { toneType: 'num', type: 'array', v: true });
      if (arr.length === chars.length) pys = arr.map((p) => String(p).toLowerCase());
    } catch (e) { /* 用字比對 */ }
  }
  return chars.map((ch, i) => {
    const py = pys[i] || ch;
    const base = py.replace(/[0-5]$/, '');
    return { ch, py, base, near: fuzzy(base) };
  });
}
// 3=對 2=只差聲調 1=近似音 0=不對
function unitLevel(a, b) {
  if (a.ch === b.ch || a.py === b.py) return 3;
  if (a.base === b.base) return 2;
  if (a.near === b.near) return 1;
  return 0;
}
const LEVEL_SCORE = { easy: [0, 1, 1, 1], normal: [0, 0.5, 1, 1], strict: [0, 0, 0.5, 1] };
const THRESHOLD = { easy: 0.5, normal: 0.67, strict: 1 };

function alignLevels(target, said, weights) {
  const n = target.length, m = said.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const lv = unitLevel(target[i - 1], said[j - 1]);
    const gain = lv ? dp[i - 1][j - 1] + weights[lv] * 10 + lv : -1;
    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1], gain);
  }
  const levels = new Array(n).fill(0);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const lv = unitLevel(target[i - 1], said[j - 1]);
    if (lv && dp[i][j] === dp[i - 1][j - 1] + weights[lv] * 10 + lv) { levels[i - 1] = lv; i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--; else j--;
  }
  return levels;
}

function judge(alts, w) {
  const weights = LEVEL_SCORE[settings.strict];
  const target = toUnits(w.text);
  const okForms = (w.accept || []).map(toUnits).filter((u) => u.length);
  let best = { score: -1, levels: target.map(() => 0), said: alts[0] || '' };
  for (const a of alts) {
    const said = toUnits(a);
    if (!said.length) continue;
    for (const f of okForms) {
      const lv = alignLevels(f, said, LEVEL_SCORE.strict);
      if (lv.every((x) => x === 3) && said.length <= f.length + 4) {
        return { pass: true, perfect: true, levels: target.map(() => 3), said: a };
      }
    }
    const levels = alignLevels(target, said, weights);
    const score = levels.reduce((s, lv) => s + weights[lv], 0) / Math.max(1, levels.length);
    const goods = levels.filter((x) => x === 3).length;
    if (score > best.score || (score === best.score && goods > best.levels.filter((x) => x === 3).length)) {
      best = { score, levels, said: a };
    }
  }
  const perfect = best.levels.length > 0 && best.levels.every((x) => x === 3);
  const pass = perfect || best.score >= THRESHOLD[settings.strict] - 1e-9;
  return { pass, perfect, levels: best.levels, said: best.said, score: best.score };
}

/* ---------- 畫面切換 ---------- */
function showScreen(name) {
  stopListening(); cancelVoice();
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === 'scr-' + name));
  if (name === 'home') renderHome();
  if (name === 'words') renderList();
  if (name === 'settings') checkOffline();
  window.scrollTo(0, 0);
}
$$('[data-home]').forEach((b) => b.onclick = () => showScreen('home'));

/* ---------- 首頁 ---------- */
const countOf = (st) => words.filter((w) => w.status === st).length;
function renderHome() {
  $('#cntAll').textContent = `${words.length} 個`;
  const bad = countOf('bad'), good = countOf('good');
  $('#cntBad').textContent = `${bad} 個`;
  $('#cntGood').textContent = `${good} 個`;
  $('#goBad').hidden = bad === 0;
  $('#goGood').hidden = good === 0;
  $('#goAll').disabled = words.length === 0;
}
$('#goAll').onclick = () => startSession('all');
$('#goBad').onclick = () => startSession('bad');
$('#goGood').onclick = () => startSession('good');
$('#goWords').onclick = () => showScreen('words');
$('#goSettings').onclick = () => showScreen('settings');

/* ---------- 練習 ---------- */
// 一輪練習：開始時固定好要練的詞，練的過程中分類改變也不會跳掉
const session = { mode: 'all', ids: [], pos: 0 };
const MODE_NAME = { all: '練習', bad: '練習念錯的', good: '複習念對的' };

function startSession(mode) {
  const list = words.filter((w) => mode === 'all' || w.status === mode);
  if (!list.length) { showScreen('home'); return; }
  session.mode = mode;
  session.ids = list.map((w) => w.id);
  if (settings.shuffle) {
    for (let i = session.ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [session.ids[i], session.ids[j]] = [session.ids[j], session.ids[i]]; }
  }
  session.pos = 0;
  showScreen('practice');
  showWord(true);
}
const current = () => words.find((w) => w.id === session.ids[session.pos]);

const elWord = $('#wordText'), elResult = $('#result');
let listenPresses = 0;
const levelClass = (lv) => (lv === 3 ? 'good' : lv > 0 ? 'close' : 'miss');

function renderWord(levels) {
  const w = current(); if (!w) return;
  elWord.innerHTML = '';
  Array.from(levels ? norm(w.text) : w.text).forEach((ch, i) => {
    const s = document.createElement('span');
    s.className = 'ch' + (levels ? ' ' + levelClass(levels[i]) : ''); s.textContent = ch;
    s.dataset.ch = ch; elWord.appendChild(s);
  });
  $('#progress').textContent = `${session.pos + 1} / ${session.ids.length}`;
  $('#btnPrev').disabled = session.pos === 0;
}

function showWord(fresh) {
  stopListening(); cancelVoice();
  elResult.hidden = true; elResult.innerHTML = '';
  listenPresses = 0;
  renderWord();
  if (fresh && settings.autoSpeak && current()) {
    const my = voiceToken;
    wait(300).then(() => { if (my === voiceToken) speak(current().text); });
  }
}

function goto(delta) {
  const next = session.pos + delta;
  if (next < 0) return;
  if (next >= session.ids.length) { finishSession(); return; }
  session.pos = next;
  showWord(true);
}

function finishSession() {
  const ids = new Set(session.ids);
  const inRound = words.filter((w) => ids.has(w.id));
  const good = inRound.filter((w) => w.status === 'good').length;
  const bad = inRound.filter((w) => w.status === 'bad').length;
  const allBad = countOf('bad');
  $('#doneText').innerHTML = bad
    ? `念對 <b class="t-good">${good}</b> 個，還要練習 <b class="t-bad">${bad}</b> 個`
    : `全部都念對了！`;
  $('#doneBad').hidden = allBad === 0;
  showScreen('done');
  const my = voiceToken;
  wait(400).then(() => { if (my === voiceToken) speak(bad ? '這一輪練完了，你很棒！' : '全部都念對了，太厲害了！', Math.min(1, settings.rate + 0.2)); });
}
$('#doneBad').onclick = () => startSession('bad');
$('#doneAgain').onclick = () => startSession(session.mode === 'bad' && countOf('bad') === 0 ? 'all' : session.mode);

function setStatus(w, st) { w.status = st; saveWords(); }

function showResult(r) {
  const w = current();
  elResult.hidden = false;
  if (r.pass) {
    setStatus(w, 'good');
    elResult.className = 'result ok';
    elResult.textContent = r.perfect ? '✔ 說對了！' : '👍 很接近，算對了！';
    renderWord(r.perfect ? null : r.levels);
    chime(true);
    const token = voiceToken + 1;
    voiceFeedback(r.perfect ? 'ok' : 'close', w.text).then((finished) => {
      if (finished && settings.autoNext && token === voiceToken) {
        wait(700).then(() => { if (token === voiceToken) goto(1); });
      }
    });
    return;
  }
  setStatus(w, 'bad');
  elResult.className = 'result warn';
  elResult.textContent = '再試一次 💪';
  renderWord(r.levels);
  chime(false);
  voiceFeedback('retry', w.text);
}

/* ---------- 語音辨識 ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
const btnSpeak = $('#btnSpeak');

function setListening(on) {
  btnSpeak.classList.toggle('listening', on);
  btnSpeak.textContent = on ? '🔴 請說…' : '🎤 我來說';
}
function stopListening() { if (rec) { try { rec.abort(); } catch (e) {} rec = null; setListening(false); } }

function startListening() {
  if (!SR) { toast('這個瀏覽器不能辨識語音，請用手機的 Chrome 打開', 4000); return; }
  if (rec) { try { rec.stop(); } catch (e) {} return; }
  const w = current(); if (!w) return;
  cancelVoice();
  elResult.hidden = true; renderWord();

  const r = new SR();
  r.lang = settings.lang;
  r.interimResults = false;
  r.maxAlternatives = 5;
  r.continuous = false;
  if (settings.offline && 'processLocally' in r) r.processLocally = true;

  let alts = null, errored = false;
  r.onresult = (e) => {
    const results = Array.from(e.results);
    const last = results[results.length - 1];
    if (last.isFinal) {
      const prefix = results.slice(0, -1).map((x) => x[0].transcript).join('');
      alts = Array.from(last).map((a) => prefix + a.transcript);
    }
  };
  r.onerror = (e) => {
    errored = true;
    const msg = {
      'no-speech': '沒有聽到聲音，再按一次「我來說」',
      'audio-capture': '找不到麥克風',
      'not-allowed': '請允許使用麥克風',
      'service-not-allowed': '請允許使用麥克風',
      network: '沒有網路，請家人到「設定」下載離線語音辨識',
      'language-not-supported': '請家人到「設定」下載離線語音辨識',
      aborted: '',
    }[e.error];
    if (msg !== '') toast(msg || '辨識失敗：' + e.error, 4000);
  };
  r.onend = () => {
    rec = null; setListening(false);
    if (alts && alts.length && current() === w) showResult(judge(alts, w));
    else if (!errored) toast('沒聽清楚，再說一次看看');
  };
  try { r.start(); rec = r; setListening(true); }
  catch (e) { toast('無法開始錄音：' + e.message); }
}

/* ---------- 練習按鈕 ---------- */
// 「聽」：第一次正常唸，再按一次會一個字一個字慢慢唸，輪流
$('#btnListen').onclick = () => {
  const w = current(); if (!w) return;
  cancelVoice();
  listenPresses++;
  if (listenPresses % 2 === 0 && Array.from(norm(w.text)).length > 1) speakSlow(w.text); else speak(w.text);
};
// 點整個詞唸整個詞；說錯後點某個字只唸那個字
elWord.onclick = (e) => {
  const w = current(); if (!w) return;
  cancelVoice();
  const span = e.target.closest('.ch.miss, .ch.close');
  if (span) speak(span.dataset.ch, Math.max(0.4, settings.rate - 0.1)); else speak(w.text);
};
btnSpeak.onclick = startListening;
$('#btnPrev').onclick = () => goto(-1);
$('#btnNext').onclick = () => goto(1);

/* ---------- 離線辨識 (Chrome 新版支援裝置端辨識) ---------- */
async function checkOffline() {
  const el = $('#offlineStatus'), btn = $('#btnInstallOffline');
  btn.hidden = true;
  if (!SR) { el.textContent = '這個瀏覽器不支援語音辨識。建議使用 Android 手機或平板上的 Chrome。'; return; }
  if (typeof SR.available !== 'function') {
    settings.offline = false; saveSettings();
    el.textContent = '這個瀏覽器的語音辨識需要網路。（Android 可在系統「設定 → Google → 語音 → 離線語音辨識」下載中文語音包）';
    return;
  }
  try {
    const st = await SR.available({ langs: [settings.lang], processLocally: true });
    if (st === 'available') { settings.offline = true; el.textContent = '✔ 已可離線辨識，不用網路也能練習。'; }
    else if (st === 'downloadable') { settings.offline = false; el.textContent = '可以下載離線語音辨識（需要網路下載一次）。'; btn.hidden = false; }
    else if (st === 'downloading') { settings.offline = false; el.textContent = '下載中…請稍候再回來看。'; }
    else { settings.offline = false; el.textContent = '這個語言目前不能離線辨識，練習時需要網路。'; }
  } catch (e) { settings.offline = false; el.textContent = '無法檢查離線辨識：' + e.message; }
  saveSettings();
}
$('#btnInstallOffline').onclick = async () => {
  try {
    $('#offlineStatus').textContent = '下載中…';
    const ok = await SR.install({ langs: [settings.lang], processLocally: true });
    toast(ok ? '下載完成！' : '下載失敗，請確認有網路');
  } catch (e) { toast('下載失敗：' + e.message); }
  checkOffline();
};

/* ---------- 詞庫 ---------- */
const STATUS_LABEL = { good: '✔ 念對', bad: '✖ 念錯', new: '還沒練' };
function renderList() {
  const ul = $('#wordList'); ul.innerHTML = '';
  words.forEach((w, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="w">${escapeHtml(w.text)}</span>
      <span class="badge st-${w.status}">${STATUS_LABEL[w.status]}</span>`;
    const play = document.createElement('button'); play.type = 'button'; play.textContent = '🔊'; play.title = '聽';
    play.onclick = () => speak(w.text);
    const ed = document.createElement('button'); ed.type = 'button'; ed.textContent = '✏️'; ed.title = '修改';
    ed.onclick = () => openEdit(i);
    li.append(play, ed); ul.appendChild(li);
  });
}

const openDlg = (d) => { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); };

/* 修改一個詞 */
let editing = -1;
const dlg = $('#editDlg');
function openEdit(i) {
  editing = i;
  $('#fText').value = words[i].text;
  openDlg(dlg);
  setTimeout(() => $('#fText').focus(), 50);
}
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save' || editing < 0) return;
  const text = $('#fText').value.trim();
  if (!text) return;
  const w = words[editing];
  if (w.text !== text) { w.text = text; w.status = 'new'; w.emoji = ''; w.accept = []; } // 換了詞就重新分類
  saveWords(); renderList(); toast('已儲存');
});
$('#fDelete').onclick = () => {
  if (editing < 0) return;
  if (!confirm(`確定要刪除「${words[editing].text}」嗎？`)) return;
  words.splice(editing, 1); saveWords(); dlg.close('deleted'); renderList(); toast('已刪除');
};

/* 一次新增很多個詞：很多格子 */
const addDlg = $('#addDlg'), addRows = $('#addRows');
function addRow(focus) {
  const n = addRows.children.length + 1;
  const row = document.createElement('div'); row.className = 'add-row';
  row.innerHTML = `<span class="add-no">${n}</span><input maxlength="30" autocomplete="off" aria-label="第 ${n} 個詞">`;
  const input = row.querySelector('input');
  // 按 Enter 跳到下一格，最後一格會自動多一格
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const next = row.nextElementSibling;
    if (next) next.querySelector('input').focus(); else addRow(true);
  });
  addRows.appendChild(row);
  if (focus) { input.focus(); row.scrollIntoView({ block: 'nearest' }); }
}
$('#btnAdd').onclick = () => {
  addRows.innerHTML = '';
  for (let i = 0; i < 5; i++) addRow(false);
  openDlg(addDlg);
  setTimeout(() => addRows.querySelector('input').focus(), 50);
};
$('#btnMoreRow').onclick = () => addRow(true);
addDlg.addEventListener('close', () => {
  if (addDlg.returnValue !== 'save') return;
  let added = 0, dup = 0;
  for (const inp of addRows.querySelectorAll('input')) {
    const text = inp.value.trim();
    if (!text) continue;
    if (words.some((w) => w.text === text)) { dup++; continue; }
    words.push(makeWord(text)); added++;
  }
  saveWords(); renderList();
  toast(`加入了 ${added} 個詞` + (dup ? `（${dup} 個已經有了）` : ''));
});

$('#btnExport').onclick = () => {
  const blob = new Blob([JSON.stringify({ app: 'speak-practice', version: 2, words }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `說說看詞庫-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
$('#fileImport').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const list = Array.isArray(data) ? data : data.words;
    if (!Array.isArray(list)) throw new Error('格式不對');
    let n = 0;
    for (const it of list) {
      const text = typeof it === 'string' ? it : it && it.text;
      if (!text || words.some((w) => w.text === text)) continue;
      const o = typeof it === 'object' ? it : {};
      words.push(makeWord(String(text), o.emoji || '', Array.isArray(o.accept) ? o.accept : [], o.status)); n++;
    }
    saveWords(); renderList(); toast(`匯入了 ${n} 個詞`);
  } catch (err) { toast('匯入失敗：' + err.message); }
  e.target.value = '';
};
$('#btnResetStatus').onclick = () => {
  if (!confirm('確定要把所有詞改回「還沒練」嗎？')) return;
  words.forEach((w) => { w.status = 'new'; }); saveWords(); renderList(); toast('已重設');
};

/* ---------- 設定 ---------- */
const TOGGLES = ['autoSpeak', 'voiceFeedback', 'autoReplay', 'autoNext', 'shuffle'];
function applySettings() {
  document.documentElement.dataset.size = settings.size;
  $('#rate').value = settings.rate;
  $('#rateVal').textContent = settings.rate <= 0.6 ? '很慢' : settings.rate <= 0.8 ? '慢' : settings.rate <= 1 ? '普通' : '快';
  $$('#strictSeg button').forEach((b) => b.setAttribute('aria-checked', b.dataset.v === settings.strict));
  $$('#sizeSeg button').forEach((b) => b.setAttribute('aria-checked', b.dataset.v === settings.size));
  $('#lang').value = settings.lang;
  TOGGLES.forEach((k) => { $('#' + k).checked = !!settings[k]; });
  document.documentElement.lang = settings.lang.startsWith('en') ? 'en' : 'zh-Hant';
}
$('#rate').oninput = (e) => { settings.rate = +e.target.value; saveSettings(); applySettings(); };
$('#btnTestVoice').onclick = () => speak('你好，我們一起來說說看');
$$('#strictSeg button').forEach((b) => b.onclick = () => { settings.strict = b.dataset.v; saveSettings(); applySettings(); });
$$('#sizeSeg button').forEach((b) => b.onclick = () => { settings.size = b.dataset.v; saveSettings(); applySettings(); });
$('#lang').onchange = (e) => { settings.lang = e.target.value; saveSettings(); applySettings(); checkOffline(); };
TOGGLES.forEach((k) => { $('#' + k).onchange = (e) => { settings[k] = e.target.checked; saveSettings(); }; });

/* ---------- 啟動 ---------- */
applySettings(); renderHome(); checkOffline();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
