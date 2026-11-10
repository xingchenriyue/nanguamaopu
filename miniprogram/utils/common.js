/**
 * utils/common.js —— 共享基础能力（避免循环引用）
 * ============================================================================
 * 【职责】统一导出：当前用户 openid、文件下载、OSS 文件上传、私有桶图片签名、
 *        时间格式化。具体实现均已下沉到 utils/api.js / utils/oss.js。
 * 【依赖】./api.js、./oss.js、./demo.js（离线 Demo）、../config.js
 * 【注意事项】
 *  1. 本文件不再引入腾讯云 COS SDK，也不再持有 app.cos 实例；
 *     私有桶读图改由后端 /api/oss/sign 签名，签名缓存短于有效期（见 oss.js）。
 *  2. 签名失败/网络异常由底层抛出带文案的 Error，绝不静默返回无效链接。
 *  3. 保持历史导出名不变，避免上层 50+ 处 import 改动。
 * ============================================================================
 */
import api from './api';
import oss from './oss';
import { isDemoMode, createMockMpServerless } from './demo';

/**
 * 获取当前用户 openid。
 * @returns {Promise<string|null>} 成功返回 openid，异常返回 null
 */
async function getCurrentUserOpenid() {
  try {
    return await api.getOpenid();
  } catch (error) {
    console.error('[common] getCurrentUserOpenid 失败：', error);
    return null;
  }
}

/**
 * 下载文件到本地临时路径。
 * 离线 Demo / 本地相对路径直接返回，避免 "downloadFile:fail url not in domain list"。
 * @param {string} filePath 文件 URL 或本地路径
 * @returns {Promise<{tempFilePath:string, statusCode:number}>}
 */
async function downloadFile(filePath) {
  if (!filePath || filePath.startsWith('/') || !filePath.startsWith('http')) {
    return { tempFilePath: filePath, statusCode: 200 };
  }
  const app = getApp();
  if (app && app.globalData && app.globalData.demoMode) {
    return { tempFilePath: filePath, statusCode: 200 };
  }
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: filePath,
      success(res) {
        console.log('[common] downloadFile success', res.statusCode);
        resolve(res);
      },
      fail(err) {
        const e = new Error('下载文件失败：' + ((err && err.errMsg) || '未知原因') + '；请检查 downloadFile 合法域名');
        e.code = 'DOWNLOAD_FAIL';
        console.error('[common]', e.message, err);
        reject(e);
      },
    });
  });
}

/**
 * 上传文件到 OSS（直传）。离线 Demo 返回模拟结果。
 * @param {object} options { filePath, cloudPath }
 * @returns {Promise<{fileUrl:string, fileId:string, key?:string}>}
 */
async function uploadFile(options) {
  if (isDemoMode()) {
    return createMockMpServerless().file.uploadFile(options);
  }
  return oss.uploadFile(options);
}

/**
 * 私有桶图片签名 URL（历史名 signCosUrl，保留以兼容 50+ 处调用）。
 * 实现已迁移到 utils/oss.js：识别 OSS key -> 后端签名 -> 缓存时长短于签名有效期。
 * @param {string} inputUrl 图片 URL / OSS 对象 key / 本地路径
 * @returns {Promise<string>} 可直接用于 <image src> 的 URL
 */
async function signCosUrl(inputUrl) {
  return oss.signImageUrl(inputUrl);
}

