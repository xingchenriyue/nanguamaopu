/**
 * pages/debug/deployTip/deployConfig.js —— 部署自检清单
 * ============================================================================
 * 【职责】为 deployTip.js 提供四类静态清单：
 *        REQUIRED_CONFIG（必填配置校验规则）、REQUIRED_COLLECTIONS（集合名）、
 *        SYSTEM_IMAGES（系统图片）、legalDomainHint（合法域名/合规提示文案）。
 * 【依赖】../../../config.js（系统图片与域名全部从 config 读取，不写死）
 * 【注意事项】原文件里的 EMAS 云函数版本表、func_configs、科普/设置初始化种子数据
 *        属于上游云函数部署遗留；自建后端的数据迁移由后端脚本负责，故不再保留在此。
 *        如需种子数据请查后端 data/exports 与 git 历史。
 * ============================================================================
 */
import config from '../../../config';

/** 合法 HTTPS 域名（排除示例占位值） */
function isUsableHttps(v) {
  return typeof v === 'string'
    && /^https:\/\/[^\s/]+\.[^\s/]+/i.test(v)
    && !/example\.com|your[-_]/i.test(v);
}

/**
 * config.js 必填项：{ key, label, validate(value), fix(失败时的修复建议) }
 * deployTip.js 会遍历并逐项调用 validate，失败时把 label + fix 展示给用户。
 */
const REQUIRED_CONFIG = [
  {
    key: 'API_BASE_URL', label: '后端 API 反代域名',
    validate: isUsableHttps,
    fix: '在 config.js 填 API_BASE_URL：已备案的 HTTPS 反代域名（指向 127.0.0.1:8000）。注意它是 API 域名，不是 OSS CNAME。',
  },
  {
    key: 'OSS_EXTERNAL_ENDPOINT', label: 'OSS 外网 endpoint',
    validate: isUsableHttps,
    fix: '填 OSS_EXTERNAL_ENDPOINT（当前值：' + config.OSS_EXTERNAL_ENDPOINT + '）。',
  },
  {
    key: 'OSS_CNAME_ENDPOINT', label: 'OSS CNAME 域名',
    validate: (v) => !v || isUsableHttps(v),
    fix: 'OSS_CNAME_ENDPOINT 若填写必须是 HTTPS 域名；不启用 CNAME 时可留空。',
  },
  {
    key: 'OSS_BUCKET', label: 'OSS 私有桶名',
    validate: (v) => typeof v === 'string' && v.length > 0,
    fix: '填 OSS_BUCKET = nanhuamaopu（该桶名是正确值，勿改成项目名 nanguamaopu）。',
  },
  {
    key: 'app_id', label: '小程序 AppID',
    validate: (v) => typeof v === 'string' && /^wx[0-9a-f]{16}$/i.test(v),
    fix: '填 app_id，并确认与 project.config.json 的 appid、后端 WX_APPID 一致。',
  },
  {
    key: 'app_version', label: '版本号',
    validate: (v) => typeof v === 'string' && v.length > 0,
    fix: '填 app_version（如 v1.20.1）。',
  },
  {
    key: 'LOGO_PATH', label: 'LOGO 固定路径',
    validate: (v) => typeof v === 'string' && /^\/.*\.png$/i.test(v),
    fix: '填 LOGO_PATH（默认 /pages/public/images/system/logo.png），并把 LOGO.png 放到该路径。',
  },
  {
    key: 'OSS_SIGN_CACHE_MARGIN_SECONDS', label: '签名缓存安全余量',
    validate: (v) => Number(v) >= 0 && Number(v) < 900,
    fix: '填 0~899 的秒数（默认 60）。缓存时长必须短于 900s 签名有效期。',
  },
  {
    key: 'OFFLINE_DEMO_MODE', label: '离线 Demo 开关',
    validate: (v) => v === false,
    fix: '正式部署必须把 OFFLINE_DEMO_MODE 改为 false，否则不会请求真实后端。',
  },
  {
    key: 'map_center', label: '地图中心坐标',
    validate: (v) => v && Number.isFinite(v.latitude) && Number.isFinite(v.longitude),
    fix: '填 map_center: { latitude, longitude }。',
  },
  {
    key: 'theme', label: '主题色板',
    validate: (v) => v && typeof v.primary === 'string' && /^#[0-9a-f]{6}$/i.test(v.primary),
    fix: '确认 theme.primary 与 app.wxss 的 --brand-primary 一致（换 LOGO 后同步改这两处）。',
  },
];

/** 需确认已初始化的数据库集合（均在后端 /api/db 白名单内） */
const REQUIRED_COLLECTIONS = [
  'photo', 'cat', 'comment', 'user', 'setting', 'feedback',
  'badge_def', 'badge', 'badge_rank', 'badge_code', 'news',
  'inter', 'reward', 'achievement', 'rating', 'photo_rank',
  'adoption', 'science', 'vaccine', 'medical', 'relation',
  'filter', 'friendLink', 'subscribeMsg', 'msg', 'follow',
];

/** 系统图片清单（label -> config 中的地址），检查时会先签名再探测下载 */
const SYSTEM_IMAGES = {
  '科普1.png': config.science_imgs[0],
  '科普2.png': config.science_imgs[1],
  '科普3.png': config.science_imgs[2],
  '科普4.png': config.science_imgs[3],
  '科普5.png': config.science_imgs[4],
  '赞赏码.jpg': config.reward_img,
  '新猫问卷.png': config.feedback_wj_img,
  '菊花码.jpg': config.mpcode_img,
  'badge_rank_count.png': config.badge_rank_count_img,
  'badge_rank_score.png': config.badge_rank_score_img,
};

/**
 * 说明：部署检查页的 9 个检查项**不检查** unionOp action 覆盖度，
 * 因此 catFace 等未注册 action 不会在检查页显示为「通过/未通过/提示」中的任何一种。
 * catFace 是原「独立部署识猫函数」，非标准 unionOp action，自建后端未注册；
 * 其 custom 模式的降级行为属于识猫功能运行时范畴，见 utils/cloudApi.js 的
 * catFace()（返回 code='custom_service_unavailable' + 明确可操作文案，绝不静默），
 * 默认 recognize_default_mode='off'，不影响上线前自检结论。
 */

/**
 * 合法域名与合规待办提示（信息项，恒展示）。
 * @returns {string} 多行提示文案
 */
function legalDomainHint() {
  return [
    '1. 微信公众平台「开发管理 → 服务器域名」：',
    '   · request 合法域名填 config.API_BASE_URL（后端反代域名，已备案 + HTTPS）；',
    '   · uploadFile / downloadFile 合法域名填 OSS 外网 endpoint 或 CNAME 域名。',
    '   · 切勿把 OSS CNAME 填成 API_BASE_URL，二者是独立配置项。',
    '2. 「用户隐私保护指引」：收集 openid、头像昵称、位置、照片属用户信息处理，',
    '   需配置指引并在调用前完成授权弹窗（以微信官方最新审核规范为准）。',
    '3. 提审前确认 AppID 与后端 WX_APPID/WX_SECRET 一致，避免测试/正式环境混淆。',
    '4. 服务器域名需已完成 ICP 备案且为 HTTPS；证书由用户侧反代提供。',
  ].join('\n');
}

module.exports = {
  REQUIRED_CONFIG,
  REQUIRED_COLLECTIONS,
  SYSTEM_IMAGES,
  legalDomainHint,
};
