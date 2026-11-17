package com.huaxueyi.rolephone;

import android.content.Context;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 壳自己的启动记录。
 *
 * 点开就闪退回桌面的时候，屏幕上一行字都留不下，日志页也来不及显示。
 * 所以把每一步都落到文件里，并且留一个「没走完」的标记：
 * 下次打开发现标记还在，就先把记录摊出来，至少能截图查到死在哪一步。
 */
final class BootLog {

    private static final String TAG = "rolephone";
    private static final String LOG_FILE = "shell.log";
    private static final String PENDING_FILE = "boot.pending";
    private static final String CRASH_FILE = "crash.txt";

    private BootLog() {
    }

    static synchronized void append(Context context, String line) {
        if (context == null) {
            Log.i(TAG, line);
            return;
        }
        File file = new File(context.getFilesDir(), LOG_FILE);
        try (FileOutputStream out = new FileOutputStream(file, true)) {
            String stamp = new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date());
            out.write((stamp + " " + line + "\n").getBytes("UTF-8"));
        } catch (IOException e) {
            Log.e(TAG, "写启动记录失败", e);
        }
    }

    static synchronized String read(Context context) {
        if (context == null) {
            return "";
        }
        File file = new File(context.getFilesDir(), LOG_FILE);
        if (!file.exists()) {
            return "(还没有记录)\n";
        }
        try (FileInputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int count;
            while ((count = in.read(chunk)) > 0) {
                buffer.write(chunk, 0, count);
            }
            return new String(buffer.toByteArray(), "UTF-8");
        } catch (IOException e) {
            return "(读不到记录: " + e + ")\n";
        }
    }

    /** 进程起来时调：返回 true 表示上一次没走到页面就退出了 */
    static synchronized boolean begin(Context context) {
        boolean unfinished = new File(context.getFilesDir(), PENDING_FILE).exists();
        try (FileOutputStream out = new FileOutputStream(new File(context.getFilesDir(), PENDING_FILE))) {
            out.write(new Date().toString().getBytes("UTF-8"));
        } catch (IOException e) {
            Log.e(TAG, "写启动标记失败", e);
        }
        append(context, "[app] 进程起来，" + (unfinished ? "上次没走完" : "上次是正常的"));
        return unfinished;
    }

    /** 正常启动时重新打个标记（同一个进程里重试过一次也能再被检测到） */
    static synchronized void markPending(Context context) {
        if (context == null) {
            return;
        }
        try (FileOutputStream out = new FileOutputStream(new File(context.getFilesDir(), PENDING_FILE))) {
            out.write(new Date().toString().getBytes("UTF-8"));
        } catch (IOException e) {
            Log.e(TAG, "写启动标记失败", e);
        }
    }

    /** 页面真的加载出来了，标记可以销掉 */
    static synchronized void ready(Context context) {
        new File(context.getFilesDir(), PENDING_FILE).delete();
        append(context, "[app] 页面加载完成");
    }

    static void crash(Context context, Thread thread, Throwable error) {
        String name = thread == null ? "?" : thread.getName();
        String stack = error == null ? "(没有异常对象)" : Log.getStackTraceString(error);
        append(context, "[crash] 线程 " + name + " 抛异常了");
        if (context == null) {
            return;
        }
        try (FileOutputStream out = new FileOutputStream(new File(context.getFilesDir(), CRASH_FILE))) {
            out.write((new Date().toString() + " 线程 " + name + "\n" + stack).getBytes("UTF-8"));
        } catch (IOException e) {
            Log.e(TAG, "写崩溃记录失败", e);
        }
    }

    static synchronized String readCrash(Context context) {
        if (context == null) {
            return "";
        }
        File file = new File(context.getFilesDir(), CRASH_FILE);
        if (!file.exists()) {
            return "";
        }
        try (FileInputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int count;
            while ((count = in.read(chunk)) > 0) {
                buffer.write(chunk, 0, count);
            }
            return new String(buffer.toByteArray(), "UTF-8");
        } catch (IOException e) {
            return "(读不到崩溃记录: " + e + ")";
        }
    }

    static synchronized void clear(Context context) {
        if (context == null) {
            return;
        }
        new File(context.getFilesDir(), LOG_FILE).delete();
        new File(context.getFilesDir(), CRASH_FILE).delete();
        new File(context.getFilesDir(), PENDING_FILE).delete();
    }
}
