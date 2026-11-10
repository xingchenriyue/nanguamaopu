/**
 * 南瓜猫谱 · 小程序全局配置（唯一需要用户手工修改的文件）
 * ============================================================================
 * 【职责】后端地址、OSS 域名、桶名、AppID、版本号、地图中心、系统图片、功能开关、
 *        主题色全部集中在本文件；其余文件禁止出现需要用户手改的常量。
 * 【依赖】无。纯数据模块，不 import 任何运行时模块，避免循环引用。
 * 【注意事项】
 *  1. 只改配置项的值，不要删除键、不要改键名（删除会导致编译出错）。
 *  2. 密钥（WX_SECRET / OSS_ACCESS_KEY_* / JWT_SECRET 等）一律放后端 .env，
 *     小程序端禁止出现任何密钥、AccessKey、密码。
 *  3. API_BASE_URL 是「后端反向代理域名」（→ 127.0.0.1:8000）；
 *     OSS_EXTERNAL_ENDPOINT / OSS_CNAME_ENDPOINT 是「OSS 图片域名」，
 *     两者互不通用，切勿把 OSS CNAME 填进 API_BASE_URL。
 *  4. LOGO 只需替换 LOGO_PATH 指向的那一个文件；所有引用 LOGO 的地方都读本文件常量。
 *  5. 主题色在 app.wxss 里用 CSS 变量定义供 WXSS 使用，本文件 theme 字段供
 *     JS（canvas 绘图等）读取，两处数值保持一致，改色时同步修改。
 *  6. 完整配置步骤见仓库根目录 README-配置说明.md。
 * ============================================================================
 */

// 系统图片统一放在 OSS 的「系统」目录。改 OSS 域名时只改这里一处即可。
// OSS 为私有桶：这些地址不能在浏览器/小程序里直接当公网直链用，
// 读取统一经 utils/oss.js 调后端 /api/oss/sign 换签名 URL。
const OSS_IMAGE_BASE = 'https://oss.xcry.top/系统/';

