# 南瓜猫谱（nanguamaopu）

校园流浪猫图鉴微信小程序。记录校园里的每一只猫：照片、性格、常出没地点、关系图谱、领养与绝育状态，
还能在校园里随手拍一张照片，让小程序帮你认出它是谁。

> 数据后端自建：Node.js + PostgreSQL + 阿里云 OSS，见 `nanguamaopu-backend` 仓库。

---

## 功能

| 模块 | 说明 |
|---|---|
| 猫猫图鉴 | 猫猫列表、筛选（校区/区域/花色/状态）、详情相册、关系图谱 |
| 拍照识猫 | 拍一张照片，返回最相似的几只猫；次数与激励视频可在页面配置里调 |
| 照片墙 | 上传、审核、精选、点赞、打赏投喂 |
| 便利贴 | 在猫猫详情页留言、回复、审核 |
| 徽章成就 | 拍照、便利贴、普查等成就，收集榜与月榜，个人主页可展示徽章 |
| 猫猫地图 | 校园地图上展示猫猫分布与常出没地点 |
| 管理后台 | 小程序内管理：审核、人员权限、页面配置、识猫服务、徽章码 |

---

## 快速开始

### 1. 改一个文件

打开 `miniprogram/config.js`，填这几项就够了（其余保持默认）：

| 字段 | 填什么 |
|---|---|
| `API_BASE_URL` | 你的后端 HTTPS 域名 |
| `app_id` | 小程序 AppID |
| `OSS_BUCKET` / `OSS_EXTERNAL_ENDPOINT` | 你的 OSS 桶与 Endpoint |
| `OSS_USE_CNAME` / `OSS_CNAME_ENDPOINT` | 用自定义域名读图才需要 |
| `map_center` | 你学校的坐标 |
| `OFFLINE_DEMO_MODE` | 正式部署填 `false` |

### 2. 换一张 LOGO

替换 `miniprogram/pages/public/images/system/logo.png`（建议 200x200 PNG，透明背景）。

### 3. 安装依赖

```bash
cd miniprogram
npm install
```

然后在微信开发者工具里点 **工具 → 构建 npm**。

### 4. 部署后端

见后端仓库的 `docs/DEPLOY.md`：`bash deploy/install.sh` 一条命令完成建库建表与启动。

---

## 目录结构

```
miniprogram/
  app.js / app.json / app.wxss   全局入口与配置
  config.js                      【唯一需要改的文件】域名、AppID、OSS、文案、地图中心
  utils/                         请求封装、数据层 facade、缓存、布局、识别、OSS 等
  components/                    毛玻璃导航栏、猫猫卡片、日历、弹窗等
  pages/                         主包：首页、猫谱、地图、关于、排行榜
  pages/packageA/                分包：识猫、徽章、各类详情
  pages/manage/                  分包：管理后台（审核/人员/页面配置）
  pages/genealogy/               分包：猫猫详情、上传、便利贴、反馈
  pages/info/                    分包：个人主页、成就、反馈、协议
```

---

## 开发要点

- **配置集中在 `config.js`**：域名、OSS、文案、地图中心、开关都在这里，页面不写死
- **数据层 facade**：`utils/api.js` + `utils/db.js` 把后端接口包成 EMAS 风格，业务代码改动小
- **毛玻璃导航**：`components/glass-nav` 统一顶栏；页面用 `initLayout()` 取占位高度
- **缓存策略**：列表/详情走本地缓存 + 过期时间，过期后静默刷新
- **识猫**：次数与广告由服务端快照驱动，管理员可在「人员管理」里改

---

## 部署与迁移

| 文档 | 内容 |
|---|---|
| `README-配置说明.md` | 小程序端配置逐项说明 |
| 后端 `docs/DEPLOY.md` | 从零部署（OSS、微信后台、接口权限要配什么） |
| 后端 `docs/MIGRATION.md` | 从 EMAS 迁移数据库与图片 |

---

## 致敬

这个小程序源自开源项目 **笃行猫谱（sysucats/zhongdamaopu）**，
页面结构、交互逻辑与数据模型大量沿用上游，感谢原作者与所有贡献者。

本项目在其基础上做了：自建后端（脱离 EMAS）、拍照识猫、徽章系统、权限人群与广告次数等扩展。

---

## License

沿用上游的开源许可；部分页面与资源版权归上游作者所有。
