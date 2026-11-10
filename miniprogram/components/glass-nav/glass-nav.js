/**
 * components/glass-nav —— 顶部毛玻璃导航栏
 * ============================================================================
 * 【职责】在页面顶部渲染一条毛玻璃导航栏：
 *         最左侧是 APP LOGO，紧随其后是大标题 + 副标题（见参考图）；
 *         导航行与微信右上角胶囊按钮「同一水平线」居中对齐，不会被挤到下方。
 * 【结构】
 *   1. glass-nav-holder：普通文档流占位块（高度 = 顶栏带高度 + 底部留白），
 *      作用是把页面内容整体往下推，避免被 fixed 定位的导航栏盖住。
 *      属性 holder=false 时不渲染占位块 —— 用于「内容需要从导航栏下方滚过」
 *      的页面（滚动内容穿过毛玻璃，产生真正的背景模糊）。
 *   2. glass-nav-layer：fixed 定位的浮层，承载毛玻璃带与导航行。
 * 【注意事项】
 *  1. 页面需在 .json 中设置 "navigationStyle": "custom"，否则原生导航栏会同时出现。
 *  2. 导航行右侧会避开微信右上角胶囊按钮（getMenuButtonBoundingClientRect）。
 *  3. 毛玻璃依赖 backdrop-filter；低版本/部分安卓机型不支持时，
 *      半透明渐变底仍能保证可读性（降级不塌版）。
 * ============================================================================
 */
import { getNavMetrics } from "../../utils/layout";

Component({
  properties: {
    // 主标题（如「喵友圈」）
    title: {
      type: String,
      value: "",
    },
    // 副标题（如「关注猫猫的新动态」）
    subtitle: {
      type: String,
      value: "",
    },
    // 是否显示 LOGO
    showLogo: {
      type: Boolean,
      value: true,
    },
    // LOGO 图片路径
    logo: {
      type: String,
      value: "/pages/public/images/system/logo_nav.png",
    },
    // 是否显示主标题
    showTitle: {
      type: Boolean,
      value: true,
    },
    // 是否显示副标题
    showSubtitle: {
      type: Boolean,
      value: true,
    },
    // 是否渲染占位块（把页面内容往下推）
    holder: {
      type: Boolean,
      value: true,
    },
    // 子页面模式：显示返回箭头，标题居中（替代 LOGO + 副标题）
    back: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    navTotalHeight: 0,
    navRowTop: 0,
    navRowHeight: 44,
    navBandHeight: 0,
    rightInset: 24,
  },

  lifetimes: {
    attached() {
      const metrics = getNavMetrics();
      this.setData({
        navTotalHeight: metrics.navTotalHeight,
        navRowTop: metrics.navRowTop,
        navRowHeight: metrics.navRowHeight,
        navBandHeight: metrics.navBandHeight,
        rightInset: metrics.rightInset,
      });
    },
  },

  methods: {
    // LOGO 点击：交给页面决定行为（如关于页弹出小程序码）
    onLogoTap() {
      this.triggerEvent("tapLogo");
    },

    // 返回箭头：优先走页面栈返回；栈里只有自己时退回首页
    onBackTap() {
      const pages = getCurrentPages();
      if (pages && pages.length > 1) {
        wx.navigateBack({ delta: 1 });
        return;
      }
      // 没有上一页（直接通过分享/扫码进入），退回首页
      wx.switchTab({ url: "/pages/genealogy/genealogy" });
    },
  },
});
