// 離線語音辨識（Whisper），在背景執行，畫面不會卡住
import { pipeline, env } from './whisper/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true; // 模型下載一次後存在瀏覽器，之後離線也能用
env.backends.onnx.wasm.wasmPaths = new URL('./whisper/', self.location.href).href;

let asr = null;
let loadedModel = '';

async function load(model) {
  if (asr && loadedModel === model) { postMessage({ type: 'ready', model }); return; }
  asr = null;
  const files = {};
  asr = await pipeline('automatic-speech-recognition', model, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        files[p.file] = { loaded: p.loaded, total: p.total };
        let loaded = 0, total = 0;
        for (const f of Object.values(files)) { loaded += f.loaded; total += f.total; }
        postMessage({ type: 'progress', loaded, total });
      }
    },
  });
  loadedModel = model;
  postMessage({ type: 'ready', model });
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await load(msg.model);
    } else if (msg.type === 'transcribe') {
      if (!asr) throw new Error('模型還沒載入');
      const t0 = performance.now();
      const out = await asr(msg.audio, { language: msg.language, task: 'transcribe' });
      postMessage({ type: 'result', id: msg.id, text: (out && out.text) || '', ms: Math.round(performance.now() - t0) });
    }
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
  }
};
