package com.huaxueyi.rolephone;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.Context;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 一个壳：
 * 1. 把 assets/nodejs-project 解到 filesDir（assets 不是真文件，node 读不了）
 * 2. 起一个后台线程跑 node，入口是文件目录里的 main.js
 * 3. WebView 加载 127.0.0.1:8787，服务还没起来就退避重试
 *
 * 曾经出现过「整片白屏、什么都不显示」：WebView 的渲染进程被系统回收后，
 * loadUrl 悄无声息地什么都不做，onReceivedError 也不触发，看上去就是白的。
 * 现在加了几道保险：启动期显示占位文字；页面加载完是空的就重载一次；
 * 渲染进程挂了就整个重建；回到前台发现还是空白的也重新加载。
 */
public class MainActivity extends Activity {

    private static final String TAG = "rolephone";
    private static final String PORT = "8787";
    private static final String HOME_URL = "http://127.0.0.1:" + PORT + "/";
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final int PHOTO_PERMISSION_REQUEST = 1002;
    private static final String PREFS = "rolephone";

    private static boolean nativeLoaded = false;
    private static String nativeError = "";

    /** 原生库加载失败的话进程会当场没了，所以接住并记下来，下次启动能看见 */
    private static synchronized void loadNative(Context context) {
        if (nativeLoaded || !nativeError.isEmpty()) {
            return;
        }
        try {
            System.loadLibrary("native-lib");
            System.loadLibrary("node");
            nativeLoaded = true;
            BootLog.append(context, "[shell] 原生库加载成功");
        } catch (Throwable t) {
            nativeError = Log.getStackTraceString(t);
            BootLog.append(context, "[shell] 原生库加载失败");
        }
    }

    private static boolean nodeStarted = false;
    private static int nodeRetries = 0;

    private FrameLayout rootLayout;
    private TextView splashView;
    private WebView webView;

    private int retryCount = 0;
    private boolean logShown = false;
    private boolean blankReloaded = false;
    private boolean pageReady = false;
    private ValueCallback<Uri[]> fileCallback;

    // 原生那边返回的是 jint，这里必须声明成 int，否则 node 一退出就会拆箱崩成 NPE
    public native int startNodeWithArguments(String[] arguments);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        loadNative(this);
        if (!nativeError.isEmpty()) {
            showStartupReport("原生库没加载上，App 起不来。");
            return;
        }
        if (NocturneApp.startedAfterCrash) {
            // 上次没走到页面就退出了，先别急着再崩一次，把记录摆出来让人截图
            NocturneApp.startedAfterCrash = false;
            showStartupReport("上次打开没走到页面就退出了。");
            return;
        }

        // 先把占位画面摆上：解包 + 起 node 以前都在 UI 线程、setContentView 之前做，
        // 升级后第一次打开会有好几秒的空窗口，看着就是白屏。
        rootLayout = new FrameLayout(this);
        splashView = new TextView(this);
        splashView.setText("Nocturne 正在启动…");
        splashView.setGravity(Gravity.CENTER);
        splashView.setTextSize(15);
        splashView.setTextColor(Color.parseColor("#8E8E93"));
        splashView.setBackgroundColor(Color.parseColor("#F7F7F7"));
        rootLayout.addView(splashView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(rootLayout);

        final File projectDir = new File(getFilesDir(), "nodejs-project");

        if (nodeStarted) {
            // 同一个进程里 Activity 重建：node 还在跑，直接把 WebView 挂回来
            installWebView();
            return;
        }
        nodeStarted = true;
        BootLog.markPending(this);

        new Thread(() -> {
            BootLog.append(this, "[shell] 开始解包");
            try {
                prepareProject(projectDir);
                BootLog.append(this, "[shell] 解包完成");
            } catch (IOException e) {
                Log.e(TAG, "解包失败", e);
                appendLog("[shell] 解包失败: " + e);
                BootLog.append(this, "[shell] 解包失败: " + e);
            }
            final String mainJs = new File(projectDir, "main.js").getAbsolutePath();
            // 先把 WebView 挂上（它自己有重试），再去起 node。
            // 以前是等 startNode 返回后才挂，node 一直不返回的话这一屏就永远出不来。
            runOnUiThread(() -> {
                if (!isFinishing() && !isDestroyed()) {
                    installWebView();
                }
            });
            BootLog.append(this, "[shell] 去起 node 了");
            startNode(mainJs);
        }, "prepare-project").start();
    }

