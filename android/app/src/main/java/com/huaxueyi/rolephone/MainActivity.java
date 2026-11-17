package com.huaxueyi.rolephone;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 一个壳：
 * 1. 把 assets/nodejs-project 解到 filesDir（assets 不是真文件，node 读不了）
 * 2. 起一个后台线程跑 node，入口是文件目录里的 main.js
 * 3. WebView 加载 127.0.0.1:8787，服务还没起来就退避重试
 */
public class MainActivity extends Activity {

    private static final String TAG = "rolephone";
    private static final String PORT = "8787";
    private static final String HOME_URL = "http://127.0.0.1:" + PORT + "/";
    private static final int FILE_CHOOSER_REQUEST = 1001;

    static {
        System.loadLibrary("native-lib");
        System.loadLibrary("node");
    }

    private static boolean nodeStarted = false;

    private WebView webView;
    private int retryCount = 0;
    private boolean logShown = false;
    private ValueCallback<Uri[]> fileCallback;

    public native Integer startNodeWithArguments(String[] arguments);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        File projectDir = new File(getFilesDir(), "nodejs-project");
        try {
            prepareProject(projectDir);
        } catch (IOException e) {
            Log.e(TAG, "解包失败", e);
        }

        if (!nodeStarted) {
            nodeStarted = true;
            final String mainJs = new File(projectDir, "main.js").getAbsolutePath();
            startNode(mainJs);
        }

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);

        WebView.setWebContentsDebuggingEnabled(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // 服务还没起来：等一会儿再试，最多试 60 次（约 30 秒）
                if (!request.isForMainFrame()) {
                    return;
                }
                if (retryCount < 60) {
                    view.postDelayed(() -> webView.loadUrl(HOME_URL), 500);
                    retryCount++;
                } else if (!logShown) {
                    logShown = true;
                    showBootLog();
                }
            }
        });

        // 网页里选图要能选到本地文件
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                Intent intent = params.createIntent();
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        webView.loadUrl(HOME_URL);
    }

    private void startNode(final String mainJs) {
        new Thread(() -> {
            int code;
            try {
                code = startNodeWithArguments(new String[]{"node", mainJs});
            } catch (Throwable t) {
                appendLog("node 启动就崩了: " + Log.getStackTraceString(t));
                code = -1;
            }
            appendLog("node 退出，code=" + code);
            Log.i(TAG, "node 退出，code=" + code);
            runOnUiThread(() -> {
                if (retryCount >= 60 && !logShown) {
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
                + "<h3 style=\"font:600 17px sans-serif;margin:0 0 4px\">服务没有起来</h3>"
                + "<p style=\"font:13px sans-serif;color:#8e8e93;margin:0 0 12px\">"
                + "把这个页面截图发给开发者就够了。</p>"
                + "<pre style=\"white-space:pre-wrap;word-break:break-all;margin:0\">"
                + escaped + "</pre></body>";
        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST && fileCallback != null) {
            Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
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
