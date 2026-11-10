/**
 * pages/debug/deployTip/deployTip.js —— 部署自检页
 * ============================================================================
 * 【职责】逐项检查上线前置条件，给出「通过 / 未通过」与明确修复建议：
 *        config.js 必填项、LOGO 文件、后端 /health、登录接口、OSS 上传签名、
 *        OSS 读图签名、数据库集合初始化、合法域名配置提示。
 * 【依赖】./deployConfig.js、../../../config.js、../../../utils/request.js、
 *        ../../../utils/oss.js、../../../utils/api.js
 * 【注意事项】
 *  1. 任何失败都必须写入 addition 文案，绝不静默；网络/网关异常直接透出原始错误。
 *  2. 检查按依赖顺序执行，前一项 break:true 失败时后续标记为未通过并跳过。
 *  3. 本页仅做探测，不写入任何业务数据（OSS policy 只取签名、不实际上传）。
 * ============================================================================
 */
import dp_cfg from './deployConfig';
import config from '../../../config';
import { get, login, getToken, getOpenidSync } from '../../../utils/request';
import { ossPolicy, ossSign, ossHost, signImageUrl } from '../../../utils/oss';
import { db } from '../../../utils/api';
import { initLayout } from "../../../utils/page";

const STATUS_DOING = 0;
const STATUS_OK = 1;
const STATUS_FAIL = 2;
// 「提示」：部署前的预期状态（如 WX_SECRET 未配置、数据库暂未就绪），
// 不算通过也不算失败，且**不阻断**后续检查项。
const STATUS_WARN = 3;

/** 统一的检查结果构造器 */
function ok(addition) { return { status: STATUS_OK, addition: addition || '' }; }
function fail(addition) { return { status: STATUS_FAIL, addition: addition }; }
function warn(addition) { return { status: STATUS_WARN, addition: addition }; }

/** 判断错误是否为「后端 WX_SECRET / AppSecret 尚未配置」这一部署前预期状态 */
function isAppSecretMissing(e) {
  return /WX_SECRET|WX_APPID|AppSecret|未配置/i.test((e && e.message) || '');
}

/** 判断错误是否为「数据库暂未就绪」(503)，按稍后重试处理，不是鉴权失败 */
function isDbNotReady(e) {
  return !!(e && e.isDbNotReady) || /503|数据库暂不可用|数据库未就绪|稍后重试/i.test((e && e.message) || '');
}

/**
 * ① config.js 必填项检查。
 * @returns {{status:number, addition:string}}
 */
function checkConfig() {
  const problems = [];
  dp_cfg.REQUIRED_CONFIG.forEach((item) => {
    let valid = false;
    try { valid = item.validate(config[item.key]); } catch (e) { valid = false; }
    if (!valid) problems.push('【' + item.label + '】' + item.fix);
  });
  // 额外：API 域名不能与 OSS 域名相同（team-lead 强调的两个域名独立配置）
  const api = String(config.API_BASE_URL || '').replace(/\/+$/, '').toLowerCase();
  const oss = String(ossHost()).replace(/\/+$/, '').toLowerCase();
  if (api && oss && api === oss) {
    problems.push('【域名混用】API_BASE_URL 与 OSS 域名相同了；CNAME 不是 API 域名，请把 API_BASE_URL 改成后端反代域名。');
  }
  if (problems.length) return fail('\n' + problems.join('\n'));
  return ok('已检查 ' + dp_cfg.REQUIRED_CONFIG.length + ' 项必填配置，均有效。');
}

/**
 * ② LOGO 文件存在性检查（用 getImageInfo 验证包内资源可解码）。
 * @returns {Promise<{status:number, addition:string}>}
 */
function checkLogo() {
  const path = config.LOGO_PATH;
  return new Promise((resolve) => {
    wx.getImageInfo({
      src: path,
      success: () => resolve(ok('已找到 LOGO：' + path)),
      fail: (e) => resolve(fail(
        '未找到或无法解码 LOGO 文件：' + path + '（' + ((e && e.errMsg) || '未知错误') + '）。'
        + '请把 LOGO.png 放到该固定路径，文件名与 config.LOGO_PATH 保持一致。'
      )),
    });
  });
}

