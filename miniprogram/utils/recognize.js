/**
 * utils/recognize.js —— 识猫模式判定、识别结果归一化、识猫服务配置的字段映射
 * ============================================================================
 * 【职责】
 *   1. 识猫模式判定（getRecognizeMode）
 *   2. 识别响应归一化（normalizeRecognizeResponse）
 *   3. 识猫服务配置（MeowID 接入参数）的存储位置与字段映射规则
 * 【依赖】无（纯函数，可在 node 下直接跑单测）
 * 【注意事项】
 *   - mode 取 off / custom / meowid，实际值来自数据库设置。
 *   - 识猫服务配置原本走 api.meowid({action:'saveConfig'}) 写 app_secret 的
 *     MEOWID_* 字段，但 PG 列式表没有这些列 → 后端「丢弃未知写入字段」，
 *     用户填的值永远存不下来。现在统一写进 setting 表 pages 行的 recognize 列。
 * ============================================================================
 */

/**
 * 识猫服务配置的存储位置。
 *
 * 【为什么要抽成常量】
 * 后端若决定改存独立行（例如 setting 表的 _id='meowidConfig'），
 * 只需要改这里的 TARGET / COLUMN 两处，调用方代码不用动。
 */
const MEOWID_CONFIG_TARGET = 'pages';
const MEOWID_CONFIG_COLUMN = 'recognize';

/**
 * 识猫服务配置字段映射：表单字段名 → recognize 对象里的键名。
 * 键名沿用后端 app_secret 的 MEOWID_* 语义（去前缀 + 驼峰）。
 */
const MEOWID_CONFIG_FIELDS = {
  cfgBaseUrl: 'meowidBaseUrl',
  cfgProjectId: 'meowidProjectId',
  cfgApiKey: 'meowidApiKey',
  cfgTopK: 'meowidTopK',
  cfgThreshold: 'meowidThreshold',
  cfgEnrollImages: 'meowidEnrollImages',
};

/**
 * 合并 recognize 对象（不修改入参）。
 *
 * 【为什么必须合并而不是整体覆盖】
 * recognize 这一棵树上同时住着三处入口管理的字段：
 *   - 页面配置页：showRecognizeBtn / interfaceURL
 *   - 识猫服务页（模式区）：mode / secretKey
 *   - 识猫服务页（服务配置区）：meowid* 六个字段
 * PG 的 jsonb 是整列替换，任何一处保存都会把整棵树盖掉，
 * 所以任一入口保存前都必须先读出现值再叠加自己的字段。
 */
function mergeRecognize(existing, patch) {
  return Object.assign({}, existing || {}, patch || {});
}

/**
 * 把表单值转成 recognize 补丁。
 * 空字符串（'' / undefined / null）视为「用户没填这一项」→ 不写进补丁，
 * 保留库中原值（对应页面上的「留空保留已保存的密钥 / 项目」提示）。
 */
function buildConfigPatch(formValues) {
  const patch = {};
  const form = formValues || {};
  for (const formKey in MEOWID_CONFIG_FIELDS) {
    const value = form[formKey];
    if (value === undefined || value === null || value === '') continue;
    patch[MEOWID_CONFIG_FIELDS[formKey]] = value;
  }
  return patch;
}

/**
 * 从 recognize 对象里读出服务配置，回填到表单。
 * 接口密钥不回显（永远返回空串）—— 密钥只写不读，避免明文回流到页面。
 */
function readMeowidConfig(recognize) {
  const r = recognize || {};
  const positiveInt = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
  };
  let threshold = '';
  if (r.meowidThreshold !== undefined && r.meowidThreshold !== null && r.meowidThreshold !== '') {
    const n = Number(r.meowidThreshold);
    threshold = Number.isFinite(n) ? n : '';
  }
  return {
    cfgBaseUrl: typeof r.meowidBaseUrl === 'string' ? r.meowidBaseUrl : '',
    cfgProjectId: typeof r.meowidProjectId === 'string' ? r.meowidProjectId : '',
    cfgApiKey: '',
    cfgTopK: positiveInt(r.meowidTopK, 5),
    cfgThreshold: threshold,
    cfgEnrollImages: positiveInt(r.meowidEnrollImages, 5),
  };
}

// ============================================================
// 识别次数 / 激励广告计数（识猫页与投喂页共用同一份，避免两个页面各算各的）
// ============================================================
// 用标准 import 引入请求模块：模块内动态 require 在微信编译产物里可能取不到，
// 会导致读取/上报次数永远失败，页面只能显示本地旧值（管理页改了也不生效）。
import { post as httpPost } from './request';

const AD_USAGE_KEY = 'recognize-ad-usage';

/**
 * 把计数快照上报到服务端（user.recognizeUsage）。
 * 【为什么需要】人员管理页要展示每个用户「识别了几次 / 看了几次广告 / 还剩几次」，
 * 本地 storage 服务端看不到，所以每次计数变化后顺手同步一份快照。
 * 失败只告警，绝不阻塞识别/赠送流程。
 */
/**
 * 以服务端快照为准读取次数（识猫页与管理页必须同源，否则数字对不上）。
 * 服务端快照属于上一个周期（bucket 不同）时按新周期从 0 开始。
 * 读取失败（未登录/断网）回退本地缓存，保证识猫仍可用。
 */
