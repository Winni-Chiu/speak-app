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
    autoReplay: true, autoNext: true, voiceFeedback: true, autoSpeak: true,
    engine: 'auto', model: 'tiny' },
  store.get('settings', {})
);
// 新版預設改成「自動」（有網路用比較準的線上辨識）
if (settings.engineV !== 2) { settings.engine = 'auto'; settings.engineV = 2; store.set('settings', settings); }
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
  if (name === 'settings') { if (settings.engine === 'google') checkOffline(); else renderWhisperStatus(); renderLog(); }
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

let busy = false; // 離線辨識運算中
function setListening(on) {
  btnSpeak.classList.toggle('listening', on);
  btnSpeak.classList.remove('busy');
  btnSpeak.textContent = on ? '🔴 請說…' : '🎤 我來說';
}
function setBusy(on) {
  busy = on;
  btnSpeak.classList.toggle('busy', on);
  btnSpeak.disabled = on;
  btnSpeak.textContent = on ? '⏳ 聽聽看…' : '🎤 我來說';
}
function stopListening() { if (rec) { try { rec.abort(); } catch (e) {} rec = null; setListening(false); } }

/* ---------- 辨識紀錄（給家人查看辨識狀況） ---------- */
let recLog = store.get('recLog', []);
let lastAudio = null; // 最近一次離線辨識錄到的聲音，可以播放檢查
const ENGINE_NAME = { whisper: '離線', google: '線上' };
function logAttempt(engine, target, heard, r, ms) {
  recLog.unshift({
    t: Date.now(), engine, target, heard: heard.slice(0, 5),
    result: r ? (r.pass ? (r.perfect ? 'ok' : 'close') : 'bad') : 'none', ms: ms || 0,
  });
  recLog = recLog.slice(0, 30);
  store.set('recLog', recLog);
}
function renderLog() {
  const ul = $('#recLog'); if (!ul) return;
  ul.innerHTML = '';
  if (!recLog.length) { ul.innerHTML = '<li class="small">還沒有紀錄。</li>'; return; }
  const mark = { ok: '✔', close: '≈', bad: '✖', none: '－' };
  for (const x of recLog) {
    const li = document.createElement('li');
    const time = new Date(x.t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
    li.innerHTML = `<span class="log-mark log-${x.result}">${mark[x.result]}</span>
      <span class="log-main">要說「${escapeHtml(x.target)}」→ 聽到「${escapeHtml(x.heard[0] || '（沒有）')}」
      <span class="small">${time}・${ENGINE_NAME[x.engine] || x.engine}${x.ms ? `・${(x.ms / 1000).toFixed(1)} 秒` : ''}${x.heard.length > 1 ? `・其他：${escapeHtml(x.heard.slice(1).join('、'))}` : ''}</span></span>`;
    ul.appendChild(li);
  }
}
function playAudio(audio) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = ctx.createBuffer(1, audio.length, 16000);
    buf.copyToChannel(audio, 0);
    const s = ctx.createBufferSource(); s.buffer = buf; s.connect(ctx.destination);
    s.onended = () => ctx.close(); s.start();
  } catch (e) { toast('無法播放：' + e.message); }
}

// 用哪一種辨識：自動 = 有網路用線上（比較準），沒網路用離線
let googleFailed = false;
function pickEngine() {
  if (settings.engine === 'google') return 'google';
  if (settings.engine === 'auto' && SR && navigator.onLine && !googleFailed) return 'google';
  return 'whisper';
}

// 按「我來說」
function startListening() {
  if (busy) return;
  if (rec) { try { rec.stop(); } catch (e) {} return; }
  const w = current(); if (!w) return;
  if (pickEngine() === 'whisper') {
    if (whisper.state === 'ready') return startWhisper(w);
    if (whisper.state === 'loading') { toast('離線語音辨識準備中，請稍等一下'); return; }
    // 還沒下載離線模型：有網路就先用線上辨識
    if (!(SR && navigator.onLine)) { toast('請家人到「設定」下載離線語音辨識', 4000); return; }
  }
  startGoogle(w);
}