/**
 * ③ 后端 /health 可达性检查。
 * @returns {Promise<{status:number, addition:string}>}
 */
async function checkHealth() {
  try {
    const data = await get('/health', {}, { auth: false });
    if (data && data.ok === true && data.db === 'up') {
      return ok('后端与 MongoDB 均正常（db: up）。');
    }
    // 后端约定：DB 未就绪时 /health 仍返回 200，但 db:'down'。
    // 这是部署前的预期状态（用户 1Panel 实例还没连上），列为提示项而非阻断项，
    // 因为 /api/oss/policy 与 /api/oss/sign 不依赖 DB，后续仍应继续检查。
    if (data && data.ok === true && data.db === 'down') {
      return warn('后端可达，但数据库暂未就绪（db: down）。'
        + (data.reason ? '原因：' + data.reason + '。' : '')
        + '这是预期状态，MongoDB 连上后会自动恢复；OSS 签名接口不依赖数据库，其余检查继续。');
    }
    return fail('后端返回异常：' + JSON.stringify(data) + '；请检查 1Panel 容器日志与 MONGODB_URI 配置。');
  } catch (e) {
    return fail('无法连接后端 /health：' + e.message + '\n请确认 API_BASE_URL 正确、反代与证书已生效、后端已启动。');
  }
}

/**
 * ④ 登录接口可用性检查。
 * @returns {Promise<{status:number, addition:string}>}
 */
async function checkLogin() {
  try {
    await login(true);
    const token = getToken();
    const openid = getOpenidSync();
    if (!token) return fail('登录接口未返回 token，请检查后端 WX_APPID/WX_SECRET 与 /api/login。');
    return ok('登录成功，已取得登录态' + (openid ? '（openid 已下发）' : '') + '。');
  } catch (e) {
    // WX_SECRET（AppSecret）用户暂未提供，登录返回明确 500 属预期行为。
    // 按 team-lead 要求列为「提示」而非「阻断」，其余检查项继续。
    if (isAppSecretMissing(e)) {
      return warn('后端 WX_SECRET（AppSecret）尚未配置，登录接口暂不可用 —— 这是部署前的预期状态。'
        + '\n用户把 WX_APPID / WX_SECRET 填入后端 .env 后即自动恢复；'
        + '当前不影响 config、LOGO、OSS 签名等其他检查项。\n原文：' + e.message);
    }
    // 503 数据库未就绪：按「稍后重试」处理，绝不当成鉴权失败，也不阻断。
    if (isDbNotReady(e)) {
      return warn('数据库暂未就绪，登录接口返回 503，请稍后重试（不是鉴权失败）。'
        + '\n原文：' + e.message);
    }
    return fail('登录失败：' + e.message + '\n常见原因：AppID 与后端不一致、code2Session 网络不通。');
  }
}

/**
 * ⑤ OSS 上传签名可用性检查（只取签名，不实际上传）。
 * @returns {Promise<{status:number, addition:string}>}
 */
async function checkOssPolicy() {
  try {
    const p = await ossPolicy('png', config.OSS_UPLOAD_PREFIX);
    const missing = ['host', 'key', 'policy', 'signature', 'OSSAccessKeyId']
      .filter((k) => !p[k]);
    if (missing.length) return fail('上传签名缺少字段：' + missing.join(', ') + '；请核对后端 /api/oss/policy 实现。');
    return ok('已取得 PostObject 直传签名（key 前缀 ' + config.OSS_UPLOAD_PREFIX + '）。');
  } catch (e) {
    if (isAppSecretMissing(e) || isDbNotReady(e)) {
      return warn('OSS 上传签名依赖登录态/后端，当前暂不可检查（' + e.message
        + '）。配置好 WX_SECRET 或数据库就绪后点「重新检查」即可。');
    }
    return fail('获取 OSS 上传签名失败：' + e.message);
  }
}

/**
 * ⑥ OSS 读图签名可用性 + 缓存时长校验（缓存必须短于签名有效期）。
 * @returns {Promise<{status:number, addition:string}>}
 */