async function fetchAdUsage(reset) {
  const bucket = adBucketKey(reset, Date.now());
  try {
    const res = await httpPost('/api/recognize/usage', { action: 'get' });
    const server = res && res.usage;
    if (!server || !server.bucket) return readAdUsage(reset);
    const readServer = () => ({
      bucket,
      used: Number(server.used) || 0,
      ads: Number(server.ads) || 0,
      bonus: Number(server.bonus) || 0,
    });
    if (server.bucket !== bucket) {
      // 只有「同一重置策略下的旧周期」才归零：
      //   daily  → 服务端是 dYYYY-MM-DD 且不是今天
      //   weekly → 服务端是 wYYYY-MM-DD 且不是本周
      //   never  → 永不归零
      // 其它情况（例如管理员用旧版本按 d 写入、而当前策略是 never）
      // 说明只是 bucket 口径不同，沿用服务端数字，避免把管理员设置覆盖掉。
      const stale = reset === 'weekly'
        ? /^w\d{4}-\d{2}-\d{2}$/.test(server.bucket) && server.bucket !== bucket
        : (reset === 'daily' ? /^d\d{4}-\d{2}-\d{2}$/.test(server.bucket) && server.bucket !== bucket : false);
      if (stale) {
        const fresh = { bucket, used: 0, ads: 0, bonus: 0 };
        writeAdUsage(fresh);
        syncAdUsageToServer(fresh);
        return fresh;
      }
      const migrated = readServer();
      writeAdUsage(migrated);
      syncAdUsageToServer(migrated); // 把 bucket 迁到当前口径，之后两端一致
      return migrated;
    }
    const usage = readServer();
    writeAdUsage(usage);
    return usage;
  } catch (error) {
    console.warn('[recognize] 读取服务端次数失败，回退本地', error);
    return readAdUsage(reset);
  }
}

async function syncAdUsageToServer(usage) {
  if (!usage) return null;
  try {
    const request = require('./request.js');
    const res = await request.post('/api/recognize/usage', { action: 'set', usage });
    return (res && res.usage) || null;
  } catch (error) {
    console.warn('[recognize] 上报识别次数快照失败', error);
    return null;
  }
}

/** 计数桶：按重置策略决定什么时候清零（本地日期，避免 UTC 偏移到前一天） */
function adBucketKey(reset, now) {
  const d = new Date(now || Date.now());
  const dayKey = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  if (reset === 'never') return 'forever';
  if (reset === 'weekly') {
    const day = (d.getDay() + 6) % 7; // 周一 = 0
    return 'w' + dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - day));
  }
  return 'd' + dayKey(d);
}

/** 读取当前计数；bucket 变化（跨天/跨周）自动视为 0 */
function readAdUsage(reset) {
  const bucket = adBucketKey(reset, Date.now());
  let saved = null;
  try { saved = wx.getStorageSync(AD_USAGE_KEY); } catch (e) { saved = null; }
  if (!saved || saved.bucket !== bucket) return { bucket, used: 0, ads: 0, bonus: 0 };
  return {
    bucket,
    used: Number(saved.used) || 0,
    ads: Number(saved.ads) || 0,
    bonus: Number(saved.bonus) || 0,
  };
}

function writeAdUsage(usage) {
  try { wx.setStorageSync(AD_USAGE_KEY, usage); } catch (e) { console.warn('[recognize] 保存识别次数失败', e); }
}

/**
 * 增加识别次数（看激励视频后调用）。
 * 只加 bonus，不动 used / ads —— 投喂页的广告不算「识猫页看广告次数」。
 */
function addRecognizeBonus(count, reset) {
  const add = Number(count) || 0;
  if (add <= 0) return readAdUsage(reset);
  const usage = readAdUsage(reset);
  usage.bonus += add;
  writeAdUsage(usage);
  syncAdUsageToServer(usage);
  return usage;
}

function getRecognizeMode(settings) {
  if (!settings) return 'off';
  const mode = settings.mode;
  // mode 缺失（老数据 / 库里从没写过）时回退到 showRecognizeBtn：
  // PG 的 NULL 序列化成 JSON null，所以要用 == null 一起判，
  // 否则 null 会掉到下面的 includes() 分支被误判成 'off'。
  if (mode === undefined || mode === null) {
    return settings.showRecognizeBtn === true ? 'custom' : 'off';
  }
  return ['off', 'custom', 'meowid'].includes(mode) ? mode : 'off';
}

function normalizeRecognizeResponse(response, mode) {
  if (!response || response.ok !== true) return response;
  const data = Object.assign({}, response.data || {});
  data.catBoxes = Array.isArray(data.catBoxes) ? data.catBoxes : [];
  data.recognizeResults = Array.isArray(data.recognizeResults) ? data.recognizeResults : [];
  if (mode === 'custom' && !Number.isInteger(data.catCount)) {
    data.catCount = Math.max(data.catBoxes.length, data.recognizeResults.length ? 1 : 0);
  }
  data.provider = mode;
  return Object.assign({}, response, { data });
}

module.exports = {
  AD_USAGE_KEY,
  adBucketKey,
  readAdUsage,
  writeAdUsage,
  fetchAdUsage,
  addRecognizeBonus,
  syncAdUsageToServer,
  getRecognizeMode,
  normalizeRecognizeResponse,
  MEOWID_CONFIG_TARGET,
  MEOWID_CONFIG_COLUMN,
  MEOWID_CONFIG_FIELDS,
  mergeRecognize,
  buildConfigPatch,
  readMeowidConfig,
};