/**
 * utils/user.js —— 用户资料读取、权限（上传/评论/赞赏/反馈）判定
 * ============================================================================
 * 【职责】用户资料读取、权限（上传/评论/赞赏/反馈）判定。
 * 【依赖】./api.js（db）、./common.js（signCosUrl）、./cache.js、./cloudApi.js
 * 【注意事项】头像为私有桶/外部 URL，展示前经 signCosUrl；权限判定依赖 user 集合角色字段。
 * ============================================================================
 */
const apiDb = require('./api.js').db;
// 负责用户表的管理、使用接口
import { randomInt } from './utils';
import { getGlobalSettings } from "./page";
import { getCacheItem, setCacheItem } from "./cache";
import { signCosUrl } from "./common";
import config from "../config";
import api from "./cloudApi";

const app = getApp();

const UserTypes = {
  manager: "manager",
  invited: "invited",
  loggedin: "loggedin",
  guest: "guest"
}

const FuncTypes = {
  uploadPhoto: "uploadPhoto",
  comment: "comment",
  reward: "reward",
  feedback: "feedback",
  fullTab: "fullTab",
}

/**
 * 给用户对象里的头像 URL 重新签名（返回新对象，不改原对象）。
 *
 * 【为什么每次读出都要重新签】
 * 后端签名 URL 有效期只有 15 分钟（OSS_SIGN_EXPIRES=900s，后端 src/oss.js DEFAULTS），
 * 而用户缓存时长是 25-35 分钟（setCacheItem(key, ..., 0, randomInt(25, 35))）。
 * 若把「已签名」的头像 URL 存进缓存，10-20 分钟后缓存里的签名就过期了，
 * <image> 会拿到 403 AccessDenied —— 表现为「头像一开始能显示，过一会儿变裂图」。
 * 所以每次从缓存读出后都要重新签一次。
 *
 * 重新签名的前提是 signCosUrl 对「已签名 URL」幂等：
 * utils/oss.js 的 extractKey 只取 URL 的 pathname（丢弃 query），
 * 所以拿旧签名 URL 也能解析出同一个 OSS key，签出新的有效签名。
 *
 * @param {object} userRes 用户记录
 * @returns {Promise<object>} 头像已重新签名的副本
 */
async function signUserAvatar(userRes) {
  if (!userRes || !userRes.userInfo || !userRes.userInfo.avatarUrl) {
    return userRes;
  }
  try {
    const signed = await signCosUrl(userRes.userInfo.avatarUrl);
    return {
      ...userRes,
      userInfo: { ...userRes.userInfo, avatarUrl: signed },
    };
  } catch (error) {
    // 签名失败不抛错：保留原值，页面会走默认头像兜底
    console.error('[user] 头像签名失败:', error);
    return userRes;
  }
}

// 获取当前用户
// 如果数据库中没有会后台自动新建并返回
async function getUser(options) {
  options = options || {};
  const key = "current-user";
  let userRes = await getCacheItem(key, options);
  if (userRes) {
    console.log(`cached ${key}`);
    // 缓存里存的是「上次签名过」的头像 URL，其签名可能已过期（见 signUserAvatar 注释），
    // 必须重新签名后再交给页面，否则头像会 403。
    return await signUserAvatar(userRes);
  }

  // 直接调用云函数，不再通过 api 对象
  const openid = await api.getCurrentUserOpenid();
  console.log(openid);
  userRes = await api.userOp({
    op: 'get',
    openid: openid,
    unionAction: 'userOp'
  });

  // 【缓存里必须存裸 URL，不能存签名 URL】
  // 签名有效期 15 分钟 < 缓存时长 25-35 分钟，存签名 URL 会让缓存命中时
  // 直接拿到过期签名（头像 403）。所以这里先存原始记录，
  // 再返回重新签名过的副本（见 signUserAvatar）。
  setCacheItem(key, userRes, 0, randomInt(25, 35))
  return await signUserAvatar(userRes);
}

