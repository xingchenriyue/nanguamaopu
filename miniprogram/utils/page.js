/**
 * utils/page.js —— 页面设置、筛选条件、tabBar 与页面路径工具
 * ============================================================================
 * 【职责】页面设置、筛选条件、tabBar 与页面路径工具。
 * 【依赖】./api.js（db）、./cache.js、../config.js
 * 【注意事项】setting.pages 为全局配置，读取带缓存；识别页配置改动应 nocache 读取。
 * ============================================================================
 */
const apiDb = require('./api.js').db;
import { getCacheItem, setCacheItem, cacheTime, removeCacheItem } from "./cache";
import { getPageMetrics } from "./layout";
import { signCosUrl } from "./common";
const app = getApp();

function _getSettingCacheKey(setting_id) {
  return `setting-${setting_id}-cache`;
}

/**
 * 失效某个 setting 的本地缓存。
 *
 * 【为什么必须有】
 * 设置缓存时长是 168 小时（cacheTime.pageSetting）。写完设置后如果不失效缓存，
 * 下一次读取会拿到旧值 —— 表现为「保存成功了但页面显示的还是旧配置」
 * （用户反馈的「页面配置无法更新」就有这一层）。
 * 凡是写入 setting 集合（页面配置页、识猫服务页）之后都必须调用一次。
 *
 * @param {string} setting_id 如 'pages' / 'filter'
 */
function invalidateSettingCache(setting_id) {
  try {
    removeCacheItem(_getSettingCacheKey(setting_id));
  } catch (e) {
    console.warn(`[page] 失效设置缓存 ${setting_id} 失败：`, e);
  }
}

/**
 * 读设置。
 *
 * 【为什么缓存前要剥掉签名 URL】
 * 后端签名 URL 有效期只有 15 分钟（OSS_SIGN_EXPIRES=900s），而设置缓存时长是
 * 168 小时（cacheTime.pageSetting）。若把带签名的 ads 图片 URL 原样缓存下来，
 * 7 天后缓存里的签名早已过期 → <image> 加载必然失败（用户实机报的一批
 * oss.xcry.top/...&Expires=... 加载失败就是这种陈旧签名）。
 * 所以这里缓存的是「未签名的裸 URL」，每次读取后再按需重新签名。
 */
async function _getSetting(_id, options) {
  const cacheKey = _getSettingCacheKey(_id);
  var nocache = false
  if (options && options.nocache) {
    nocache = true;
  }

  var cacheItem = getCacheItem(cacheKey, { nocache: nocache });
  if (cacheItem !== undefined) {
    return await resignSettingUrls(cacheItem);
  }
  const { result } = await apiDb.collection('setting').findOne({ _id: _id });
  cacheItem = result

  // 缓存裸 URL（剥离签名参数），避免把短效签名存进长效缓存
  setCacheItem(cacheKey, stripSignParams(cacheItem), cacheTime.pageSetting);
  return await resignSettingUrls(cacheItem);
}

/**
 * 剥掉单个 URL 字符串上的 OSS 签名查询参数
 * （?OSSAccessKeyId=...&Expires=...&Signature=...）。
 * 非字符串、非签名 URL 一律原样返回。
 */
function stripSignParamsFromUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  // 先把整段签名参数（含其前面的 ? 或 &）删掉，再清理可能残留的孤立分隔符。
  // 注意不能只删参数值：那会留下 "...jpg&x=1" 这种畸形 URL（首个 & 变成了 ? 的位置）。
  return url
    .replace(/([?&])(OSSAccessKeyId|Expires|Signature)=[^&]*/g, '')
    .replace(/\?&/g, '?')
    .replace(/&&+/g, '&')
    .replace(/^&/, '?')          // 签名参数在首位时残留的首个 & 还原成 ?
    .replace(/[?&]$/, '');
}

/**
 * 剥掉 URL 上的 OSS 签名查询参数（?OSSAccessKeyId=...&Expires=...&Signature=...）。
 * 用于把「短效签名 URL」还原成「稳定裸 URL」，使长效缓存不失效。
 * 非 URL 值、非 OSS 签名 URL 一律原样返回。
 *
 * 支持两种入参：
 *   - 字符串：直接返回剥离后的 URL 字符串（写库前用）
 *   - 对象/数组：递归处理其内的字符串字段（缓存前用）
 */
function stripSignParams(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return stripSignParamsFromUrl(obj);
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripSignParams);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      out[k] = stripSignParamsFromUrl(v);
    } else if (v && typeof v === 'object') {
      out[k] = stripSignParams(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 给设置里的图片 URL 重新签名（签名 15 分钟就过期，必须现签现用）。
 * 签名失败时保留原值，不影响设置本身的其他字段。
 */
async function resignSettingUrls(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    const arr = [];
    for (const item of obj) arr.push(await resignSettingUrls(item));
    return arr;
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && /^(https?:\/\/|\/)/.test(v)) {
      try {
        out[k] = await signCosUrl(v);
      } catch (e) {
        console.error(`[page] 设置项 ${k} 签名失败:`, e);
        out[k] = v;
      }
    } else if (v && typeof v === 'object') {
      out[k] = await resignSettingUrls(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// 加载校区区域过滤器
async function loadFilter(options) {
  return await _getSetting('filter', options);
}

// 获取全局的设置
async function getGlobalSettings(key, options) {
  var res = await _getSetting('pages', options);
  if (!res) {
    return undefined;
  }

  if (key == null) {
    return res;
  }
  return res[key];
}

// 获取当前页面路径
function getCurrentPath() {
  const pages = getCurrentPages();
  const currentPage = pages[pages.length - 1];
  return currentPage?.route;
}

// 初始化页面布局尺寸（顶部毛玻璃导航栏 + 底部悬浮 dock）
// 页面在 onLoad 里调用，保证首帧就有正确的导航栏预留高度
function initLayout(page) {
  // 注意：dock 占位高度一律按 layout.js 的样式常量推导，
  // 不读取 storage 里的实测值 —— 那是旧版通栏 TabBar 留下的残留值（96rpx），
  // 直接用会导致首启底部留白不足。
  const metrics = getPageMetrics(0);
  page.setData({
    tabBarHeight: metrics.dockReserveHeight,
    navTotalHeight: metrics.navTotalHeight,
    navBottom: metrics.navBottom,
    navBandHeight: metrics.navBandHeight,
    contentHeight: metrics.contentHeight,
    screenHeight: metrics.screenHeight,
  });
  return metrics;
}

// 切换自定义tab
function showTab(page) {
  if (typeof page.getTabBar != 'function' || !page.getTabBar()) {
    // 拿不到 tabBar 组件时也要保证布局尺寸正确
    initLayout(page);
    return;
  }
  const path = getCurrentPath();
  console.log("current path:", path);
  page.getTabBar().setData({
    activePath: path,
  });

  // 底部悬浮 dock 的占位高度：优先用 custom-tab-bar 实测值，
  // 没有实测值时用 layout.js 按样式常量推导的兜底值。
  initLayout(page);
}

// 跳转到设置页，并发起提示
function toSettings(tip) {
  const curPath = getCurrentPath();
  const url = "pages/manage/pageSettings/pageSettings";
  if (curPath == url) {
    return;
  }
  wx.navigateTo({
    url: `/${url}?tip=${encodeURIComponent(tip)}`,
  })
}
module.exports = {
  loadFilter,
  getGlobalSettings,
  invalidateSettingCache,
  initLayout,
  showTab,
  getCurrentPath,
  toSettings,
  stripSignParams,
}