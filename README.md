<div align="center">

![Nocturne](docs/banner.svg)

# Nocturne

**一个跑在自己手机上的 AI 角色聊天应用**

角色聊天 · 小剧场 · 朋友圈 · 世界书 · 生图

[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-black.svg)](https://nodejs.org)
[![CI](https://github.com/Yuiichi093/Nocturne/actions/workflows/ci.yml/badge.svg)](https://github.com/Yuiichi093/Nocturne/actions/workflows/ci.yml)

</div>

---

## 这是什么

Nocturne 是一个**完全跑在本地**的角色扮演聊天应用：Node.js 起一个本地服务，
浏览器打开 `127.0.0.1:8787` 使用。没有账号、没有云端、聊天记录和图片都存在你自己手机上的 SQLite 里。

它最初是为在 Android（Termux）上使用而写的，界面按 iOS 的风格做：分组灰底、白卡片、底部升起的面板。

> 不内置任何模型。你需要自备一个 OpenAI 兼容的 API（模型名、地址、Key 自己填），
> 想用哪家都行，也可以用本地模型。

## 功能

**聊天**
- 角色人设、用户人设、开场白，支持多套人设
- 回复分成【旁白】和【对白】，按微信的节奏说话，不是小说体
- 图片：发给角色，他能读图；也能让他画图（带角色参考图）
- 表情包：每个角色一套，你自己写每张图的意思
- 重新生成：一次给三份候选，不满意换一批
- 旁白 / 重新生成 / 图片都在输入框的「＋」里

**小剧场**
- 剧本 → 会话，可扮演角色、也可上帝视角
- 剧情走向提示、重选、分支、章节管理
- 给当前这一幕生图，图直接进剧情流

**朋友圈**
- 角色可以评论、点赞，也能自己发动态
- 同一世界观的角色互相可见
- 角色能读你发的图片内容

**其他**
- 世界书（关键词检索，连角色名字一起匹配）
- 多世界观、日历/节日、消息编辑与历史版本
- 备份导出/恢复（备份默认不含 API Key）
- 模型分工：文字/思考、看图、生图各用各的模型

## 截图

还没拍。手机截图放进 `docs/screenshots/`，命名见 [那里的说明](docs/screenshots/README.md)，
README 会显示下面这排：

<!-- 拍好之后把这段注释删掉，换成三张图：
| 聊天 | 小剧场 | 朋友圈 |
| --- | --- | --- |
| ![聊天](docs/screenshots/chat.png) | ![小剧场](docs/screenshots/theater.png) | ![朋友圈](docs/screenshots/moments.png) |
-->

## 快速开始

### 手机上（Termux）

```bash
pkg install nodejs        # Node 26
git clone https://github.com/Yuiichi093/Nocturne.git
cd rolephone
npm install
node server.js
```

然后浏览器打开 `http://127.0.0.1:8787`。
想让它开机自启，可以用 Termux:Boot 配一条启动命令；想有个桌面图标，浏览器菜单里选「添加到主屏幕」。

### 电脑上

同样的命令，`node server.js` 之后开 `http://127.0.0.1:8787`。数据会在 `data/` 下自动生成。

### 版本说明

推荐 Node 24 以上（Termux 里 `pkg install nodejs` 给的就是 26）。
Node 18～22 也能跑：没有内置 `node:sqlite` 时会自动切到 `sql.js`（WASM 版 SQLite）兼容层，
功能一样，只是写入落盘稍慢。APK 分支就是跑在 Node 18 上的。

### 配置模型

进「模型设置」，填 Base URL、模型名、API Key，然后点「测试」——它会做一次自检，
报告这个模型能不能看图、能不能生图，省得你猜。

- 文字与思考：平时的对话、剧情、朋友圈都用它
- 看图：发给角色的图片由它来读
- 生图：画图用的模型

## 目录结构

```
server.js            HTTP 入口，路由注册
db.js / migrate.js   SQLite 连接与自动迁移（启动时自动补表补列）
llm.js               统一的模型调用（对话 / 看图）
chat-api.js          聊天
theater-api.js       小剧场剧本与会话
theater-play-api.js  小剧场推进与生图
moment-api.js        朋友圈
moment-ai.js         朋友圈的 AI 评论与自主发动态
image-api.js         生图与参考图
sticker-api.js       表情包
backup-api.js        备份导出与恢复
worldbook*.js        世界书
public/              前端（裸 HTML/CSS/JS，无构建步骤）
```

## 设计原则

- **本地优先**：数据只在你自己的机器上，没有任何遥测。
- **无构建**：前端是原生 HTML/CSS/JS，改完刷新就生效，不需要打包。
- **可组合的模型**：任何 OpenAI 兼容接口都能用，能力靠「测试」自检，不写死厂商。
- **数据库自动迁移**：新版本直接覆盖代码即可，`migrate.js` 会补上缺的表和列。

## 更新

```bash
git pull && npm install && node server.js
```

数据不会被覆盖：`data/` 是运行期目录，不在版本控制里。

## 关于 APK

已经有一个实验分支：WebView 壳 + 内置 Node 18（nodejs-mobile），数据层在缺少
`node:sqlite` 时自动退到 WASM 版 SQLite。构建走 GitHub Actions 的 Android workflow，
详见 [docs/ANDROID.md](docs/ANDROID.md)。

## 开发

```bash
npm start             # 起服务，默认 http://127.0.0.1:8787
npm run check         # 语法检查（node --check）
```

贡献前请读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

[MIT](LICENSE) © 花雪一