async function checkOssSign() {
  const key = config.OSS_SYSTEM_PREFIX + '科普1.png';
  try {
    const s = await ossSign(key);
    if (!s || !s.url) return fail('读图签名未返回 url（key=' + key + '）；请核对后端 GET /api/oss/sign。');
    const nowSec = Math.floor(Date.now() / 1000);
    const life = Number(s.expire) > nowSec ? Number(s.expire) - nowSec : null;
    const cache = Number(s.cacheSeconds) || 0;
    if (life !== null && cache >= life) {
      return fail('签名有效期 ' + life + 's，但后端建议缓存 ' + cache + 's（缓存未短于有效期），'
        + '会导致「徽章图片过一会儿只剩名字」。请把 cacheSeconds 调小。');
    }
    return ok('已取得签名 URL，有效期约 ' + (life === null ? '未知' : life + 's')
      + '，缓存 ' + (cache || '未指定') + 's，缓存短于有效期。');
  } catch (e) {
    if (isAppSecretMissing(e) || isDbNotReady(e)) {
      return warn('OSS 读图签名依赖登录态/后端，当前暂不可检查（' + e.message
        + '）。配置好 WX_SECRET 或数据库就绪后点「重新检查」即可。');
    }
    return fail('获取 OSS 读图签名失败：' + e.message + '\n请确认私有桶、OSS_* 环境变量与 /api/oss/sign 已配置。');
  }
}

/**
 * ⑦ 数据库集合初始化检查（逐个 count，失败列出集合名）。
 * @returns {Promise<{status:number, addition:string}>}
 */
async function checkDatabase() {
  const failed = [];
  for (const name of dp_cfg.REQUIRED_COLLECTIONS) {
    try {
      const { result } = await db.collection(name).count({});
      if (typeof result !== 'number') failed.push(name + '（返回非数字：' + JSON.stringify(result) + '）');
    } catch (e) {
      // 503 数据库未就绪：按「稍后重试」处理，立即中止避免连发 26 次请求
      if (isDbNotReady(e)) {
        return warn('数据库暂未就绪（503），集合检查已中止，请稍后重试。\n原文：' + e.message);
      }
      if (isAppSecretMissing(e)) {
        return warn('尚未取得登录态（WX_SECRET 未配置），集合检查暂不可执行，配置后重新检查即可。');
      }
      failed.push(name + '（' + e.message + '）');
    }
  }
  if (failed.length) {
    return fail('以下集合未初始化或被网关拒绝：\n' + failed.join('\n')
      + '\n请运行后端数据迁移脚本，并确认集合名在 /api/db 白名单内。');
  }
  return ok('已检查 ' + dp_cfg.REQUIRED_COLLECTIONS.length + ' 个集合，均可访问。');
}

/**
 * ⑧ 系统图片可读性检查（走签名 URL 后探测下载）。
 * @returns {Promise<{status:number, addition:string}>}
 */
async function checkImages() {
  const failed = [];
  for (const label of Object.keys(dp_cfg.SYSTEM_IMAGES)) {
    const url = dp_cfg.SYSTEM_IMAGES[label];
    if (!url) { failed.push(label + '（config 中未配置）'); continue; }
    try {
      const signed = await signImageUrl(url);
      await new Promise((resolve, reject) => {
        wx.downloadFile({
          url: signed,
          success: (res) => (res.statusCode === 200 ? resolve() : reject(new Error('HTTP ' + res.statusCode))),
          fail: reject,
        });
      });
    } catch (e) {
      // 登录态/DB 未就绪导致整体不可检查：列为提示项，不把 10 张图逐个标为失败
      if (isAppSecretMissing(e) || isDbNotReady(e)) {
        return warn('系统图片签名依赖登录态/后端，当前暂不可检查（' + (e.message || e.errMsg)
          + '）。配置好 WX_SECRET 或数据库就绪后点「重新检查」即可。');
      }
      failed.push(label + '（' + ((e && e.errMsg) || e.message) + '）');
    }
  }
  if (failed.length) {
    return fail('以下系统图片无法读取：\n' + failed.join('\n')
      + '\n请把图片上传到 OSS 私有桶「' + config.OSS_SYSTEM_PREFIX + '」目录，并确认签名接口可用。');
  }
  return ok('系统图片均已可签名读取。');
}

/**
 * ⑨ 合法域名配置提示（信息项，恒为通过，但必须展示待办文案）。
 * @returns {{status:number, addition:string}}
 */
