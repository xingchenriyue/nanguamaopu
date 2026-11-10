const apiDb = require('../../../utils/api.js').db;
// miniprogram/pages/info/reward/reward.js
import { text as text_cfg, reward_img } from "../../../config";
import { checkCanReward } from "../../../utils/user";
import { getGlobalSettings } from "../../../utils/page";
import { signCosUrl } from "../../../utils/common";
import { addRecognizeBonus } from "../../../utils/recognize";
const share_text = text_cfg.app_name + ' - ' + text_cfg.reward.share_tip;
const app = getApp();
Page({

  /**
   * 页面的初始数据
   */
  data: {
    showAdBlock: false,
    text_cfg: text_cfg,
  },

  onLoad: async function (option) {
    // jsData 放页面实例上，不作为 Page 的顶层选项：
    // 微信会把顶层 jsData 判为“游离数据”并告警
    // "Free data with key \"jsData\" ... seems not a simple value"。
    this.jsData = {
      // 在页面中定义激励视频广告
      videoAd: null,
    };

    this.loadReward();
    // 是否开启
    this.setData({
      canReward: await checkCanReward()
    });

    // 设置广告ID
    const ads = await getGlobalSettings('ads') || {};
    // 看完这条广告赠送的识猫次数（0 = 不赠送），与识猫页共用同一份次数计数
    this.jsData.adReset = ads.recognize_ad_reset || 'daily';
    this.jsData.recognizeBonus = Math.max(0, parseInt(ads.reward_video_bonus, 10) || 0);
    // 在页面onLoad回调事件中创建激励视频广告实例
    var that = this;
    if (wx.createRewardedVideoAd) {
      this.jsData.videoAd = wx.createRewardedVideoAd({
        adUnitId: ads.reward_video
      })
      this.jsData.videoAd.onLoad(() => {
        that.setData({
          showAdBlock: true
        });
      })
      this.jsData.videoAd.onError((err) => {
        that.setData({
          showAdBlock: false
        });
      })
      this.jsData.videoAd.onClose((res) => {
        // 用户点击了【关闭广告】按钮
        var toast = text_cfg.reward.ad_success_tip;
        var icon = 'success';
        const ended = !!(res && res.isEnded);
        if (ended) {
          // 正常播放结束：按页面配置赠送识猫次数（与识猫页共享计数，跨页生效）
          const bonus = this.jsData.recognizeBonus || 0;
          if (bonus > 0) {
            addRecognizeBonus(bonus, this.jsData.adReset || 'daily');
            toast = '已赠送 ' + bonus + ' 次识猫机会';
          }
        } else {
          // 播放中途退出
          icon = 'error';
        }
        wx.showToast({
          title: toast,
          icon: icon,
        });
      })
    }
  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage: function () {
    return {
      title: share_text
    }
  },

  async loadReward() {
    var { result: rewardRes } = await apiDb.collection('reward').find({}, { sort: { mdate: -1 } })

    console.log(rewardRes);
    for (var r of rewardRes) {
      const tmp = r.recordDate ? new Date(r.recordDate) : new Date(r.mdate);
      r.mdate = tmp.getFullYear() + '年' + (tmp.getMonth() + 1) + '月';
      r.records = r.records.replace(/^\#+|\#+$/g, '').split('#');
    }
    this.setData({
      reward: rewardRes
    });
  },

  // 打开大图
  async openImg(e) {
    const src = await signCosUrl(reward_img);
    wx.previewImage({
      urls: [src],
      success: (res) => {
        console.log(res);
      },
      fail: (res) => {
        console.log(res);
      },
      complete: (res) => {
        console.log(res);
      },
    });
  },

  // 跳转到 给赞 小程序
  openMina(e) {
    const appid = e.currentTarget.dataset.appid;
    const path = e.currentTarget.dataset.path;
    wx.navigateToMiniProgram({
      appId: appid,
      path: path,
    });
  },

  // 激励广告
  openAd() {
    // 用户触发广告后，显示激励视频广告
    if (this.jsData.videoAd) {
      this.jsData.videoAd.show().catch(() => {
        // 失败重试
        this.jsData.videoAd.load()
          .then(() => this.jsData.videoAd.show())
          .catch(err => {
            console.log('激励视频 广告显示失败')
          })
      })
    }
  }
})