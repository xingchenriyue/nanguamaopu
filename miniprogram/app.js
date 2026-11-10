/**
 * app.js —— 小程序入口
 * ============================================================================
 * 【职责】初始化全局数据、版本更新检查、缓存清理、注册未处理 Promise 拒绝兜底提示。
 * 【依赖】./config.js、./utils/api.js（兼容 facade）、./utils/utils.js、./utils/eventBus.js
 * 【注意事项】
 *  1. 已移除 EMAS Serverless SDK：所有数据/OSS 能力统一走 utils/api.js 的收敛层，
 *     再经 utils/request.js 访问 config.API_BASE_URL 指向的自建后端。
 *  2. mpServerless 仅作兼容兜底（防止遗漏的旧式调用），新增代码直接 import utils/api.js。
 *  3. 离线 Demo 由 config.OFFLINE_DEMO_MODE 控制，db.js / oss.js 内部自动使用假数据。
 *  4. 小程序端不含任何密钥；token 由 /api/login 下发，存于 wx storage。
 * ============================================================================
 */
import { checkUpdateVersion, getDateWithDiffHours } from './utils/utils';
import { app_version } from './config';
import config from './config';
import { mpServerless } from './utils/api';
import eventBus from './utils/eventBus';

const DEMO_MODE = !!config.OFFLINE_DEMO_MODE;

App({
  async onLaunch() {
    checkUpdateVersion();
    this.clearCache();

    this.globalData = {
      version: app_version,
      eventBus: eventBus,
      demoMode: DEMO_MODE,
    };

    // 兜底：任何未被页面 catch 的网络/网关异常都给出提示，绝不静默失败
    if (typeof wx.onUnhandledRejection === 'function') {
      wx.onUnhandledRejection(({ reason }) => {
        if (!reason) return;
        // 取出可读信息：微信的 API 失败对象是 {errMsg, ...}，没有 message 字段
        const msg = (reason && (reason.errMsg || reason.message)) || (typeof reason === 'string' ? reason : '');
        // 用户主动取消（chooseMedia:fail cancel 之类）不是错误：
        // 不打日志、不弹提示，避免用户取消一次就被当成故障打扰
        if (/cancel/i.test(msg)) return;
        console.error('[app] 未处理的 Promise 拒绝：', reason);
        // toast 标题只放用户看得懂的话：
        // 纯技术性 errMsg（如 request:fail timeout）截断展示没有意义，统一走友好兜底；
        // 后端返回的中文提示（如「仅管理员可执行照片处理」）则原样透出。
        const isChinese = /[\u4e00-\u9fa5]/.test(msg);
        const title = isChinese && msg.length <= 24 ? msg : '请求失败，请重试';
        wx.showToast({ icon: 'none', title, duration: 3000 });
      });
    }
  },

  /**
   * 每 48 小时清理一次业务缓存，避免过期签名 URL 与脏数据堆积。
   * 【必须保留登录态】clearStorageSync 会把 mp_token / mp_openid 一起清掉，
   * 用户会突然被当成未登录（识猫页要求登录时尤其明显）。只清业务缓存。
   */
  clearCache() {
    const clearDay = wx.getStorageSync('clear-all-cache');
    if (!clearDay || new Date(clearDay) < new Date()) {
      console.log('清理业务缓存（保留登录态）');
      const KEEP_KEYS = ['mp_token', 'mp_openid'];
      const kept = {};
      for (const k of KEEP_KEYS) {
        const v = wx.getStorageSync(k);
        if (v) kept[k] = v;
      }
      try { wx.clearStorageSync(); } catch (e) { console.warn('[app] 清理缓存失败', e); }
      for (const k of Object.keys(kept)) {
        try { wx.setStorageSync(k, kept[k]); } catch (e) { /* ignore */ }
      }
      wx.setStorageSync('clear-all-cache', getDateWithDiffHours(48));
    } else {
      console.log('缓存仍然有效，过期时间', new Date(clearDay));
    }
  },

  // 兼容兜底：内部实现为 utils/api.js 的 facade（不再依赖 EMAS SDK）
  mpServerless: mpServerless,
  cos: null,
});