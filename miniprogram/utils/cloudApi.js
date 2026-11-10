/**
 * utils/cloudApi.js —— 云函数（unionOp）能力收敛层
 * ============================================================================
 * 【职责】把原 EMAS SDK 的 function.invoke('unionOp', {...}) 的 30+ 个包装
 *        函数统一改走 api.callUnionOp（POST /api/unionOp），对外导出名与参数保持
 *        不变，页面无需改动。另含识猫（meowid / catFace）的长任务超时与错误归一化。
 * 【依赖】../config.js、./api.js、./page.js（getGlobalSettings）、./recognize.js
 * 【注意事项】
 *  1. openid 由服务端从 JWT 注入，客户端不再自行拼装（后端会忽略客户端传值）。
 *  2. 网关/超时/未迁移动作（501）由 api.js 抛出带文案的 Error，绝不静默
 *     （对应 PR#170 的 9aa94b8 修复精神）。
 *  3. 识猫长任务用 MEOWID_TIMEOUT_MS 临时放大传输超时，finally 中恢复，
 *     避免污染后续普通请求。
 * ============================================================================
 */
import config from '../config';
import api from './api';
import { getGlobalSettings } from './page';
import { getRecognizeMode, normalizeRecognizeResponse } from './recognize';

/** 调用后端 unionOp 并取 result；附带统一错误日志 */
async function invoke(unionAction, args = {}) {
  const res = await api.callUnionOp(unionAction, args);
  return res.result;
}

/**
 * 当前用户 openid（保留历史导出名，实现改为读登录会话）。
 * @returns {Promise<string>}
 */
async function getCurrentUserOpenid() {
  return api.getOpenid();
}

/**
 * 保留历史行为：返回当前时间（原实现即返回 new Date()，不做格式化）。
 * @param {Date|string|number} date 原参数保留但未被使用
 * @returns {Date}
 */
function getDate(date) {
  date = date ? new Date(date) : new Date();
  return new Date();
}

// ---------------------------------------------------------------- 管理端 / 通用
/** 管理端通用 CRUD；options 内 operation/collection/item_id/data/query 原样透传 */
async function curdOp(options) { return invoke('curdOp', options); }
/** 当前用户资料 */
async function userOp(options) { return invoke('userOp', options); }
/** 发送订阅消息 */
async function sendMsgV2(options) { return invoke('sendMsgV2', options); }

/**
 * 生成小程序码。
 * @param {object} options { _id, scene, page }
 */
async function getMpCode(options) {
  return invoke('getMpCode', {
    _id: options._id,
    scene: options.scene,
    page: options.page,
    width: 500,
    use_private_tencent_cos: config.use_private_tencent_cos,
  });
}

/** 照片管理（check 走识猫长任务通道） */
async function managePhoto(options) {
  if (options.type === 'check') {
    return invokeRecognition('unionOp', { ...options, unionAction: 'managePhoto' }, MEOWID_TIMEOUT_MS);
  }
  return invoke('managePhoto', options);
}

/**
 * 后端生成压缩图与水印图（压缩 + 水印 + 写库一次完成）。
 * @param {object} options { photo_id }
 * @returns {Promise<object>} res.result.data = { compressed, watermark, compressedKey, watermarkKey }
 */
async function processPhoto(options) { return invoke('processPhoto', options); }

/** 科普文章列表 */
async function getAllSci(options) { return invoke('getAllSci', options); }
/** 更新猫资料 */
async function updateCat(options) { return invoke('updateCat', options); }

/**
 * 内容安全检查（留言/昵称）。
 * @param {string} content 文本内容
 * @param {string} nickname 昵称
 * @returns {Promise<object|undefined>} 不通过时返回 { title, content, showCancel }，通过返回 undefined
 */
async function contentSafeCheck(content, nickname) {
  const label_type = {
    100: '正常', 10001: '广告', 20001: '时政', 20002: '色情', 20003: '辱骂',
    20006: '违法犯罪', 20008: '欺诈', 20012: '低俗', 20013: '版权', 21000: '其他',
  };
  const res = await invoke('commentCheck', { content, nickname });
  console.log('contentSafeCheck', res);
  if (res.errCode != 0 && res.errcode != 0) {
    return { title: '内容检测未通过', content: `接口访问错误，错误码${res.errcode}`, showCancel: false };
  }
  const label_code = res.result.label;
  const label = label_type[label_code];
  if (label_code != 100) {
    return { title: '内容检测未通过', content: `涉及[${label_code}]${label}内容，请修改嗷~~`, showCancel: false };
  }
  return;
}

// ---------------------------------------------------------------- 徽章
/** 获取用户徽章 */
async function getBadge(options) { return invoke('getBadge', options); }
/** 发放徽章 */
async function giveBadge(options) { return invoke('giveBadge', options); }
/** 生成徽章二维码 */
async function genBadgeCode(options) { return invoke('genBadgeCode', options); }
/** 加载徽章码（走 curdOp read） */
async function loadBadgeCode(options) {
  return invoke('curdOp', {
    ...options,
    operation: 'read',
    collection: 'badge_code',
    where: options.where,
    skip: options.skip,
    limit: options.limit,
  });
}

