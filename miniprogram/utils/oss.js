/**
 * utils/oss.js —— OSS 上传 / 私有桶签名读取收敛层
 * ============================================================================
 * 【职责】
 *   - 上传：POST /api/oss/policy 取 PostObject 直传签名 -> wx.uploadFile 直传 OSS，
 *          图片不经过 ECS 出站带宽；返回 { fileUrl, fileId } 供原调用点使用。
 *   - 读取：OSS 为私有桶，所有图片 URL 必须经后端 /api/oss/sign 换签名 URL。
 *   - 签名 URL 缓存：**缓存时长严格短于签名有效期**（cacheSeconds 再减余量），
 *          杜绝本项目已修复的「徽章图片过一会儿只剩名字」bug 再次引入。
 * 【依赖】./request.js（get/post）、../config.js（OSS_* 配置、OFFLINE_DEMO_MODE）
 * 【注意事项】
 *  1. 小程序端只有外网 endpoint / CNAME，绝不写内网 endpoint 或任何 AccessKey。
 *  2. 公网可直读的外部 URL（如微信头像）与小程序本地路径原样返回，不签名。
 *  3. 签名失败/接口异常一律抛出带文案的 Error，绝不静默返回过期或无效链接。
 * ============================================================================
 */
import config from '../config';
import { get, post } from './request';

const SIGN_CACHE_PREFIX = 'oss-sign-';
const DEMO = !!config.OFFLINE_DEMO_MODE;

/** 当前使用的 OSS 外网 / CNAME 域名（去掉尾部斜杠） */
function ossHost() {
  const raw = config.OSS_USE_CNAME ? config.OSS_CNAME_ENDPOINT : config.OSS_EXTERNAL_ENDPOINT;
  return String(raw || '').replace(/\/+$/, '');
}

/**
 * 取 OSS PostObject 直传签名。
 * @param {string} ext 文件扩展名（不含点）
 * @param {string} prefix 对象 key 前缀，默认取 config.OSS_UPLOAD_PREFIX
 * @returns {Promise<object>} { host, key, policy, signature, OSSAccessKeyId, expire, ... }
 */
async function ossPolicy(ext = 'jpg', prefix) {
  const data = await post('/api/oss/policy', {
    ext: String(ext).replace(/[^a-zA-Z0-9]/g, '').slice(0, 5) || 'jpg',
    prefix: prefix || config.OSS_UPLOAD_PREFIX || 'photos/',
  });
  if (!data || !data.key || !data.policy || !data.signature) {
    const err = new Error('OSS 上传签名返回不完整，请检查后端 /api/oss/policy 与 OSS_* 环境变量');
    err.code = 'OSS_POLICY_BAD_RESPONSE';
    err.detail = data;
    console.error('[oss]', err.message, data);
    throw err;
  }
  return data;
}

/**
 * 单个对象签名 URL。
 * @param {string} key OSS 对象 key
 * @returns {Promise<{url:string, expire:number, cacheSeconds:number}>}
 */
async function ossSign(key) {
  const data = await get('/api/oss/sign', { key });
  if (!data || !data.url) {
    const err = new Error('OSS 签名失败：后端未返回 url（key=' + key + '），请检查 /api/oss/sign');
    err.code = 'OSS_SIGN_BAD_RESPONSE';
    err.detail = data;
    console.error('[oss]', err.message, data);
    throw err;
  }
  return data;
}

/**
 * 批量签名（一次请求签多个 key，减少相册/列表的请求数）。
 * @param {Array<string>} keys
 * @returns {Promise<{urls:object, expire:number, cacheSeconds:number}>}
 */
async function ossSignBatch(keys) {
  const data = await post('/api/oss/sign', { keys });
  if (!data || !data.urls) {
    const err = new Error('OSS 批量签名失败：后端未返回 urls');
    err.code = 'OSS_SIGN_BATCH_BAD_RESPONSE';
    err.detail = data;
    throw err;
  }
  return data;
}

