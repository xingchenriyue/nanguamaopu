/**
 * utils/db.js —— 数据库收敛层（EMAS SDK 同语义）
 * ============================================================================
 * 【职责】把原 EMAS SDK 的 db.collection(x).<op>(...) 收敛到自建后端网关：
 *        POST /api/db/:collection/:op  body { args: [query, options] } -> { result }
 *        所有方法统一返回 { result }，与 EMAS SDK 一致，
 *        因此 139 处调用点只需替换前缀、查询条件/字段/排序/分页全部原样保留。
 * 【依赖】./request.js（post）、../config.js（OFFLINE_DEMO_MODE）、./demo.js（离线数据）
 * 【注意事项】
 *  1. args 按原 SDK 的实参顺序原样透传，绝不在客户端改写查询语义。
 *  2. 网关错误由 request.js 抛出带文案的 Error，绝不静默；未迁移动作会 501 提示。
 *  3. offline Demo 模式下委托给内置假数据，保证离线预览行为不回归。
 * ============================================================================
 */
import { post, getOpenidSync } from './request';
import config from '../config';
import { createMockMpServerless } from './demo';

const DEMO = !!config.OFFLINE_DEMO_MODE;
let _demoDb = null;

/** 懒加载离线 Demo 的 db（避免模块初始化时调用 getApp） */
function demoDb() {
  if (!_demoDb) _demoDb = createMockMpServerless().db;
  return _demoDb;
}

/**
 * 规范化查询条件：把客户端显式传入的 `_openid` 覆盖为当前登录用户的 openid。
 *
 * 背景：后端出于越权防护会处理客户端传入的 `_openid`。但前端有若干「查自己」的
 * 业务条件（photo/rating/achievement 等非归属集合）依赖 `_openid`，直接删除会让
 * 查询退化成全表（例如「我上传的照片数」变成全站照片数）。因此这里**覆盖而非删除**：
 * 既保证客户端无法伪造他人 openid，又保持「查本人」的语义不变。
 * 后端若同样做「覆盖为 JWT openid」则两边完全一致；详见与 backend-dev 的契约同步。
 *
 * @param {Array} args 原 SDK 实参 [query, options] 或 [filter, update]
 * @returns {Array} 规范化后的新数组（不修改原数组）
 */
function normalizeQuery(args) {
  if (!Array.isArray(args) || !args.length) return args;
  const q = args[0];
  if (!q || typeof q !== 'object' || Array.isArray(q)) return args;
  if (!Object.prototype.hasOwnProperty.call(q, '_openid')) return args;
  const openid = getOpenidSync();
  if (!openid) return args; // 尚未登录时保留原值，由后端注入/覆盖
  const copy = args.slice();
  copy[0] = { ...q, _openid: openid };
  return copy;
}

/** 网关返回体缺 result 时明确报错，避免上层拿到 undefined 后静默失败 */
function assertResult(data, collectionName, op) {
  if (!data || typeof data !== 'object' || !('result' in data)) {
    const err = new Error(
      '数据库网关返回异常（' + collectionName + '/' + op + '）：缺少 result 字段，请检查后端 /api/db 版本'
    );
    err.code = 'DB_BAD_RESPONSE';
    err.detail = data;
    console.error('[db]', err.message, data);
    throw err;
  }
  return { result: data.result };
}

/** 与后端 db.js 约定支持的操作；aggregate 单独走 /aggregate */
const OPS = ['find', 'count', 'findOne', 'insertOne', 'updateOne', 'deleteOne'];

// 后端 buildOptions 把单次 find 的 limit 钳在 100。前端有两处真实大 limit：
//   utils/comment.js  { projection:{photo_id:1}, limit:1000 }（便利贴计数）
//   myFootprint.js    { limit:500 }（我的足迹去重统计）
// 若原样透传会被静默截断，导致计数偏小/漏猫。这里在收敛层把大 limit
// 透明拆成多次 <=100 的请求并按序拼回，对业务调用点完全无感、查询语义不变。
// 两处调用点均未带 sort，故分页请求统一补 _id 稳定排序键，规避跨请求
// 并发写入导致的重复/漏数据；业务层拿到的仍是完整结果集，顺序不影响其消费
// （comment.js 只做 .filter().length 计数；myFootprint.js 做 cat_id 去重 + 计数）。
const DB_PAGE_LIMIT = 100;
const DB_PAGE_MAX_BLOCKS = 20; // 安全上限：最多 2000 条，防止异常 limit 打爆后端

/**
 * 大 limit 的 find 分块拉取（仅在 limit > 100 时启用）。
 * @param {string} path 网关路径
 * @param {Array} safeArgs 已规范化的 [query, options]
 * @param {string} name 集合名
 * @returns {Promise<{result:Array}>}
 */
