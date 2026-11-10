# 小程序端配置说明（5 分钟上手）

> 后端部署见后端仓库 `docs/DEPLOY.md`；旧数据迁移见 `docs/MIGRATION.md`。

这个小程序**只需要改一个文件 + 换一张图**就能跑起来。

---

## 一、只改 config.js

打开 `miniprogram/config.js`，按下表填写（其余保持默认）：

| 字段 | 填什么 | 从哪获取 |
|---|---|---|
| `API_BASE_URL` | 你的后端地址，如 `https://api.your-domain.com` | 自己部署的后端（必须 HTTPS、已备案、不带端口） |
| `app_id` | 小程序 AppID | 微信公众平台 → 开发管理 → 开发设置 → AppID |
| `OSS_BUCKET` | OSS 桶名 | 阿里云 OSS 控制台 |
| `OSS_EXTERNAL_ENDPOINT` | OSS 外网 Endpoint | OSS 控制台 Bucket 概览 |
| `OSS_CNAME_ENDPOINT` | 自定义图片域名（可选） | 你的 CNAME 域名；不用 CNAME 就留空并设 `OSS_USE_CNAME: false` |
| `OSS_USE_CNAME` | 是否用自定义域名读图 | 用 CNAME 填 `true`，否则 `false` |
| `map_center` | 地图默认中心点 | 你的学校坐标（高德/腾讯地图拾取坐标） |
| `OFFLINE_DEMO_MODE` | 正式部署必须是 `false` | — |

**注意**：`API_BASE_URL`（后端接口域名）与 `OSS_*_ENDPOINT`（图片域名）是两个不同的配置，千万别混填。

---

## 二、换一张 LOGO

`config.js` 里的 `LOGO_PATH` 指向 `/pages/public/images/system/logo.png`，
直接把这张图替换成你自己的（建议 200×200 PNG，透明背景）即可，所有页面的 LOGO 会自动跟着变。

---

## 三、npm install 与构建

项目用到小程序 npm 包（`crypto-js` 等）：

```bash
cd miniprogram
npm install
```

然后在微信开发者工具里点 **工具 → 构建 npm**，勾选「使用 npm 模块」。

`project.config.json` 里的 `appid` 也要改成你自己的 AppID（这是开发者工具要求的构建期字段，与 `config.js` 保持一致）。

---

## 四、公众平台要配的东西

| 项 | 位置 | 说明 |
|---|---|---|
| 服务器域名 | 开发管理 → 开发设置 → 服务器域名 | request 合法域名填 `API_BASE_URL` 的域名；downloadFile/uploadFile 填 OSS/CNAME 域名 |
| 用户隐私保护指引 | 设置 → 服务内容声明 | 声明摄像头、相册、位置信息、剪切板；不声明会被驳回 |
| 接口权限 | 开发管理 → 接口设置 | 用到 `wx.getFuzzyLocation`、`wx.chooseLocation`，需要申请「位置信息」。不需要位置功能可删掉相关代码与 `app.json` 里的 `requiredPrivateInfos` |
| 广告位 | 流量主 → 广告位管理 | 首页 banner、识猫页 banner、识猫页激励视频、投喂页激励视频；广告 ID 填到「小程序配置 → 广告设置」 |

> 这些配置存在数据库 `setting.pages` 里，不用改代码：管理员在小程序内「关于 → 小程序配置」即可修改。

---

## 五、上传前自检

- [ ] 开发者工具「详情 → 本地设置」里 `OFFLINE_DEMO_MODE` 为 `false`
- [ ] 首页能加载猫猫列表、图片能显示（说明后端与 OSS 都通）
- [ ] 登录正常（不报 401）
- [ ] 编译无「接口无权限」提示（位置接口已申请或已移除）
- [ ] `app.json` 的 `requiredPrivateInfos` 与实际使用一致

---

## 六、常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 图片全部裂图 | OSS 签名失败或域名不对 | 检查后端 `OSS_*`；确认 `config.js` 的 OSS 域名与后端一致 |
| 请求全部失败 | `API_BASE_URL` 错或域名未配置 | 公众平台补服务器域名；确认后端 `/health` 可访问 |
| 编译报 `wx.chooseLocation` 无权限 | 位置接口未申请 | 见上表；或让维护者移除位置功能 |
| 页面白屏 | 某个 wxml 语法/组件缺失 | 看开发者工具 Console 第一条红色报错 |