/** 读签名缓存（毫秒级过期，精度高于 storage 的小时/分钟级封装） */
function cacheGet(key) {
  try {
    const v = wx.getStorageSync(SIGN_CACHE_PREFIX + key);
    if (!v || !v.url || !v.expireAtMs) return null;
    if (Date.now() >= v.expireAtMs) {
      wx.removeStorageSync(SIGN_CACHE_PREFIX + key);
      return null;
    }
    return v.url;
  } catch (e) {
    return null;
  }
}

/**
 * 写签名缓存。TTL 取三者最小值，保证严格短于签名有效期：
 *   a) 后端 cacheSeconds - config.OSS_SIGN_CACHE_MARGIN_SECONDS
 *   b) (expire - now) * 0.8（签名绝对过期时间的 80%）
 *   c) 至少 1 秒
 * @param {string} key OSS 对象 key
 * @param {string} url 签名后的 URL
 * @param {number} cacheSeconds 后端建议缓存秒数
 * @param {number} expire 签名过期的 Unix 秒
 */
function cacheSet(key, url, cacheSeconds, expire) {
  const margin = Number(config.OSS_SIGN_CACHE_MARGIN_SECONDS) || 60;
  const nowSec = Math.floor(Date.now() / 1000);
  let ttl = Math.max(1, (Number(cacheSeconds) || 600) - margin);
  if (Number(expire) > nowSec) {
    ttl = Math.min(ttl, Math.max(1, Math.floor((Number(expire) - nowSec) * 0.8)));
  }
  try {
    wx.setStorageSync(SIGN_CACHE_PREFIX + key, { url, expireAtMs: Date.now() + ttl * 1000 });
  } catch (e) {
    console.warn('[oss] 签名缓存写入失败，本次不缓存：', e);
  }
}

/**
 * 从图片 URL 解析 OSS 对象 key；非本项目 OSS 的 URL 返回 null。
 * 兼容两种历史 URL：
 *   自建 OSS： https://<bucket>.oss-xx.aliyuncs.com/<key>  或 CNAME/<key>
 *   旧腾讯云 COS： https://cos.ap-xx.myqcloud.com/<bucket>/<key>
 *                https://<bucket>.cos.ap-xx.myqcloud.com/<key>
 * @param {string} url
 * @returns {string|null} 对象 key 或 null（外部直链 / 本地路径）
 */
