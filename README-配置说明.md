# 南瓜猫谱 · 小程序配置说明

> **目标：只需改 `miniprogram/config.js` 一个文件 + 替换一个 LOGO 图片，即可完成全部配置。**
> 其余任何文件都不应出现需要你手工修改的常量（域名、AppID、密钥等）。
> 密钥（`WX_SECRET`、`OSS_ACCESS_KEY_*`、`JWT_SECRET` 等）一律只放后端 `.env`，**小程序端不放任何密钥**。

---

## 一、最快配置步骤（3 步）

### 1. 改 `miniprogram/config.js`

打开文件，按注释找到「① 必填：后端与 OSS」，改下面几项：

| 配置项 | 填什么 | 说明 |
|---|---|---|
| `API_BASE_URL` | 你的**后端 API 反代域名** | 指向 `127.0.0.1:8000` 的反代域名，需 **HTTPS + 已 ICP 备案**。反代与证书由你自备，本项目不新增 conf |
| `OSS_USE_CNAME` | `true`（当前）或 `false` | 是否启用 OSS 自定义域名 |
| `OSS_EXTERNAL_ENDPOINT` | `https://nanhuamaopu.oss-cn-beijing.aliyuncs.com` | OSS **外网** endpoint，只用于图片上传/下载 |
| `OSS_CNAME_ENDPOINT` | `https://oss.xcry.top` | 启用 CNAME 时使用，同样只用于图片 |
| `OSS_BUCKET` | `nanhuamaopu` | 私有桶名，**这是正确值**，见下方「桶名」说明 |
| `app_id` | 你的小程序 AppID | 需与 `project.config.json` 的 `appid`、后端 `WX_APPID` 一致 |
| `LOGO_PATH` | 一般不用改 | 见第 2 步 |

其它按需调整：`app_version`、`map_center`（地图中心）、`chooseMediaCount`、
`mapAccessAutoPassCount`、`OFFLINE_DEMO_MODE`、系统图片前缀、`theme` 色板。

### 2. 替换 LOGO 文件

把你的 LOGO 图片放到 **`miniprogram/pages/public/images/system/logo.png`**（文件名固定）。
全项目所有引用 LOGO 的地方都读 `config.js` 的 `LOGO_PATH`，不需要改别的文件。

> 当前已放入的 LOGO 源文件来自 `D:\个人信息内容\冷归档\猫协\LOGO.png`。

### 3. 上线前跑一次部署自检

微信开发者工具里打开分包页面 `pages/debug/deployTip/deployTip`（部署检查页），
或在调试入口进入。页面会逐项检查并给出「通过 / 未通过 / 提示」与修复建议：

1. `config.js` 必填项是否齐全、两个域名是否混用
2. LOGO 文件是否存在且可解码
3. 后端 `/health` 是否可达（MongoDB 是否 up）
4. 登录接口 `/api/login` 是否可用
5. OSS 上传签名 `/api/oss/policy` 是否可用
6. OSS 读图签名 `/api/oss/sign` 是否可用、**缓存时长是否短于签名有效期**
7. 数据库集合是否初始化（逐个 `count` 探测）
8. 系统图片是否可签名读取
9. 合法域名 / 隐私合规待办提示

**任何失败都有明确文案，不会静默通过。**

其中两类是**部署前的预期状态**，显示为「提示」而非「未通过」，且不会阻断后续检查：

- **`WX_SECRET`（AppSecret）尚未配置**：用户暂未提供，登录接口返回明确的 500。
  把 `WX_APPID / WX_SECRET` 填入后端 `.env` 并重启后即自动恢复，不影响
  config、LOGO、OSS 签名等其他检查项。
- **数据库暂未就绪**：后端 `/api/db/*`、`/api/unionOp`、`/api/login` 返回 503，
  `/health` 仍返回 200 但 `db:'down'`。这属于「稍后重试」，**不是鉴权失败**，
  前端不会因此重新登录；MongoDB 连上后自动恢复。OSS 签名接口不依赖数据库。

---

## 二、两个域名是独立配置，别混用

| 域名 | 配置项 | 用途 |
|---|---|---|
| **API 反代域名** | `API_BASE_URL` | 所有 `/api/*` 请求、`/health`、登录、数据库网关 |
| **OSS 图片域名** | `OSS_EXTERNAL_ENDPOINT` / `OSS_CNAME_ENDPOINT` | 只用于图片上传（直传）与图片读取（签名 URL） |

> ⚠️ **CNAME 不是 API 域名**。千万不要把 `API_BASE_URL` 填成 OSS CNAME，
> 否则所有业务请求会打到 OSS 上而 404。部署检查页第 1 项会检测这个错误。

服务器与 OSS 之间走内网 `oss-cn-beijing-internal.aliyuncs.com` 是**后端**的事，
小程序端只用外网 endpoint 或 CNAME。

---

## 三、OSS 是私有桶（重要）

- **上传**：先调后端 `POST /api/oss/policy` 拿 PostObject 直传签名，再直传 OSS，图片不经过 ECS 出站带宽。
- **读取**：所有图片 URL 必须经后端 `GET /api/oss/sign?key=` 换成**签名 URL** 才能显示。
- **签名 URL 会过期**：后端签名有效期 900s、建议缓存 600s。
  前端缓存时长 = `min(cacheSeconds − OSS_SIGN_CACHE_MARGIN_SECONDS, expire×0.8)`，
  **严格短于签名有效期**。

