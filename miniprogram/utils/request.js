/**
 * utils/request.js —— 统一 HTTP 请求层
 * ============================================================================
 * 【职责】封装 wx.request：拼接 baseURL、自动带 Authorization: Bearer <token>、
 *        统一构造带明确文案的错误、登录态失效自动重登并重试一次。
 * 【依赖】../config.js（API_BASE_URL / REQUEST_TIMEOUT_MS / RELOGIN_MAX_RETRY）
 * 【注意事项】
 *  1. 网关错误 / 超时 / 网络失败**绝不静默**：一律 console.error 并 reject 带
 *     code/statusCode 的 Error，由上层展示；对应已合并的 9aa94b8 修复精神。
 *  2. 本文件不读取也不写入任何密钥；token 是短期登录态，存于 wx storage。
 *  3. 除 /api/login 与 /health 外的请求都会先确保已登录（懒登录）。
 *  4. 所有请求路径以 / 开头，例如 '/api/db/photo/find'。
 * ============================================================================
 */
import config from '../config';

const TOKEN_KEY = 'mp_token';
const OPENID_KEY = 'mp_openid';

/** 拼接并规范化 API baseURL（去掉尾部斜杠），避免双斜杠 404 */
function baseURL() {
  return String(config.API_BASE_URL || '').replace(/\/+$/, '');
}

/**
 * 读取本地 token。
 * @returns {string} token，未登录返回空串
 */
function getToken() {
  try { return wx.getStorageSync(TOKEN_KEY) || ''; } catch (e) { return ''; }
}

/**
 * 同步读取 openid（登录成功后写入）。
 * @returns {string} openid 或空串
 */
function getOpenidSync() {
  try { return wx.getStorageSync(OPENID_KEY) || ''; } catch (e) { return ''; }
}

/** 保存登录会话；副作用：写 wx storage */
function setSession(token, openid) {
  wx.setStorageSync(TOKEN_KEY, token);
  if (openid) wx.setStorageSync(OPENID_KEY, openid);
}

/** 清除登录会话；副作用：删 wx storage */
function clearSession() {
  try { wx.removeStorageSync(TOKEN_KEY); wx.removeStorageSync(OPENID_KEY); } catch (e) { /* ignore */ }
}

/**
 * 构造统一的 Error 对象，附带可机读字段，便于上层分类提示。
 * @param {string} message 面向用户的明确文案
 * @param {object} fields 附加字段（code/statusCode/path/detail 等）
 * @returns {Error}
 */
function makeError(message, fields) {
  const err = new Error(message);
  Object.assign(err, { isApiError: true, ...fields });
  return err;
}

/** 调用 wx.login 拿 code；失败不静默 */
function wxLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        if (res && res.code) return resolve(res.code);
        reject(makeError('wx.login 未返回 code，请检查小程序 AppID 配置', { code: 'WX_LOGIN_NO_CODE' }));
      },
      fail(e) {
        reject(makeError('wx.login 调用失败：' + (e && e.errMsg ? e.errMsg : '未知原因'), { code: 'WX_LOGIN_FAIL', detail: e }));
      },
    });
  });
}

/** 并发登录去重：同一时刻只发一次 /api/login */
let loginPromise = null;

/**
 * 登录：wx.login code -> POST /api/login -> { token, openid }。
 * @param {boolean} force 为 true 时忽略本地已有 token 强制重新登录
 * @returns {Promise<{token:string, openid:string}>}
 * @throws 登录失败时抛出带明确文案的 Error
 */
async function login(force = false) {
  if (!force && getToken()) {
    return { token: getToken(), openid: getOpenidSync() };
  }
  if (loginPromise) return loginPromise;
  loginPromise = (async () => {
    const code = await wxLoginCode();
    const data = await rawRequest('POST', '/api/login', { code }, { auth: false });
    if (!data || !data.token) {
      throw makeError('登录失败：后端未返回 token，请检查 /api/login 与 WX_APPID/WX_SECRET 配置', { code: 'LOGIN_NO_TOKEN' });
    }
    setSession(data.token, data.openid);
    return { token: data.token, openid: data.openid || '' };
  })().finally(() => { loginPromise = null; });
  return loginPromise;
}

/** 确保已有登录态，未登录则懒登录 */
async function ensureLogin() {
  if (getToken()) return;
  await login(false);
}

/**
 * 单次底层请求（不含自动重登），返回响应体。
 * @param {string} method HTTP 方法
 * @param {string} path 路径（/ 开头）或完整 URL
 * @param {object} data 请求体 / query
 * @param {object} options { auth, timeout }
 * @returns {Promise<any>} 响应体（已 JSON 解析）
 */