function startGoogle(w) {
  if (!SR) { toast('這個瀏覽器不能辨識語音，請用手機的 Chrome 打開', 4000); return; }
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
    // 自動模式下線上辨識失敗：之後改用離線
    if (settings.engine === 'auto' && (e.error === 'network' || e.error === 'service-not-allowed') && whisper.state === 'ready') {
      googleFailed = true; toast('網路不穩，改用離線辨識，請再說一次'); return;
    }
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
    if (alts && alts.length && current() === w) {
      const res = judge(alts, w);
      logAttempt('google', w.text, alts, res);
      showResult(res);
    } else if (!errored) { logAttempt('google', w.text, [], null); toast('沒聽清楚，再說一次看看'); }
  };
  try { r.start(); rec = r; setListening(true); }
  catch (e) { toast('無法開始錄音：' + e.message); }
}

/* ---------- 離線語音辨識 (Whisper) ---------- */
const WHISPER_MODELS = {
  tiny: 'onnx-community/whisper-tiny',
  base: 'onnx-community/whisper-base',
};
const whisper = { state: 'idle', worker: null, model: '', jobs: new Map(), nextId: 1, lastMs: 0 };

function whisperWorker() {
  if (whisper.worker) return whisper.worker;
  const wk = new Worker('worker.js', { type: 'module' });
  wk.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      const pct = Math.round((m.loaded / m.total) * 100);
      renderWhisperStatus(`下載中… ${pct}%（${(m.loaded / 1048576).toFixed(0)} / ${(m.total / 1048576).toFixed(0)} MB）`, pct);
    } else if (m.type === 'ready') {
      whisper.state = 'ready';
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      renderWhisperStatus();
    } else if (m.type === 'result' || (m.type === 'error' && m.id)) {
      const job = whisper.jobs.get(m.id); whisper.jobs.delete(m.id);
      if (job) m.type === 'result' ? job.resolve(m) : job.reject(new Error(m.message));
    } else if (m.type === 'error') {
      whisper.state = 'error';
      renderWhisperStatus('下載或載入失敗：' + m.message + '（請確認有網路再試一次）');
    }
  };
  wk.onerror = (e) => {
    whisper.state = 'error';
    renderWhisperStatus('離線辨識無法啟動：' + (e.message || '這台裝置可能不支援'));
  };
  whisper.worker = wk;
  return wk;
}

function loadWhisper() {
  const model = WHISPER_MODELS[settings.model];
  if (whisper.state === 'ready' && whisper.model === model) return;
  whisper.state = 'loading'; whisper.model = model;
  renderWhisperStatus('準備中…', 0);
  whisperWorker().postMessage({ type: 'load', model });
}

// 檢查模型是否已經下載過（存在瀏覽器裡）
async function whisperCached(modelKey) {
  try {
    const model = WHISPER_MODELS[modelKey];
    const keys = await (await caches.open('transformers-cache')).keys();
    const has = (part) => keys.some((r) => r.url.includes(model + '/') && r.url.includes(part));
    return has('encoder_model') && has('decoder_model_merged');
  } catch (e) { return false; }
}

function transcribe(audio) {
  const id = whisper.nextId++;
  const language = settings.lang.startsWith('en') ? 'english' : 'chinese';
  return new Promise((resolve, reject) => {
    whisper.jobs.set(id, { resolve, reject });
    whisperWorker().postMessage({ type: 'transcribe', id, audio, language }, [audio.buffer]);
  });
}