function extractKey(url) {
  if (!url) return null;
  // 【本地/临时文件不是 OSS 对象】拍照、选图、开发者工具给的
  // wxfile://temp/11.png / http://tmp/xxx / blob: / data: 之类，绝不能被拿去后端签名：
  // 后端会把整串当 key 编码，生成 https://oss.xcry.top/wxfile%3A//temp/11.png 这种
  // 必然 404 的地址，渲染层报「Failed to load image」。
  if (/^(wxfile:|file:|blob:|data:)/i.test(url)) return null;
  if (/^https?:\/\/(tmp|usr|store)(\/|$)/i.test(url)) return null;
  // 裸对象 key：没有协议、不是本地绝对路径
  if (!/^https?:\/\//i.test(url) && url.charAt(0) !== '/') return url;
  // 小程序本地资源
  if (url.charAt(0) === '/') return null;

  let host = '';
  let pathname = '';
  try {
    const m = url.match(/^https?:\/\/([^/?#]+)([^?#]*)/i);
    if (!m) return null;
    host = m[1].toLowerCase();
    pathname = m[2].replace(/^\//, '');
  } catch (e) {
    return null;
  }

  const cfgHost = ossHost().replace(/^https?:\/\//i, '').toLowerCase().split('/')[0];
  const isOwn = host === cfgHost
    || (config.OSS_BUCKET && host.indexOf(String(config.OSS_BUCKET).toLowerCase()) >= 0)
    || host.indexOf('aliyuncs.com') >= 0
    || host.indexOf('taihangrda.cn') >= 0;
  const isLegacyCos = host.indexOf('myqcloud.com') >= 0;

  if (!isOwn && !isLegacyCos) return null; // 外部公网直链，无需签名

  let key = pathname;
  if (isLegacyCos && host.indexOf('cos.') === 0) {
    // cos.ap-xx.myqcloud.com/<bucket>/<key> —— 去掉第一段 bucket 名
    const idx = key.indexOf('/');
    if (idx >= 0) key = key.slice(idx + 1);
  }
  try { key = decodeURIComponent(key); } catch (e) { /* 保留原样 */ }
  return key || null;
}

/**
 * 把图片 URL / 对象 key 换成可直接展示的签名 URL（原 signCosUrl 的替代）。
 * @param {string} inputUrl 图片 URL、OSS 对象 key 或本地路径
 * @returns {Promise<string>} 可直接放入 <image src> 的 URL
 */
async function signImageUrl(inputUrl) {
  if (!inputUrl) return inputUrl;
  // 离线 Demo：仅本项目 OSS / 旧 COS 资源回退本地占位图，避免域名报错；
  // 外部公网直链（如微信头像）原样返回，保持与历史 signCosUrl 一致。
  if (DEMO) {
    return extractKey(inputUrl) ? config.DEFAULT_AVATAR_PATH : inputUrl;
  }
  const key = extractKey(inputUrl);
  if (!key) return inputUrl; // 本地资源或外部公网直链

  const cached = cacheGet(key);
  if (cached) return cached;

  const signed = await ossSign(key);
  cacheSet(key, signed.url, signed.cacheSeconds, signed.expire);
  return signed.url;
}

/**
 * 上传文件到 OSS（直传，不经过业务服务器）。
 * @param {object} options { filePath, cloudPath }
 * @returns {Promise<{fileUrl:string, fileId:string, key:string, statusCode:number}>}
 */
async function uploadFile(options) {
  const { filePath, cloudPath } = options || {};
  if (!filePath) throw new Error('uploadFile 缺少 filePath');
  const ext = String(cloudPath || '').split('.').pop() || 'jpg';
  const policy = await ossPolicy(ext, config.OSS_UPLOAD_PREFIX);

  // 后端返回的 host 为准；若用户启用 CNAME，则改用 CNAME 域名直传
  let host = String(policy.host || ossHost()).replace(/\/+$/, '');
  if (config.OSS_USE_CNAME && config.OSS_CNAME_ENDPOINT) {
    host = String(config.OSS_CNAME_ENDPOINT).replace(/\/+$/, '');
  }

  const formData = {
    key: policy.key,
    policy: policy.policy,
    OSSAccessKeyId: policy.OSSAccessKeyId,
    signature: policy.signature,
  };
  // 后端若附带 callback / x-oss-* 等字段，一并透传给 OSS
  Object.assign(formData, policy.formData || {});

  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: host,
      filePath,
      name: 'file',
      formData,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({
            fileUrl: host + '/' + policy.key,
            fileId: policy.key,
            key: policy.key,
            statusCode: res.statusCode,
            data: res.data,
          });
        } else {
          const err = new Error('OSS 直传失败（HTTP ' + res.statusCode + '）：' + (res.data || '请检查 policy 与 OSS 跨域配置'));
          err.code = 'OSS_UPLOAD_FAIL';
          err.statusCode = res.statusCode;
          console.error('[oss]', err.message, res);
          reject(err);
        }
      },
      fail(e) {
        const err = new Error('OSS 直传网络失败：' + ((e && e.errMsg) || '未知原因') + '；请检查 uploadFile 合法域名');
        err.code = 'OSS_UPLOAD_NETWORK_FAIL';
        console.error('[oss]', err.message, e);
        reject(err);
      },
    });
  });
}

module.exports = {
  ossHost,
  ossPolicy,
  ossSign,
  ossSignBatch,
  signImageUrl,
  extractKey,
  uploadFile,
};
