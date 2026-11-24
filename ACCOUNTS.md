# 账号系统（单机多账号）

一台设备上可以有多个账号，各自的数据互相看不见。

## 为什么这样做

加 `user_id` 意味着改 18 张表、几十条查询语句，而且以后每写一条新查询都得记得带上它——
漏一处就是别人的数据串进来。

所以这里换了个做法：**一个账号一个数据库文件**。

```
data/
├── auth.db              账号与登录态（全局一份）
├── system.db            启动阶段给"还不知道是谁"的代码用的空库
└── users/
    ├── 1/
    │   ├── saudade.db   这个账号的全部内容
    │   ├── uploads/     这个账号的图片
    │   └── backups/     这个账号的备份
    └── 2/
        └── ...
```

上层代码照旧写 `db.prepare('SELECT ...')`，`db.js` 用 `AsyncLocalStorage` 把
"当前请求是哪个账号"带下去，自动路由到对应的连接。**一个查询语句都不用改。**

## 登录态

- 密码用 `scrypt` 加盐哈希（`scrypt$盐$哈希`），不存明文
- 登录后发一个随机 token，存 `sessions` 表（只存 sha256），cookie 名 `nocturne_session`
- cookie 是 `HttpOnly` + `SameSite=Lax`，有效期 30 天
- 换密码会作废其它设备上的登录，当前这条保留
- 连错 5 次歇 3 秒（防暴力尝试）

## 访问控制

| 情况 | 行为 |
| --- | --- |
| 没登录打开页面 | 302 到 `/login.html?next=原地址` |
| 没登录调接口 | 401 `{error:'未登录'}`，前端 `auth-guard.js` 跳登录页 |
| 没登录取 `/uploads/xxx.jpg` | 401 |
| 白名单 | `/login.html`、`/auth-guard.js`、`/api/auth/*`、`/api/health`、`/icons/`、静态资源 |

`?next=` 只接受站内相对路径（`/` 开头且不是 `//`），防止被拿去做跳转钓鱼。

## 老数据怎么处理

第一个注册的账号会**继承**原来的 `data/saudade.db` 与 `data/uploads/`（移动进
`data/users/1/`），所以升级后第一次注册时，用户名密码随便设成自己记得的就行，
原来的角色、聊天、世界书都还在。

第二个及以后的账号是全新的空库。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | `{username, password, nickname?}`，成功即登录 |
| POST | `/api/auth/login` | `{username, password}` |
| POST | `/api/auth/logout` | 清 cookie |
| GET | `/api/auth/me` | 当前账号（未登录 401） |
| GET | `/api/auth/status` | `{has_users, logged_in}`，登录页用 |
| POST | `/api/auth/password` | `{old_password, new_password}` |

## 换账号 / 加账号

从首页「我的 → 账号」里退出，再在登录页注册新账号即可。
想切回原来的账号，退出后用原来的用户名密码登录。

## 注意

- 账号只存在这台设备上，**没有云端**。忘了密码只能手工改 `data/auth.db`（或者删掉它重来，
  代价是所有账号的登录态和账号表一起丢，但 `data/users/<id>/` 里的内容还在）。
- 备份是**按账号**的：账号 1 导出的备份不会包含账号 2 的内容。
- 手机丢了就等于全丢了，重要的对话记得导出备份。
