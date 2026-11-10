/**
 * utils/layout.js —— 自定义导航栏 / 悬浮 dock 的尺寸计算
 * ============================================================================
 * 【职责】统一算出「顶部毛玻璃导航栏」与「底部悬浮 dock」占用的尺寸，
 *         供 6 个 tab 页复用，避免每个页面各写一份、且与实际渲染值漂移。
 * 【背景】TabBar 从「贴底通栏」改为「悬浮 dock」、顶部导航从系统原生改为
 *         自定义毛玻璃后，页面可用高度需要重新计算。
 * 【关键结论】
 *  1. 本项目 6 个 tab 页使用 navigationStyle: custom，页面视口 = 整个屏幕，
 *     状态栏区域也在视口内（内容会滚到状态栏下方，由毛玻璃顶栏遮罩）。
 *  2. 顶部毛玻璃栏的总高度 = 状态栏高度 + 导航行高度（44px，与原生导航栏一致），
 *     这样正文可用高度和改造前保持相同，不会被顶部区域挤压。
 *  3. 所有高度统一用 px（运行时量），页面里直接 style="height: {{x}}px" 使用。
 * ============================================================================
 */

// 导航行高度（px）：与原生导航栏的内容区高度一致，保证正文高度不变
const NAV_ROW_HEIGHT_PX = 44;

// 底部悬浮 dock 本体高度（图标 + 文字），单位 rpx，与 custom-tab-bar 的 .tab-bar-panel 保持一致
const DOCK_HEIGHT_RPX = 112;
// dock 与屏幕底部的悬空距离，单位 rpx，与 .tab-bar 的 padding-bottom 保持一致
const DOCK_BOTTOM_MARGIN_RPX = 40;

/**
 * 取窗口信息（优先新接口 getWindowInfo，旧库回退 getSystemInfoSync）
 */
function getWindowInfo() {
  try {
    if (typeof wx.getWindowInfo === 'function') {
      return wx.getWindowInfo();
    }
  } catch (e) {
    // 忽略，走回退
  }
  return wx.getSystemInfoSync();
}

/**
 * 取右上角胶囊按钮的矩形；取不到时返回 null
 */
function getCapsuleRect() {
  try {
    if (typeof wx.getMenuButtonBoundingClientRect !== 'function') {
      return null;
    }
    const rect = wx.getMenuButtonBoundingClientRect();
    if (!rect || !rect.bottom || !rect.left) {
      return null;
    }
    return rect;
  } catch (e) {
    return null;
  }
}

/**
 * 计算顶部毛玻璃导航栏所需的全部尺寸
 *
 * 结构上分两层：
 *   navBandHeight —— 毛玻璃「顶栏」的总高度（状态栏 + 导航行），从屏幕顶 0 盖下来；
 *   navRowTop     —— 导航行（LOGO + 标题 + 副标题）在顶栏内的位置，
 *                    垂直方向与胶囊按钮居中对齐，避免「被胶囊挤到下方」。
 *
 * @return {Object} 顶部导航相关尺寸
 */