// 使用openid来读取用户信息
async function getUserInfo(openid, options) {
  const key = `uinfo-${openid}`;
  var value = getCacheItem(key, options);
  if (value != undefined) {
    return await signUserAvatar(value);
  }

  // 重新获取
  const { result } = await apiDb.collection('user').findOne({ openid: openid });
  if (!result) {
    console.log("user " + openid + " not existed.");
    return null;
  }

  // 写入缓存（25-35min过期）
  setCacheItem(key, result, 0, randomInt(25, 35));

  // 【必须签名后返回】user 表里的 avatarUrl 是裸 OSS URL，桶 ACL=private，
  // 直接塞进 <image src> 会 403。消费方如 pages/manage/replyFeedback/replyFeedback.js
  // 会把这里的 userInfo 原样交给 <image>，所以签名必须在这一层做。
  return await signUserAvatar(result);
}


// 使用openid来读取用户信息
async function getUserInfoMulti(openids, cacheOptions, retMap) {
  if (!openids) {
    return undefined;
  }
  var res = {};
  var not_found = [];
  for (var openid of openids) {
    if (res[openid]) {
      continue;
    }
    const cacheKey = `uinfo-${openid}`;
    var cacheItem = getCacheItem(cacheKey, cacheOptions);
    if (cacheItem) {
      res[openid] = cacheItem;
      continue;
    }
    not_found.push(openid);
  }

  // 请求没有的
  if (not_found.length) {
    var { result: db_res } = await apiDb.collection('user').find({ openid: { $in: not_found } });
    for (var user of db_res) {
      const cacheKey = `uinfo-${user.openid}`;
      setCacheItem(cacheKey, user, 0, randomInt(25, 35));
      res[user.openid] = user;
    }
  }

  if (retMap) {
    return res;
  }
  return openids.map(x => res[x]);
}

/**
 * 判定用户所属人群（严格互斥，优先级：管理员 > 特邀 > 登录用户 > 游客）。
 *
 * 【为什么要有「登录用户」这一档】
 * 上游只分「游客 / 特邀 / 管理员」，于是「刚进小程序、微信授权过但没填资料的人」
 * 和「认真填了昵称头像的老用户」被算成同一类，管不住前者。这里把「已经完善资料」
 * 单独拎出来：有用户名（userInfo.nickName）且有头像（userInfo.avatarUrl）才算登录用户。
 * 只登录过、没填资料的仍是游客 —— 避免「点一下微信授权就拿到特权」。
 *
 * @param {object} user 用户记录（getUser 的返回值）
 * @param {boolean} isManager 是否管理员（由 isManagerAsync 判定）
 * @returns {string} UserTypes 之一
 */
function classifyUser(user, isManager) {
  if (isManager) return UserTypes.manager;
  if (user && user.role == 1) return UserTypes.invited; // 特邀：role == 1
  const info = (user && user.userInfo) || {};
  if (info.nickName && info.avatarUrl) return UserTypes.loggedin;
  return UserTypes.guest;
}

async function getUserType() {
  const user = await getUser();
  const isManager = await isManagerAsync();
  return classifyUser(user, isManager);
}

async function _checkFuncEnable(funcName) {
  // 对特定人群、特地版本进行控制
  let accessCtrl = await getGlobalSettings("accessCtrl");
  if (!accessCtrl) return true; // Demo/离线模式：默认开启所有功能
  let { ctrlUser, ctrlVersion, disabledFunc, limitedFunc } = accessCtrl;

  // 完全禁用，不需要判断人群/版本
  if (disabledFunc.split(",").includes(funcName)) {
    return false;
  }

  const { app_version } = config;
  if (ctrlVersion != "*" && ctrlVersion != app_version) {
    // 版本不匹配，限制不生效
    return true;
  }
  // 人群判定收敛到 classifyUser：管理员 > 特邀 > 登录用户 > 游客，严格互斥。
  // 旧实现把「非管理员非特邀」一律算游客，导致页面配置里没法区分
  // 「没填资料的游客」和「已完善资料的登录用户」。
  const user = await getUser();
  const isManager = await isManagerAsync();
  const userType = classifyUser(user, isManager);
  ctrlUser = ctrlUser.split(",");
  if (ctrlUser.includes(userType)) {
    // 满足人群限制，返回功能是否受限
    return !limitedFunc.split(',').includes(funcName);
  }
  return true;
}

