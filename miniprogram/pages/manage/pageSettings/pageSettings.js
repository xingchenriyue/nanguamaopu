// pages/manage/pageSettings/pageSettings.js
import { checkAuth } from "../../../utils/user";
import { getGlobalSettings, invalidateSettingCache } from "../../../utils/page";
import api from "../../../utils/cloudApi";
import { isWriteOk } from "../../../utils/common";
import desc from "./desc";

// 识猫设置分两个入口，字段级互补、互不覆盖：
//   页面配置页管「展现」：recognize.showRecognizeBtn / recognize.interfaceURL / ads.recognize_banner
//   识猫服务页管「服务接入」：recognize.mode / recognize.secretKey
// 所以本页只隐藏「接入类字段 + 历史遗留项」，不再隐藏整个 recognize 组。
const HIDDEN_RECOGNIZE_GROUPS = ["recognize_test"];          // 历史遗留组，整体隐藏
// 识猫页激励视频广告位已重新启用（识别满 2 次要看完一次才继续），不再隐藏
const HIDDEN_RECOGNIZE_ADS_FIELDS = [];
const HIDDEN_RECOGNIZE_FIELDS = ["mode", "secretKey"];      // 识猫服务页负责的字段，字段级隐藏

// 从 settings 树里摘出识猫相关字段（深拷贝），返回 { groups, adsFields, recognizeFields }
// groups：整组隐藏的（当前只有历史遗留的 recognize_test）
// adsFields：ads 组里整字段隐藏的（当前只有历史遗留的 recognize_video）
// recognizeFields：recognize 组里字段级隐藏的（mode / secretKey，由识猫服务页管理）
function pickHiddenRecognition(settings) {
  const groups = {};
  for (const g of HIDDEN_RECOGNIZE_GROUPS) {
    if (settings[g] !== undefined) {
      groups[g] = JSON.parse(JSON.stringify(settings[g]));
      delete settings[g];
    }
  }
  const adsFields = {};
  if (settings.ads) {
    for (const f of HIDDEN_RECOGNIZE_ADS_FIELDS) {
      if (settings.ads[f] !== undefined) {
        adsFields[f] = settings.ads[f];
        // 摘出渲染树：页面配置不再显示这个字段（desc.js 已无描述，否则渲染成"未知字段"）。
        // 值保存在 adsFields，提交时由 uploadSetting 合并回 ads，不会丢失。
        delete settings.ads[f];
      }
    }
  }
  // recognize 组：只摘「接入类字段」，**保留整组在渲染树里**，
  // 这样 showRecognizeBtn / interfaceURL 能正常渲染成可编辑字段（识猫页展现配置）。
  const recognizeFields = {};
  if (settings.recognize && typeof settings.recognize === 'object') {
    for (const f of HIDDEN_RECOGNIZE_FIELDS) {
      if (settings.recognize[f] !== undefined) {
        recognizeFields[f] = JSON.parse(JSON.stringify(settings.recognize[f]));
        // 摘出渲染树，避免渲染成"未知字段"（desc.js 里刻意没写这两个字段的描述）
        delete settings.recognize[f];
      }
    }
  }
  return { groups, adsFields, recognizeFields };
}


