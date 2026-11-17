# 贡献指南

谢谢你看这个项目。下面是几条约定，都不长。

## 环境

- Node.js ≥ 18。24 以上用内置 `node:sqlite`；18～22 自动退到 `sql.js`（WASM），不需要编译原生模块
- 想强制指定驱动：`ROLEPHONE_SQLITE=sqljs node server.js` 或 `ROLEPHONE_SQLITE=native`
- 依赖只有 express / multer / lunar-javascript
- 前端无构建步骤：改 `public/` 下的文件，刷新就生效

## 本地跑起来

```bash
npm install
node server.js        # http://127.0.0.1:8787
```

数据库会在 `data/` 下自动创建并迁移，不用手动建表。

## 提交前

```bash
npm run check         # 对所有 js 做 node --check
```

改动涉及接口时，请顺手手测一遍：起服务，用 curl 打一下相关接口。

## 代码风格

- CommonJS，两空格缩进，单引号
- 新增数据库列/表请写在 `migrate.js` 里，用 `addColumnIfMissing` / `CREATE TABLE IF NOT EXISTS`
- 前端只用原生 API，不引框架、不引构建工具
- 中文字符串写得像正常人说话，不要客套腔

## 不要提交

- `data/`、`backups/`、`logs/`、任何 `*.db`
- 你的 API Key（配置存在数据库里，不在代码里，但这仍然值得提醒一次）
- 私人聊天记录与截图里出现的个人信息

## 提 Issue

写清三件事：**你做了什么 → 你期待什么 → 实际发生了什么**。
有报错就把终端里的红字贴全，别只截一半。