async function findPaged(path, safeArgs, name) {
  const [query, options = {}] = safeArgs;
  const limit = Number.isFinite(options.limit) ? options.limit : 0;
  if (!(limit > DB_PAGE_LIMIT)) {
    return assertResult(await post(path, { args: safeArgs }), name, 'find');
  }
  const baseSkip = Number.isFinite(options.skip) ? Math.max(options.skip, 0) : 0;
  const total = Math.min(limit, DB_PAGE_LIMIT * DB_PAGE_MAX_BLOCKS);

  // 跨请求用 skip 分页必须保证顺序稳定：若调用点未带 sort、或 sort 字段有重复值，
  // 多次请求之间可能因并发写入出现重复 / 漏数据。这里以唯一的 _id 作为最终
  // tiebreaker（仅作用于发往后端的分页请求，业务层传入的 options 对象不被修改）。
  // 调用点自带 _id 排序时保留其方向，否则追加 _id:1。
  const baseSort = options.sort || {};
  const stableSort = Object.prototype.hasOwnProperty.call(baseSort, '_id')
    ? baseSort
    : { ...baseSort, _id: 1 };

  const all = [];
  let skip = baseSkip;
  while (all.length < total) {
    const batch = Math.min(DB_PAGE_LIMIT, total - all.length);
    // projection / fields / 原 sort 键全部保留；只覆盖 limit、叠加 skip、补稳定排序键
    const pageOptions = { ...options, sort: stableSort, limit: batch, skip };
    const { result } = assertResult(await post(path, { args: [query, pageOptions] }), name, 'find');
    const rows = Array.isArray(result) ? result : [];
    all.push(...rows);
    if (rows.length < batch) break; // 已到数据末尾
    skip += rows.length;
  }
  return { result: all };
}

/**
 * 集合对象工厂。
 * @param {string} name 集合名（后端有白名单校验）
 * @returns {object} 提供 find/count/findOne/insertOne/updateOne/deleteOne/aggregate 的对象
 */
function collection(name) {
  const col = {};

  OPS.forEach((op) => {
    /**
     * @param {...any} args 与 EMAS SDK 完全一致的实参，例如
     *   find(query, options) / updateOne(filter, update) / insertOne(doc)
     * @returns {Promise<{result:any}>}
     */
    col[op] = async function (...args) {
      if (DEMO) {
        const mock = demoDb().collection(name);
        if (typeof mock[op] === 'function') return mock[op](...args);
        return { result: null };
      }
      const path = '/api/db/' + encodeURIComponent(name) + '/' + op;
      // insertOne 的首参是文档，其 _openid 应由后端统一注入，不做覆盖；
      // 其余操作的首参是查询/过滤条件，做越权规范化。
      const safeArgs = op === 'insertOne' ? args : normalizeQuery(args);
      if (op === 'find') return findPaged(path, safeArgs, name);
      const data = await post(path, { args: safeArgs });
      return assertResult(data, name, op);
    };
  });

  /**
   * 聚合管道（后端 POST /api/db/:collection/aggregate body { args: [pipeline] }）。
   * 用于按月份分组排序、按 _openid 分组统计等 3 处场景。
   * @param {Array<object>} pipeline Mongo 聚合管道
   * @returns {Promise<{result:Array}>}
   */
  col.aggregate = async function (pipeline) {
    if (DEMO) {
      const mock = demoDb().collection(name);
      if (typeof mock.aggregate === 'function') return mock.aggregate(pipeline);
      return { result: [] };
    }
    const path = '/api/db/' + encodeURIComponent(name) + '/aggregate';
    // 与其它 op 保持一致：后端从 body.args[0] 取管道（不是 body.pipeline）
    const data = await post(path, { args: [pipeline] });
    return assertResult(data, name, 'aggregate');
  };

  return col;
}

/**
 * 与 EMAS db.command 兼容的查询操作符构造器（返回普通 Mongo 操作符对象）。
 * 前端活跃代码直接写 { $in: [...] }，这里供历史/扩展代码使用。
 */
const command = {
  eq: (v) => ({ $eq: v }),
  neq: (v) => ({ $ne: v }),
  gt: (v) => ({ $gt: v }),
  gte: (v) => ({ $gte: v }),
  lt: (v) => ({ $lt: v }),
  lte: (v) => ({ $lte: v }),
  in: (v) => ({ $in: v }),
  nin: (v) => ({ $nin: v }),
  exists: (v) => ({ $exists: v !== false }),
};

module.exports = {
  collection,
  command,
  isDemoMode: () => DEMO,
};