// 能否上传照片
async function checkCanUpload() {
  return await _checkFuncEnable(FuncTypes.uploadPhoto);
}

// 能否评论
async function checkCanComment() {
  return await _checkFuncEnable(FuncTypes.comment);
}

// 能否打赏投喂
async function checkCanReward() {
  return await _checkFuncEnable(FuncTypes.reward);
}

// 能否反馈
async function checkCanFeedback() {
  return await _checkFuncEnable(FuncTypes.feedback);
}

// 是否展示完整底Tab
async function checkCanFullTabBar() {
  return await _checkFuncEnable(FuncTypes.fullTab);
}

// 是否展示弹出公告
async function checkCanShowNews() {
  const tabBarOrder = wx.getStorageSync("tabBarOrder");
  if (!tabBarOrder) {
    return false;
  }
  return tabBarOrder.includes("news");
}

// 能否使用喵地图（按用户权限，默认关闭）
async function checkCanUseMap() {
  const app = getApp();
  if (app.globalData && app.globalData.demoMode) return true;
  const user = await getUser({ nocache: true });
  return !!(user.mapAccess && user.mapAccess.status === 'approved');
}

// 设置页面上的userInfo
async function getPageUserInfo(page) {
  // 检查用户信息有没有拿到，如果有就更新this.data
  const userRes = await getUser();
  if (!userRes.userInfo || !userRes.userInfo == {}) {
    console.log('无用户信息');
    return false;
  }
  page.setData({
    isAuth: true,
    user: userRes,
  });
  return true;
}

async function isManagerAsync(req) {
  const user = await getUser();
  if (!req) {
    req = 1;
  }
  return user.manager && user.manager >= req;
}

// TODO，应该做成一个模块
async function checkAuth(page, level) {
  if (await isManagerAsync(level)) {
    page.setData({
      auth: true
    });
    return true;
  }
  page.setData({
    tipText: `只有管理员Level-${level}能进入嗷`,
    tipBtn: true,
  });
  return false;
}

// 去设置用户信息页，上传照片时点更新个人信息改为了跳出组件
// 不过貌似有些地方不能用组件，不太确定跳出组件或者跳转到页面哪种比较好
function toSetUserInfo() {
  const url = "/pages/info/userInfo/userInfo";
  wx.navigateTo({
    url: url,
  })
}

// 设置用户等级
async function setUserRole(openid, role) {
  // 直接调用云函数，不再通过 api 对象
  const currentOpenid = await api.getCurrentUserOpenid();
  return await api.userOp({
    "op": "updateRole",
    "user": {
      openid: openid,
      role: role
    },
    openid: currentOpenid,
    unionAction: "userOp"
  })
}

// 填充userInfo
// items: array类型，期待加上userInfo的内容
// openidKey：openid的字段名
// userInfoKey：userInfo的字段名
async function fillUserInfo(items, openidKey, userInfoKey, cacheOptions) {
  var openids = [];
  for (var item of items) {
    if (item[userInfoKey] != undefined) {
      continue;
    }
    const openid = item[openidKey];
    openids.push(openid);
  }
  var res = await getUserInfoMulti(openids, cacheOptions, true);
  for (var item of items) {
    if (item[userInfoKey] != undefined) {
      continue;
    }
    const openid = item[openidKey];
    item[userInfoKey] = res[openid]?.userInfo;
    console.log(item[userInfoKey]);
    if (item[userInfoKey]?.avatarUrl) {
      item[userInfoKey].avatarUrl = await signCosUrl(item[userInfoKey].avatarUrl);
    }
  }
  return;
}

module.exports = {
  UserTypes,
  FuncTypes,
  classifyUser,
  getUserType,
  getUser,
  getUserInfo,
  getUserInfoMulti,
  getPageUserInfo,
  checkCanUpload,
  checkCanComment,
  checkCanReward,
  checkCanFeedback,
  checkCanFullTabBar,
  checkCanShowNews,
  checkCanUseMap,
  isManagerAsync,
  checkAuth,
  toSetUserInfo,
  setUserRole,
  fillUserInfo,
}