function checkDomains() {
  return ok('\n' + dp_cfg.legalDomainHint());
}

Page({
  data: {
    // 顶部自定义导航栏预留高度（由 initLayout 注入）
    navTotalHeight: 0,
    // 屏幕高度（由 initLayout 注入）
    screenHeight: 0,
    status_to_text: {
      [STATUS_DOING]: '等待中...',
      [STATUS_OK]: '通过',
      [STATUS_FAIL]: '未通过',
      [STATUS_WARN]: '提示',
    },
    status_to_css: {
      [STATUS_DOING]: '',
      [STATUS_OK]: 'success',
      [STATUS_FAIL]: 'fail',
      [STATUS_WARN]: 'warn',
    },
    checking: false,
    check_list: {
      1: { title: 'config.js 必填项', status: STATUS_DOING, func: checkConfig,
        tip: '只需修改 miniprogram/config.js。\n', addition: '', break: true },
      2: { title: 'LOGO 文件', status: STATUS_DOING, func: checkLogo,
        tip: '替换 LOGO_PATH 指向的那一个文件即可。\n', addition: '', break: false },
      3: { title: '后端 /health 可达', status: STATUS_DOING, func: checkHealth,
        tip: '检查后端容器与 MongoDB 是否正常。\n', addition: '', break: true },
      4: { title: '登录接口 /api/login', status: STATUS_DOING, func: checkLogin,
        tip: '检查 AppID、WX_APPID/WX_SECRET 与 code2Session。\n', addition: '', break: true },
      5: { title: 'OSS 上传签名 /api/oss/policy', status: STATUS_DOING, func: checkOssPolicy,
        tip: '检查 OSS_* 环境变量与 PostObject Policy。\n', addition: '', break: false },
      6: { title: 'OSS 读图签名 /api/oss/sign', status: STATUS_DOING, func: checkOssSign,
        tip: '私有桶读图必须走签名 URL，且缓存要短于签名有效期。\n', addition: '', break: false },
      7: { title: '数据库集合初始化', status: STATUS_DOING, func: checkDatabase,
        tip: '逐个集合 count 探测，确认迁移已完成。\n', addition: '', break: false },
      8: { title: '系统图片可读', status: STATUS_DOING, func: checkImages,
        tip: '检查科普图/赞赏码/菊花码等系统资源。\n', addition: '', break: false },
      9: { title: '域名 / 合法域名提示', status: STATUS_DOING, func: checkDomains,
        tip: '上线前在微信公众平台完成以下配置。\n', addition: '', break: false },
    },
  },

  onLoad() {
    // 自定义导航栏 + 悬浮 dock 的布局尺寸
    initLayout(this);
    this.checkProcess();
  },

  /** 重新执行全部检查（供页面按钮调用） */
  onTapRecheck() {
    this.checkProcess();
  },

  /** 顺序执行检查；break 项失败后，后续项标记为未通过并跳过 */
  async checkProcess() {
    if (this.data.checking) return;
    this.setData({ checking: true });
    const check_list = this.data.check_list;
    let failed = false;
    for (const i of Object.keys(check_list)) {
      const item = check_list[i];
      if (failed) {
        this.setData({
          [`check_list.${i}.status`]: STATUS_FAIL,
          [`check_list.${i}.addition`]: '前置检查未通过，已跳过（请先修复上面的失败项）。',
        });
        continue;
      }
      let res;
      try {
        res = await item.func();
      } catch (e) {
        // 检查函数自身抛错也必须有明确文案，绝不静默
        res = fail('检查过程异常：' + ((e && e.message) || String(e)));
        console.error('[deployTip] 检查项 ' + i + ' 异常：', e);
      }
      this.setData({
        [`check_list.${i}.status`]: res.status,
        [`check_list.${i}.addition`]: res.addition || '',
      });
      // 只有「未通过」(STATUS_FAIL) 且该项标记 break 时才阻断后续；
      // 「提示」(STATUS_WARN，如 AppSecret 未配置 / DB 未就绪) 不阻断，继续检查。
      if (res.status === STATUS_FAIL && item.break) failed = true;
    }
    this.setData({ checking: false });
  },
});