// ---------------------------------------------------------------- 统计 / 关系 / 资料
/** 用户个人数据统计 */
async function getUserStats(options) { return invoke('getUserStats', options); }
/** 更新猫评分 */
async function updateCatRating(options) { return invoke('updateCatRating', options); }
/** 猫统计 */
async function getCatStats(options) { return invoke('getCatStats', options); }
/** 更新关注列表 */
async function updateFollowCats(options) { return invoke('updateFollowCats', options); }
/** 疫苗接种记录 */
async function vaccineOp(options) { return invoke('vaccineOp', options); }
/** 领养流程 */
async function adoptionOp(options) { return invoke('adoptionOp', options); }
/** 医疗记录 */
async function medicalOp(options) { return invoke('medicalOp', options); }
/** 成就数量排行榜 */
async function getAchievementRank(options) { return invoke('getAchievementRank', options); }
/** 更新猫的关系 */
async function catRelationOp(options) { return invoke('catRelationOp', options); }
/** 管理关系规则 */
async function manageRelationRules(options) { return invoke('manageRelationRules', options); }
/** 初始化疫苗类型 */
async function initVaccineTypes(options) { return invoke('initVaccineTypes', options); }

// ---------------------------------------------------------------- 识猫
// 原 catFace 保持 30s；MeowID 与审核上传等待上限 55s（原 EMAS 硬上限 60s，留 5s 余量）。
const MEOWID_TIMEOUT_MS = 55000;

/** 云函数版本落后的可操作提示 */
const FUNCTION_OUTDATED_MSG = '云函数未更新，请重新部署 unionOp';

/**
 * 识猫长任务调用：临时放大传输超时，结束恢复。
 * @param {string} functionName 'unionOp' 或 'catFace'（后者映射为同名 action）
 * @param {object} options 参数（unionOp 时含 unionAction）
 * @param {number} timeout 超时毫秒
 * @returns {Promise<any>} 云函数 result
 */
async function invokeRecognition(functionName, options, timeout) {
  const oldTimeout = api.setTransportTimeout(timeout);
  try {
    const isUnionOp = functionName === 'unionOp';
    const action = isUnionOp ? options.unionAction : functionName;
    const args = { ...options };
    if (isUnionOp) delete args.unionAction;
    const response = await api.callUnionOp(action, args, { timeout });
    return response ? response.result : response;
  } finally {
    api.setTransportTimeout(oldTimeout);
  }
}

/**
 * 归一化 MeowID 返回：识别「云函数版本落后」与通用错误，给出可操作文案。
 * @param {object} result 云函数 result
 * @returns {object}
 */
function normalizeMeowidResult(result) {
  if (!result || typeof result !== 'object') return result;
  const body = !('ok' in result) && result.data && typeof result.data === 'object' && 'ok' in result.data
    ? result.data : result;
  if (typeof body.errMsg !== 'string' || body.msg) return body;
  if (/unknown action/i.test(body.errMsg)) return { ok: false, code: 'function_outdated', msg: FUNCTION_OUTDATED_MSG };
  return { ok: false, code: 'function_error', msg: '识猫服务返回错误：' + body.errMsg };
}

/**
 * MeowID 识猫。网关/未迁移(501)异常转成结构化结果，保留可操作提示且不静默。
 * @param {object} options 识猫参数
 * @returns {Promise<object>} 归一化结果
 */
async function meowid(options) {
  try {
    const result = await invokeRecognition('unionOp', { ...options, unionAction: 'meowid' }, MEOWID_TIMEOUT_MS);
    return normalizeMeowidResult(result);
  } catch (e) {
    const outdated = /未迁移|501|outdated|unknown action/i.test(e.message || '');
    return {
      ok: false,
      code: outdated ? 'function_outdated' : 'function_error',
      msg: outdated ? FUNCTION_OUTDATED_MSG : (e.message || '识猫服务调用失败'),
    };
  }
}

/**
 * 统一识猫入口：按页面设置选择 off / meowid / custom 模式。
 * @param {object} options 识猫参数
 * @returns {Promise<object>} 归一化后的识别结果
 */
async function catFace(options = {}) {
  const settings = await getGlobalSettings('recognize', { nocache: true });
  const mode = getRecognizeMode(settings);
  if (mode === 'off') return { ok: false, code: 'recognition_disabled', msg: '识猫功能已关闭' };
  if (mode === 'custom' && options.action && options.action !== 'search') {
    return { ok: false, code: 'unsupported_action', msg: '原识猫服务不支持此操作' };
  }
  if (mode === 'meowid') {
    const response = await meowid(options);
    return normalizeRecognizeResponse(response, mode);
  }
  // custom 模式对应原「独立部署识猫函数 catFace」，它不在自建后端
  // /api/unionOp 的 actionMap 中。捕获网关错误并转成可操作的结构化结果，
  // 避免上层笼统显示「网络失败」，也绝不静默吞掉（对应 9aa94b8 精神）。
  try {
    const response = await invokeRecognition('catFace', options, 30000);
    return normalizeRecognizeResponse(response, mode);
  } catch (e) {
    const detail = (e && e.message) || '未知错误';
    return {
      ok: false,
      code: 'custom_service_unavailable',
      msg: '独立识猫服务(catFace)未接入自建后端，请在「页面设置」把识猫模式改为 MeowID 或关闭识猫。原文：' + detail,
    };
  }
}

module.exports = {
  curdOp,
  userOp,
  sendMsgV2,
  getMpCode,
  managePhoto,
  processPhoto,
  getAllSci,
  contentSafeCheck,
  updateCat,
  getDate,
  getBadge,
  giveBadge,
  genBadgeCode,
  loadBadgeCode,
  getUserStats,
  updateCatRating,
  getCatStats,
  updateFollowCats,
  vaccineOp,
  adoptionOp,
  medicalOp,
  getAchievementRank,
  catRelationOp,
  manageRelationRules,
  initVaccineTypes,
  catFace,
  meowid,
  getCurrentUserOpenid,
};