Page({
  /**
   * 页面的初始数据
   */
  data: {
    settings: {},
    desc,
  },

  /**
   * 生命周期函数--监听页面加载
   */
  async onLoad(options) {
    // jsData 放页面实例上，不作为 Page 的顶层选项：
    // 微信会把顶层 jsData 判为“游离数据”并告警
    // "Free data with key \"jsData\" ... seems not a simple value"。
    this.jsData = {
      // 页面配置不展示、但提交时需要原样写回的识猫字段（防止覆盖识猫服务页的修改）
      hiddenRecognition: null,
    };

    if (await checkAuth(this, 99)) {
      await this.reloadSettings();
      if (options.tip) {
        wx.showModal({
          title: "请修改设置",
          content: decodeURIComponent(options.tip),
          showCancel: false
        });
      }
    }
  },


  setDefaultValues(settings) {
    let shouldUpload = false;
    for (const i in desc) {
      for (const j in desc[i]) {
        var defaultValue = desc[i][j].default;
        // 【必须用 === undefined，不能用 == undefined】
        // `null == undefined` 为 true（宽松相等），所以原来的 `==` 会把
        // 「值确实为 null 的项」也当成「未设置」，从而用默认值覆盖用户已存的 null。
        if (defaultValue === undefined) {
          continue;
        }
        if (typeof defaultValue === "string" && defaultValue.startsWith("#copy")) {
          var [_, ci, cj] = defaultValue.split("-");
          defaultValue = settings[ci] ? settings[ci][cj] : undefined;
          if (defaultValue === undefined) continue;
        }
        // 同理：settings[i] 为 null 时要新建对象，不能沿用 null
        if (settings[i] === undefined || settings[i] === null) {
          shouldUpload = true;
          settings[i] = {}
        }
        if (settings[i][j] === undefined) {
          settings[i][j] = defaultValue;
        }
      }
    }

    if (shouldUpload) {
      this.uploadSetting();
    }
  },

  // 排序一下Map，target为需要排序的东西，example是参考的标准
  sortMap(target, example) {
    // 【必须挡住 null】
    // typeof null === 'object'，所以只判 typeof 不够。
    // 背景：Mongo 里缺失的字段在 PG 里是 NULL，序列化回 JSON 后是 null 而非 undefined。
    // 当 target[key] === null 且 example[key] 是对象时，旧代码的
    // `target[key] === undefined` 判定不成立（null !== undefined），
    // 于是递归进去读 null.tip → TypeError: Cannot read properties of null。
    // 这就是「页面配置无法更新 / 报 reading 'tip'」的直接原因。
    if (target === null || target === undefined) {
      return target === undefined ? undefined : null;
    }
    if (typeof target !== "object") {
      return target;
    }
    // example 为 null / undefined 时没有可参考的标准结构，直接返回 target
    if (example === null || example === undefined || typeof example !== "object") {
      return target;
    }
    var res = {};
    for (const key in example) {
      if (target[key] === undefined) {
        continue;
      }
      res[key] = this.sortMap(target[key], example[key]);
    }

    for (const key in target) {
      if (res[key] === undefined) {
        res[key] = target[key];
      }
    }

    return res;
  },

  // 加载数据库设置
  async reloadSettings() {
    let settings = await getGlobalSettings(null, { nocache: true });
    console.log(JSON.stringify(settings));
    delete settings._id;
    delete settings.openid;
    delete settings.mdate;
    // 摘出识猫字段：不展示、不参与默认值填充；提交时原样合并回库
    this.jsData.hiddenRecognition = pickHiddenRecognition(settings);
    this.setDefaultValues(settings);
    settings = this.sortMap(settings, desc);

    // 【为什么要在渲染前剔除 null 字段】
    // Mongo 里这些 key 根本不存在，迁到 PG 后变成「有列但值 NULL」，
    // 序列化回 JSON 是 null。页面配置把它们当成一项「配置」渲染出来，
    // 但它们既没有 desc 描述、值也是空的 —— 用户看到的就是一屏
    // 「colour / campuses / area / apps / verifyPhoto / ... 未知配置，
    // 请在desc.js中添加描述」的垃圾条目。
    // 服务器实测（2026-11-09）：pages 文档共有 13 个值为 null 的顶层字段：
    //   colour / campuses / area / apps / verifyPhoto / chkFeedback / types /
    //   rules / accessToken / expiredAt / lastUpdate / lastRunDate / lastRunAt
    // 判定：顶层 key 的值是 null → 视为「该配置项不存在」，不渲染、不提交。
    for (const k in settings) {
      if (settings[k] === null) {
        delete settings[k];
      }
    }

    // 顶层是标量（如 app_name: "南瓜猫谱"）的也不是「配置组」——
    // wxml 的结构是 desc[i].tip + desc[i][j] 两层，标量套不进去，
    // 渲染出来只会是一行没有意义的标题。同样不展示。
    for (const k in settings) {
      const v = settings[k];
      if (typeof v !== 'object' || Array.isArray(v)) {
        delete settings[k];
      }
    }

    // 【关键：desc 不能就地改】
    // desc 是模块级单例（import 进来的同一个对象），reloadSettings 每次进来
    // 都往里补 desc[i] = {...}，会把这次读到的临时结构**永久写进模块状态**，
    // 下次进页面时残留上一轮的脏 key（用户截图里的「一堆莫名其妙的字」）。
    // 所以这里深拷贝一份再补，模块级 desc 保持原样。
    const descView = JSON.parse(JSON.stringify(desc));
    for (const i in settings) {
      if (descView[i] === undefined) {
        descView[i] = {
          tip: "未知配置，请在desc.js中添加描述",
        }
      }
      for (const j in settings[i]) {
        // console.log(descView[i][j], settings[i][j])
        if (descView[i][j] === undefined) {
          descView[i][j] = {
            tip: "未知字段，请在desc.js中添加描述，该值无法被修改",
            type: "origin",
            disabled: true,
          }
        }
      }
    }
    this.setData({
      settings,
      desc: descView
    });
  },

  // 获取输入
  inputChange(e) {
    var { i, j } = e.currentTarget.dataset;
    var { value } = e.detail;
    this.setData({
      [`settings.${i}.${j}`]: value
    });
  },

  // 获取checkBox输入
  checkBoxChange(e) {
    var { i, j } = e.currentTarget.dataset;
    var { value } = e.detail;
    this.setData({
      [`settings.${i}.${j}`]: value.join(",")
    });
  },

  // 获取switch输入
  switchChange(e) {
    var { i, j } = e.currentTarget.dataset;
    var { value } = e.detail;
    this.setData({
      [`settings.${i}.${j}`]: value
    });
  },

  // 检查设置类型有效
  checkAvaliable() {
    var { settings, desc } = this.data;
    for (const i in settings) {
      for (const j in settings[i]) {
        const type = desc[i][j].type;
        var value = settings[i][j];
        // console.log(i, j, value, type);
        if (type == "number") {
          if (isNaN(value)) {
            wx.showModal({
              title: '提示',
              content: `字段${i}.${j}无效，值为"${value}"`,
              showCancel: false
            });
            return false;
          }
          settings[i][j] = parseFloat(value);
        }
        if (type == "bool") {
          // 规范化为布尔值，兼容历史数据中可能存的字符串 "true"/"false"
          settings[i][j] = (value === true || value === "true");
        }
        // 不允许关闭info Tabbar，以防不能再调回去
        if (i == "tabBarCtrl") {
          if ((j == "ctrlTab" && value.includes("info")) || (j == "fullTab" && !value.includes("info"))) {
            wx.showModal({
              title: '提示',
              content: `不可隐藏关于页`,
              showCancel: false
            });
            return false;
          }
        }
      }
    }

    return true;
  },

  // 上传设置
  async uploadSetting() {
    if (!await this.checkAvaliable()) {
      return false;
    }

    wx.showLoading({
      title: '上传中...',
    })

    const { settings } = this.data;

    // 把识猫相关字段原样合并回去：
    // - 整组隐藏的（recognize_test）与 ads 里隐藏的广告位：保留数据库现值
    // - recognize 组：隐藏字段（mode/secretKey）优先级最低，被本页可编辑字段覆盖。
    //   不这样做的话，整树 $set 会用本页读到的旧值覆盖识猫服务页刚保存的 mode/secretKey。
    const merged = Object.assign({}, settings);
    const hidden = this.jsData.hiddenRecognition;
    if (hidden) {
      for (const g of Object.keys(hidden.groups)) {
        merged[g] = hidden.groups[g];
      }
      if (hidden.adsFields && Object.keys(hidden.adsFields).length) {
        merged.ads = Object.assign({}, settings.ads, hidden.adsFields);
      }
      // 隐藏字段（mode/secretKey）优先级最低，被本页可编辑字段覆盖
      const hiddenFields = hidden.recognizeFields || {};
      const editable = settings.recognize || {};
      if (Object.keys(hiddenFields).length || Object.keys(editable).length) {
        merged.recognize = Object.assign({}, hiddenFields, editable);
      }
    }

    // 【不能把 null 写回库】
    // 顶层有一批字段在 Mongo 时代根本不存在，迁到 PG 后是「有列但值为 NULL」。
    // 本页不展示它们（reloadSettings 已剔除），若照原样提交就会把整树 $set 成
    // 一堆 null —— 反而把数据库里其它页面的配置清空（用户日志里
    // accessCtrl.disabledFunc 从有值变成 "" 就是这么来的）。
    // 所以：提交前剔除值为 null 的顶层字段，等价于「没碰过这个字段」。
    for (const k of Object.keys(merged)) {
      if (merged[k] === null) {
        delete merged[k];
      }
    }

    const res = await api.curdOp({
      operation: "update",
      collection: "setting",
      item_id: "pages",
      data: merged
    })
    // 【成功判定】后端 curdOp 的 update 分支返回 updateOne 的原始结果
    // { matchedCount, modifiedCount, acknowledged }，没有 ok 字段。
    // 原判定 `if (res.ok)` 恒为假 → 保存成功后既不提示成功也不刷新页面，
    // 表现为「页面配置无法更新」。这里按 matchedCount 判定。
    if (isWriteOk(res)) {
      // 失效设置缓存：否则下一次读取拿到 168 小时前的旧值，
      // 表现为「保存成功了但页面显示的还是旧配置」
      invalidateSettingCache('pages');
      wx.showToast({
        title: '保存成功',
        icon: "success"
      });
      await this.reloadSettings();
    } else {
      console.error('[pageSettings] 保存设置失败，后端返回：', res);
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

})