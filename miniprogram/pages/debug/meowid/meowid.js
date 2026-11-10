import api from "../../../utils/cloudApi";
import { checkAuth } from "../../../utils/user";
import { getGlobalSettings, invalidateSettingCache } from "../../../utils/page";
import {
  getRecognizeMode,
  MEOWID_CONFIG_TARGET,
  MEOWID_CONFIG_COLUMN,
  mergeRecognize,
  buildConfigPatch,
  readMeowidConfig,
} from "../../../utils/recognize";
import { isWriteOk } from "../../../utils/common";
import config from "../../../config";

// 默认地址收敛到 config.js，避免其他文件出现需要用户手改的域名
const DEFAULT_BASE_URL = config.MEOWID_BASE_URL;

// 客户端侧 invoke 超时（55s，EMAS 硬上限 60s）：云端可能仍在执行，不能当成失败直接重试
const CALL_TIMEOUT_MSG = '请求云函数超时（超过 55 秒）。云端可能仍在继续执行，请稍后点「刷新状态」查看结果。';
const TIMEOUT_CODES = ['FunctionTimeout', 'timeout', 'ETIMEDOUT'];

function describeCallError(error) {
  if (TIMEOUT_CODES.includes((error && error.code) || '')) return CALL_TIMEOUT_MSG;
  const detail = error && error.message ? '（' + error.message + '）' : '';
  return '网络或服务异常，请检查云函数日志。' + detail;
}

// 进度条百分比：分母缺失或为 0 时按 0 处理，避免出现 NaN 宽度
function percent(done, total) {
  const d = Number(done) || 0;
  const t = Number(total) || 0;
  return t > 0 ? Math.max(0, Math.min(100, Math.round(d / t * 100))) : 0;
}

