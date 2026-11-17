# 打包成 APK

> 状态：**实验分支**。工程、构建脚本、GitHub Actions 都在仓库里，但还没有在真机上跑通，
> 第一个可用的构建结果以 Actions 的日志为准。

## 思路

APK 是个壳，里面塞一个 Node 跑你这套 JS：

```
MainActivity (WebView)
   └── assets/nodejs-project.zip   ← 整个应用 + node_modules
            ↓ 首次启动解压到 filesDir
       libnode.so (Node 18 for Android) 跑 main.js
            ↓ 监听 127.0.0.1:8787
       WebView 加载 http://127.0.0.1:8787/
```

数据存在 App 私有目录（`filesDir/nodejs-project/data`），卸载 App 才会没；升级时保留。

## 为什么是 Node 18

`libnode` 目前是 nodejs-mobile 提供的 Node 18.20.4。而本项目原本依赖 `node:sqlite`
（Node 22.5+ 内置），Node 18 上没有它 —— 所以 `db.js` 会退到 `sql.js`（WASM 版 SQLite）
兼容层，见 `db-sqljs.js`。

两者接口一致，Termux 里跑还是用原生 `node:sqlite`，只有 APK 里走 sql.js。

## 自己构建

### 用 GitHub Actions（推荐，不用装 Android SDK）

1. 把仓库推到 GitHub
2. 打开 **Actions → Android APK → Run workflow**
3. 跑完后在页面的 Artifacts 里下载 `rolephone-apk`

### 本地构建

需要 JDK 17、Android SDK（platform 34、build-tools 34、NDK 26.1、CMake 3.22）。

```bash
# 1. 放 libnode
curl -L -o /tmp/libnode.zip \
  https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip
unzip -q /tmp/libnode.zip -d /tmp/libnode
mkdir -p android/app/libnode
cp -r /tmp/libnode/bin android/app/libnode/
cp -r /tmp/libnode/include android/app/libnode/

# 2. 装依赖
npm install --omit=dev

# 3. 构建
cd android && gradle assembleDebug
```

产物在 `android/app/build/outputs/apk/debug/`。

## 已知问题

- 还没在真机上跑过：WebView 里软键盘、图片选择、返回键这些交互都要实测
- sql.js 是整个库读进内存、定期导出回文件，数据量很大时会慢；日常几千条消息没问题
- 首次启动要解 783 个文件，会慢一两秒
- debug 包用调试签名，能直接装；要上架得自己配 release keystore（在 `app/build.gradle` 里加 `signingConfigs`）
- 后台被杀后 WebView 会白屏，重进 App 即可（服务会重新起）

## 目录

```
android/
├── prepare-assets.js        把 JS 应用 + node_modules 打成 assets/nodejs-project.zip
├── app/CMakeLists.txt       链接 libnode.so
├── app/src/main/cpp/native-lib.cpp   把 args 交给 node::Start
├── app/src/main/java/.../MainActivity.java  解压 + 起 node + WebView
└── app/build.gradle         preBuild 里调 prepare-assets.js
```

## 踩过的坑

**Node 18 for Android 不带 ICU。** nodejs-mobile 编的 Node 18 没有 ICU 数据，所以
`\p{ID_Start}` 这类 Unicode 属性正则会在**解析阶段**直接抛
`SyntaxError: Invalid regular expression ... Invalid property name in character class`。
express 5 依赖的 `path-to-regexp@8` 第 11 行就用了它，结果就是服务根本起不来。
`android/prepare-assets.js` 在打包时会把那几行正则替换成等价的 ASCII 写法，
只影响打进 APK 的那份依赖拷贝，仓库里的 `node_modules` 不动。
以后再遇到别的 ICU 相关报错，同一个函数里加一条替换即可。

**启动失败要看得到日志。** `main.js` 会把所有 `console.*` 输出追加到
`files/nodejs-project/boot.log`，`MainActivity` 在重试 60 次（约 30 秒）还没起来时，
会把这个文件渲染成一个页面显示出来，直接截图就能定位。
