const apiDb = require('../../../../utils/api.js').db;
import {
  text as text_cfg,
  cat_status_adopt
} from "../../../../config";
import {
  hex_sha256,
  randomInt
} from "../../../../utils/utils";
import {
  loadFilter,
  getGlobalSettings
} from "../../../../utils/page";

import drawUtils from "../../../../utils/draw";
import { signPhotoUrls } from  "../../../../utils/cat";
import api from "../../../../utils/cloudApi";
import { getRecognizeMode, readAdUsage, writeAdUsage, fetchAdUsage, syncAdUsageToServer } from "../../../../utils/recognize";
import { getUser, getUserType } from "../../../../utils/user";

const share_text = text_cfg.app_name + ' - ' + text_cfg.recognize.share_tip;
// 免费识别次数：连续识别满 AD_FREE_TIMES 次后，下一次需要看完一次激励视频
const AD_DEFAULT_FREE = 2;   // 免费次数默认值（可在页面配置改）
const AD_DEFAULT_BONUS = 2;  // 看一次广告增加的次数默认值（可在页面配置改）
const app = getApp();
Page({

  /**
   * 页面的初始数据
   */
  data: {
    cameraAuth: false,
    devicePosition: 'back', // 前置/后置摄像头
    photoPath: null, // 用户选择的照片的路径
    photoBase64: null, // 用户选择的照片的base64编码，用于设置background-image
    campusList: ['所有校区'],
    campusIndex: 0,
    lastFilterType: '',
    colourList: ['所有花色'],
    colourIndex: 0,
    catList: [], // 展示的猫猫列表
    catBoxList: [], // 展示的猫猫框列表
    catIdx: null, // 在有多只猫猫的图片中，识别的猫猫的编号（UI 高亮用，= 数组位置）
    catMeowIdx: null, // 传给后端的候选下标（取自 catBox.index），与数组位置可能不一致
    unknownCat: false, // 检测到猫但身份未确认
    recognizeMode: 'off',
    recognitionMessage: '',
    catCount: 0,
    showResultBox: false, // 用来配合动画延时展示resultBox
    showAdBox: true, // 展示banner广告
    ad: {},          // 广告位与次数配置（来自 setting.pages.ads）
    // 识别次数展示：已识别 / 看广告次数 / 剩余
    adUsage: { used: 0, ads: 0, remaining: 0, total: 0, exempt: false },
    adUsageText: '',
    text_cfg: text_cfg,

    // 领养状态
    adopt_desc: cat_status_adopt,
  },

  initJsData() {
    if (this.jsData) return false;
    this.jsData = {
      secretKey: null,
      canvasSideLen: 500,
      widthHeightRatio: null,
      recognizeResults: [],
      adVideo: null,        // 激励视频实例（按需创建）
      adVideoUnitId: '',    // 当前实例对应的广告位 ID
    };
    return true;
  },

  async onLoad() {
    this.initJsData();
    var res = await loadFilter();
    console.log('filterRes:', res);
    this.setData({
      campusList: ['所有校区'].concat(res.campuses),
      colourList: ['所有花色'].concat(res.colour)
    })

    this.checkAuth();

  },

  async onShow() {
    this.initJsData();
    const settings = await getGlobalSettings('recognize', { nocache: true });
    this.jsData.secretKey = settings && settings.secretKey;
    const mode = getRecognizeMode(settings);
    this.setData({ unknownCat: false, recognizeMode: mode });
    if (mode === 'off') {
      wx.showToast({ icon: 'none', title: '识猫功能已关闭' });
      return;
    }
    // banner 只在 custom 模式展示；激励视频两种模式都可能用到（识别次数门禁）
    const ads = await getGlobalSettings('ads', { nocache: true }) || {};
    // 激励视频广告位：复用「打赏投喂页」的 reward_video（同一个广告位，不用重复创建）；
    // 如果单独配了 recognize_video 则优先用它，方便日后拆开。
    const hasOwn = ads.recognize_video && ads.recognize_video !== 'your_ad_id' && String(ads.recognize_video).trim();
    const videoUnitId = hasOwn ? ads.recognize_video : ads.reward_video;
    // 次数与广告位全部由页面配置（setting.pages.ads）决定，改库即生效
    this.setData({ ad: {
      banner: ads.recognize_banner,
      video: videoUnitId,
      freeTimes: ads.recognize_free_times,
      bonus: ads.recognize_ad_bonus,
      reset: ads.recognize_ad_reset,
      exemptRoles: ads.recognize_ad_exempt_roles,
    } });
    console.log('[recognize] 广告配置', this.data.ad);
    const usageState = await this.refreshAdUsage();
    // 每天首次进入识猫页时告知「今日赠送次数」，让用户知道额度从哪来
    if (usageState && !usageState.exempt) {
      const welcomeKey = 'recognize-welcome-' + usageState.usage.bucket;
      if (!wx.getStorageSync(welcomeKey)) {
        wx.setStorageSync(welcomeKey, 1);
        wx.showToast({ icon: 'none', title: '今日赠送 ' + usageState.cfg.freeTimes + ' 次识别机会', duration: 2500 });
      }
    }
    await this.recognizeChatImage();
  },


  recognizeChatImage() {
    var launchOptions = wx.getEnterOptionsSync();
    console.log("lanOpt:", launchOptions);
    if (launchOptions.scene !== 1173) {
      return;
    }
    var chatImage = launchOptions.forwardMaterials[0].path;
    if (this.data.photoPath === chatImage) {
      // 已经识别了
      return;
    }
    this.reset();
    //从聊天素材打开，识别素材图片
    this.setData({
      photoPath: chatImage,
      photoBase64: wx.getFileSystemManager().readFileSync(chatImage, 'base64')
    });
    this.recognizePhoto();
  },

  async checkAuth() {
    let setting = await wx.getSetting();
    console.log('auth setting:', setting.authSetting);
    this.setData({
      cameraAuth: setting.authSetting['scope.camera'] || false
    });
  },

  async reqCamAuth() {
    let setting = await wx.getSetting();
    if (setting.authSetting['scope.camera'] === false) {
      // 拒绝过授权，这时无法弹窗唤起授权，只能跳转到设置页面
      await wx.openSetting();
    } else {
      // 未申请过，唤起弹窗授权
      await wx.authorize({
        scope: 'scope.camera'
      });
    }
    this.checkAuth(); // 重新检查授权情况
  },

  takePhoto() {
    if (!this.data.cameraAuth) {
      return;
    }
    const that = this;
    const ctx = wx.createCameraContext();
    ctx.takePhoto({
      quality: 'high',
      success: (res) => {
        that.reset(); // 清空上一张照片的识别状态
        that.setData({
          photoPath: res.tempImagePath,
          photoBase64: wx.getFileSystemManager().readFileSync(res.tempImagePath, 'base64')
        });
        that.recognizePhoto();
      }
    });
  },

  /**
   * 广告与识别次数配置：全部来自「页面配置 → 广告设置」（setting.pages.ads），
   * 运营侧改库即生效，不需要改代码。
   */
  adConfig() {
    const ad = this.data.ad || {};
    const int = (v, dflt) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n >= 0 ? n : dflt;
    };
    const reset = String(ad.reset || 'daily');
    return {
      freeTimes: Math.max(1, int(ad.freeTimes, AD_DEFAULT_FREE)),
      bonus: Math.max(1, int(ad.bonus, AD_DEFAULT_BONUS)),
      reset: ['daily', 'weekly', 'never'].indexOf(reset) >= 0 ? reset : 'daily',
      exemptRoles: String(ad.exemptRoles || '').split(',').map((s) => s.trim()).filter(Boolean),
      videoUnitId: ad.video || '',
    };
  },

  // 计数读写统一走 utils/recognize.js（与投喂页共享同一份计数）
  adUsage() {
    return readAdUsage(this.adConfig().reset);
  },

  saveAdUsage(usage) {
    writeAdUsage(usage);
    // 同步一份快照到服务端，人员管理页才能看到每个人的识别/广告次数
    syncAdUsageToServer(usage);
  },

  /** 是否免广告：单用户到期时间（人员管理页设置）+ 页面配置的免广告人群 */
  async isAdExempt() {
    try {
      const user = await getUser();
      const info = (user && user.userInfo) || {};
      const until = info.adExemptUntil;
      if (until === 0 || until === '0') return true;                 // 0 = 永久免广告
      if (Number(until) > Date.now()) return true;                    // 限期免广告
      const cfg = this.adConfig();
      if (cfg.exemptRoles.length) {
        const type = await getUserType();
        if (cfg.exemptRoles.indexOf(type) >= 0) return true;
      }
    } catch (error) {
      console.warn('[recognize] 免广告判定失败，按不免处理', error);
    }
    return false;
  },

  /** 刷新「已识别 / 看广告 / 剩余次数」展示 */
  async refreshAdUsage() {
    const cfg = this.adConfig();
    // 以服务端快照为准（管理员在人员管理里改的剩余次数要立刻反映到识猫页）
    const usage = await fetchAdUsage(cfg.reset);
    const exempt = await this.isAdExempt();
    const total = cfg.freeTimes + usage.bonus;
    // usage.remaining 是权威的「还可识别次数」（管理员可直接设置）；
    // 老数据没有这个字段时按 free+bonus-used 计算，并顺手写回迁移一次。
    if (usage.remaining === null || usage.remaining === undefined) {
      usage.remaining = Math.max(0, total - usage.used);
      this.saveAdUsage(usage);
    }
    const remaining = exempt ? -1 : usage.remaining;
    this.setData({
      adUsage: { used: usage.used, ads: usage.ads, remaining: remaining, total: total, exempt: exempt },
      adUsageText: exempt
        ? '免广告用户 · 已识别 ' + usage.used + ' 次（不限次数）'
        : '已识别 ' + usage.used + ' 次 · 看广告 ' + usage.ads + ' 次 · 还可识别 ' + remaining + ' 次',
    });
    return { cfg, usage, exempt, remaining };
  },

  /**
   * 识别次数门禁：次数用完时必须看完一次激励视频，看完按配置增加次数。
   * 【为什么广告位缺失时放行】管理员没填广告位 / 平台无广告填充时若仍拦截，
   * 用户会彻底用不了识猫 —— 宁可少一次广告收入，也不能把功能锁死。
   */
  async ensureRecognizeQuota() {
    const state = await this.refreshAdUsage();
    if (state.exempt) return true;
    if (state.remaining > 0) return true;
    const unitId = state.cfg.videoUnitId;
    if (!unitId || unitId === 'your_ad_id' || typeof wx.createRewardedVideoAd !== 'function') {
      console.warn('[recognize] 未配置激励视频广告位，跳过广告门禁');
      return true;
    }
    const passed = await this.showRewardedAd(unitId);
    if (!passed) {
      wx.showToast({ icon: 'none', title: '看完广告才能继续识别哦', duration: 2500 });
      return false;
    }
    const usage = this.adUsage();
    usage.ads += 1;
    usage.bonus += state.cfg.bonus;
    if (usage.remaining !== null && usage.remaining !== undefined) usage.remaining += state.cfg.bonus;
    this.saveAdUsage(usage);
    await this.refreshAdUsage();
    wx.showToast({ icon: 'none', title: '已增加 ' + state.cfg.bonus + ' 次识别', duration: 2000 });
    return true;
  },

  /**
   * 识别成功计数。
   * 免广告用户**不消耗**每日额度：这样免广告到期后他还剩原来的次数，
   * 不会出现「免广告期间把额度用光、到期立刻被广告拦住」的情况。
   */
  async bumpAdUsage() {
    if (await this.isAdExempt()) return;
    const usage = this.adUsage();
    usage.used += 1;
    if (usage.remaining !== null && usage.remaining !== undefined) usage.remaining = Math.max(0, usage.remaining - 1);
    this.saveAdUsage(usage);
    this.refreshAdUsage();
  },

  /** 播放激励视频；看完 resolve(true)，中途关闭或出错按「放行/不放行」分别处理 */
  showRewardedAd(unitId) {
    return new Promise((resolve) => {
      if (!this.jsData.adVideo || this.jsData.adVideoUnitId !== unitId) {
        this.jsData.adVideo = wx.createRewardedVideoAd({ adUnitId: unitId });
        this.jsData.adVideoUnitId = unitId;
      }
      const ad = this.jsData.adVideo;
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        ad.offClose(onClose);
        ad.offError(onError);
        resolve(value);
      };
      const onClose = (res) => done(!!(res && res.isEnded));
      const onError = (err) => {
        // 广告加载失败不算用户的错：放行，避免功能被广告 SDK 卡死
        console.warn('[recognize] 激励视频不可用，放行本次识别', err);
        done(true);
      };
      ad.onClose(onClose);
      ad.onError(onError);
      ad.show().catch(() => ad.load().then(() => ad.show()).catch(onError));
    });
  },

  /**
   * 识别必须登录：未登录（没有 JWT/openid）时先尝试一次静默登录，仍失败就明确拒绝。
   * 放在广告门禁之前 —— 免广告人群/单用户免广告都依赖用户身份，没身份就无从判定。
   */
  async ensureLoginForRecognize() {
    try {
      // ⚠️ 这里用的是 cloudApi 的封装（api 是 cloudApi，不是 utils/api.js），
      // 它导出的是 getCurrentUserOpenid；之前误写成 api.getOpenid 会抛 TypeError，
      // 被 catch 后误判成「未登录」，于是已登录用户也一直弹登录框。
      const openid = await api.getCurrentUserOpenid();
      if (openid) return true;
    } catch (error) {
      console.warn('[recognize] 登录态检查失败', error);
    }
    this.setData({ recognitionMessage: '识别猫猫需要先登录，请重新进入小程序后再试' });
    wx.showModal({
      title: '需要登录',
      content: '识别猫猫需要先用微信登录。请重新进入小程序后再试；如果一直失败，请检查网络后重试。',
      showCancel: false,
    });
    return false;
  },

  async recognizePhoto() {
    if (!(await this.ensureLoginForRecognize())) return;
    if (!(await this.ensureRecognizeQuota())) return;
    const stateInitialized = this.initJsData();
    this.setData({ catList: [], catBoxList: [], showResultBox: false, unknownCat: false,
      recognitionMessage: '正在处理图片并请求识猫服务，请稍候…' });
    wx.showLoading({
      title: '翻阅猫谱中...',
      mask: true
    });
    let stage = '读取识猫配置';
    try {
      if (stateInitialized) {
        const settings = await getGlobalSettings('recognize', { nocache: true });
        this.jsData.secretKey = settings && settings.secretKey;
        this.setData({ recognizeMode: getRecognizeMode(settings) });
      }
      stage = '处理图片';
      const compressPhotoPath = await this.compressPhoto();
      const compressPhotoInfo = await wx.getImageInfo({ src: compressPhotoPath });
      this.jsData.compressPhotoInfo = compressPhotoInfo;
      console.log("compressPhotoInfo", compressPhotoInfo);
      const photoBase64 = wx.getFileSystemManager().readFileSync(compressPhotoPath, 'base64');
      const params = { photoBase64 };
      if (this.jsData.secretKey) {
        params.timestamp = Math.round(new Date().getTime() / 1000);
        params.signature = hex_sha256(photoBase64 + params.timestamp + this.jsData.secretKey);
      }
      if (this.data.catMeowIdx !== null && this.data.catMeowIdx !== undefined) {
        params.catIdx = this.data.catMeowIdx;
      }
      stage = '请求识猫服务';
      const res = await api.catFace(params);
      console.log('[recognize response]', {
        ok: res && res.ok, code: res && res.code, requestId: res && res.requestId,
        provider: res && res.data && res.data.provider,
        catCount: res && res.data && res.data.catCount,
        matches: res && res.data && (res.data.recognizeResults || []).length,
        unknown: res && res.data && res.data.unknown,
      });
      if (!res || res.ok !== true) {
        // 服务错误 / 额度不足：不能解释成"照片里没有猫"
        const code = (res && res.code) || '';
        let title = '识别失败，请稍后再试';
        if (code === 'expired') title = '请求已过期，请重试';
        else if (code === 'bad_signature') title = '校验失败，请重试';
        else if (code === 'not_configured') title = '识猫服务未配置';
        else if (res && res.msg) title = String(res.msg).slice(0, 30);
        this.setData({ recognitionMessage: (res && res.msg) || title });
        wx.hideLoading();
        wx.showToast({ icon: 'none', title: title, duration: 2500 });
        wx.reportMonitor('recognizeCatPhotoError', 1);
        return;
      }
      const data = res.data || {};
      this.setData({ recognizeMode: data.provider || this.data.recognizeMode, catCount: data.catCount || 0 });
      // 检测到猫但云端身份未确认（有候选也不能自动认定）
      this.setData({ unknownCat: !!data.unknown });
      if (!data.catCount) {
        // 没检测到猫：后端此时不扣次数，用专门文案
        wx.hideLoading();
        this.setData({ recognitionMessage: text_cfg.recognize.no_cat_tip });
        wx.showToast({ icon: 'none', title: text_cfg.recognize.no_cat_tip, duration: 2000 });
        return;
      }
      stage = '加载猫咪档案';
      await this.loadRecognizeResult(data);
      // 识别成功才计入次数（没检测到猫不扣）
      this.bumpAdUsage();
    } catch (err) {
      console.log('get error from catFace:', err);
      const isTimeout = ['FunctionTimeout', 'timeout', 'ETIMEDOUT'].includes((err && err.code) || '');
      const message = isTimeout ? '识别请求超时（超过 55 秒），请稍后重试。'
        : stage === '读取识猫配置' ? '读取识猫配置失败，请稍后重试。'
        : stage === '处理图片' ? '图片处理失败，请重新选择照片后再试。'
        : stage === '加载猫咪档案' ? '识别已返回，但加载猫咪档案失败，请稍后重试。'
          : '识别请求失败，请检查网络后重试。';
      this.setData({ recognitionMessage: message });
      wx.hideLoading();
      wx.showToast({
        icon: 'none',
        title: isTimeout ? '识别请求超时' : '网络或服务异常'
      });
      wx.reportMonitor('recognizeCatPhotoError', 1);
    } finally {
      wx.hideLoading();
    }
  },

  async compressPhoto() {
    // 获取图像宽高信息
    const photoInfo = await wx.getImageInfo({
      src: this.data.photoPath,
    });
    console.log('photo info:', photoInfo);
    // 记录图片长宽比。用于重新映射后端返回的catBox位置信息。
    this.jsData.widthHeightRatio = photoInfo.width / photoInfo.height;
    // 使用canvas方法压缩图片
    const { canvasSideLen } = this.jsData;
    const drawRate = Math.max(photoInfo.width, photoInfo.height) / canvasSideLen; // 计算缩放比
    const drawWidth = photoInfo.width / drawRate;
    const drawHeight = photoInfo.height / drawRate;
    if (!this.jsData.ctx) {
      const { ctx, canvas } = await drawUtils.initCanvas('#canvasForCompress');
      this.jsData.ctx = ctx;
      this.jsData.canvas = canvas;
    }
    const { ctx, canvas } = this.jsData;
    await drawUtils.drawImage(ctx, canvas, photoInfo.path, 0, 0, drawWidth, drawHeight);

    const compressPhotoPath = await drawUtils.getTempPath(ctx, canvas, {
      width: drawWidth,
      height: drawHeight,
      destWidth: drawWidth,
      destHeight: drawHeight,
      fileType: 'jpg'
    });

    return compressPhotoPath;
  },

  async loadRecognizeResult(result) {
    // 解析猫猫框
    let catBoxes = result.catBoxes;
    let catBoxList = [];
    const previewSideLen = 675; // view#previewArea的长宽rpx值
    const compressSideLen = this.jsData.canvasSideLen; // 上传到后台的图片的长边长度
    const ratio = previewSideLen / compressSideLen; // 缩放比
    const { compressPhotoInfo } = this.jsData;
    for (let catBox of catBoxes) {
      let xOffset = 0, yOffset = 0;
      // 短边由于居中会产生offset
      if (this.jsData.widthHeightRatio < 1) {
        xOffset = previewSideLen * ((1 - this.jsData.widthHeightRatio) / 2);
      } else {
        yOffset = previewSideLen * ((1 - 1 / this.jsData.widthHeightRatio) / 2);
      }
      console.log(catBox, ratio, xOffset, yOffset, previewSideLen);

      // PC端压缩后的照片，尺寸不一定是500
      const realDrawRate = compressSideLen / Math.max(compressPhotoInfo.width, compressPhotoInfo.height);

      catBoxList.push({
        // 后端候选下标，点击框重新识别时回传（不能直接用数组位置）
        meowIdx: catBox.index,
        x: catBox.xmin * realDrawRate * ratio + xOffset,
        y: catBox.ymin * realDrawRate * ratio + yOffset,
        width: (catBox.xmax - catBox.xmin) * realDrawRate * ratio,
        height: (catBox.ymax - catBox.ymin) * realDrawRate * ratio
      });
    }
    console.log("cat box list:", catBoxList);
    this.setData({
      catBoxList: catBoxList
    });
    // 识别结果：MeowID 侧已登记但本地没绑定的猫会拿不到结果
    const results = result.recognizeResults || [];
    if (!results.length) {
      this.setData({ recognitionMessage: '识别到了猫咪，但没有匹配到猫谱中的档案。请确认该猫已同步并注册完成，或换一张清晰的照片。' });
      wx.hideLoading();
      wx.showToast({
        icon: 'none',
        title: '没有匹配到猫谱中的档案',
        duration: 2500
      });
      return;
    }
    this.jsData.recognizeResults = await Promise.all(results.map(this.getCatInfo));
    await this.pickCatList();
    if (!this.data.catList.length) {
      this.setData({ recognitionMessage: '当前筛选条件下没有匹配的猫咪，请重新选图或调整筛选条件。' });
      return;
    }
    this.setData({ recognitionMessage: '' });
    wx.hideLoading();
    // 在布局完成上移后展示resultBox
    const that = this;
    setTimeout(() => {
      that.setData({
        showResultBox: true,
      });
    }, 500);
  },

  catFilter(res) {
    //点击筛选picker
    var type = res.currentTarget.dataset.type;
    this.setData({
      [type + 'IndexOld']: this.data[type + 'Index'],
      lastFilterType: type,
      [type + 'Index']: res.detail.value
    })
    this.pickCatList();
  },

  async pickCatList() {
    wx.showLoading({
      title: '筛选中...',
    })

    const that = this;
    console.log("recognizeResults:", this.jsData.recognizeResults);
    const choseCampus = that.data.campusList[that.data.campusIndex];
    const choseColour = that.data.colourList[that.data.colourIndex];
    const catList = this.jsData.recognizeResults.filter(cat => {
      if ((choseCampus === cat.campus || choseCampus === "所有校区") && (choseColour === cat.colour || choseColour === "所有花色")) {
        return true; //筛选结果
      }
    });

    console.log("catList:", catList);
    if (catList.length === 0) {
      wx.hideLoading();
      this.setData({
        [this.data.lastFilterType + 'Index']: this.data[this.data.lastFilterType + "IndexOld"] // 无筛选结果，恢复原选项
      })
      wx.showToast({
        title: '找不到这样的猫猫，试试换个选项吧',
        duration: 2000,
        icon: 'none',
        mask: true
      })
      return false;
    } else {
      this.calculateSoftmaxProb(catList);
    }

    let displayList = [];
    // 少于maxNum只全部展示；多于maxNum：最多maxNum只，最少minNum只，去除概率太低的
    const minProb = 0.001;
    const minNum = 3;
    const maxNum = 5;

    if (catList.length <= maxNum) {
      for (let index = 0; index < catList.length; index++) {
        const catInfo = catList[index];
        catInfo.photo = await this.getCatPhoto(catInfo);
        displayList.push(catInfo);
      }
    } else {
      for (let index = 0; index < maxNum; index++) {
        if (catList[index].prob > minProb || index < minNum) {
          const catInfo = catList[index];
          catInfo.photo = await this.getCatPhoto(catInfo);
          displayList.push(catInfo);
        } else {
          break;
        }
      }
    }

    this.setData({
      catList: displayList
    });
    wx.hideLoading();
  },

  // 根据模型输出的得分（即每个对象的score属性）计算softmax概率，并将结果放到原对象的prob属性上
  calculateSoftmaxProb(catList) {
    // const scores = catList.map(item => item.score);
    // const maxScore = scores.reduce((prev, cur) => Math.max(prev, cur));
    // const expScoreSum = scores.reduce((prev, cur) => prev + Math.exp(cur - maxScore), 0);
    catList.forEach(item => {
      // 目前的 yolo 识猫模型，会直接输出概率，不需要再次 softmax
      item.prob = item.score;
      // item.prob = Math.exp(item.score - maxScore) / expScoreSum;
    });
  },

  async getCatInfo(cat) {
    const { result: catInfo } = await apiDb.collection('cat').findOne({ _id: cat.catID });
    catInfo.score = cat.score;
    return catInfo;
  },

  async getCatPhoto(catInfo) {
    // 从精选照片里随机挑选一张
    const query = {
      cat_id: catInfo._id,
      verified: true,
      best: true
    };
    var total = catInfo.photo_count_best;
    var index = randomInt(0, total);
    var { result: photoURL } = await apiDb.collection('photo').findOne(query, { skip: index });
    const signedPhotoURL = await signPhotoUrls(photoURL);
    return signedPhotoURL;
  },

  async choosePhoto() {
    var res;
    try {
      res = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sizeType: ["compressed"],
        sourceType: ['album'],
      })
    } catch (err) {
      // 用户主动取消（chooseMedia:fail cancel）不是错误，静默返回，
      // 否则会变成未处理的 Promise 拒绝（app.js 会打印告警）
      const errMsg = (err && (err.errMsg || err.message)) || '';
      if (errMsg.includes('cancel')) {
        return;
      }
      console.error('[choosePhoto] 选择图片失败:', err);
      wx.showToast({ title: '选择图片失败', icon: 'none' });
      return;
    }

    const filePath = res.tempFiles[0].tempFilePath;
    this.reset(); // 清空上一张照片的识别状态（含 catIdx / catMeowIdx）
    this.setData({
      photoPath: filePath,
      photoBase64: wx.getFileSystemManager().readFileSync(filePath, 'base64')
    });
    this.recognizePhoto();
  },

  reset() {
    this.setData({
      photoPath: null,
      photoBase64: null,
      catBoxList: [],
      catList: [],
      catIdx: null,
      catMeowIdx: null,
      unknownCat: false,
      recognitionMessage: '',
      showResultBox: false,
      campusIndex: 0,
      colourIndex: 0
    });
  },

  reverseCamera() {
    if (!this.data.cameraAuth) {
      return;
    }
    if (this.data.devicePosition === 'front') {
      this.setData({
        devicePosition: 'back'
      });
    } else {
      this.setData({
        devicePosition: 'front'
      });
    }
  },

  savePhoto() {
    wx.saveImageToPhotosAlbum({
      filePath: this.data.photoPath,
      success() {
        wx.showToast({
          title: '保存成功',
          icon: 'success',
        });
      }
    })
  },

  tapCatCard(e) {
    const catId = e.currentTarget.dataset.catId;
    wx.navigateTo({
      url: '/pages/genealogy/detailCat/detailCat?cat_id=' + catId,
    });
  },

  tapPreview(e) {
    if (!this.data.photoPath) {
      return;
    }
    wx.previewImage({
      urls: [this.data.photoPath],
    });
  },

  tapCatBox(e) {
    const index = e.currentTarget.dataset.index;
    const box = this.data.catBoxList[index];
    const currentCatIdx = this.data.catIdx in this.data.catBoxList ? this.data.catIdx : 0;
    if (index !== currentCatIdx) {
      this.setData({
        catList: [],
        showResultBox: false,
        catIdx: index,
        // 回传后端候选下标（没有就退回数组位置）
        // 注意：切换猫会重新调用识别，并按后端规则再次计入次数
        catMeowIdx: box && box.meowIdx !== undefined ? box.meowIdx : index,
      });
      this.recognizePhoto();
    }
  },

  onShareAppMessage() {
    return {
      title: share_text,
      imageUrl: '/pages/public/images/recognize/share_cover.jpg'
    };
  },
  onShareTimeline: function () {
    return this.onShareAppMessage();
  },

  adLoad() {
    console.log('Banner 广告加载成功')
    this.setData({
      showAdBox: true
    });
  },
  adError(err) {
    console.log('Banner 广告加载失败', err)
    this.setData({
      showAdBox: false
    });
  },
  adClose() {
    console.log('Banner 广告关闭')
    this.setData({
      showAdBox: false
    });
  }

})