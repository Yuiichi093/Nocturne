package com.huaxueyi.rolephone;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

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

    static {
        System.loadLibrary("native-lib");
        System.loadLibrary("node");
    }

    private static boolean nodeStarted = false;

    private FrameLayout rootLayout;
    private TextView splashView;
    private WebView webView;

    private int retryCount = 0;
    private boolean logShown = false;
    private boolean blankReloaded = false;
    private boolean pageReady = false;
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

        installWebView();
    }

    /** 建一个 WebView 并加载首页；渲染进程挂掉后也用它重建 */
    private void installWebView() {
        webView = new WebView(this);

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
                // 服务还没起来：等一会儿再试，最多试 120 次（约 60 秒）
                if (!request.isForMainFrame()) {
                    return;
                }
                if (retryCount < 120) {
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
                                hideSplash();
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
                pageReady = false;
                blankReloaded = false;
                installWebView();
                return true;
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

        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        rootLayout.addView(webView, 0, params);

        loadHome();
    }

    private void loadHome() {
        if (webView == null) {
            return;
        }
        webView.loadUrl(HOME_URL);
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
            if (rootLayout != null) {
                installWebView();
            }
            return;
        }
        if (!pageReady) {
            String current = webView.getUrl();
            if (current == null || current.startsWith("about:") || current.isEmpty()) {
                loadHome();
            }
        }
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
