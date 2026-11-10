/**
 * utils/dbHelper.js —— 照片查询辅助函数
 * ============================================================================
 * 【职责】提供两个常用照片聚合查询（全部照片 / 按猫过滤），供管理端复用。
 * 【依赖】./api.js 的 db 收敛层（POST /api/db/photo/find）
 * 【注意事项】查询的 fields / sort 原样保留；异常时返回空数组但不吞掉错误日志。
 *
 * ---------------------------------------------------------------------------
 * 【为什么这里必须做 OSS 签名】—— 私有桶的硬约束
 *   桶 ACL = private，实测（2026-11-09，容器内走公网 CNAME oss.xcry.top）：
 *     未签名 GET https://oss.xcry.top/<key>  → 403 AccessDenied
 *     服务端签名 GET                         → 200 + 正确图片
 *   所以 DB 里存的裸 URL **不能**直接塞进 <image src>，必须先换签名 URL。
 *   本函数是管理端所有照片页面的唯一取数入口，在这里统一签名，
 *   避免每个页面各写一遍、漏一处就整页图片 403。
 * ============================================================================
 */
import { db } from './api';
import { signCosUrl } from './common';

const PHOTO_FIELDS = [
  '_id', 'cat_id', 'user_id', 'best', 'create_date',
  'photo_compressed', 'photo_watermark', 'verified', 'shooting_date',
];

// 需要签名的图片 URL 字段
const SIGN_FIELDS = ['photo_compressed', 'photo_watermark'];

/**
 * 给照片数组里的图片 URL 字段换成签名 URL。
 * 单条签名失败不影响其它字段（置空该字段，页面会走 fallback 分支）。
 * @param {Array} photos
 * @returns {Promise<Array>} 原地处理后的照片数组
 */
async function signPhotoUrls(photos) {
  if (!Array.isArray(photos) || photos.length === 0) return photos;
  await Promise.all(photos.map(async (p) => {
    if (!p) return;
    for (const f of SIGN_FIELDS) {
      const url = p[f];
      if (!url || typeof url !== 'string') continue;
      try {
        p[f] = await signCosUrl(url);
      } catch (e) {
        console.error(`[dbHelper] 签名 ${f} 失败:`, e);
        p[f] = '';
      }
    }
  }));
  return photos;
}

/**
 * 获取所有照片（按收录时间倒序）。
 * @returns {Promise<Array>} 照片数组（图片 URL 已签名），失败返回空数组
 */
async function getAllPhotos() {
  try {
    const { result } = await db.collection('photo').find({}, {
      fields: PHOTO_FIELDS,
      sort: { create_date: -1 },
    });
    return await signPhotoUrls(result || []);
  } catch (error) {
    console.error('[dbHelper] 获取所有照片失败：', error);
    return [];
  }
}

/**
 * 获取指定猫猫的所有照片（按收录时间倒序）。
 * @param {string} catId 猫 _id
 * @returns {Promise<Array>} 照片数组（图片 URL 已签名），失败返回空数组
 */
async function getPhotosByCatId(catId) {
  try {
    const { result } = await db.collection('photo').find({ cat_id: catId }, {
      fields: PHOTO_FIELDS,
      sort: { create_date: -1 },
    });
    return await signPhotoUrls(result || []);
  } catch (error) {
    console.error(`[dbHelper] 获取猫猫${catId}的照片失败：`, error);
    return [];
  }
}

module.exports = {
  getAllPhotos,
  getPhotosByCatId,
  signPhotoUrls,
};