module.exports = {
  // ======================== ① 必填：后端与 OSS ========================
  // 后端 API 反代域名（用户已备好反代与证书，指向 127.0.0.1:8000）。必须 HTTPS 且已备案。
  // 注意：这是 API 域名，不是 OSS 图片域名，切勿把 CNAME 填到这里。
  API_BASE_URL: "https://mao.xcry.top",
  // 普通请求超时（毫秒）；识猫等长任务会在调用处单独放大
  REQUEST_TIMEOUT_MS: 15000,
  // 登录态失效时自动重登并重试的最大次数
  RELOGIN_MAX_RETRY: 1,

  // OSS 外网 endpoint 与可选 CNAME，由 OSS_USE_CNAME 切换（二者只用于图片上传/读取）
  OSS_USE_CNAME: true,
  OSS_EXTERNAL_ENDPOINT: "https://nanhuamaopu.oss-cn-beijing.aliyuncs.com",
  OSS_CNAME_ENDPOINT: "https://oss.xcry.top",
  // 私有桶桶名：nanhuamaopu 是正确值（原名被占用才改用此名），项目名仍是 nanguamaopu。
  // 存储桶名与项目名不同属正常情况，切勿「好心」改成 nanguamaopu，否则图片全部 404。
  OSS_BUCKET: "nanhuamaopu",
  // 上传对象 key 前缀 / 系统图片 key 前缀
  OSS_UPLOAD_PREFIX: "photos/",
  OSS_SYSTEM_PREFIX: "系统/",
  // 签名 URL 缓存时长必须短于签名有效期（后端签名有效期 900s、建议缓存 600s）：
  // 收敛层用后端返回的 cacheSeconds 再减这里的安全余量，并以 expire×0.8 兜底，
  // 保证严格短于签名有效期，避免「徽章图片过一会儿只剩名字」。
  OSS_SIGN_CACHE_MARGIN_SECONDS: 60,

  // ======================== ② 应用与版本 ========================
  // 版本号
  app_version: "v1.20.1",
  // 小程序 AppID（用户 19:37 确认值）。这是全项目业务代码里的唯一来源，
  // 其他 js/wxml 禁止重复硬编码；project.config.json 的 appid 是微信开发者工具
  // 必需的构建期字段（属用户本地配置），需与此处保持一致。
  app_id: "wx4f0e7cb23f923f92",
  // 离线 Demo 开关：true 时用内置假数据离线预览、不发网络请求；正式部署必须为 false
  OFFLINE_DEMO_MODE: false,

  // ======================== ③ LOGO 与默认图 ========================
  // 全项目唯一 LOGO 文件：替换这一个文件即可完成品牌换图
  LOGO_PATH: "/pages/public/images/system/logo.png",
  // 缺省头像占位图
  DEFAULT_AVATAR_PATH: "/pages/public/images/system/user.png",

  // ======================== ④ 地图与业务参数 ========================
  // 图片选择数量限制
  chooseMediaCount: 20,
  // 喵地图配置的大本营坐标，默认地图中心（湖南衡阳）
  map_center: { latitude: 26.898607, longitude: 112.587911 },
  map_max_markers: 200,
  // 喵地图申请——达到此数量即可申请（未达到的也可以提交，但是会有警示标识）
  mapAccessMinRequired: 10,
  // 喵地图申请——达到此数量自动通过
  mapAccessAutoPassCount: 200, 

  // ======================== ⑤ 功能开关 ========================
  // 识猫默认模式：off / custom / meowid（运行时以数据库 setting.pages.recognize 为准）
  recognize_default_mode: "off",
  // MeowID 独立部署服务的默认地址（调试页表单默认值，可在页面内临时覆盖）
  MEOWID_BASE_URL: "https://platform.meowid.net",
  // 是否在调试页展示详细网络错误文案
  debug_network_error: true,

  // ======================== ⑥ 主题色（与 app.wxss CSS 变量一致） ========================
  // LOGO 精确取色色板（team-lead 统一口径，量化值）：
  //   --brand-primary #406090 猫头钢蓝，品牌主色（精确像素 #4D6F97 量化后即 #406090）
  //   --brand-deep    #104070 圆环/文字藏蓝，深强调
  //   --brand-ink     #004080 标题/主按钮/边框
  //   --brand-light   #C0D0D0 浅色（分割线/禁用态，勿作正文色）
  //   --brand-bg      #E0E0F0 浅背景
  //   --brand-on      #FFFFFF LOGO 白底 / 主色上的文字
  // JS 侧（canvas 绘图等）读这里；WXSS 侧读 app.wxss 的 --color-* / --brand-* 变量。
  // 换 LOGO 后只需改 app.wxss 的变量 + 这里对应值，即可整体换色。
  theme: {
    primary: "#406090",
    primary_dark: "#104070",
    primary_light: "#B0C0D0",
    accent: "#004080",
    accent_deep: "#104070",
    bg: "#E0E0F0",
    card: "#FFFFFF",
    tint: "#D0E0E0",
    border: "#C0D0D0",
    text: "#22314A",
    text_sub: "#5B6B80",
    text_on_primary: "#FFFFFF",
  },

  // ======================== ⑦ 遗留本地环境配置（勿删） ========================
  // 以下为用户本地环境值，迁移到自建后端后已不再被运行时读取，
  // 按迁移要求原样保留，避免丢失用户本地配置语义。
  // EMAS 空间 ID（停用）
  space_id: "mp-26746b0d-b9b4-4ffd-86ef-540c58973c4e",
  // EMAS 服务空间地址（停用）
  space_endpoint: "https://api.next.bspapp.com",
  // 原「私有腾讯云 COS」开关（停用，保留原值 false）。
  // 新架构 OSS 为私有桶，读图一律走后端签名，不受此开关影响。
  use_private_tencent_cos: false,
  // 原腾讯云 COS 签名有效期（秒，停用）
  sign_expires_tencent_cos: 3600 * 2,

  // ======================== ⑧ 系统图片（OSS 私有桶，读取走后端签名） ========================
  // 全部由文件顶部 OSS_IMAGE_BASE 拼出，换 OSS 域名只需改那一处。
  // 科普页图片
  science_imgs: [
    `${OSS_IMAGE_BASE}科普1.png`,
    `${OSS_IMAGE_BASE}科普2.png`,
    `${OSS_IMAGE_BASE}科普3.png`,
    `${OSS_IMAGE_BASE}科普4.png`,
    `${OSS_IMAGE_BASE}科普5.png`
  ],
  // 赞赏码图片
  reward_img: `${OSS_IMAGE_BASE}赞赏码.jpg`,
  // 新猫问卷图片
  feedback_wj_img: `${OSS_IMAGE_BASE}新猫问卷.png`,
  // 小程序菊花码图片
  mpcode_img: `${OSS_IMAGE_BASE}菊花码.jpg`,
  // 徽章排行榜的数量榜 logo
  badge_rank_count_img: `${OSS_IMAGE_BASE}badge_rank_count.png`,
  // 徽章排行榜的价值榜 logo
  badge_rank_score_img: `${OSS_IMAGE_BASE}badge_rank_score.png`,

  // 猫猫领养状态字符串，对应数据库cat.adopt中的数字下标
  cat_status_adopt: ["未领养", "已领养", "寻找领养中"],
  // 首页漂浮的领养Logo对应的状态
  cat_status_adopt_target: "寻找领养中",

  // 各种文字内容
  text: {
    // 小程序名
    app_name: "南瓜猫谱",
    // 首页，pages/genealogy/genealogy
    genealogy: {
      share_tip: "发现身边校园猫咪",
      search_tip: "搜索猫猫名字或昵称",
      filter_tip: "点此进行筛选",
      new_photo_tip: "有新相片！",
      no_photo_tip: "暂无封面照片...",
      photo_by_tip: "Photo by ",
      photo_by_unknow_tip: "匿名猫友",
      photo_loading_tip: "加载照片ing",
      to_star_tip: "返回喵星",
      missing_tip:"已失踪",
      adopt_btn: "只小猫",
    },
    // 关于页，pages/info/info
    info: {
      share_tip: "关于",
      slogan: "拍照记录校园内猫猫的成长轨迹",
    },
    // 猫猫详情页，pages/genealogy/detailCat/detailCat
    detail_cat: {
      bottom_text_loading: "LOADING...",
      bottom_text_end: "- THE END -",
      popularity_tip: "猫猫人气值",
      comment_tip: "猫猫便利贴数",
      button_feedback: "反馈猫猫信息",
      label_nickname: "昵称",
      label_location: "常驻地",
      label_birthday: "生日",
      label_father: "爸爸",
      label_mother: "妈妈",
      label_friend: "好友",
      label_character: "性格及特点",
      label_tutorial: "撸猫指南",
      label_rating: "猫友评分",
      label_tutorial_empty: "暂时还没有",
      label_comment_board: "便利贴墙",
      sterilized_true: "已绝育",
      sterilized_false: "待绝育",
      slogan1: "它们的点点滴滴，由你来记录",
      slogan2: "扫右方小程序码了解更多~",
    },
    // 提交反馈页，pages/genealogy/feedbackDetail/feedbackDetail
    feedback_detail: {
      feedback_title: "反馈",
      feedback_tip: "猫猫信息纠错、照片归属权、功能改进等~",
      input_length_tip: "字数",
      contract_title: "其他信息",
      contract_tip: "（选填）",
      submit_button: "提交反馈",
      submit_tip: "*反馈仅后台工作人员可见",
    },
    // 提交便利贴页，pages/genealogy/commentBoard/commentBoard
    comment_board: {
      ban_tip: "如有误封请在\"关于-信息反馈\"中反馈~",
      auth_tip: "请先设置头像昵称~",
      comment_tip: "给猫咪留张便利贴吧~"
    },
    // 添加照片，pages/genealogy/addPhoto/addPhoto
    add_photo: {
      auth_tip: "设置头像昵称后上传~",
      uploading_tip: "正在上传...",
      success_tip_title: "上传成功！",
      success_tip_content: "审核后就会展示出来啦",
      unfinished_tip_title: "提示",
      unfinished_tip_content: "填写信息后再上传哦！",
    },
    // 赞赏页，pages/info/reward/reward
    reward: {
      share_tip: "投喂罐头",
      ad_success_tip: "多谢喵(ฅ'ω'ฅ)!",
      ad_fail_tip: "没播完喵...",
      reward_tip_title: "投喂罐头",
      reward_tip: "您的投喂将用作猫猫救助，每月的收支都在支付宝小荷包，感谢您对南华流浪猫的帮助与支持！\n喵(^･ｪ･^)",
      reward_count_tip: "* 进群找支付宝小荷包看，多谢晒（鞠躬）",
      reward_title: "爱心捐款",
    },
    // 排行页，pages/info/photoRank/photoRank
    photo_rank: {
      share_tip: "拍照月榜",
      auth_tip_title: "请授权查看自己的排名",
      auth_tip: "点击授权",
      count_tip: "* 定期自动更新"
    },
    // 反馈页，pages/info/feedback/feedback
    feedback: {
      share_tip: "信息反馈",
      feedback_tip_title: "留下反馈",
      feedback_tip: "每一条反馈我们都会认真看滴",
      new_cat_tip_title: "新的猫猫",
      new_cat_tip: "提交猫谱中没有的猫猫信息，给猫猫上户口~",
      contract_tip_title: "更多联系",
      contract_tip: "有关猫猫信息添加、小程序的建议、照片维权、猫猫领养咨询等事项，请邮件：cym@xcry.top",
    },
    // 开发团队页，pages/info/devTeam/devTeam
    dev_team: {
      share_tip: "开发团队",
      team: "程序部署：曹瑛明\n程序开发：渔政、蓝卷、XD、zJ、ArcherJo、yw、lauzeyu、xuannfx、LightHouse-1024、曹瑛明\n资料维护：Lo\n初期资料整理：hehe、玥琪、大米\n以及各校区猫群的小伙伴~\n非常欢迎新朋友加入设计开发哇~！",
    },
    // 识猫页，pages/recognize/recognize
    recognize: {
      share_tip: "拍照识猫",
      select_tip: "你可以从相册选择猫猫照片\n或点击下方启用相机权限后直接拍照\n",
      select_btn: "启用相机权限",
      reselect_btn: "重新选图",
      no_cat_tip: "照片里好像没有猫猫",
      multi_cat_tip: "点击对应方框可以更改想识别的猫猫",
      no_cat_rec_tip: "看起来，整张照片更像...",
      single_cat_rec_tip: "看起来，这张照片里的猫猫更像...",
      multi_cat_rec_tip: "看起来，黄色框框中的猫猫更像...",
      bottom_tip: "*目前仅拥有十张以上靓照（清晰正面、仅含一只）的猫猫才能被认到哦！多多上传帮忙改进识别效果吧~",
      ad_tip: "识别累了，帮忙点下广告喵（揉眼睛 ( '-ωก̀ )",
    },
    // 科普页，pages/science/science
    science: {
      share_tip: "科普",
    },
    // 精选，pages/leaderboard/leaderboard
    leaderboard: {
      share_tip: "榜单",
    },
    // 特邀用户，pages/inviteUser/inviteUser
    inviteUser: {
      share_tip: "该分享无法激活特邀哦",
      share_title: "[6小时内] 点击成为特邀用户~",
      default_tip: "哦吼，这里空空如也，去首页看看猫猫吧~",
      invite_tip: "猫猫正在检查邀请函...",
      manager_tip: "分享至聊天，普通用户点击后将成为特邀，邀请有效期6小时~",
      expired_title: "出问题",
      success_title: "完成",
      expired_tip: "邀请链接已过期...请联系管理员~",
      already_tip: "你已经是特邀用户啦~",
      success_tip: "`已成为特邀用户~",
    },
  }
}
