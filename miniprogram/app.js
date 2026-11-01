// app.js
// 说明：本小程序为「信息展示型」应用。
// 不采集用户个人信息、不强制登录、不收集手机号/位置，因此无需在 app.json 声明隐私接口。

const CLOUD_ENV = 'cloud1-d7g95svj63424be41'

// 「别人分享出来的卡片」才有的启动场景值：
//   1007 单人聊天会话中的小程序消息卡片
//   1008 群聊会话中的小程序消息卡片
//   1044 带 shareTicket 的小程序消息卡片
// 从「最近使用」「我的小程序」「发现栏小程序列表」等入口进来时，微信会复用上一次启动的
// path 和 query —— 那个 query 里还留着上次分享卡片的 open，必须靠场景值过滤掉，
// 否则用户返回首页后，下次从入口点进来又会莫名其妙跳回同一个详情页。
const SHARE_SCENES = [1007, 1008, 1044]

// 调用统计：在开发者工具 Console 里执行 getApp().cloudStats() 可查看
// 返回 { calls: 实际云函数调用次数, hits: 命中缓存省下的次数, cacheKeys: 缓存条目数 }
const cloud = require('./utils/cloud')

App({
  globalData: {
    env: CLOUD_ENV,
    // 管理员身份通过的时间戳：manage 页 bootstrap 命中后写入，publish 页 60 秒内复用，
    // 省掉一次身份校验调用。仅在「已确认是管理员」时写入，不影响 openid 的准确获取。
    adminAuthAt: 0,
    // 管理台列表是否需要重拉：发布/编辑页写入成功后置 true，
    // manage 页 onShow 据此决定是否真的再调一次云函数（省掉无意义的重复拉取）
    adminListDirty: false,
    // 非首页时长按 tabBar「首页」→ 先置 true 再 switchTab，首页 onShow 消费后立即强制刷新
    homeRefreshPending: false,
    // 从分享卡片打开时带进来的参数（含 open=信息id）。
    // 由 App.onShow 写入、首页 onShow 消费：冷启动与热启动的参数来源不同，统一在这里中转
    pendingOpen: null,
    // 信息类型字典，全局复用，避免各页面重复定义
    TYPES: {
      house: { key: 'house', label: '房源租售', desc: '求租 / 招租' },
      secondhand: { key: 'secondhand', label: '二手闲置', desc: '求买 / 求卖' },
      offer: { key: 'offer', label: '生活信息', desc: '本地生活服务' }
    }
  },

  cloudStats: cloud.getStats,

  onLaunch() {
    if (!wx.cloud) {
      console.error('当前基础库版本过低，请使用 2.2.3 及以上版本')
      return
    }
    wx.cloud.init({
      env: CLOUD_ENV,
      // 不追踪用户，减少个人信息采集，降低隐私合规负担
      traceUser: false
    })
  },

  /**
   * 统一接住「从分享卡片打开」的参数。
   *
   * 冷启动和热启动拿参数的位置不一样：
   *   - 冷启动：Page.onLoad(options) 直接带参数
   *   - 热启动：path 指向首页（tabBar 页）时微信走 switchTab，页面栈被重置，
   *     首页只触发 onShow 且**不带参数**，参数只能在 App.onShow 拿到
   * 所以统一在这里记一笔，由首页 onShow 消费 —— 一处写入一处消费，不会重复跳转。
   *
   * 必须按场景值过滤：微信从「最近使用」「我的小程序」等入口进入时，会复用上一次启动的
   * path 和 query，query 里可能还留着上次分享卡片的 open。不过滤就会一进小程序就跳详情页。
   */
  onShow(options) {
    const q = (options && options.query) || {}
    const scene = options ? options.scene : undefined

    if (q.open && SHARE_SCENES.indexOf(scene) !== -1) {
      this.globalData.pendingOpen = q
    } else {
      // 非分享入口：主动清空，避免上一次没消费完的参数残留到这次启动
      this.globalData.pendingOpen = null
    }
  }
})
