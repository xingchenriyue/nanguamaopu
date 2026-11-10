const apiDb = require('../../../utils/api.js').db;
// miniprogram/pages/manage/managers.js
import { checkAuth } from "../../../utils/user";
import { formatDate } from "../../../utils/utils";
import api from "../../../utils/cloudApi";
import { signCosUrl, isWriteOk } from "../../../utils/common";
import { isDemoMode } from "../../../utils/demo";
import { initLayout } from "../../../utils/page";
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
      query["userInfo.nickName"] = { $regex: userSearch }
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

    const res = await wx.showModal({
      title: '免看识猫广告',
      content: hint,
      editable: true,
      placeholderText: '天数：0=永久，留空=取消免广告',
      confirmText: '保存',
    });
    if (!res.confirm) return;
    const raw = String(res.content || '').trim();
    const userInfo = Object.assign({}, user.userInfo || {});
    if (raw === '') {
      delete userInfo.adExemptUntil;
    } else {
      const days = parseInt(raw, 10);
      if (!Number.isFinite(days) || days < 0) {
        wx.showToast({ icon: 'none', title: '请输入不小于 0 的整数' });
        return;
      }
      userInfo.adExemptUntil = days === 0 ? 0 : Date.now() + days * 86400000;
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
    this.setData({ ['users[' + index + '].userInfo']: userInfo });
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