    /** 建一个 WebView 并加载首页；渲染进程挂掉后也用它重建 */
    private void installWebView() {
        if (webView != null) {
            return; // 已经有了（onCreate 与解包线程可能都想装一次），别叠两个
        }
        webView = new WebView(this);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);

        // 网页通过它把图片存进相册、主动要相册权限
        webView.addJavascriptInterface(new AndroidBridge(), "NocturneAndroid");
        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            if (mimetype != null && mimetype.startsWith("image/")) {
                saveImageToAlbumAsync(url, mimetype, null);
            } else {
                downloadWithSystem(url, userAgent, contentDisposition, mimetype);
            }
        });

        WebView.setWebContentsDebuggingEnabled(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // 服务还没起来：等一会儿再试，最多试 120 次（约 60 秒）
                if (!request.isForMainFrame()) {
                    return;
                }
                if (retryCount < 120) {
                    showSplash();
                    view.postDelayed(() -> loadHome(), 500);
                    retryCount++;
                } else if (!logShown) {
                    logShown = true;
                    showBootLog();
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // 加载完成但页面是空的（WebView 抽风、或者前端脚本整体没跑起来）：
                // 先重载一次，还是空就把日志摊出来，至少让人能截图
                view.evaluateJavascript(
                        "(document.body && document.body.innerText.trim().length) || 0",
                        value -> {
                            int length = 0;
                            if (value != null) {
                                String digits = value.replaceAll("[^0-9]", "");
                                try {
                                    length = digits.isEmpty() ? 0 : Integer.parseInt(digits);
                                } catch (NumberFormatException ignored) {
                                    length = 0;
                                }
                            }
                            if (length > 0) {
                                pageReady = true;
                                retryCount = 0;
                                blankReloaded = false;
                                logShown = false;
                                hideSplash();
                                BootLog.ready(this);
                                return;
                            }
                            if (!blankReloaded) {
                                blankReloaded = true;
                                view.postDelayed(() -> loadHome(), 800);
                            } else if (!logShown) {
                                logShown = true;
                                showBootLog();
                            }
                        });
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // 系统把 WebView 的渲染进程回收了：这个 WebView 已经废了，
                // 必须销毁重建，否则永远白屏（而且不会触发任何回调）
                Log.e(TAG, "WebView 渲染进程挂了，重建");
                appendLog("[shell] WebView 渲染进程被回收，重建");
                rootLayout.removeView(view);
                view.destroy();
                webView = null; // 置空，installWebView 才会真的重建一个
                pageReady = false;
                blankReloaded = false;
                logShown = false;
                retryCount = 0;
                showSplash();
                installWebView();
                return true;
            }
        });

        // 网页里选图要能打开系统相册/文件选择器
        // params.createIntent() 在一些 ROM 上解析不出来，就自己拼一个，
        // 顺便支持多选（参考图一次放好几张）和 .gz/.json 这类备份文件
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;

                Intent intent = buildFileChooserIntent(params);
                if (intent == null) {
                    fileCallback = null;
                    toast("这台设备没有可用的相册/文件选择器");
                    return false;
                }
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception e) {
                    Log.w(TAG, "打开选择器失败", e);
                    fileCallback = null;
                    toast("打不开相册，试试从文件管理器选");
                    return false;
                }
            }
        });

        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        rootLayout.addView(webView, 0, params);

        ensurePhotoPermissionOnce();
        loadHome();
    }

    private void toast(String text) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show();
    }

    /** 看看有没有应用能处理这个 Intent（Android 11+ 需要 manifest 里的 queries 才看得见） */
    private boolean canHandle(Intent intent) {
        try {
            List<ResolveInfo> list = getPackageManager()
                    .queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY);
            return list != null && !list.isEmpty();
        } catch (Exception e) {
            return false;
        }
    }

    private Intent buildFileChooserIntent(WebChromeClient.FileChooserParams params) {
        boolean multiple = params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;

        // 从 accept 里挑 mime 类型；带 .gz/.json 这种扩展名的就直接放开成 */*
        List<String> types = new ArrayList<>();
        boolean anyExtension = false;
        String[] accepts = params.getAcceptTypes();
        if (accepts != null) {
            for (String accept : accepts) {
                if (accept == null) {
                    continue;
                }
                String value = accept.trim();
                if (value.isEmpty()) {
                    continue;
                }
                if (value.startsWith(".")) {
                    anyExtension = true;
                    continue;
                }
                int slash = value.indexOf('/');
                if (slash > 0) {
                    types.add(value);
                }
            }
        }
        if (anyExtension || types.isEmpty()) {
            types.clear();
            types.add("*/*");
        }

        // 有相册权限、又是挑单张图时，直接叫系统相册来，比文件选择器少点几下
        if (!multiple && types.size() == 1 && types.get(0).startsWith("image/")
                && hasPhotoPermission()) {
            Intent gallery = new Intent(Intent.ACTION_PICK);
            gallery.setType("image/*");
            if (canHandle(gallery)) {
                return gallery;
            }
        }

        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(types.size() == 1 ? types.get(0) : "*/*");
        if (types.size() > 1) {
            intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
        }
        if (multiple) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        if (canHandle(intent)) {
            return intent;
        }

        // 兜底 1：老式的「选内容」
        Intent legacy = new Intent(Intent.ACTION_GET_CONTENT);
        legacy.addCategory(Intent.CATEGORY_OPENABLE);
        legacy.setType(types.size() == 1 ? types.get(0) : "*/*");
        if (types.size() > 1) {
            legacy.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
        }
        if (multiple) {
            legacy.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        if (canHandle(legacy)) {
            return legacy;
        }

        // 兜底 2：相册专用入口（只挑图片时用）
        if (types.size() == 1 && types.get(0).startsWith("image/")) {
            Intent pick = new Intent(Intent.ACTION_PICK);
            pick.setType("image/*");
            if (canHandle(pick)) {
                return pick;
            }
        }
        return null;
    }

    // ---------- 相册权限 ----------

    private String photoPermissionName() {
        if (Build.VERSION.SDK_INT >= 33) {
            return Manifest.permission.READ_MEDIA_IMAGES;
        }
        return Manifest.permission.READ_EXTERNAL_STORAGE;
    }

    private boolean hasPhotoPermission() {
        return checkSelfPermission(photoPermissionName()) == PackageManager.PERMISSION_GRANTED;
    }

    /** 装好第一次进来问一次；之后不再主动骚扰，点选图时还会再问 */
    private void ensurePhotoPermissionOnce() {
        if (hasPhotoPermission()) {
            return;
        }
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (prefs.getBoolean("photo_permission_asked", false)) {
            return;
        }
        prefs.edit().putBoolean("photo_permission_asked", true).apply();
        requestPhotoPermission();
    }

    private void requestPhotoPermission() {
        if (hasPhotoPermission()) {
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                requestPermissions(new String[]{Manifest.permission.READ_MEDIA_IMAGES},
                        PHOTO_PERMISSION_REQUEST);
            } else if (Build.VERSION.SDK_INT >= 29) {
                requestPermissions(new String[]{Manifest.permission.READ_EXTERNAL_STORAGE},
                        PHOTO_PERMISSION_REQUEST);
            } else {
                requestPermissions(new String[]{
                        Manifest.permission.READ_EXTERNAL_STORAGE,
                        Manifest.permission.WRITE_EXTERNAL_STORAGE
                }, PHOTO_PERMISSION_REQUEST);
            }
        } catch (Exception e) {
            Log.w(TAG, "请求相册权限失败", e);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != PHOTO_PERMISSION_REQUEST) {
            return;
        }
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        Log.i(TAG, granted ? "相册权限已授予" : "相册权限被拒绝");
        if (!granted) {
            toast("不给相册权限也能选图，只是每次要自己在系统选择器里找");
        }
    }

    // ---------- 保存图片到相册 ----------

    private void saveImageToAlbumAsync(String src, String mime, String name) {
        if (src == null || src.isEmpty()) {
            return;
        }
        new Thread(() -> {
            boolean ok;
            String message;
            try {
                byte[] bytes = readImageBytes(src);
                if (bytes == null || bytes.length == 0) {
                    throw new IOException("图片是空的");
                }
                String type = (mime != null && mime.startsWith("image/")) ? mime : guessMime(src);
                String fileName = (name != null && !name.isEmpty()) ? name : buildImageName(type);
                Uri saved = writeImageToAlbum(bytes, type, fileName);
                ok = saved != null;
                message = ok ? "已存到相册 Pictures/Nocturne" : "保存失败";
            } catch (Exception e) {
                Log.w(TAG, "保存图片失败", e);
                ok = false;
                message = "保存失败：" + (e.getMessage() == null ? e.toString() : e.getMessage());
            }
            final boolean success = ok;
            final String text = message;
            runOnUiThread(() -> {
                if (webView != null) {
                    webView.evaluateJavascript(
                            "window.__nocturneSaved && window.__nocturneSaved(" 
                                    + (success ? "true" : "false") + "," + jsString(text) + ")",
                            null);
                }
                toast(text);
            });
        }, "save-image").start();
    }

    /** 把 JS 字符串安全地塞进 evaluateJavascript */
    private String jsString(String value) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') {
                sb.append('\\').append(c);
            } else if (c == '\n') {
                sb.append("\\n");
            } else if (c < 0x20) {
                sb.append(' ');
            } else {
                sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    private byte[] readImageBytes(String src) throws IOException {
        if (src.startsWith("data:")) {
            int comma = src.indexOf(',');
            if (comma < 0) {
                throw new IOException("图片数据不完整");
            }
            String meta = src.substring(5, comma);
            String payload = src.substring(comma + 1);
            if (meta.contains("base64")) {
                return Base64.decode(payload, Base64.DEFAULT);
            }
            return URLDecoder.decode(payload, "UTF-8").getBytes("UTF-8");
        }

        String url = src;
        if (url.startsWith("//")) {
            url = "http:" + url;
        }
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(30000);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("User-Agent", "Nocturne/Android");
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie != null) {
            conn.setRequestProperty("Cookie", cookie);
        }
        try {
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new IOException("HTTP " + code);
            }
            try (InputStream in = new BufferedInputStream(conn.getInputStream());
                 ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                }
                return out.toByteArray();
            }
        } finally {
            conn.disconnect();
        }
    }

    private Uri writeImageToAlbum(byte[] bytes, String mime, String name) throws IOException {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
            values.put(MediaStore.Images.Media.MIME_TYPE, mime);
            values.put(MediaStore.Images.Media.RELATIVE_PATH,
                    Environment.DIRECTORY_PICTURES + "/Nocturne");
            values.put(MediaStore.Images.Media.IS_PENDING, 1);
            Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                throw new IOException("相册不接受这个文件");
            }
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                if (out == null) {
                    throw new IOException("写不进相册");
                }
                out.write(bytes);
            } catch (IOException e) {
                getContentResolver().delete(uri, null, null);
                throw e;
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.Images.Media.IS_PENDING, 0);
            getContentResolver().update(uri, done, null, null);
            return uri;
        }

        File dir = new File(Environment.getExternalStoragePublicDirectory(
                Environment.DIRECTORY_PICTURES), "Nocturne");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("建不了相册目录");
        }
        File file = new File(dir, name);
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(bytes);
        }
        MediaScannerConnection.scanFile(this, new String[]{file.getAbsolutePath()},
                new String[]{mime}, null);
        return Uri.fromFile(file);
    }

    private String guessMime(String src) {
        String lower = src.toLowerCase(Locale.US);
        if (lower.contains(".jpg") || lower.contains(".jpeg")) {
            return "image/jpeg";
        }
        if (lower.contains(".webp")) {
            return "image/webp";
        }
        if (lower.contains(".gif")) {
            return "image/gif";
        }
        return "image/png";
    }

    private String buildImageName(String mime) {
        String ext = "png";
        if ("image/jpeg".equals(mime)) {
            ext = "jpg";
        } else if ("image/webp".equals(mime)) {
            ext = "webp";
        } else if ("image/gif".equals(mime)) {
            ext = "gif";
        }
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
        return "nocturne-" + stamp + "." + ext;
    }

    private void downloadWithSystem(String url, String userAgent,
                                    String contentDisposition, String mime) {
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            String fileName = URLUtil.guessFileName(url, contentDisposition, mime);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) {
                request.addRequestHeader("Cookie", cookie);
            }
            if (userAgent != null) {
                request.addRequestHeader("User-Agent", userAgent);
            }
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (manager != null) {
                manager.enqueue(request);
                toast("开始下载到 Download");
                return;
            }
        } catch (Exception e) {
            Log.w(TAG, "系统下载失败", e);
        }
        toast("这个文件请在浏览器里下载");
    }

    /** 网页里调 window.NocturneAndroid.xxx() */
    public class AndroidBridge {
        @JavascriptInterface
        public void saveImage(String src) {
            saveImageToAlbumAsync(src, null, null);
        }

        /** 下载新版本安装包：交给系统下载器，下完点通知安装 */
        @JavascriptInterface
        public void downloadApk(String url) {
            if (url == null || url.isEmpty()) {
                toast("下载地址是空的");
                return;
            }
            runOnUiThread(() -> {
                toast("开始下载安装包…");
                downloadWithSystem(url, null, null, "application/vnd.android.package-archive");
            });
        }

        @JavascriptInterface
        public void saveImageAs(String src, String name) {
            saveImageToAlbumAsync(src, null, name);
        }

        @JavascriptInterface
        public void requestPhotoPermission() {
            runOnUiThread(() -> MainActivity.this.requestPhotoPermission());
        }

        @JavascriptInterface
        public boolean hasPhotoPermission() {
            return MainActivity.this.hasPhotoPermission();
        }
    }

    private void loadHome() {
        if (webView == null) {
            return;
        }
        webView.loadUrl(HOME_URL);
    }

    private void showSplash() {
        if (splashView != null) {
            splashView.setVisibility(TextView.VISIBLE);
        }
    }

    private void hideSplash() {
        if (splashView != null && splashView.getVisibility() == TextView.VISIBLE) {
            splashView.setVisibility(TextView.GONE);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 从后台回来还是白的（进程被系统杀过、渲染进程没了）：重新加载一次
        if (webView == null) {
            // 解包线程还没装好 WebView，让它自己装，别在这儿抢
            return;
        }
        if (!pageReady) {
            blankReloaded = false;
            showSplash();
            loadHome();
        }
    }

    private void startNode(final String mainJs) {
        new Thread(() -> {
            final long startedAt = System.currentTimeMillis();
            BootLog.append(this, "[shell] 进 startNode");
            int code;
            try {
                code = startNodeWithArguments(new String[]{"node", mainJs});
            } catch (Throwable t) {
                appendLog("node 启动就崩了: " + Log.getStackTraceString(t));
                code = -1;
            }
            BootLog.append(this, "[shell] node 退出，code=" + code);
            appendLog("node 退出，code=" + code + "，跑了 " + (System.currentTimeMillis() - startedAt) + " 毫秒");
            Log.i(TAG, "node 退出，code=" + code);
            if (!pageReady && nodeRetries < 1) {
                // node 刚起就退了：再拉一次，能扛过一次偶发的启动失败
                nodeRetries++;
                appendLog("node 退出得太早，重试第 " + nodeRetries + " 次");
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException ignored) {
                }
                nodeStarted = false;
                startNode(mainJs);
                return;
            }
            nodeStarted = false;
            runOnUiThread(() -> {
                if (!pageReady && !logShown) {
                    logShown = true;
                    showBootLog();
                }
            });
        }).start();
    }

    /** 往 boot.log 追加一行（和 main.js 写的同一个文件） */
    private void appendLog(String line) {
        File log = new File(new File(getFilesDir(), "nodejs-project"), "boot.log");
        try (FileOutputStream out = new FileOutputStream(log, true)) {
            out.write((new java.util.Date().toString() + " [shell] " + line + "\n").getBytes("UTF-8"));
        } catch (IOException e) {
            Log.e(TAG, "写日志失败", e);
        }
    }

    /** 上次没走完或者原生库没加载上：把记录摊在屏幕上，方便截图发出来 */
    private void showStartupReport(String reason) {
        StringBuilder text = new StringBuilder();
        if (!nativeError.isEmpty()) {
            text.append("原生库加载失败：\n").append(nativeError).append("\n\n");
        }
        if (reason != null && !reason.isEmpty()) {
            text.append(reason).append("\n\n");
        }
        text.append("—— 壳的启动记录 ——\n").append(BootLog.read(this)).append("\n");
        String crash = BootLog.readCrash(this);
        if (!crash.isEmpty()) {
            text.append("—— 上次崩溃 ——\n").append(crash).append("\n");
        }
        BootLog.append(this, "[shell] 显示了启动记录");

        ScrollView scroll = new ScrollView(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundColor(Color.parseColor("#F7F7F7"));
        box.setPadding(40, 80, 40, 80);

        TextView view = new TextView(this);
        view.setText(text.toString());
        view.setTextSize(12);
        view.setTextColor(Color.parseColor("#1C1C1E"));
        view.setTypeface(Typeface.MONOSPACE);
        view.setTextIsSelectable(true);
        box.addView(view, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button again = new Button(this);
        again.setText("清掉记录，重新启动");
        again.setOnClickListener(v -> {
            BootLog.clear(this);
            recreate();
        });
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = 40;
        box.addView(again, params);

        scroll.addView(box);
        setContentView(scroll);
    }

    /** 服务没起来：把 boot.log 摊给用户看，好把错误发出去 */
    private void showBootLog() {
        File log = new File(new File(getFilesDir(), "nodejs-project"), "boot.log");
        StringBuilder sb = new StringBuilder();
        try {
            sb.append(new String(java.nio.file.Files.readAllBytes(log.toPath()), "UTF-8"));
        } catch (Exception e) {
            sb.append("(读不到 boot.log: ").append(e).append(")");
        }
        if (sb.length() == 0) {
            sb.append("(boot.log 是空的，node 可能根本没跑起来)");
        }
        String escaped = sb.toString()
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;");
        String html = "<!doctype html><meta name=viewport content=\"width=device-width,initial-scale=1\">"
                + "<body style=\"margin:0;padding:16px;font:13px/1.5 monospace;background:#F2F2F7;color:#1c1c1e\">"
                + "<h3 style=\"font:600 17px sans-serif;margin:0 0 4px\">页面没有正常显示</h3>"
                + "<p style=\"font:13px sans-serif;color:#8e8e93;margin:0 0 12px\">"
                + "把这个页面截图发给开发者就够了。</p>"
                + "<pre style=\"white-space:pre-wrap;word-break:break-all;margin:0\">"
                + escaped + "</pre></body>";
        if (webView != null) {
            webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
        }
    }

    @Override
    protected void onDestroy() {
        fileCallback = null;
        if (webView != null) {
            if (rootLayout != null) {
                rootLayout.removeView(webView);
            }
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST && fileCallback != null) {
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null && clip.getItemCount() > 0) {
                    results = new Uri[clip.getItemCount()];
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        results[i] = clip.getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(results);
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    /**
     * 把 assets/nodejs-project.zip 解到 filesDir。
     * 版本变了才重解；重解时保留 data/ —— 那里是聊天记录和图片。
     */
    private void prepareProject(File projectDir) throws IOException {
        String version = buildVersion();
        File marker = new File(getFilesDir(), "nodejs-project.version");
        boolean fresh = !projectDir.isDirectory() || !marker.isFile();
        String installed = "";
        if (marker.isFile()) {
            installed = new String(java.nio.file.Files.readAllBytes(marker.toPath())).trim();
        }

        if (!fresh && version.equals(installed)) {
            Log.i(TAG, "项目已是最新（" + version + "）");
            return;
        }

        Log.i(TAG, "解包项目 " + version);
        // 只删代码，不动 data
        File[] children = projectDir.listFiles();
        if (children != null) {
            for (File child : children) {
                if (!"data".equals(child.getName())) {
                    deleteRecursively(child);
                }
            }
        }
        projectDir.mkdirs();

        try (InputStream in = getAssets().open("nodejs-project.zip");
             java.util.zip.ZipInputStream zip = new java.util.zip.ZipInputStream(in)) {
            java.util.zip.ZipEntry entry;
            byte[] buffer = new byte[64 * 1024];
            while ((entry = zip.getNextEntry()) != null) {
                String name = entry.getName();
                if (name.startsWith("__MACOSX") || name.contains("..")) {
                    continue;
                }
                File target = new File(projectDir, name);
                if (entry.isDirectory()) {
                    target.mkdirs();
                    continue;
                }
                File parent = target.getParentFile();
                if (parent != null) {
                    parent.mkdirs();
                }
                try (OutputStream out = new FileOutputStream(target)) {
                    int read;
                    while ((read = zip.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                    }
                }
            }
        }

        java.nio.file.Files.write(marker.toPath(), version.getBytes());
    }

    private String buildVersion() {
        try {
            android.content.pm.PackageInfo info = getPackageManager()
                    .getPackageInfo(getPackageName(), 0);
            return String.valueOf(info.versionCode) + "-" + info.versionName;
        } catch (Exception e) {
            return "1";
        }
    }

    private void deleteRecursively(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        file.delete();
    }
}