function getNavMetrics() {
  const info = getWindowInfo();
  const rpx2px = (info.windowWidth || 375) / 750;
  const capsule = getCapsuleRect();
  // 某些机型 / 开发者工具拿不到 statusBarHeight，会退化成 0，
  // 顶栏就矮一截，页面占位不足 → 内容被毛玻璃栏挡住（个人主页、徽章页曾出现）。
  // 用胶囊按钮顶部兜底，再退到 20px。
  const statusBarHeight = info.statusBarHeight || (capsule && capsule.top) || 20;
  const rowHeight = NAV_ROW_HEIGHT_PX;

  // 顶栏总高度：状态栏 + 导航行，与原生导航栏占位一致，正文高度不变
  const bandHeight = statusBarHeight + rowHeight;

  // 导航行顶边：默认紧贴状态栏底部；若有胶囊按钮则向胶囊中心对齐，
  // 但不允许把顶栏撑高（高度必须等于状态栏 + 导航行，正文高度才不变）。
  let rowTop = statusBarHeight;
  if (capsule) {
    const capsuleCenter = capsule.top + capsule.height / 2;
    const alignedTop = capsuleCenter - rowHeight / 2;
    // 只在「对齐后仍不超出顶栏」时采纳，否则保持紧贴状态栏
    if (alignedTop >= statusBarHeight && alignedTop + rowHeight <= bandHeight) {
      rowTop = alignedTop;
    }
  }

  // 右侧避让胶囊按钮：内容右边界停在胶囊左侧
  let rightInset = 24;
  if (capsule) {
    rightInset = Math.max(rightInset, Math.round((info.windowWidth || 375) - capsule.left + 12));
  }

  return {
    statusBarHeight: statusBarHeight,
    rpx2px: rpx2px,
    // 导航行在屏幕上的绝对位置
    navRowTop: rowTop,
    navRowHeight: rowHeight,
    // 毛玻璃顶栏总高度（从屏幕顶盖到导航行底部）
    navBandHeight: bandHeight,
    // 顶栏底边位置：页面内其他悬浮元素据此下移，避免与顶栏重叠
    navBottom: bandHeight,
    // 页面内容需要让出的顶部总高度（与改造前原生导航栏占位相同）
    navTotalHeight: bandHeight,
    // 右侧需要避让胶囊按钮的宽度（px）
    rightInset: rightInset,
  };
}

/**
 * 计算底部悬浮 dock 需要的预留高度（占位用）
 * @param {Number} realHeight custom-tab-bar 实测写入 storage 的真实高度；没有则用默认值
 * @return {Number} 页面底部应预留的 px 高度
 */
function getDockReserveHeight(realHeight) {
  if (realHeight && realHeight > 0) {
    return realHeight;
  }
  const info = getWindowInfo();
  const rpx2px = (info.windowWidth || 375) / 750;
  return DOCK_HEIGHT_RPX * rpx2px + DOCK_BOTTOM_MARGIN_RPX * rpx2px + getSafeBottom();
}

/**
 * 底部安全区高度（px）：全面屏手势条预留，无 safeArea 的机型按 0 处理
 */
function getSafeBottom() {
  const info = getWindowInfo();
  if (!info.safeArea) {
    return 0;
  }
  return Math.max(0, (info.screenHeight || 0) - info.safeArea.bottom);
}

/**
 * dock 与屏幕底部之间的实际间距（px）：安全区 + 悬空间距
 */
function getDockBottomOffset() {
  const info = getWindowInfo();
  const rpx2px = (info.windowWidth || 375) / 750;
  return getSafeBottom() + DOCK_BOTTOM_MARGIN_RPX * rpx2px;
}

/**
 * 页面通用尺寸包：一次性拿到顶部预留、内容区高度、底部预留
 * @param {Number} dockHeight custom-tab-bar 实测高度（可选）
 * @return {Object} 页面布局所需的全部 px 尺寸
 */
function getPageMetrics(dockHeight) {
  const nav = getNavMetrics();
  const info = getWindowInfo();
  const screenHeight = info.screenHeight || 0;
  return {
    statusBarHeight: nav.statusBarHeight,
    navRowTop: nav.navRowTop,
    navRowHeight: nav.navRowHeight,
    navBandHeight: nav.navBandHeight,
    navBottom: nav.navBottom,
    // 顶部需要让出的总高度（= 原生导航栏占位，正文高度不变）
    navTotalHeight: nav.navTotalHeight,
    // 右侧避让胶囊按钮的宽度
    rightInset: nav.rightInset,
    // 导航条下方可用内容高度
    contentHeight: screenHeight - nav.navTotalHeight,
    // 底部悬浮 dock 遮挡区高度（页面需加占位）
    dockReserveHeight: getDockReserveHeight(dockHeight),
    screenHeight: screenHeight,
  };
}

module.exports = {
  getNavMetrics,
  getDockReserveHeight,
  getDockBottomOffset,
  getSafeBottom,
  getPageMetrics,
  getWindowInfo,
  getCapsuleRect,
};