Page({
  data: {
    auth: false, isManager: false, loading: false, saving: false, syncing: false, syncMode: 'all',
    modeLabels: ['关闭识猫', '独立部署识猫函数', 'MeowID'],
    modes: ['off', 'custom', 'meowid'], modeIndex: 0,
    pageCfg: { mode: 'off', secretKey: '' },
    cfgProjectId: '', cfgApiKey: '', cfgBaseUrl: DEFAULT_BASE_URL, cfgTopK: 5, cfgThreshold: '',
    cfgEnrollImages: 5,
    // 本地已配置的判定（recognize 里有项目编号 + 密钥）。
    // 后端 syncStatus 返回的 ready 读的是它自己那份配置，在后端改成读 recognize 之前
    // 可能还是旧值（app_secret 为空），用它会把「刚保存成功」显示成「未配置」。
    cfgLocalReady: false,
    baseUrlDirty: false, cfgStatus: null, syncStatus: null, savedImageLimit: null, syncLimitDirty: false, result: '',
  },

  async onShow() {
    this.stopSync = false;
    const isManager = await checkAuth(this, 99);
    this.setData({ isManager });
    if (!isManager) return;
    await this.loadPageCfg();
    if (this.data.pageCfg.mode === 'meowid') await this.call('syncStatus');
  },

  onHide() { this.stopSync = true; },
  onUnload() { this.stopSync = true; },

  async loadPageCfg() {
    const settings = await getGlobalSettings(null, { nocache: true }) || {};
    const record = settings.recognize || {};
    const mode = getRecognizeMode(record);
    const cfg = readMeowidConfig(record);
    const enrollSaved = record.meowidEnrollImages === undefined || record.meowidEnrollImages === null
      ? null : Number(record.meowidEnrollImages);
    this.setData({
      pageCfg: { mode, secretKey: record.secretKey || '' },
      modeIndex: this.data.modes.indexOf(mode),
      cfgBaseUrl: cfg.cfgBaseUrl || DEFAULT_BASE_URL,
      cfgProjectId: cfg.cfgProjectId,
      cfgApiKey: '',
      cfgTopK: cfg.cfgTopK,
      cfgEnrollImages: cfg.cfgEnrollImages,
      savedImageLimit: Number.isSafeInteger(enrollSaved) && enrollSaved >= 5 ? enrollSaved : null,
      baseUrlDirty: false,
      cfgLocalReady: !!(cfg.cfgProjectId && record.meowidApiKey),
      cfgStatus: {
        ready: !!(cfg.cfgProjectId && record.meowidApiKey),
        projectIdSet: !!cfg.cfgProjectId,
        apiKeySet: !!record.meowidApiKey,
        baseUrl: cfg.cfgBaseUrl || DEFAULT_BASE_URL,
        topK: cfg.cfgTopK,
        enrollImagesPerCat: cfg.cfgEnrollImages,
      },
    });
  },

  /**
   * 保存 recognize 补丁（识猫服务配置的家）。
   * 【为什么走 curdOp 而不是 api.meowid saveConfig】后端 saveConfig 现在也写同一棵
   * recognize 树，但前端直连 setting 少一次网络往返、且能立刻回读校验；两条路不冲突。
   * 【为什么必须合并】PG 的 jsonb 是整列替换，不先读现值会把 mode / showRecognizeBtn 抹掉。
   */
  async saveRecognizePatch(patch) {
    let settings;
    try {
      settings = await getGlobalSettings(null, { nocache: true }) || {};
    } catch (error) {
      return { ok: false, msg: '读取设置失败，未保存，请重试' };
    }
    const recognize = mergeRecognize(settings.recognize, patch);
    let result;
    try {
      result = await api.curdOp({ operation: 'update', collection: 'setting', item_id: 'pages', data: { recognize } });
    } catch (error) {
      console.error('[meowid] saveRecognizePatch', error);
      return { ok: false, msg: '保存失败，请检查网络后重试' };
    }
    if (!isWriteOk(result)) return { ok: false, msg: '保存失败，请重试' };
    invalidateSettingCache('pages');
    // 回读校验：接口 ok 不等于已经落库（历史上踩过 $set 被静默丢弃）
    let after;
    try { after = (await getGlobalSettings(null, { nocache: true })) || {}; }
    catch (error) { return { ok: false, msg: '保存后回读失败，请重试' }; }
    const saved = after.recognize || {};
    const norm = (v) => (v === undefined || v === null ? '' : String(v));
    const missing = Object.keys(patch).filter((key) => norm(saved[key]) !== norm(patch[key]));
    if (missing.length) return { ok: false, msg: '保存未生效：' + missing.join('、') };
    return { ok: true, recognize: saved };
  },

  onModeChange(event) {
    if (this.data.syncing) return;
    const index = Number(event.detail.value);
    if (!this.data.modes[index]) return;
    this.setData({ modeIndex: index, 'pageCfg.mode': this.data.modes[index], result: '' });
  },

  pageCfgInput(event) { this.setData({ 'pageCfg.secretKey': event.detail.value }); },

  onCopyGuide() {
    wx.setClipboardData({
      data: 'https://meowid.net/zh-cn/developers/zhongdamaopu',
      success: () => wx.showModal({
        title: '文档链接已复制',
        content: '请在浏览器中粘贴打开 MeowID 接入文档。',
        showCancel: false,
      }),
      fail: () => wx.showToast({ icon: 'none', title: '复制失败，请重试' }),
    });
  },

  async onSavePageCfg() {
    let settings;
    try { settings = await getGlobalSettings(null, { nocache: true }) || {}; }
    catch (error) { wx.showToast({ icon: 'none', title: '读取设置失败，未保存，请重试' }); return; }
    const recognize = Object.assign({}, settings.recognize || {}, {
      mode: this.data.pageCfg.mode,
      secretKey: String(this.data.pageCfg.secretKey || '').trim(),
    });
    try {
      const result = await api.curdOp({ operation: 'update', collection: 'setting', item_id: 'pages', data: { recognize } });
      // 【成功判定】后端 curdOp 的 update 分支返回 updateOne 的原始结果
      // { matchedCount, modifiedCount, acknowledged }，**没有 ok 字段**。
      // 原判定 `!result.ok` 恒为真 → 保存成功却提示「保存失败，请重试」。
      if (!isWriteOk(result)) throw new Error('保存失败');
      // 失效设置缓存：否则 loadPageCfg 重新读到的还是 168 小时前的旧 mode
      invalidateSettingCache('pages');
      wx.showToast({ title: '已保存', icon: 'success' });
      await this.loadPageCfg();
    } catch (error) { wx.showToast({ icon: 'none', title: '保存失败，请重试' }); }
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ [field]: event.detail.value,
      ...(field === 'cfgEnrollImages' ? { syncLimitDirty: true } : {}),
      ...(field === 'cfgBaseUrl' ? { baseUrlDirty: true } : {}) });
  },

  async call(action, extra = {}) {
    if (this.data.loading || !this.data.isManager) return;
    this.setData({ loading: true });
    try {
      const result = await api.meowid({ action, ...extra });
      this.setData({ result: result && (result.ok || result.code === 'timeout') ? '' : (result && result.msg) || '操作失败' });
      if (result && result.config) {
        this.setData({ cfgStatus: result.config, cfgTopK: result.config.topK || 5,
          ...(result.config.baseUrl && !this.data.baseUrlDirty ? { cfgBaseUrl: result.config.baseUrl } : {}) });
      }
      const limit = Number(result && ((result.sync && result.sync.imageLimit) || result.imageLimit ||
        (result.config && result.config.enrollImagesPerCat)));
      if (Number.isSafeInteger(limit) && limit >= 5) {
        this.setData({ savedImageLimit: limit, ...(!this.data.syncLimitDirty ? { cfgEnrollImages: limit } : {}) });
      } else if (result && result.config) this.setData({ savedImageLimit: null });
      if (result && result.sync) {
        const s = result.sync;
        const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
        this.setData({ syncStatus: {
          ...s,
          bound: num(s.bound), accepted: num(s.accepted),
          remainingCats: Math.max(0, num(s.cats) - num(s.bound)),
          remainingPhotos: Math.max(0, num(s.total) - num(s.accepted)),
          catPercent: percent(s.bound, s.cats),
          photoPercent: percent(s.accepted, s.total),
        } });
      }
      if (result && result.meowid && !result.meowid.reachable) this.setData({ result: result.meowid.code === 'timeout' ? '' : result.meowid.msg || '连接服务失败' });
      // 云端 unionOp 版本落后（路由层不认识 meowid）时给出明确处置方式，只弹一次
      if (result && result.code === 'function_outdated' && !this.outdatedNotified) {
        this.outdatedNotified = true;
        wx.showModal({ title: '需要更新云函数', showCancel: false,
          content: '线上 unionOp 还未包含 meowid 动作。请部署 functionsEMAS/unionOp 的最新代码，然后重新进入此页。' });
      }
      return result;
    } catch (error) {
      const code = (error && error.code) || 'invoke_error';
      console.error('[meowid]', action, code, error);
      this.setData({ result: describeCallError(error) });
      if (TIMEOUT_CODES.includes(code)) wx.showToast({ icon: 'none', title: '请求云函数超时', duration: 2500 });
      return { ok: false, code };
    } finally { this.setData({ loading: false }); }
  },

  async onSaveConfig() {
    if (this.data.saving || this.data.loading || this.data.syncing) return;
    // 空值不写（保留库里已保存的密钥/项目），识别候选数量始终带上
    const patch = buildConfigPatch({
      cfgBaseUrl: String(this.data.cfgBaseUrl || '').trim(),
      cfgProjectId: String(this.data.cfgProjectId || '').trim(),
      cfgApiKey: String(this.data.cfgApiKey || '').trim(),
      cfgTopK: Math.max(1, Math.min(100, parseInt(this.data.cfgTopK, 10) || 5)),
    });
    if (!Object.keys(patch).length) {
      wx.showToast({ icon: 'none', title: '没有需要保存的配置' });
      return;
    }
    this.setData({ saving: true });
    try {
      const res = await this.saveRecognizePatch(patch);
      if (!res.ok) { wx.showToast({ icon: 'none', title: res.msg || '保存失败，请重试' }); return; }
      const saved = res.recognize || {};
      const ready = !!(saved.meowidProjectId && saved.meowidApiKey);
      this.setData({ cfgApiKey: '', baseUrlDirty: false, cfgLocalReady: ready,
        cfgStatus: { ready, projectIdSet: !!saved.meowidProjectId, apiKeySet: !!saved.meowidApiKey,
          baseUrl: saved.meowidBaseUrl || DEFAULT_BASE_URL,
          topK: Number(saved.meowidTopK) || 5,
          enrollImagesPerCat: Number(saved.meowidEnrollImages) || 5 } });
      wx.showToast({ title: '已保存', icon: 'success' });
      await this.call('syncStatus');
    } finally { this.setData({ saving: false }); }
  },

  async onSaveSyncConfig() {
    if (this.data.saving || this.data.loading || this.data.syncing) return;
    const limit = Number(this.data.cfgEnrollImages);
    if (!Number.isSafeInteger(limit) || limit < 5) {
      wx.showToast({ icon: 'none', title: '每猫图片上限请填写至少 5 的整数' });
      return;
    }
    this.setData({ saving: true });
    try {
      const res = await this.saveRecognizePatch({ meowidEnrollImages: limit });
      if (!res.ok) { wx.showToast({ icon: 'none', title: res.msg || '保存失败，请重试' }); return; }
      this.setData({ savedImageLimit: limit, syncLimitDirty: false });
      wx.showToast({ title: '同步上限已保存', icon: 'success' });
      await this.call('syncStatus');
    } finally { this.setData({ saving: false }); }
  },

  onCheckConnection() { return this.call('syncStatus', { ping: true }); },

  onStatus() { return this.call('status'); },

  onSyncAll() { return this.startSync(false); },

  onSyncLimited() { return this.startSync(true); },

  async startSync(limited) {
    if (this.data.syncing || this.data.loading) return;
    if (limited && this.data.syncLimitDirty) {
      wx.showToast({ icon: 'none', title: '请先保存同步上限' });
      return;
    }
    let savedLimit = this.data.savedImageLimit;
    if (limited && (!Number.isSafeInteger(savedLimit) || savedLimit < 5)) {
      const refreshed = await this.call('syncStatus');
      if (!refreshed || !refreshed.ok) {
        wx.showToast({ icon: 'none', title: '读取同步上限失败，请重试' });
        return;
      }
      savedLimit = this.data.savedImageLimit;
      if (!Number.isSafeInteger(savedLimit) || savedLimit < 5) {
        wx.showModal({ title: '需要更新云函数',
          content: '当前 unionOp 未返回每猫图片上限，无法按上限同步。请部署 functionsEMAS/unionOp 的最新代码，然后重新进入此页并保存同步上限。',
          showCancel: false });
        return;
      }
    }
    wx.showModal({
      title: limited ? '按上限同步' : '全量 / 增量同步',
      content: (limited ? '每猫累计最多上传 ' + savedLimit + ' 张（已保存设置）。' : '同步全部猫咪档案和审核通过的照片，不限制每猫数量；之前因上限暂缓的照片也会补传。') +
        '已受理、有任务编号和结果待核对的照片不重传。注册会产生第三方用量，请勿清空原同步记录。',
      success: async response => {
        if (!response.confirm || this.data.syncing || this.data.loading) return;
        this.stopSync = false;
        const syncMode = limited ? 'limited' : 'all';
        this.setData({ syncing: true, syncMode, result: '正在开始同步…' });
        let uploaded = 0;
        let batches = 0;
        let idle = 0;
        try {
          // 只读统计，不做任务刷新：任务刷新可能占用几十秒，放在循环里会把首屏时间全吃掉
          await this.call('syncStatus');
          let action = 'syncAll';
          while (!this.stopSync) {
            const result = await this.call(action, { syncMode });
            if (!result) break;
            if (!result.ok) {
              // 超时说明云端这批还没跑完（批次锁约 70 秒），提示用户等一会再继续，而不是静默中断
              if (TIMEOUT_CODES.includes(result.code)) {
                this.setData({ result: '云端这一批还没跑完就被判超时，请等约 1 分钟后再点一次继续（已受理的照片不会重传）。' });
              }
              break;
            }
            if (result.busy) {
              this.setData({ result: '另一批同步正在执行，请稍后点击继续。' });
              break;
            }
            batches++;
            const done = Number(result.processed) || 0;
            uploaded += done;
            const moved = done > 0 || Number(result.progress) > 0;
            idle = moved ? 0 : idle + 1;
            this.setData({ result: '已上传 ' + uploaded + ' 张 · 第 ' + batches + ' 批' +
              (result.phase === 'cats' ? ' · 正在核对猫咪档案' : '') });
            if (!result.more) {
              this.setData({ result: '本批上传结束，正在核对注册结果…' });
              await this.call('status');
              const progress = this.data.syncStatus;
              this.setData({ result: progress && (progress.remainingCats || progress.remainingPhotos)
                ? (limited ? '本轮按上限同步已结束；超出上限的照片可提高上限后补传，或选择全量 / 增量同步。' : '本轮同步已结束。') +
                  '仍有未同步记录，请查看剩余数量、失败及待核对提示。'
                : '本轮上传已结束，可点击刷新状态查看注册结果。' });
              break;
            }
            // 只在上传阶段做空转保护：猫咪阶段本来就可能整批跳过（已同步的猫不写库）
            if (result.phase === 'photos' && idle >= 3) {
              this.setData({ result: '连续几批都没有可上传的照片，已停止。请刷新状态查看失败与待核对的记录。' });
              break;
            }
            if (batches % 5 === 0 && !this.stopSync) await this.call('syncStatus');
            action = 'syncNext';
          }
        } finally { this.setData({ syncing: false }); }
      },
    });
  },
});
