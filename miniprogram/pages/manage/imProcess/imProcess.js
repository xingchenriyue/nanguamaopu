const apiDb = require('../../../utils/api.js').db;
// miniprogram/pages/manage/imProcess/imProcess.js
/**
 * 照片批量处理（压缩 + 水印）· 管理端
 * ============================================================================
 * 【职责】拉取「待处理照片」列表，勾选后批量/单张触发后端处理，并展示进度与错误。
 * 【图像压缩/水印全部在后端 unionOp.processPhoto 完成，客户端不做任何图像处理】
 *   后端算法（供维护参考）：
 *   - 压缩图：长边 500px，等比缩放。
 *   - 水印图：在长边 1200px 的画布上绘制白色 sans-serif 文字，
 *     字号 = 画布高 * 0.03，位置 x=30、y=画布高 - 字号，输出为原图尺寸。
 *   - 水印文本：`${app_name}@${photographer || userInfo.nickName}`。
 * 【接口契约】（后端已上线验证，unionOp 顶层传参，不要嵌套 args）
 *   POST /api/unionOp  { unionAction:'processPhoto', photo_id: <photo 表 _id> }
 *   → { success, result, data: { compressed, watermark, compressedKey, watermarkKey } }
 *   compressed / watermark 是可直接使用的 OSS URL（oss.xcry.top）。
 *   photo_id 传的是 photo 表的 _id，不是图片 URL。
 *   仅管理员可触发；非管理员返回 HTTP 200 + result:false（msg='not a manager'）。
 *   后端会自行回写 photo 表 4 个字段（photo_compressed / photo_compressed_id /
 *   photo_watermark / photo_watermark_id），客户端不再写库。
 * 【注意】
 *   1. 批量处理按张「串行」调用，避免并发打爆后端；用户可中途点「停止」在下一张前中断。
 *   2. 删除单张照片仍走 api.managePhoto({ type: 'delete' })。
 * ============================================================================
 */
import { checkAuth, fillUserInfo } from "../../../utils/user";
import api from "../../../utils/cloudApi";
import { signCosUrl } from "../../../utils/common";