function rawRequest(method, path, data, options) {
  const { auth = true, timeout } = options || {};
  const url = /^https?:\/\//i.test(path) ? path : baseURL() + path;
  const header = { 'content-type': 'application/json' };
  const token = getToken();
  if (auth && token) header.Authorization = 'Bearer ' + token;

  const timeoutMs = timeout || config.REQUEST_TIMEOUT_MS || 15000;
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method,
      data: data || {},
      header,
      timeout: timeoutMs,
      success(res) {
        const status = res.statusCode;
        if (status >= 200 && status < 300) return resolve(res.data);
        const serverMsg = res.data && (res.data.error || res.data.errMsg || res.data.message);
        let msg;
        // 503 = 数据库/依赖暂未就绪（后端约定），属于「稍后重试」，不是鉴权失败，
        // 绝不触发重登（重登只在 401 分支）。上层据 isDbNotReady 展示提示而非报错。
        const isDbNotReady = status === 503
          || (status >= 500 && /数据库暂不可用|MongoDB|MONGODB_URI|暂未就绪/i.test(serverMsg || ''));
        if (status === 401) msg = '登录态已失效（401），请重新进入小程序或检查 /api/login 配置';
        else if (status === 403) msg = '权限不足（403）：' + (serverMsg || '需要管理员权限或集合未授权');
        else if (status === 404) msg = '接口不存在（404）：' + path + '，请检查后端版本与 API_BASE_URL';
        else if (status === 501) msg = '后端能力未实现（501）：' + (serverMsg || '该 unionAction 尚未迁移');
        else if (isDbNotReady) msg = '服务暂不可用（' + status + '，' + (serverMsg || '数据库未就绪')
          + '），请稍后重试；这是暂态故障，不是鉴权失败，无需重新登录';
        else if (status >= 500) msg = '服务器错误（' + status + '）：' + (serverMsg || '请查看后端日志');
        else msg = '请求失败（' + status + '）：' + (serverMsg || '未知错误');
        const err = makeError(msg, {
          code: 'HTTP_' + status, statusCode: status, path, isDbNotReady, detail: res.data,
        });
        console.error('[request] ' + method + ' ' + url, msg, res.data);
        reject(err);
      },
      fail(e) {
        const errMsg = (e && e.errMsg) || '未知原因';
        const isTimeout = /timeout/i.test(errMsg);
        const msg = isTimeout
          ? '请求超时（' + timeoutMs + 'ms）：' + path + '，云端可能仍在执行，请稍后重试'
          : '网络请求失败：' + errMsg + '；请检查 API_BASE_URL、request 合法域名与 HTTPS 证书';
        const err = makeError(msg, {
          code: isTimeout ? 'NETWORK_TIMEOUT' : 'NETWORK_FAIL',
          isNetworkError: true,
          isTimeout,
          path,
          detail: e,
        });
        console.error('[request] ' + method + ' ' + url, msg, e);
        reject(err);
      },
    });
  });
}

/**
 * 统一请求入口：自动带 token、自动重登重试、错误不静默。
 * @param {string} method HTTP 方法
 * @param {string} path 路径（/ 开头）
 * @param {object} data 请求体 / query
 * @param {object} options { auth, timeout, _retried }
 * @returns {Promise<any>}
 * @throws {Error} 带 code/statusCode/isNetworkError 的错误
 */
async function request(method, path, data, options = {}) {
  const { auth = true, _retried = 0 } = options;
  if (auth) await ensureLogin();
  try {
    return await rawRequest(method, path, data, options);
  } catch (err) {
    if (err.statusCode === 401 && auth && _retried < (config.RELOGIN_MAX_RETRY || 0)) {
      clearSession();
      console.warn('[request] 401，重新登录后重试一次：', path);
      await login(true);
      return request(method, path, data, { ...options, _retried: _retried + 1 });
    }
    throw err;
  }
}

/** GET 快捷方法；query 会拼到 URL */
function get(path, query, options) {
  let url = path;
  if (query && Object.keys(query).length) {
    const qs = Object.keys(query)
      .filter(k => query[k] !== undefined && query[k] !== null)
      .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(query[k])))
      .join('&');
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  return request('GET', url, undefined, options);
}

/** POST 快捷方法 */
function post(path, data, options) {
  return request('POST', path, data, options);
}

/**
 * 统一错误提示（供页面 catch 调用）。网络/超时错误绝不静默。
 * @param {Error} err request 层抛出的错误
 * @param {string} fallback 自定义前缀文案
 */
function toastError(err, fallback) {
  const msg = (err && err.message) || fallback || '操作失败，请稍后重试';
  console.error('[request.toastError]', msg, err);
  wx.showToast({ icon: 'none', title: msg.slice(0, 24), duration: 3000 });
}

module.exports = {
  getToken,
  getOpenidSync,
  clearSession,
  login,
  ensureLogin,
  request,
  get,
  post,
  toastError,
};