/**
 * 归一化后端写操作的返回体，剥掉多一层 result。
 *
 * 【为什么要剥一层】
 * 运行时的 ctx.mpserverless.db 是后端 src/db/pg.js 的 **emasDb 视图**，
 * 它的写操作返回的是「包了一层 result 的 { result, ok }」结构（服务器实测）：
 *   add    → { result: { insertedId, acknowledged }, ok: true }
 *   update → { result: { matchedCount, modifiedCount, acknowledged }, ok: true }
 *   remove → { result: { deletedCount, acknowledged }, ok: true }
 * 再经 /api/unionOp 包一层、api.callUnionOp 再剥一层后，客户端最终拿到的是
 *   { result: { ... }, ok: true }
 * 所以 **insertedId 在 res.result.insertedId，不在 res.insertedId**。
 * 旧代码直接读 `res.insertedId` 得到 undefined → 新建记录后拿不到 _id，
 * 表现为「保存了但记录对不上 / 再次保存变成新增一条」。
 *
 * @param {object} res curdOp 的返回值
 * @returns {object} { ok, insertedId, matchedCount, deletedCount, raw }
 */
function normalizeWriteResult(res) {
  const raw = (res && typeof res === 'object') ? res : {};
  const inner = (raw.result && typeof raw.result === 'object') ? raw.result : raw;
  return {
    ok: isWriteOk(raw),
    insertedId: inner.insertedId !== undefined ? inner.insertedId : raw.insertedId,
    matchedCount: typeof inner.matchedCount === 'number' ? inner.matchedCount : 0,
    deletedCount: typeof inner.deletedCount === 'number' ? inner.deletedCount : 0,
    raw,
  };
}

/**
 * 格式化时间为 "YYYY-MM-DD HH:mm:ss"。
 * @param {Date} date
 * @returns {string}
 */
function formatTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

/**
 * 判定后端写操作（curdOp）是否成功。
 *
 * 【返回体的精确形状 —— 服务器实测，2026-11-09】
 * 运行时的 ctx.mpserverless.db 是后端 src/db/pg.js 的 **emasDb 视图**，
 * 它的写操作返回的是「包了一层 result 的 { result, ok }」结构：
 *   UPDATE → { result: { matchedCount, modifiedCount, acknowledged }, ok: true }
 *   DELETE → { result: { deletedCount, acknowledged }, ok: true }
 * 再经 /api/unionOp 包一层、api.callUnionOp 再剥一层后，客户端最终拿到的是
 *   { result: { matchedCount, ... }, ok: true }
 * 所以**计数在 res.result.matchedCount，不在 res.matchedCount**。
 * 而旧 EMAS 的契约是 `res.n`（等于 1 表示成功），后端从未实现过该字段
 * —— 全工程 grep 后端 src/handlers 无任何一处返回 n。
 * 原判定 `res.ok && res.n == 1`：`res.ok` 为 true，但 `res.n` 是 undefined，
 * `undefined == 1` 为 false → 整体恒假 → 明明写入成功却提示「更新失败」。
 *
 * @param {object} res curdOp 的返回值
 * @returns {boolean} true 表示写入成功
 */
function isWriteOk(res) {
  if (!res || typeof res !== 'object') return false;
  // 后端显式给出业务失败（{ ok:false, errMsg }）时直接判失败
  if (res.ok === false) return false;
  // 两层都查：兼容「嵌套 result」与「扁平」两种形状
  const inner = (res.result && typeof res.result === 'object') ? res.result : res;
  // add：拿到 insertedId 即成功
  if (inner.insertedId !== undefined && inner.insertedId !== null) return true;
  // update / inc：matchedCount >= 1 表示命中了目标记录
  if (typeof inner.matchedCount === 'number' && inner.matchedCount >= 1) return true;
  // remove：deletedCount >= 1 表示删掉了
  if (typeof inner.deletedCount === 'number' && inner.deletedCount >= 1) return true;
  // set（findOneAndUpdate）：返回了文档即成功
  if (inner.value !== undefined) return true;
  // 兼容旧 EMAS 的 { n: 1 } 契约（若后端将来补上）
  if (typeof inner.n === 'number' && inner.n >= 1) return true;
  return false;
}

module.exports = {
  getCurrentUserOpenid,
  downloadFile,
  uploadFile,
  signCosUrl,
  isWriteOk,
  normalizeWriteResult,
  formatTime,
};
