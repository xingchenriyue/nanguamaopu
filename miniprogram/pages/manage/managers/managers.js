const apiDb = require('../../../utils/api.js').db;
// miniprogram/pages/manage/managers.js
import { checkAuth } from "../../../utils/user";
import { formatDate } from "../../../utils/utils";
import api from "../../../utils/cloudApi";
import { signCosUrl, isWriteOk } from "../../../utils/common";
import { isDemoMode } from "../../../utils/demo";
import { initLayout, getGlobalSettings } from "../../../utils/page";
import { adBucketKey } from "../../../utils/recognize";
import { getPageMetrics } from "../../../utils/layout";

// 是否正在加载
var loading = false;
const app = getApp();
Page({

  /**
   * 页面的初始数据
   */
  data: {
    // 顶部自定义导航栏预留高度（由 initLayout 注入）
    navTotalHeight: 0,
    tipText: '正在鉴权...',
    tipBtn: false,
    userSearch: '',
    managerOnly: false,
    loggedinOnly: false,   // 只看登录用户（有昵称 + 有头像）
    adFreeTimes: 2,        // 识猫每天赠送次数（来自页面配置，用于算「剩余识别次数」）
    adReset: 'daily',      // 识别次数重置策略（与识猫页同一份配置，决定 bucket）
    // 「设置剩余识猫次数」弹窗状态
    adRemainingModal: { show: false, index: -1, current: 0, value: '' },
    users: [],
    // 内层滚动区可用高度（由 initLayout 注入：视口高度 - 毛玻璃顶栏）
    windowHeight: "300",
    manager_types: ['0-非管理员', '1-审核照片、删除便利贴', '2-修改猫猫、校区、关系、徽章', '3-发布公告', '99-管理成员、页面设置、处理图片、识猫服务'],
    role_types: ['游客', '特邀用户'],
    // Tab
    currentTab: 'users',
    // 地图待审申请
    applications: [],
    appsLoading: false,
    appCount: 0,
  },
  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: async function (options) {
    // 自定义导航栏 + 悬浮 dock 的布局尺寸
    initLayout(this);
    // 识猫「每天赠送次数」影响每人剩余次数的换算，先读页面配置
    const ads = await getGlobalSettings('ads', { nocache: true }) || {};
    const freeTimes = parseInt(ads.recognize_free_times, 10);
    const reset = ['daily', 'weekly', 'never'].indexOf(String(ads.recognize_ad_reset)) >= 0 ? String(ads.recognize_ad_reset) : 'daily';
    this.setData({
      adFreeTimes: Number.isFinite(freeTimes) && freeTimes >= 1 ? freeTimes : 2,
      adReset: reset,
    });
    if (await checkAuth(this, 99)) {
      await this.loadUsers(true);
      this.getHeights();
      this.loadApplications();
    }
  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady: function () {

  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow: function () {
    // 每次切回来刷新待审数量
    if (this.data.auth) {
      this.loadApplications();
    }
  },

  // ========== Tab 切换 ==========

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ currentTab: tab });
    if (tab === 'apps') {
      this.loadApplications();
    }
  },

  // ========== 用户列表 ==========

  // 读取用户列表
  loadUsers: async function (reload) {
    if (loading) {
      return false;
    }
    var users = this.data.users;
    loading = true;
    wx.showLoading({
      title: '加载中...',
    });
    var userSearch = this.data.userSearch;
    var query = {};
    if (userSearch) {
      // 转义正则元字符：把用户输入当字面串搜索，避免被输入特殊的正则拖垮数据库
      const safeSearch = String(userSearch).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 50);
      query["userInfo.nickName"] = { $regex: safeSearch, $options: 'i' }
    }
    if (this.data.managerOnly) {
      query["manager"] = { $gt: 0 }
    }
    if (this.data.role1Only) {
      query["role"] = { $gt: 0 }
    }
    if (this.data.mapAccessOnly) {
      query["mapAccess.status"] = "approved"
    }
    // 只看登录用户：有昵称 + 有头像（与识猫页 classifyUser 的判定一致）
    if (this.data.loggedinOnly) {
      const and = query.$and || [];
      and.push({ "userInfo.nickName": { $gt: "" } });
      and.push({ "userInfo.avatarUrl": { $gt: "" } });
      query.$and = and;
    }
    console.log("query", query);
    var { result: userRes } = await apiDb.collection('user').find(query, { skip: users.length, limit: 10 })
    await this.signUserAvatars(userRes);
    console.log(userRes);
    wx.hideLoading();
    if (reload) {
      users = userRes;
    } else {
      if (!userRes.length) {
        wx.showToast({
          title: '加载完啦',
          icon: 'none',
        })
        loading = false;
        return;
      }
      users = users.concat(userRes);
    }
    // 附加识猫次数 / 免广告的展示字段（wxml 里不写复杂表达式）
    const freeTimes = Number(this.data.adFreeTimes) || 2;
    // 与识猫页共用同一套 bucket 算法，避免两边口径不一致导致「管理页显示剩余、识猫页显示另一套」
    const bucketNow = adBucketKey(this.data.adReset || 'daily', Date.now());
    for (const u of users) {
      const usage = u.recognizeUsage || {};
      const stale = !!usage.bucket && usage.bucket !== bucketNow;
      const used = stale ? 0 : (Number(usage.used) || 0);
      const ads = stale ? 0 : (Number(usage.ads) || 0);
      const bonus = stale ? 0 : (Number(usage.bonus) || 0);
      // 剩余次数以快照里的 remaining 为准（管理员可直接设置），缺省按总额-已用计算
      const hasRemaining = !stale && usage.remaining !== undefined && usage.remaining !== null;
      u.adUsed = used;
      u.adSeen = ads;
      u.adRemaining = hasRemaining ? Math.max(0, Number(usage.remaining) || 0) : Math.max(0, freeTimes + bonus - used);
      const until = u.userInfo && u.userInfo.adExemptUntil;
      const permanent = until === 0 || until === '0';
      const daysLeft = Number(until) > Date.now() ? Math.ceil((Number(until) - Date.now()) / 86400000) : 0;
      u.adExempt = permanent || daysLeft > 0;
      u.adExemptText = permanent ? '永久' : (daysLeft > 0 ? ('还剩 ' + daysLeft + ' 天') : '无');
    }
    this.setData({
      users: users
    });
    loading = false;
  },

  async signUserAvatars(users) {
    for (let i = 0; i < users.length; i++) {
      if (users[i].userInfo?.avatarUrl) {
        users[i].userInfo.avatarUrl = await signCosUrl(users[i].userInfo.avatarUrl);
      }
    }
  },

  // 滑到底部来reload
  scrollToReload: async function (e) {
    await this.loadUsers();
  },

  fSearchInput: function (e) {
    const value = e.detail.value;
    this.setData({
      userSearch: value
    });
  },

  // 搜索
  fSearch: async function (e) {
    this.data.users = [];
    await this.loadUsers(true);
  },

  // 筛选条件复选框
  async filterChange(e) {
    let filters = e.detail.value;
    this.data.managerOnly = filters.indexOf('manager-only') != -1;
    this.data.role1Only = filters.indexOf('role1-only') != -1;
    this.data.mapAccessOnly = filters.indexOf('mapAccess-only') != -1;
    this.data.loggedinOnly = filters.indexOf('loggedin-only') != -1;
    this.data.users = [];
    await this.loadUsers(true);
  },

  // 获取一下页面高度，铺满scroll-view
  // 注意：自定义导航栏下 windowHeight 不再减去原生导航栏高度，
  // 语义与改造前不同，这里统一用 layout.js 推导的 contentHeight。
  getHeights() {
    const metrics = getPageMetrics(0);
    this.setData({
      "windowHeight": metrics.contentHeight,
    });
  },

  // ========== 用户设置更新（管理员等级 + 角色，一次更新） ==========

  // 管理员等级 picker 变动
  /**
   * 手动设置某个用户的「剩余识猫次数」。
   * 换算逻辑：保持 daily 赠送 base 不动，调 used；剩余超过总额时提高 bonus。
   * 写 user.recognizeUsage（jsonb），与识猫页上报的快照是同一个字段。
   */
  // 打开「设置剩余识猫次数」弹窗（页面内自绘，输入框直接可见可填）
  setAdRemaining(e) {
    const index = e.currentTarget.dataset.index;
    const user = this.data.users[index];
    if (!user) return;
    const freeTimes = Number(this.data.adFreeTimes) || 2;
    const usage = user.recognizeUsage || {};
    const used = Number(usage.used) || 0;
    const bonus = Number(usage.bonus) || 0;
    // 与列表展示保持一致：优先用快照里的 remaining（管理员设置的值），
    // 没有才回退到 free+bonus-used。之前这里只用了旧算法，导致弹窗显示 2、列表显示 0。
    const bucketNow = adBucketKey(this.data.adReset || 'daily', Date.now());
    const stale = !!usage.bucket && usage.bucket !== bucketNow;
    const hasRemaining = !stale && usage.remaining !== undefined && usage.remaining !== null;
    const current = hasRemaining
      ? Math.max(0, Number(usage.remaining) || 0)
      : Math.max(0, freeTimes + bonus - used);
    this.setData({
      adRemainingModal: { show: true, index, current, value: String(current) },
    });
  },

  onAdRemainingInput(e) {
    this.setData({ 'adRemainingModal.value': e.detail.value });
  },

  closeAdRemaining() {
    this.setData({ adRemainingModal: { show: false, index: -1, current: 0, value: '' } });
  },

  async confirmAdRemaining() {
    const modal = this.data.adRemainingModal || {};
    const index = modal.index;
    const user = this.data.users[index];
    if (!user) return;
    const raw = String(modal.value || '').trim();
    const target = parseInt(raw, 10);
    if (raw === '' || !Number.isFinite(target) || target < 0) {
      wx.showToast({ icon: 'none', title: '请输入不小于 0 的整数' });
      return;
    }
    const usage = user.recognizeUsage || {};
    // 只设置「剩余次数」，**不动已识别次数**：
    // 之前用 used = total - 剩余 反推，导致管理员设 0 时把「已识别」从 0 改成 5。
    // bucket 必须与识猫页同一个算法（按当前重置策略），否则会判成「上个周期」而清零。
    const bucket = adBucketKey(this.data.adReset || 'daily', Date.now());
    const nextUsage = Object.assign({}, usage, {
      bucket,
      remaining: target,
      updatedAt: Date.now(),
    });
    let result;
    try {
      result = await api.curdOp({ operation: 'update', collection: 'user', item_id: user._id, data: { recognizeUsage: nextUsage } });
    } catch (error) {
      console.error('[managers] 设置剩余次数失败', error);
      wx.showToast({ icon: 'none', title: '保存失败，请重试' });
      return;
    }
    if (!isWriteOk(result)) {
      wx.showToast({ icon: 'none', title: '保存失败（服务端未命中记录）' });
      return;
    }
    // 回读校验：确认 adExemptUntil 真的落库（历史上出现过「提示已保存但库没变」）
    try {
      const { result: fresh } = await apiDb.collection('user').findOne({ _id: user._id });
      const saved = fresh && fresh.userInfo ? fresh.userInfo.adExemptUntil : undefined;
      const expect = userInfo.adExemptUntil;
      const same = (expect === undefined && (saved === undefined || saved === null))
        || String(saved) === String(expect);
      if (!same) {
        wx.showToast({ icon: 'none', title: '保存未生效，请重试', duration: 2500 });
        return;
      }
    } catch (e) {
      console.warn('[managers] 免广告回读失败', e);
    }
    this.setData({
      ['users[' + index + '].recognizeUsage']: nextUsage,
      ['users[' + index + '].adSeen']: Number(usage.ads) || 0,
      ['users[' + index + '].adRemaining']: target,
      adRemainingModal: { show: false, index: -1, current: 0, value: '' },
    });
    wx.showToast({ title: '已设置为剩余 ' + target + ' 次' });
  },

  /**
   * 设置单个用户的「免看识猫广告」权限。
   * 写进 user.userInfo.adExemptUntil（jsonb，不新增列）：0 = 永久，时间戳 = 到期时间，
   * 删除该键 = 取消免广告。识猫页读它决定是否跳过识别次数门禁。
   */
  async setAdExempt(e) {
    const index = e.currentTarget.dataset.index;
    const user = this.data.users[index];
    if (!user) return;
    const current = user.userInfo && user.userInfo.adExemptUntil;
    let hint = '当前：未免广告';
    if (current === 0 || current === '0') hint = '当前：永久免广告';
    else if (Number(current) > Date.now()) hint = '当前：有效期至 ' + formatDate(Number(current)) + '（约 ' + Math.ceil((Number(current) - Date.now()) / 86400000) + ' 天）';

    // 用选择器而不是文本输入：管理员点一下就能选，避免手输格式出错
    const items = ['永久免广告', '7 天', '30 天', '自定义天数…', '取消免广告'];
    let choiceIndex = -1;
    try {
      // 不用 alertText：部分基础库传了会直接抛参数错误，导致「点了没反应」
      const sheet = await wx.showActionSheet({ itemList: items });
      choiceIndex = sheet.tapIndex;
    } catch (error) {
      const msg = String((error && (error.errMsg || error.message)) || '');
      if (!/cancel/i.test(msg)) {
        console.warn('[managers] showActionSheet 失败', error);
        wx.showToast({ icon: 'none', title: '打开菜单失败，请重试' });
      }
      return;
    }
    const userInfo = Object.assign({}, user.userInfo || {});
    if (items[choiceIndex] === '取消免广告') {
      delete userInfo.adExemptUntil;
    } else if (items[choiceIndex] === '自定义天数…') {
      const custom = await wx.showModal({
        title: '免广告天数',
        content: hint,
        editable: true,
        placeholderText: '填整数天数，0 = 永久',
        confirmText: '保存',
      });
      if (!custom.confirm) return;
      const days = parseInt(String(custom.content || '').trim(), 10);
      if (!Number.isFinite(days) || days < 0) {
        wx.showToast({ icon: 'none', title: '请输入不小于 0 的整数' });
        return;
      }
      userInfo.adExemptUntil = days === 0 ? 0 : Date.now() + days * 86400000;
    } else if (items[choiceIndex] === '永久免广告') {
      userInfo.adExemptUntil = 0;
    } else {
      const days = items[choiceIndex] === '7 天' ? 7 : 30;
      userInfo.adExemptUntil = Date.now() + days * 86400000;
    }
    let result;
    try {
      result = await api.curdOp({ operation: 'update', collection: 'user', item_id: user._id, data: { userInfo } });
    } catch (error) {
      console.error('[managers] 保存免广告失败', error);
      wx.showToast({ icon: 'none', title: '保存失败，请重试' });
      return;
    }
    if (!isWriteOk(result)) {
      wx.showToast({ icon: 'none', title: '保存失败（服务端未命中记录）' });
      return;
    }
    // 回读校验：确认 adExemptUntil 真的落库（历史上出现过「提示已保存但库没变」）
    try {
      const { result: fresh } = await apiDb.collection('user').findOne({ _id: user._id });
      const saved = fresh && fresh.userInfo ? fresh.userInfo.adExemptUntil : undefined;
      const expect = userInfo.adExemptUntil;
      const same = (expect === undefined && (saved === undefined || saved === null))
        || String(saved) === String(expect);
      if (!same) {
        wx.showToast({ icon: 'none', title: '保存未生效，请重试', duration: 2500 });
        return;
      }
    } catch (e) {
      console.warn('[managers] 免广告回读失败', e);
    }
    // 立刻更新卡片上的免广告状态，不用等重新加载列表
    const until = userInfo.adExemptUntil;
    const permanent = until === 0 || until === '0';
    const daysLeft = Number(until) > Date.now() ? Math.ceil((Number(until) - Date.now()) / 86400000) : 0;
    this.setData({
      ['users[' + index + '].userInfo']: userInfo,
      ['users[' + index + '].adExempt']: permanent || daysLeft > 0,
      ['users[' + index + '].adExemptText']: permanent ? '永久' : (daysLeft > 0 ? ('还剩 ' + daysLeft + ' 天') : '无'),
    });
    wx.showToast({ title: '已保存' });
  },

  onManagerChange(e) {
    const index = e.currentTarget.dataset.index;
    const value = parseInt(e.detail.value);
    this.setData({
      ["users[" + index + "].manager"]: value
    });
  },

  // 角色 picker 变动
  onRoleChange(e) {
    const index = e.currentTarget.dataset.index;
    const value = parseInt(e.detail.value);
    this.setData({
      ["users[" + index + "].role"]: value
    });
  },

  // 一次性更新管理员等级和角色
  async updateUserSettings(e) {
    const formData = e.detail.value;
    const index = parseInt(formData.index);
    const _id = formData._id;
    var level = parseInt(formData.level);
    var role = parseInt(formData.role);

    if (isNaN(level)) {
      level = null;
    }
    if (level == this.data.manager_types.length - 1) {
      // 最后一个是99管理员
      level = 99;
    }
    if (isNaN(role)) {
      role = null;
    }

    console.log("updateUserSettings #" + index, _id, "manager:", level, "role:", role);

    const res = await api.curdOp({
      operation: "update",
      collection: "user",
      item_id: _id,
      data: {
        manager: level,
        role: role
      }
    })

    console.log("updateUserSettings Result:", res);
    // 【成功判定】后端 curdOp 的 update 分支返回 updateOne 的原始结果：
    //   { matchedCount, modifiedCount, acknowledged }（见后端 src/handlers/curdOp.js
    //   与 src/db/pg.js 的 updateOne）。**没有 ok 字段，也没有旧 EMAS 的 n 字段**。
    //   原判定 `res.ok && res.n == 1` 恒为假 → 明明写入成功却提示「更新失败」。
    if (isWriteOk(res)) {
      wx.showToast({
        title: '更新成功',
      });
      // 同步本地数据
      if (level !== null) {
        this.setData({ ["users[" + index + "].manager"]: level });
      }
      if (role !== null) {
        this.setData({ ["users[" + index + "].role"]: role });
      }
    } else {
      wx.showToast({
        title: '更新失败',
        icon: 'none',
      })
    }
  },

  // ========== 地图权限开关（即时生效） ==========

  async toggleMapAccess(e) {
    const index = e.currentTarget.dataset.index;
    const user = this.data.users[index];
    if (!user) return;

    const currentApproved = user.mapAccess && user.mapAccess.status === 'approved';
    const nextVal = currentApproved
      ? null
      : { status: 'approved', applyReason: '管理员手动开通', applyDate: api.getDate() };

    // 乐观更新 UI
    this.setData({ ["users[" + index + "].mapAccess"]: nextVal });

    if (isDemoMode()) {
      return;
    }

    try {
      const res = await api.curdOp({
        operation: "update",
        collection: "user",
        item_id: user._id,
        data: { mapAccess: nextVal }
      });
      if (!isWriteOk(res)) {
        // 回滚
        const rollback = currentApproved
          ? { status: 'approved', applyReason: '管理员手动开通', applyDate: api.getDate() }
          : null;
        this.setData({ ["users[" + index + "].mapAccess"]: rollback });
        wx.showToast({ title: '操作失败', icon: 'none' });
      }
    } catch (err) {
      console.error('地图权限更新失败:', err);
      const rollback = currentApproved
        ? { status: 'approved', applyReason: '管理员手动开通', applyDate: api.getDate() }
        : null;
      this.setData({ ["users[" + index + "].mapAccess"]: rollback });
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  // ========== 地图权限待审申请 ==========

  async loadApplications() {
    this.setData({ appsLoading: true });
    try {
      const { result: users } = await apiDb.collection('user')
        .find({ 'mapAccess.status': 'pending' }, { sort: { 'mapAccess.applyDate': -1 } });
      const apps = await Promise.all((users || []).map(async u => {
        // 【字段名必须用 PG 实际列，否则 count 恒为 0】
        // photo 表没有 openid 列，只有 _openid（上传者）与 user_id（= user 表的 _id）；
        //   用 _openid 也不行 —— utils/db.js 的 normalizeQuery 会把客户端传的 _openid
        //   覆盖为「当前登录用户」的 openid，管理员查别人的照片就查不到了。
        //   所以按 user._id 关联 photo.user_id（实测 photo.user_id ↔ user._id 完全对应，
        //   且 photo._openid 与该 user.openid 一致）。
        // comment 表的作者列叫 user_openid（同样没有 openid 列）。
        const [photoRes, commentRes] = await Promise.all([
          apiDb.collection('photo').count({ user_id: u._id, verified: true }),
          apiDb.collection('comment').count({ user_openid: u.openid, deleted: { $ne: true }, needVerify: { $ne: true } })
        ]);
        return {
          _id: u._id,
          openid: u.openid,
          userInfo: u.userInfo,
          mapAccess: {
            ...u.mapAccess,
            applyDate: formatDate(u.mapAccess.applyDate, 'yyyy-MM-dd hh:mm:ss')
          },
          photoCount: photoRes.result,
          commentCount: commentRes.result,
        };
      }));
      this.setData({
        applications: apps,
        appCount: apps.length,
        appsLoading: false
      });
    } catch (e) {
      console.error('加载申请列表失败:', e);
      this.setData({ appsLoading: false });
    }
  },

  async approveApplication(e) {
    const index = e.currentTarget.dataset.index;
    const application = this.data.applications[index];
    if (!application) return;

    const reasonPreview = (application.mapAccess.applyReason || '').substring(0, 20);
    wx.showModal({
      title: '确认通过',
      content: '确定通过「' + reasonPreview + '...」的申请吗？',
      confirmText: '通过',
      cancelText: '取消',
      success: async (res) => {
        if (!res.confirm) return;

        try {
          await api.curdOp({
            operation: "update",
            collection: "user",
            item_id: application._id,
            data: {
              mapAccess: {
                status: 'approved',
                applyReason: application.mapAccess.applyReason,
                applyDate: application.mapAccess.applyDate,
              }
            }
          });

          const apps = [...this.data.applications];
          apps.splice(index, 1);
          this.setData({
            applications: apps,
            appCount: apps.length
          });
          wx.showToast({ title: '已通过申请', icon: 'success' });
        } catch (e) {
          console.error('审批失败:', e);
          wx.showToast({ title: '操作失败', icon: 'none' });
        }
      }
    });
  },

  async rejectApplication(e) {
    const index = e.currentTarget.dataset.index;
    const application = this.data.applications[index];
    if (!application) return;

    wx.showModal({
      title: '确认拒绝',
      content: '确定拒绝该申请吗？',
      confirmText: '拒绝',
      cancelText: '取消',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await api.curdOp({
            operation: "update",
            collection: "user",
            item_id: application._id,
            data: { mapAccess: null }
          });
          const apps = [...this.data.applications];
          apps.splice(index, 1);
          this.setData({
            applications: apps,
            appCount: apps.length
          });
          wx.showToast({ title: '已拒绝申请', icon: 'success' });
        } catch (e) {
          console.error('操作失败:', e);
          wx.showToast({ title: '操作失败', icon: 'none' });
        }
      }
    });
  },
})