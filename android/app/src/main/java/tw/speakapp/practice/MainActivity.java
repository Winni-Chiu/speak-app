package tw.speakapp.practice;

import android.Manifest;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognitionService;
import android.speech.RecognitionSupport;
import android.speech.RecognitionSupportCallback;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 說說看 Android 版：
 * 網頁版 App 包在 WebView 裡（檔案放在 assets/www，不用網路），
 * 語音辨識改用手機內建的 Google 語音辨識（沒網路時優先用離線語音包），
 * 發音改用手機內建的文字轉語音。
 */
public class MainActivity extends Activity {
    private static final String START_URL = "https://appassets.androidplatform.net/assets/www/index.html";
    private static final int REQ_MIC = 1, REQ_FILE = 2, REQ_SAVE = 3;

    private WebView web;

    // 語音辨識
    private SpeechRecognizer recognizer;
    private int session = 0;          // 每次開始聽都 +1，舊的回呼一律忽略
    private boolean usingOnDevice = false;
    private String currentLang = "zh-TW";
    private String pendingLang = null; // 等待麥克風權限
    private SpeechRecognizer helperRecognizer; // 檢查 / 下載離線語音包用

    // 文字轉語音
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private String[] pendingSpeak = null;

    // 檔案
    private ValueCallback<Uri[]> fileCallback;
    private String pendingSaveText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(0xFF2F6F5E);

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100); // App 自己有「字的大小」設定，避免系統放大字體把畫面撐破

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(i, REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "AndroidSpeech");

        tts = new TextToSpeech(this, status -> runOnUiThread(() -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (ttsReady) {
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { }
                    @Override public void onDone(String id) { ttsDone(id); }
                    @Override public void onError(String id) { ttsDone(id); }
                    @Override public void onStop(String id, boolean interrupted) { ttsDone(id); }
                });
            }
            if (pendingSpeak != null) {
                String[] p = pendingSpeak;
                pendingSpeak = null;
                doSpeak(p[0], p[1], Float.parseFloat(p[2]), p[3]);
            }
        }));

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
    }

    /* ================= JavaScript 介面 ================= */
    private class Bridge {
        @JavascriptInterface public void startListening(String lang) {
            runOnUiThread(() -> beginListening(lang));
        }
        @JavascriptInterface public void stopListening() {
            runOnUiThread(() -> { if (recognizer != null) recognizer.stopListening(); });
        }
        @JavascriptInterface public void abortListening() {
            runOnUiThread(() -> {
                // 網頁那邊已經自己結束了，這裡不再回報（避免影響下一次辨識）
                if (recognizer == null) return;
                session++;
                recognizer.cancel();
                destroyRecognizer();
            });
        }
        @JavascriptInterface public void speak(String text, String lang, float rate, String id) {
            runOnUiThread(() -> doSpeak(text, lang, rate, id));
        }
        @JavascriptInterface public void stopSpeaking() {
            runOnUiThread(() -> { pendingSpeak = null; if (ttsReady) tts.stop(); });
        }
        @JavascriptInterface public boolean isOnline() { return MainActivity.this.isOnline(); }
        @JavascriptInterface public int sdk() { return Build.VERSION.SDK_INT; }
        @JavascriptInterface public String diagInfo() { return MainActivity.this.diagInfo(); }
        @JavascriptInterface public void checkOffline(String lang) { runOnUiThread(() -> doCheckOffline(lang)); }
        @JavascriptInterface public void downloadOffline(String lang) { runOnUiThread(() -> doDownloadOffline(lang)); }
        @JavascriptInterface public void openVoiceSettings() { runOnUiThread(MainActivity.this::openVoiceSettings); }
        @JavascriptInterface public void saveFile(String name, String text) {
            runOnUiThread(() -> {
                pendingSaveText = text;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("application/json");
                i.putExtra(Intent.EXTRA_TITLE, name);
                try { startActivityForResult(i, REQ_SAVE); }
                catch (Exception e) { Toast.makeText(MainActivity.this, "無法儲存檔案", Toast.LENGTH_LONG).show(); }
            });
        }
    }

    /* ================= 語音辨識 ================= */
    // 依序嘗試的辨識引擎："default"、"ondevice"，或某個辨識服務的元件名稱
    private final List<String> attempts = new ArrayList<>();
    private int attemptIdx = 0;
    private long attemptStart = 0;
    private boolean began = false;
    private final StringBuilder trace = new StringBuilder();

    private void beginListening(String lang) {
        currentLang = lang;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            pendingLang = lang;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
            return;
        }
        final boolean online = isOnline();
        // 引擎順序：沒網路時 Google 語音服務（離線語音包所在）優先，其次是手機預設
        List<String> engines = new ArrayList<>();
        List<ComponentName> services = recognitionServices();
        if (!online) for (ComponentName c : services)
            if (c.getPackageName().equals("com.google.android.tts")) engines.add(c.flattenToString());
        engines.add("default");
        for (ComponentName c : services) if (!engines.contains(c.flattenToString())) engines.add(c.flattenToString());
        if (Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) engines.add("ondevice");

        // 每個引擎都試幾種語言代碼；離線語音包用 cmn-Hant-TW，所以沒網路時它排第一
        List<String> langs = langVariants(lang);
        if (!online && langs.size() > 1) langs.add(0, langs.remove(1));
        attempts.clear();
        for (String e : engines) for (String l : langs) attempts.add(e + "\n" + l);

        // 上次成功的方式排最前面
        String last = getSharedPreferences("speech", MODE_PRIVATE).getString(lastOkKey(lang, online), null);
        if (last != null && attempts.remove(last)) attempts.add(0, last);

        attemptIdx = 0;
        trace.setLength(0);
        trace.append(online ? "有網路" : "沒網路");
        runAttempt();
    }

    /** 手機上所有語音辨識服務，Google 的排前面 */
    private List<ComponentName> recognitionServices() {
        List<ComponentName> out = new ArrayList<>();
        try {
            List<ResolveInfo> list = getPackageManager().queryIntentServices(new Intent(RecognitionService.SERVICE_INTERFACE), 0);
            for (ResolveInfo ri : list) {
                if (ri.serviceInfo == null) continue;
                ComponentName c = new ComponentName(ri.serviceInfo.packageName, ri.serviceInfo.name);
                String pkg = ri.serviceInfo.packageName;
                // 只用 Google 和三星的辨識服務（其他 App 提供的服務不一定能用）
                if (pkg.startsWith("com.google")) out.add(0, c);
                else if (pkg.startsWith("com.samsung") || pkg.startsWith("com.sec")) out.add(c);
            }
        } catch (Exception ignored) { }
        return out;
    }

    private static String lastOkKey(String lang, boolean online) {
        return "ok_" + lang + (online ? "_online" : "_offline");
    }

    /** 同一個語言的不同寫法；Google 離線語音包「國語（台灣）」的代碼是 cmn-Hant-TW */
    private static List<String> langVariants(String lang) {
        List<String> out = new ArrayList<>();
        out.add(lang);
        switch (lang) {
            case "zh-TW": out.add("cmn-Hant-TW"); out.add("zh-Hant-TW"); break;
            case "zh-CN": out.add("cmn-Hans-CN"); out.add("zh-Hans-CN"); break;
            case "zh-HK": out.add("yue-Hant-HK"); break;
        }
        return out;
    }

    private static String label(String a) {
        if (a.equals("default")) return "預設";
        if (a.equals("ondevice")) return "裝置端";
        if (a.contains("googlequicksearchbox")) return "Google App";
        if (a.contains("com.google.android.tts")) return "Google 語音服務";
        if (a.contains("com.google.android.as")) return "Google 系統智慧";
        if (a.contains("samsung")) return "三星";
        int slash = a.indexOf('/');
        return slash > 0 ? a.substring(0, slash) : a;
    }

    private void runAttempt() {
        destroyRecognizer();
        final int my = ++session;
        final String[] pair = attempts.get(attemptIdx).split("\n");
        final String a = pair[0];
        final String lng = pair[1];
        final String tag = label(a) + (lng.equals(currentLang) ? "" : "[" + lng + "]");
        final boolean online = isOnline();
        try {
            if (a.equals("ondevice")) {
                recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(this);
            } else if (a.equals("default")) {
                if (!SpeechRecognizer.isRecognitionAvailable(this)) throw new IllegalStateException("not-available");
                recognizer = SpeechRecognizer.createSpeechRecognizer(this);
            } else {
                recognizer = SpeechRecognizer.createSpeechRecognizer(this, ComponentName.unflattenFromString(a));
            }
        } catch (Exception e) {
            trace.append(" → ").append(tag).append(":無法啟動");
            nextAttemptOrFail("not-available");
            return;
        }
        usingOnDevice = a.equals("ondevice");
        began = false;
        attemptStart = System.currentTimeMillis();

        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onResults(Bundle b) {
                if (my != session) return;
                ArrayList<String> list = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                trace.append(" → ").append(tag).append(":成功");
                getSharedPreferences("speech", MODE_PRIVATE).edit()
                        .putString(lastOkKey(currentLang, online), attempts.get(attemptIdx)).apply();
                JSONObject o = new JSONObject();
                try {
                    o.put("type", "result");
                    o.put("alts", new JSONArray(list == null ? new ArrayList<String>() : list));
                    o.put("trace", trace.toString());
                } catch (Exception ignored) { }
                session++;
                destroyRecognizer();
                emitSR(o.toString());
                emitSR("{\"type\":\"end\"}");
            }

            @Override public void onError(int err) {
                if (my != session) return;
                String code = errorCode(err);
                trace.append(" → ").append(tag).append(":").append(code).append("(").append(err).append(")");
                long elapsed = System.currentTimeMillis() - attemptStart;
                // 這個引擎不能用（通常是沒網路又沒離線語音包）：換下一個引擎再試
                boolean engineFailed = !code.equals("not-allowed") && !began
                        && (!online || code.equals("language-not-supported") || code.startsWith("error-"))
                        && !(code.equals("no-speech") && elapsed > 3000);
                if (engineFailed) { nextAttemptOrFail(code); return; }
                session++;
                destroyRecognizer();
                emitError(code);
            }

            @Override public void onReadyForSpeech(Bundle params) { }
            @Override public void onBeginningOfSpeech() { began = true; }
            @Override public void onRmsChanged(float rmsdB) { }
            @Override public void onBufferReceived(byte[] buffer) { }
            @Override public void onEndOfSpeech() { }
            @Override public void onPartialResults(Bundle partialResults) { }
            @Override public void onEvent(int eventType, Bundle params) { }
        });

        recognizer.startListening(recognizeIntent(lng, !online));
    }

    private void nextAttemptOrFail(String code) {
        if (attemptIdx + 1 < attempts.size()) {
            attemptIdx++;
            runAttempt();
            return;
        }
        session++;
        destroyRecognizer();
        emitError(code);
    }

    private void emitError(String code) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", "error");
            o.put("error", code);
            o.put("trace", trace.toString());
        } catch (Exception ignored) { }
        emitSR(o.toString());
        emitSR("{\"type\":\"end\"}");
    }

    /** 給設定頁顯示：手機有哪些辨識服務 */
    private String diagInfo() {
        StringBuilder sb = new StringBuilder("Android ").append(Build.VERSION.RELEASE)
                .append("・").append(Build.MANUFACTURER).append(" ").append(Build.MODEL)
                .append("\n辨識服務：");
        List<ComponentName> list = recognitionServices();
        if (list.isEmpty()) sb.append("（沒有）");
        for (int i = 0; i < list.size(); i++) sb.append(i == 0 ? "" : "、").append(label(list.get(i).flattenToString()));
        sb.append("\n裝置端辨識：");
        if (Build.VERSION.SDK_INT >= 31) sb.append(SpeechRecognizer.isOnDeviceRecognitionAvailable(this) ? "可用" : "不可用");
        else sb.append("Android 版本不支援");
        sb.append("\n網路：").append(isOnline() ? "有" : "沒有");
        return sb.toString();
    }

    private Intent recognizeIntent(String lang, boolean preferOffline) {
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
        i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
        if (preferOffline) i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        return i;
    }

    private static String errorCode(int err) {
        switch (err) {
            case 1: case 2: case 4: case 10: case 11: return "network";
            case 3: return "audio-capture";
            case 5: case 6: case 7: return "no-speech";
            case 8: return "busy";
            case 9: return "not-allowed";
            case 12: case 13: return "language-not-supported";
            default: return "error-" + err;
        }
    }

    private void destroyRecognizer() {
        if (recognizer != null) {
            try { recognizer.destroy(); } catch (Exception ignored) { }
            recognizer = null;
        }
    }

    private void emitSR(String json) {
        if (web == null) return;
        web.evaluateJavascript("window.__androidSR && window.__androidSR(" + json + ")", null);
    }

    /* ================= 離線語音包 ================= */
    private void doCheckOffline(String lang) {
        if (Build.VERSION.SDK_INT >= 33 && SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) {
            releaseHelper();
            helperRecognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(this);
            helperRecognizer.checkRecognitionSupport(recognizeIntent(lang, true), getMainExecutor(),
                    new RecognitionSupportCallback() {
                        @Override public void onSupportResult(RecognitionSupport rs) {
                            String state = "unsupported";
                            if (anyMatch(rs.getInstalledOnDeviceLanguages(), lang)) state = "installed";
                            else if (anyMatch(rs.getPendingOnDeviceLanguages(), lang)) state = "downloading";
                            else if (anyMatch(rs.getSupportedOnDeviceLanguages(), lang)) state = "downloadable";
                            emitOffline(state);
                            releaseHelper();
                        }
                        @Override public void onError(int error) {
                            emitOffline("unknown");
                            releaseHelper();
                        }
                    });
        } else {
            emitOffline("unknown");
        }
    }

    private void doDownloadOffline(String lang) {
        if (Build.VERSION.SDK_INT >= 33 && SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) {
            try {
                releaseHelper();
                helperRecognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(this);
                helperRecognizer.triggerModelDownload(recognizeIntent(lang, true));
                Toast.makeText(this, "開始下載離線語音包，請保持網路連線", Toast.LENGTH_LONG).show();
                return;
            } catch (Exception ignored) { }
        }
        openVoiceSettings();
    }

    private void openVoiceSettings() {
        try { startActivity(new Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)); return; } catch (Exception ignored) { }
        try { startActivity(new Intent(Settings.ACTION_SETTINGS)); } catch (Exception ignored) { }
    }

    private void releaseHelper() {
        if (helperRecognizer != null) {
            try { helperRecognizer.destroy(); } catch (Exception ignored) { }
            helperRecognizer = null;
        }
    }

    private void emitOffline(String state) {
        if (web == null) return;
        web.evaluateJavascript("window.__androidOffline && window.__androidOffline(" + JSONObject.quote(state) + ")", null);
    }

    private static boolean anyMatch(List<String> list, String lang) {
        if (list == null) return false;
        String l = lang.toLowerCase(Locale.ROOT).replace('_', '-');
        for (String raw : list) {
            String e = raw.toLowerCase(Locale.ROOT).replace('_', '-');
            if (e.equals(l)) return true;
            boolean chinese = e.startsWith("zh") || e.startsWith("cmn");
            if (l.equals("zh-tw") && chinese && (e.contains("hant") || e.endsWith("-tw"))) return true;
            if (l.equals("zh-cn") && chinese && (e.contains("hans") || e.endsWith("-cn"))) return true;
            if (l.equals("zh-hk") && (e.startsWith("yue") || e.endsWith("-hk"))) return true;
            if (l.startsWith("en") && e.startsWith(l)) return true;
        }
        return false;
    }

    /* ================= 文字轉語音 ================= */
    private void doSpeak(String text, String lang, float rate, String id) {
        if (!ttsReady) {
            if (tts != null && pendingSpeak == null) { pendingSpeak = new String[]{text, lang, String.valueOf(rate), id}; return; }
            ttsDone(id);
            return;
        }
        try { tts.setLanguage(Locale.forLanguageTag(lang)); } catch (Exception ignored) { }
        tts.setSpeechRate(rate);
        if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) ttsDone(id);
    }

    private void ttsDone(String id) {
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript("window.__androidTTS && window.__androidTTS(" + JSONObject.quote(id) + ")", null);
        });
    }

    /* ================= 其他 ================= */
    private boolean isOnline() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            Network n = cm.getActiveNetwork();
            NetworkCapabilities c = n == null ? null : cm.getNetworkCapabilities(n);
            return c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQ_MIC) return;
        String lang = pendingLang;
        pendingLang = null;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED && lang != null) {
            beginListening(lang);
        } else {
            emitSR("{\"type\":\"error\",\"error\":\"not-allowed\"}");
            emitSR("{\"type\":\"end\"}");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        Uri uri = (resultCode == RESULT_OK && data != null) ? data.getData() : null;
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) fileCallback.onReceiveValue(uri == null ? null : new Uri[]{uri});
            fileCallback = null;
        } else if (requestCode == REQ_SAVE) {
            String text = pendingSaveText;
            pendingSaveText = null;
            if (uri == null || text == null) return;
            try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                os.write(text.getBytes(StandardCharsets.UTF_8));
                Toast.makeText(this, "已儲存", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, "儲存失敗", Toast.LENGTH_LONG).show();
            }
        }
    }

    @Override
    public void onBackPressed() {
        // 不在首頁時，返回鍵回首頁；在首頁才離開 App
        web.evaluateJavascript("window.__androidBack ? window.__androidBack() : false", v -> {
            if (!"true".equals(v)) finish();
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (recognizer != null) {
            session++;
            recognizer.cancel();
            destroyRecognizer();
            emitSR("{\"type\":\"error\",\"error\":\"aborted\"}");
            emitSR("{\"type\":\"end\"}");
        }
        if (ttsReady) tts.stop();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        destroyRecognizer();
        releaseHelper();
        if (tts != null) tts.shutdown();
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }
}
