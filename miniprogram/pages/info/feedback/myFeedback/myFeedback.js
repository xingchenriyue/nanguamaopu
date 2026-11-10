const apiDb = require('../../../../utils/api.js').db;
import { formatDate } from "../../../../utils/utils";
import { getUser } from "../../../../utils/user";

const step = 6;
const app = getApp();
Page({

  /**
   * 页面的初始数据
   */
  data: {
    login: false,
    feedbacks: [],
    total: 0,
  },

  onLoad: async function () {
    // jsData 放页面实例上，不作为 Page 的顶层选项：
    // 微信会把顶层 jsData 判为“游离数据”并告警
    // "Free data with key \"jsData\" ... seems not a simple value"。
    this.jsData = {
      currentUser: null,
    };

    this.jsData.currentUser = await getUser();
    console.log(this.jsData.currentUser);
    if (!this.jsData.currentUser) {
      return;
    }
    this.setData({
      login: true
    });
    this.reload();
  },

  async reload() {
    wx.showLoading({
      title: '加载中...',
    });
    const that = this;
    const countRes = await apiDb.collection('feedback').count({ _openid: this.jsData.currentUser.openid })
    that.setData({
      total: countRes.result,
    });
    // 清空，loadFeedbacks再填充
    this.data.feedbacks = [];
    await this.loadFeedbacks();
    wx.hideLoading();
  },

  async loadFeedbacks() {
    const nowLoaded = this.data.feedbacks.length;
    var { result: feedbacks } = await apiDb.collection('feedback').find({ _openid: this.jsData.currentUser.openid }, { sort: { openDate: -1 }, skip: nowLoaded, limit: step })
    console.log(feedbacks);
    // 获取对应猫猫信息；将Date对象转化为字符串；判断是否已回复
    for (let i = 0; i < feedbacks.length; ++i) {
      if (feedbacks[i].cat_id != undefined) {
        feedbacks[i].cat = (await apiDb.collection('cat').findOne({ _id: feedbacks[i].cat_id }, { projection: { name: 1, campus: 1 } })).result;
      }
      feedbacks[i].openDateStr = formatDate(feedbacks[i].openDate, "yyyy-MM-dd hh:mm:ss");
      feedbacks[i].replied = feedbacks[i].hasOwnProperty('replyDate');
      if (feedbacks[i].replied) {
        feedbacks[i].replyDateStr = formatDate(feedbacks[i].replyDate, "yyyy-MM-dd hh:mm:ss");
      }
    }
    this.data.feedbacks.push(...feedbacks);
    this.setData({
      feedbacks: this.data.feedbacks
    });
  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom: async function () {
    if (this.data.feedbacks.length == this.data.total) {
      wx.showToast({
        title: '已无更多反馈',
        icon: 'none',
        duration: 500
      });
      return;
    }
    wx.showLoading({
      title: '加载更多反馈..',
      mask: true
    });
    await this.loadFeedbacks();
    wx.hideLoading();
  },

  // 点击所属猫猫名称，可以跳转到猫猫详情
  toCatDetail(e) {
    const cat_id = e.currentTarget.dataset.cat_id;
    wx.navigateTo({
      url: '/pages/genealogy/detailCat/detailCat?cat_id=' + cat_id,
    })
  },
})