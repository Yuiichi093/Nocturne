package com.huaxueyi.rolephone;

import android.app.Application;

/** 进程里最早跑起来的地方：装崩溃记录，留启动标记 */
public class NocturneApp extends Application {

    /** 上次没走到页面就退出了（多半是闪退） */
    static boolean startedAfterCrash = false;

    @Override
    public void onCreate() {
        super.onCreate();
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            BootLog.crash(this, thread, error);
            if (previous != null) {
                previous.uncaughtException(thread, error);
            }
        });
        startedAfterCrash = BootLog.begin(this);
    }
}