// 錄音：偵測到說話開始，說完停頓約 1 秒就自動停止
function recordUtterance() {
  return new Promise(async (resolve) => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) { resolve({ error: 'not-allowed' }); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ sampleRate: 16000 });
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    const chunks = [], pre = [];
    let speaking = false, lastVoice = 0, noise = 0, noiseN = 0, done = false;
    const t0 = performance.now();

    const finish = (keep, error) => {
      if (done) return; done = true;
      try { proc.disconnect(); src.disconnect(); } catch (e) {}
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
      rec = null; setListening(false);
      if (!keep || !chunks.length) { resolve({ error: error || 'aborted' }); return; }
      const len = chunks.reduce((s, c) => s + c.length, 0);
      const audio = new Float32Array(len);
      let off = 0; for (const c of chunks) { audio.set(c, off); off += c.length; }
      // 採樣率不是 16000 時重新取樣
      resolve({ audio: ctx.sampleRate === 16000 ? audio : resample(audio, ctx.sampleRate, 16000) });
    };

    proc.onaudioprocess = (e) => {
      if (done) return;
      const d = new Float32Array(e.inputBuffer.getChannelData(0));
      let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      const rms = Math.sqrt(s / d.length);
      const t = performance.now() - t0;
      if (t < 300) { noise += rms; noiseN++; pre.push(d); return; } // 先聽一下環境噪音
      const th = Math.min(0.06, Math.max(0.015, (noise / Math.max(1, noiseN)) * 2.5));
      if (!speaking) {
        pre.push(d); if (pre.length > 5) pre.shift();
        if (rms > th) { speaking = true; chunks.push(...pre); lastVoice = t; }
        else if (t > 7000) finish(false, 'no-speech');
      } else {
        chunks.push(d);
        if (rms > th) lastVoice = t;
        if (t - lastVoice > 1000 || t > 10000) finish(true);
      }
    };
    src.connect(proc); proc.connect(ctx.destination);
    // 再按一次「我來說」：有說話就直接判斷，沒說話就取消
    rec = { stop: () => finish(speaking), abort: () => finish(false) };
    setListening(true);
  });
}