Page({

  /**
   * 页面的初始数据
   */
  data: {
    phase: 0, // 0 未开始 / 1 后端处理中 / 2 已完成
    phase2str: [
      '未开始',
      '后端处理中',
      '已完成'
    ],
    now: 0, // 当前已处理数量
    total: 0, // 待处理总数
    processing: false,
    errMsg: "",
    errStack: "",
    photoList: [], // 待处理照片列表
    selectedCount: 0, // 选中照片数量
    allSelected: false, // 是否全选
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: async function () {
    if (await checkAuth(this, 99)) {
      await this.loadProcess();
      // 前端显示鉴权组件提示权限不够，点击返回，而不是直接跳转
    }
  },

  onShow: function () {
    console.log('设置屏幕常亮');
    wx.setKeepScreenOn({
      keepScreenOn: true
    });
  },

  onHide: function () {
    console.log('取消屏幕常亮');
    wx.setKeepScreenOn({
      keepScreenOn: false
    });
  },

  onUnload: async function () {
    console.log('取消屏幕常亮');
    wx.setKeepScreenOn({
      keepScreenOn: false
    });
  },

  // 加载所有需要处理的照片到列表
  async loadProcess() {
    try {
      wx.showLoading({
        title: '加载中...',
      });

      const { result: total } = await apiDb.collection('photo').count({
        photo_compressed: { $in: [undefined, ''] },
        verified: true
      });

      // 获取所有需要处理的照片
      const { result: photos } = await apiDb.collection('photo').find({
        photo_compressed: { $in: [undefined, ''] },
        verified: true
      });

      // 填充用户信息
      await fillUserInfo(photos, "_openid", "userInfo");

      // 为每张照片添加选中状态，并生成签名URL和格式化日期
      const photoList = [];
      for (let photo of photos) {
        // 生成签名URL用于显示缩略图
        const signedPhotoId = await signCosUrl(photo.photo_id);

        // 格式化日期
        let formattedDate = '未知时间';
        try {
          if (photo.mdate) {
            const date = new Date(photo.mdate);
            formattedDate = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
          }
        } catch (error) {
          console.error('日期格式化错误:', error);
        }

        photoList.push({
          ...photo,
          checked: false,
          signedPhotoId: signedPhotoId, // 签名后的URL用于显示缩略图
          formattedDate: formattedDate // 格式化后的日期
        });
      }

      console.log("imProcess loadProcess:", total, photoList);
      this.setData({
        total: total,
        now: 0,
        processing: false,
        photoList: photoList,
        selectedCount: 0,
        allSelected: false
      });

      wx.hideLoading();
    } catch (error) {
      console.error('加载照片列表失败:', error);
      wx.hideLoading();
      wx.showToast({
        title: '加载失败',
        icon: 'error'
      });
    }
  },

  // 点击处理按钮：未处理时开始，处理中则请求停止（在下一张前中断）
  clickProcessBtn: async function () {
    if (this.data.processing) {
      // 用户点击停止：置 processing=false，处理循环会在下一张前退出
      this.setData({ processing: false });
      return;
    }

    if (this.data.selectedCount === 0) {
      wx.showToast({
        title: '请先选择照片',
        icon: 'none'
      });
      return;
    }

    this.setData({ processing: true, errMsg: "" });
    try {
      await this.beginProcess();
    } catch (error) {
      console.error(error);
      await wx.showModal({
        title: '出错了',
        content: error.toString(),
        showCancel: false
      });
      this.setData({
        errMsg: JSON.stringify(error.message) || "-",
        errStack: error.stack?.toString() || "-",
      });
      await this.loadProcess();
      wx.hideLoading();
    } finally {
      this.setData({ processing: false });
    }
  },

  // 开始处理选中的照片（逐张串行调用后端，避免并发打爆）
  beginProcess: async function () {
    // 获取选中的照片
    const photosToProcess = this.data.photoList.filter(photo => photo.checked);

    if (photosToProcess.length === 0) {
      wx.showModal({
        title: '提示',
        content: '没有选中需要处理的照片',
        showCancel: false,
      });
      this.setData({
        processing: false
      });
      return;
    }

    this.setData({ phase: 1, now: 0 }); // 后端处理中

    // 处理每张照片（串行）
    // 【为什么单张失败不中断整批】旧实现里 processOne 抛错会直接跳出整个循环：
    // 一张坏图（原图缺失/签名失败）就让后面所有照片都不处理，用户只看到「出错了」，
    // 不知道到底成功了几张。现在逐张兜错、统计成功/失败，最后统一汇报。
    let okCount = 0;
    const failures = [];
    for (let i = 0; i < photosToProcess.length; i++) {
      if (!this.data.processing) break; // 如果用户点击停止，则中断

      const photo = photosToProcess[i];
      try {
        await this.processOne(photo);
        okCount += 1;
      } catch (error) {
        console.error('[imProcess] 处理失败', photo && photo._id, error);
        failures.push({ id: photo && photo._id, msg: (error && error.message) || String(error) });
      }

      // 更新进度
      this.setData({
        now: this.data.now + 1
      });
    }

    this.setData({
      phase: 2, // 已完成
      processing: false
    });

    // 重新加载照片列表
    await this.loadProcess();
    wx.hideLoading();

    if (failures.length) {
      await wx.showModal({
        title: '部分照片处理失败',
        showCancel: false,
        content: '成功 ' + okCount + ' 张，失败 ' + failures.length + ' 张。',
        // 第一条失败原因单独提示，便于直接定位（失败明细已打到控制台）
      });
      wx.showToast({ icon: 'none', title: '失败原因：' + failures[0].msg, duration: 3000 });
    } else if (okCount) {
      wx.showToast({ title: '处理完成 ' + okCount + ' 张', icon: 'success' });
    }
  },

  setPhase: function (phase) {
    this.setData({ phase: phase });
  },

  // 处理一张图片：交给后端 processPhoto（压缩 + 水印 + 写库一次完成）
  processOne: async function (photoInfo) {
    this.setPhase(1); // 后端处理中

    // 后端契约：body { unionAction:'processPhoto', photo_id: photo 表 _id }（顶层传参）
    // 返回 { success, result, data:{ compressed, watermark, compressedKey, watermarkKey, ... } }
    const res = await api.processPhoto({ photo_id: photoInfo._id });

    // result === false 是业务失败（如非管理员），HTTP 仍是 200，需单独识别
    if (res && res.result === false) {
      const msg = res.msg || '未知原因';
      throw new Error(msg === 'not a manager' ? '仅管理员可执行照片处理' : ('后端拒绝处理：' + msg));
    }

    const data = (res && res.data) || {};

    // 后端应返回压缩图/水印图 OSS URL；缺失则视为后端异常，不静默
    if (!data.compressed && !data.watermark) {
      throw new Error('后端未返回压缩图/水印图地址：' + JSON.stringify(res));
    }

    console.log("imProcess processOne done:", photoInfo._id, data);
    this.setPhase(2); // 已完成
    return data;
  },

  // 全选/取消全选
  toggleSelectAll: function () {
    const allSelected = !this.data.allSelected;
    const photoList = this.data.photoList.map(photo => {
      return {
        ...photo,
        checked: allSelected
      };
    });

    this.setData({
      photoList: photoList,
      allSelected: allSelected,
      selectedCount: allSelected ? photoList.length : 0
    });
  },

  // 切换单张照片的选中状态
  togglePhotoSelect: function (e) {
    const index = e.currentTarget.dataset.index;
    const photoList = this.data.photoList;
    photoList[index].checked = !photoList[index].checked;

    const selectedCount = photoList.filter(photo => photo.checked).length;
    const allSelected = selectedCount === photoList.length;

    this.setData({
      photoList: photoList,
      selectedCount: selectedCount,
      allSelected: allSelected
    });
  },

  // 预览照片
  previewPhoto: function (e) {
    const index = e.currentTarget.dataset.index;
    const photo = this.data.photoList[index];

    if (!photo.showImg) {
      this.setData({
        [`photoList[${index}].showImg`]: true,
      });
      return;
    }

    wx.previewImage({
      urls: [photo.signedPhotoId]
    });
  },

  // 删除单张照片后重新加载列表
  deletePhoto: async function (e) {
    const index = e.currentTarget.dataset.index;
    const photo = this.data.photoList[index];

    const res = await wx.showModal({
      title: '确认删除',
      content: '确定要删除这张照片吗？此操作不可撤销。',
    });

    if (res.confirm) {
      try {
        wx.showLoading({
          title: '删除中...',
        });

        // 从数据库删除照片
        await api.managePhoto({
          photo: photo,
          type: 'delete'
        });

        wx.showToast({
          title: '删除成功',
        });

        // 重新加载照片列表
        await this.loadProcess();
      } catch (error) {
        console.error('删除照片失败:', error);
        wx.hideLoading();
        wx.showToast({
          title: '删除失败',
          icon: 'error'
        });
      }
    }
  },

  // 处理单张照片后重新加载列表
  processSinglePhoto: async function (e) {
    const index = e.currentTarget.dataset.index;
    const photo = this.data.photoList[index];

    this.setData({
      processing: true,
      errMsg: ""
    });

    try {
      await this.processOne(photo);

      wx.showToast({
        title: '处理完成',
      });

      // 重新加载照片列表
      await this.loadProcess();
    } catch (error) {
      console.error('处理照片失败:', error);
      this.setData({
        processing: false
      });
      wx.showModal({
        title: '处理失败',
        content: error.toString(),
        showCancel: false
      });
    }
  },

  copyText: function (e) {
    const { text } = e.currentTarget.dataset;
    wx.setClipboardData({
      data: text,
    });
  }
})
