/**
 * utils/api.js —— 后端能力统一收敛层（全项目唯一入口）
 * ============================================================================
 * 【职责】按职责聚合子模块，向外提供与 EMAS SDK 同语义的方法：
 *   - db.collection(x).find/count/findOne/insertOne/updateOne/deleteOne/aggregate
 *   - callUnionOp(action, args)  —— 替代 function.invoke('unionOp', ...)
 *   - login() / getOpenid()      —— 替代 user.getInfo()
 *   - ossPolicy/ossSign/ossSignBatch/uploadFile/signImageUrl —— OSS 上下行
 *   - mpServerless                —— 兼容 facade，兜底任何遗留 SDK 形态调用
 * 【依赖】./request.js、./db.js、./oss.js、../config.js
 * 【注意事项】
 *  1. 本文件不含任何密钥；所有敏感凭证只在后端 .env。
 *  2. 网关错误 / 超时 / 未迁移动作（501）一律抛出带文案的 Error，绝不静默
 *     （对应 PR#170 的 9aa94b8 修复精神）。
 *  3. mpServerless facade 仅作向后兼容兜底；新增代码请直接 import 具体方法。
 * ============================================================================
 */
import config from '../config';
import { post, get, login, ensureLogin, clearSession, getOpenidSync, getToken, toastError } from './request';
import dbModule from './db';
import oss from './oss';

// 模块级传输超时，供识猫等长任务临时放大（对应原 mpServerless.transport.setTimeout）
let transportTimeout = config.REQUEST_TIMEOUT_MS || 15000;

/** 设置后续 unionOp 请求的超时（毫秒），返回旧值 */
function setTransportTimeout(ms) {
  const old = transportTimeout;
  if (Number(ms) > 0) transportTimeout = Number(ms);
  return old;
}

/** 读取当前传输超时 */
function getTransportTimeout() {
  return transportTimeout;
}

/**
 * 调用后端 unionOp 云函数兼容入口。
 * @param {string} unionAction 动作名（curdOp/userOp/getBadge/meowid/catFace ...）
 * @param {object} args 其余参数，原样透传（服务端会忽略客户端传的 openid，由 JWT 注入）
 * @param {object} options { timeout } 可选超时覆盖
 * @returns {Promise<{result:any, ok:boolean}>} 与原 function.invoke 返回体同形
 * @throws 后端 ok:false / 501 未迁移 / 网络异常时抛出带文案的 Error
 */
async function callUnionOp(unionAction, args = {}, options = {}) {
  if (!unionAction) throw new Error('callUnionOp 缺少 unionAction');
  const body = { unionAction, ...args };
  const data = await post('/api/unionOp', body, { timeout: options.timeout || transportTimeout });
  if (!data || typeof data !== 'object') {
    const err = new Error('unionOp 返回异常（' + unionAction + '）：响应不是对象，请检查后端 /api/unionOp');
    err.code = 'UNIONOP_BAD_RESPONSE';
    err.action = unionAction;
    err.detail = data;
    console.error('[api]', err.message, data);
    throw err;
  }
  if (data.ok === false) {
    const err = new Error('unionOp 执行失败（' + unionAction + '）：' + (data.error || data.errMsg || '未知错误'));
    err.code = 'UNIONOP_FAIL';
    err.action = unionAction;
    err.detail = data;
    console.error('[api]', err.message, data);
    throw err;
  }
  return { result: data.result, ok: true };
}

/**
 * 异步取当前用户 openid（登录成功后缓存在本地）。
 * @returns {Promise<string>} openid
 */
async function getOpenid() {
  const cached = getOpenidSync();
  if (cached) return cached;
  const session = await login(false);
  return session.openid || getOpenidSync();
}

/** 从参数对象中剔除 unionAction，供 facade 的 function.invoke 使用 */
function omitAction(params) {
  const out = {};
  Object.keys(params || {}).forEach((k) => {
    if (k !== 'unionAction') out[k] = params[k];
  });
  return out;
}

/**
 * 兼容 facade：让遗留的旧式 SDK 调用零改动地走自建后端。
 * 新增代码请勿使用，直接 import 本文件的方法。
 */
const mpServerless = {
  db: dbModule,
  function: {
    /**
     * @param {string} name 云函数名；unionOp 走 action 分发，其余（如 catFace）
     *        统一按同名 action 走 /api/unionOp，未迁移会返回明确 501 而非静默。
     * @param {object} params 参数
     */
    async invoke(name, params = {}) {
      if (name === 'unionOp') return callUnionOp(params.unionAction, omitAction(params));
      return callUnionOp(name, params);
    },
  },
  user: {
    /** 返回与原 user.getInfo 同形的结果，openid 取自登录会话 */
    async getInfo() {
      const openid = await getOpenid();
      return { success: true, result: { user: { oAuthUserId: openid } } };
    },
  },
  file: {
    /** OSS 直传，返回 { fileUrl, fileId } */
    uploadFile: oss.uploadFile,
  },
  transport: {
    get timeoutOption() { return getTransportTimeout(); },
    setTimeout(ms) { return setTransportTimeout(ms); },
  },
  init() { /* 自建后端无需初始化 */ },
};

module.exports = {
  // 数据库
  db: dbModule,
  collection: dbModule.collection,
  command: dbModule.command,
  // 云函数 / 登录
  callUnionOp,
  login,
  ensureLogin,
  clearSession,
  getOpenid,
  getOpenidSync,
  getToken,
  // OSS
  ossPolicy: oss.ossPolicy,
  ossSign: oss.ossSign,
  ossSignBatch: oss.ossSignBatch,
  signImageUrl: oss.signImageUrl,
  uploadFile: oss.uploadFile,
  ossHost: oss.ossHost,
  // 传输 / 错误
  setTransportTimeout,
  getTransportTimeout,
  request: { get, post, toastError },
  // 兼容兜底
  mpServerless,
};