function resample(data, from, to) {
  const ratio = from / to, out = new Float32Array(Math.floor(data.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = data[Math.floor(i * ratio)];
  return out;
}

// Whisper 沒聽到東西時常會冒出的字幕用語
const HALLUCINATION = /字幕|訂閱|订阅|點讚|点赞|amara|請不吝|请不吝|明鏡|明镜|中文字幕/i;

async function startWhisper(w) {
  cancelVoice();
  elResult.hidden = true; renderWord();
  const r = await recordUtterance();
  if (r.error) {
    if (r.error === 'no-speech') toast('沒有聽到聲音，再按一次「我來說」');
    else if (r.error === 'not-allowed') toast('請允許使用麥克風', 4000);
    return;
  }
  setBusy(true);
  lastAudio = r.audio.slice(); // 留一份，給設定頁播放檢查
  try {
    const res = await transcribe(r.audio);
    whisper.lastMs = res.ms;
    const text = res.text.trim();
    console.log('[whisper]', text, res.ms + 'ms');
    setBusy(false);
    if (current() !== w) return;
    if (!norm(text) || HALLUCINATION.test(text)) {
      logAttempt('whisper', w.text, [text], null, res.ms);
      toast('沒聽清楚，再說一次看看'); return;
    }
    const jr = judge([text], w);
    logAttempt('whisper', w.text, [text], jr, res.ms);
    showResult(jr);
  } catch (e) {
    setBusy(false);
    toast('辨識失敗：' + e.message, 4000);
  }
}

async function renderWhisperStatus(msg, pct) {
  const el = $('#whisperStatus'), prog = $('#whisperProg'), btn = $('#btnWhisperDl');
  if (!el) return;
  prog.hidden = pct === undefined;
  if (pct !== undefined) prog.value = pct;
  if (msg) { el.textContent = msg; btn.hidden = whisper.state === 'loading'; return; }
  const sameModel = whisper.model === WHISPER_MODELS[settings.model];
  if (whisper.state === 'ready' && sameModel) {
    el.textContent = '✔ 已可離線辨識，不用網路也能練習。' + (whisper.lastMs ? `（上次辨識花了 ${(whisper.lastMs / 1000).toFixed(1)} 秒）` : '');
    btn.hidden = true;
  } else if (whisper.state === 'loading' && sameModel) {
    btn.hidden = true;
  } else {
    const cached = await whisperCached(settings.model);
    el.textContent = cached ? '已下載，載入中…' : '還沒下載。';
    btn.hidden = cached;
    if (cached) loadWhisper();
  }
}
$('#btnWhisperDl').onclick = () => {
  if (!navigator.onLine) { toast('下載需要網路'); return; }
  loadWhisper();
};

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
  $$('#engineSeg button').forEach((b) => b.setAttribute('aria-checked', b.dataset.v === settings.engine));
  $$('#modelSeg button').forEach((b) => b.setAttribute('aria-checked', b.dataset.v === settings.model));
  $('#whisperBox').hidden = settings.engine === 'google';
  $('#googleBox').hidden = settings.engine !== 'google';
  document.documentElement.lang = settings.lang.startsWith('en') ? 'en' : 'zh-Hant';
}
$('#rate').oninput = (e) => { settings.rate = +e.target.value; saveSettings(); applySettings(); };
$('#btnTestVoice').onclick = () => speak('你好，我們一起來說說看');
$$('#strictSeg button').forEach((b) => b.onclick = () => { settings.strict = b.dataset.v; saveSettings(); applySettings(); });
$$('#sizeSeg button').forEach((b) => b.onclick = () => { settings.size = b.dataset.v; saveSettings(); applySettings(); });
$('#lang').onchange = (e) => { settings.lang = e.target.value; saveSettings(); applySettings(); checkOffline(); };
TOGGLES.forEach((k) => { $('#' + k).onchange = (e) => { settings[k] = e.target.checked; saveSettings(); }; });
$$('#engineSeg button').forEach((b) => b.onclick = () => {
  settings.engine = b.dataset.v; googleFailed = false; saveSettings(); applySettings();
  if (settings.engine === 'google') checkOffline(); else renderWhisperStatus();
});

/* 麥克風測試：錄一句話 → 播放給你聽 → 顯示離線辨識聽到什麼 */
$('#btnMicTest').onclick = async () => {
  const out = $('#micTestOut');
  if (rec) { try { rec.stop(); } catch (e) {} return; }
  out.textContent = '🔴 請說一句話，說完停一下…';
  const btn = $('#btnMicTest'); btn.textContent = '⏹ 錄音中（按這裡結束）';
  const r = await recordUtterance();
  btn.textContent = '🎙 測試麥克風';
  if (r.error) { out.textContent = r.error === 'no-speech' ? '沒有聽到聲音，麥克風可能沒收到音。' : r.error === 'not-allowed' ? '沒有麥克風權限。' : '已取消。'; return; }
  lastAudio = r.audio.slice();
  out.textContent = `錄到 ${(r.audio.length / 16000).toFixed(1)} 秒，正在播放…`;
  playAudio(r.audio);
  if (whisper.state !== 'ready') { out.textContent += '（離線辨識還沒下載，所以只播放聲音）'; return; }
  const res = await transcribe(r.audio.slice());
  out.textContent = `離線辨識聽到：「${res.text.trim() || '（沒有）'}」・花了 ${(res.ms / 1000).toFixed(1)} 秒`;
};
$('#btnPlayLast').onclick = () => { if (lastAudio) playAudio(lastAudio); else toast('還沒有錄音（線上辨識不會留下錄音）'); };
$('#btnClearLog').onclick = () => { recLog = []; store.set('recLog', recLog); renderLog(); };
$('#diagPanel').addEventListener('toggle', renderLog);
$$('#modelSeg button').forEach((b) => b.onclick = () => {
  settings.model = b.dataset.v; saveSettings(); applySettings(); renderWhisperStatus();
});

/* ---------- 啟動 ---------- */
applySettings(); renderHome(); checkOffline();
// 已下載過離線模型的話，開 App 時就先在背景載入
if (settings.engine !== 'google') whisperCached(settings.model).then((ok) => { if (ok) loadWhisper(); });
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // 重新整理一次，讓多核心運算生效
  if (!window.crossOriginIsolated) {
    // 新版背景程式接手時重新整理
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
    // 背景程式已準備好，但這一頁還沒被它接手：重新整理一次
    navigator.serviceWorker.ready.then(() => setTimeout(() => {
      if (navigator.serviceWorker.controller || window.crossOriginIsolated) return;
      try { if (sessionStorage.getItem('coiReloaded')) return; sessionStorage.setItem('coiReloaded', '1'); } catch (e) { return; }
      location.reload();
    }, 1500));
    // 目前的背景程式已經會加隔離標頭，只是這一頁還沒套用：重新整理一次
    if (navigator.serviceWorker.controller) {
      fetch('manifest.webmanifest', { cache: 'no-store' }).then((r) => {
        if (!r.headers.get('cross-origin-embedder-policy')) return;
        try { if (sessionStorage.getItem('coiReloaded')) return; sessionStorage.setItem('coiReloaded', '1'); } catch (e) { return; }
        location.reload();
      }).catch(() => {});
    }
  }
}