> ⚠️ 这正是本项目已修复的「徽章图片过一会儿只剩名字」bug 的根因
> （原 `utils/common.js` 的 `signCosUrl` 把签名链接长期缓存）。
> 新实现在 `utils/oss.js::signImageUrl`，请勿改回长期缓存。

### 桶名说明

`OSS_BUCKET = nanhuamaopu` 是**正确值**：原名被占用才改用此名，项目名仍是 `nanguamaopu`。
存储桶名与项目名不同属正常情况，**切勿「好心」改成 `nanguamaopu`，否则图片全部 404**。

---

## 四、整体换色：改 LOGO 后只需改几个变量

色板取自 LOGO 精确取色（761×695 RGBA，量化口径）：

| 角色 | 色值 | CSS 变量 | 用途 |
|---|---|---|---|
| 主色（猫头钢蓝） | `#406090` | `--brand-primary` | 品牌主色、按钮背景、选中态 |
| 深强调（圆环/文字藏蓝） | `#104070` | `--brand-deep` | 标题、主按钮、边框 |
| 墨蓝 | `#004080` | `--brand-ink` | 强调文字 |
| 浅色 | `#C0D0D0` | `--brand-light` | 分割线、禁用态（**勿作正文色**） |
| 浅背景 | `#E0E0F0` | `--brand-bg` | 页面/卡片浅底 |
| 白 | `#FFFFFF` | `--brand-on` | LOGO 底色、主色上的文字 |

> 主色 `#406090` 作按钮背景配白字对比度足够；但作为正文色偏暗，**正文仍用深色**
> （`--color-text: #22314A`）。浅色系不要直接当文字色。

**换 LOGO 后整体换色只需两处：**

1. `miniprogram/app.wxss` 里 `page { ... }` 的 `--brand-*` / `--color-primary*` 变量（WXSS 侧）；
2. `miniprogram/config.js` 的 `theme` 字段（JS 侧，供 canvas 绘图等读取）。

两处数值保持一致即可一处换色、全站生效；各页面/组件 WXSS 均引用变量，不写死色值。

---

## 五、后端接口契约（了解即可，不需改小程序）

统一鉴权：除 `/api/login` 与 `/health` 外，所有请求带 `Authorization: Bearer <token>`。

| 接口 | 请求 | 返回 |
|---|---|---|
| `POST /api/login` | `{ code }` | `{ token, openid }` |
| `GET /health` | — | `{ ok, db }` |
| `POST /api/db/:collection/:op` | `{ args: [query, options] }` | `{ result }` |
| `POST /api/db/:collection/aggregate` | `{ pipeline }` | `{ result }` |
| `POST /api/unionOp` | `{ unionAction, ...args }` | `{ ok, result }` |
| `POST /api/oss/policy` | `{ ext, prefix }` | `{ host, key, policy, signature, OSSAccessKeyId, expire }` |
| `GET /api/oss/sign?key=` | — | `{ url, expire, cacheSeconds }` |
| `POST /api/oss/sign` | `{ keys: [...] }` | `{ urls, expire, cacheSeconds }` |

小程序端分层：

```
页面 / 组件 / utils
   └─ utils/api.js        统一入口（db / callUnionOp / login / oss*）
        ├─ utils/request.js  HTTP：baseURL、Bearer、错误不静默、401 重登
        ├─ utils/db.js      数据库网关（EMAS 同语义，返回 { result }）
        └─ utils/oss.js     上传直传 + 私有桶签名 URL（缓存短于有效期）
   └─ utils/common.js     兼容层（signCosUrl / uploadFile / downloadFile 等旧导出名）
```

`openid` 由后端从 JWT 注入，客户端不再自行拼装身份字段；
越权防护在服务端完成。

---

## 六、微信公众平台待办（上线前）

1. 「开发管理 → 服务器域名」：
   - `request` 合法域名 = `API_BASE_URL`
   - `uploadFile` / `downloadFile` 合法域名 = OSS 外网 endpoint 或 CNAME
   - 域名须 **HTTPS + 已 ICP 备案**
2. 「用户隐私保护指引」：收集 openid、头像昵称、位置、照片属用户信息处理，
   需配置指引并在调用前完成授权弹窗（以微信官方最新审核规范为准）。
3. 确认 `app_id` 与后端 `WX_APPID` / `WX_SECRET` 一致，避免测试/正式环境混淆。

---

## 七、本地环境配置说明（勿覆盖）

`miniprogram/config.js` 里有一组「⑦ 遗留本地环境配置」保留项
（`space_id`、`space_endpoint`、`use_private_tencent_cos`、`sign_expires_tencent_cos`），
以及 `app_id`、`map_center`、`mapAccessAutoPassCount` 等用户本地值。
这些是从 EMAS 迁移前的本地环境配置，按迁移要求**原样保留**，运行时已不再读取，
请勿删除或覆盖。`project.config.json` 的 `appid` 同样以本地值为准。
