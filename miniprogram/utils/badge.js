/**
 * utils/badge.js —— 徽章定义、用户徽章、猫猫徽章的加载与排序
 * ============================================================================
 * 【职责】徽章定义、用户徽章、猫猫徽章的加载与排序。
 * 【依赖】./api.js（db）、./common.js（signCosUrl）、./cache.js
 * 【注意事项】徽章图片是私有桶资源，展示前必须经 signCosUrl 换签名 URL。
 * ============================================================================
 */
const apiDb = require('./api.js').db;
import { signCosUrl } from './common'
const app = getApp();
// 等级序
const levelOrderMap = {
  'S': 0,
  'A': 1,
  'B': 2,
  'C': 3,
}

async function loadBadgeDefMap() {
  let { result: badgeDefMap } = await apiDb.collection('badge_def').find({})
  if (!badgeDefMap) {
    return;
  }

  // 超过100种徽章定义，需要分批获取
  if (badgeDefMap.length === 100) {
    let count = (await apiDb.collection('badge_def').count({})).result;
    while (badgeDefMap.length < count) {
      let tmp = (await apiDb.collection('badge_def').find({}, { skip: badgeDefMap.length })).result;
      badgeDefMap = badgeDefMap.concat(tmp);
    }
  }

  // 对每个徽章定义的 img 字段进行签名处理
  for (let badgeDef of badgeDefMap) {
    if (badgeDef.img) {
      badgeDef.img = await signCosUrl(badgeDef.img);
    }
  }

  return badgeDefMap.reduce((badgeDefMap, badgeDef) => {
    badgeDefMap[badgeDef._id] = badgeDef;
    return badgeDefMap
  }, {});
}

async function loadUserBadge(openid, badgeDefMap, options) {
  const userBadges = (await apiDb.collection("badge").find({
    _openid: openid,
    catId: null
  })).result;
  // 过滤掉已被赠送出去的勋章
  const filteredBadges = userBadges.filter(badge => !badge.givenTime);
  const res = await mergeAndSortBadges(filteredBadges, badgeDefMap, options);
  return res;
}

async function loadCatBadge(catId) {
  const count = (await apiDb.collection('badge').count({ catId: catId })).result;
  let allBadges = [];
  while (allBadges.length < count) {
    const tmp = (await apiDb.collection('badge').find({
      catId: catId,
    }, { skip: allBadges.length })).result;
    allBadges = allBadges.concat(tmp);
  }
  return allBadges;
}

// 按照等级排序，并统计Badge的个数
async function mergeAndSortBadges(badges, badgeDefMap, options) {
  if (!badges || !badgeDefMap) {
    return;
  }
  // 顺便统计0个的情况
  let userBadgesMap = {};
  for (const id in badgeDefMap) {
    const badgeDef = badgeDefMap[id];
    userBadgesMap[id] = {
      _id: badgeDef._id,
      img: badgeDef.img,
      name: badgeDef.name,
      desc: badgeDef.desc,
      level: badgeDef.level,
      count: 0,
    }
  }

  // 合并已有
  for (const badge of badges) {
    userBadgesMap[badge.badgeDef].count++;
  }

  let mergedBadges = Object.values(userBadgesMap);
  mergedBadges.sort((a, b) => levelOrderMap[a.level] - levelOrderMap[b.level]);

  if (options && options.keepZero) {
    return mergedBadges;
  }

  const res = mergedBadges.filter((value) => value.count);
  return res;
}

// 按等级排序徽章定义
async function sortBadgeDef(badgeDefs) {
  badgeDefs.sort((a, b) => levelOrderMap[a.level] - levelOrderMap[b.level]);
  return badgeDefs;
}

export {
  levelOrderMap,
  loadBadgeDefMap,
  loadUserBadge,
  loadCatBadge,
  mergeAndSortBadges,
  sortBadgeDef,
}