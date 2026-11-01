// pages/index/index.js
const util = require('../../utils/util')
const infoQuery = require('../../utils/infoQuery')
const homeMetaQuery = require('../../utils/homeMeta')

Page({
  data: {
    // 自定义导航栏：顶部渐变从头屏顶部开始，用状态栏高度把品牌文字顶下来
    statusBarHeight: 20,

    categories: [
      { key: 'house', label: '房源租售', desc: '求租 / 招租' },
      { key: 'secondhand', label: '二手闲置', desc: '出售 / 求购' },
      { key: 'offer', label: '生活信息', desc: '本地生活服务' }
    ],

    // 公告栏
    notices: [],
    noticeIndex: 0,
    noticeText: '',
    noticeAnim: 'noticeA',
    noticeDuration: 8000,

    // 轮播图：与公告同一次请求返回（utils/homeMeta.js），空数组时整块不渲染
    banners: [],

    list: [],
    loading: true
  },

  onLoad() {
    this.initNavMetrics()
    this.loadHomeMeta()
    this.loadPinned()
  },

  /**
   * 分享卡片落地。
   *
   * 为什么落地页不是详情页：微信冷启动时，path 指向的那个页面会成为页面栈的栈底，
   * 侧滑手势 = 页面栈 pop 一层，栈底再 pop 就只能关闭小程序。
   * 所以分享路径写成「首页」，由首页补上列表、列表再补上详情，凑成三层：
   *   详情 ←(侧滑) 列表 ←(侧滑) 首页 ←(侧滑) 退出小程序
   * 每层都是真实页面，返回手势和左上角返回都能正常工作。
   */
  openSharedInfo(options) {
    const id = options && options.open
    if (!id) return

    const type = options.type || 'all'
    let url = `/pages/list/list?type=${type}&open=${id}`
    if (options.tab) url += `&tab=${options.tab}`

    wx.navigateTo({ url })
  },

  /**
   * 消费 App.onShow 记下的分享参数。
   * 只在这里跳、不在 onLoad 跳：冷启动时 onShow 紧随 onLoad，
   * 两处都做会连续压两层列表页。统一由 onShow 处理，冷热启动行为一致。
   */
  consumeSharedInfo() {
    const g = getApp().globalData || {}
    const q = g.pendingOpen
    if (!q) return
    g.pendingOpen = null
    this.openSharedInfo(q)
  },

  onShow() {
    // 先消费分享参数：下面几个分支都带 return，放最后会被跳过
    this.consumeSharedInfo()

    // 自定义 tabBar：回到首页时把选中态切到「首页」（原生 tabBar 会自动做这件事）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }

    // 在别的 tab 上长按了「首页」：切回来时强制刷新一次（消费即复位，避免下次误触发）
    const g = getApp().globalData || {}
    if (g.homeRefreshPending) {
      g.homeRefreshPending = false
      this.onLongPressRefresh()
      return
    }

    // 返回首页时刷新一次；缓存未到刷新点（每日 8:00 / 17:00，或 2 小时上限）时命中缓存，不产生云函数调用
    if (this.ready) this.loadPinned()
    if (this.metaReady) this.loadHomeMeta()
  },

  /** 读取状态栏高度：自定义导航栏下页面从屏幕顶部开始绘制 */
  initNavMetrics() {
    let statusBarHeight = 20
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      if (info && info.statusBarHeight) statusBarHeight = info.statusBarHeight
    } catch (err) {
      console.warn('[index] 获取状态栏高度失败，使用默认值', err)
    }
    this.setData({ statusBarHeight })
  },

  /**
   * 公告 + 轮播图：同一次请求返回，首页首屏只花 1 次调用
   * 两者都是「无数据则整块不渲染」，不会留空白占位
   */
  async loadHomeMeta(options) {
    const opts = options || {}
    const meta = await homeMetaQuery.fetchHomeMeta({ force: !!opts.force })
    this.metaReady = true

    const notices = meta.notices || []
    const banners = meta.banners || []

    // 轮播图跟着缓存一起更新，数量为 0 时 wx:if 直接不渲染
    this.setData({ banners })

    if (!notices.length) {
      this.setData({ notices: [], noticeText: '' })
      return
    }

    this.setData({ notices })
    if (opts.force) {
      // 强刷时内容可能变了，换一个动画名从头重播第一条
      this.playNotice(0, this.data.noticeAnim === 'noticeA' ? 'noticeB' : 'noticeA')
    } else if (!this.data.noticeText) {
      // 日常进入：已有正在播的公告就不打断
      this.playNotice(0, 'noticeA')
    }
  },

  /**
   * 播放第 index 条公告
   * @param {number} index 公告序号（自动取模循环）
   * @param {string} anim  noticeA / noticeB，交替使用以强制重启 CSS 动画
   */
  playNotice(index, anim) {
    const list = this.data.notices
    if (!list.length) return

    const i = index % list.length
    const text = list[i].content || ''
    // 字幕时长按字数估算，短句不拖沓、长句给够阅读时间
    const duration = Math.min(18000, Math.max(5000, 4000 + text.length * 300))

    this.lastNoticeAt = Date.now()
    this.setData({
      noticeIndex: i,
      noticeText: text,
      noticeDuration: duration,
      noticeAnim: anim
    })

    // 兜底：个别机型不触发 animationend 时，用定时器把字幕接力下去
    this.clearNoticeTimer()
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null
      if (Date.now() - this.lastNoticeAt >= duration - 200) this.onNoticeEnd()
    }, duration + 1200)
  },

  clearNoticeTimer() {
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer)
      this.noticeTimer = null
    }
  },

  /** 一条播完：切下一条，并换一个动画名让动画从头开始 */
  onNoticeEnd() {
    this.playNotice(
      this.data.noticeIndex + 1,
      this.data.noticeAnim === 'noticeA' ? 'noticeB' : 'noticeA'
    )
  },

  onUnload() {
    this.clearNoticeTimer()
  },

  /** 点击公告：弹出当前这条的完整内容（字幕只能滚动看一遍） */
  onNoticeTap() {
    const notice = this.data.notices[this.data.noticeIndex]
    if (!notice) return
    wx.showModal({
      title: '公告',
      content: notice.content,
      showCancel: false,
      confirmText: '知道了'
    })
  },

  /** 首页只展示推荐信息（weight > 0），其余信息需进入对应分类列表查看 */
  async loadPinned(options) {
    const opts = options || {}
    if (!this.ready) this.setData({ loading: true })
    try {
      const result = await infoQuery.fetchList(
        { page: 1, size: 10, pinned: true },
        { force: !!opts.force }
      )

      const list = ((result && result.list) || [])
        .map(util.decorateItem)
        .filter(item => !item.isExpired)

      this.ready = true
      this.setData({ list, loading: false })
      return true
    } catch (err) {
      console.error('[index] loadPinned failed', err)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败，请稍后重试', icon: 'none' })
      return false
    }
  },

  /**
   * 隐藏功能：强制刷新（跳过本地缓存）
   * 入口只在底部导航的「首页」项上长按（见 custom-tab-bar），页面内容区不响应长按，
   * 界面上也不放任何文字说明，只给一次轻震动作为反馈
   */
  async onLongPressRefresh() {
    if (this.refreshing) return
    this.refreshing = true

    wx.vibrateShort({ type: 'light' })

    try {
      const results = await Promise.all([
        this.loadPinned({ force: true }),
        this.loadHomeMeta({ force: true })
      ])
      // loadPinned 内部失败时已提示过，这里只补一个成功反馈
      if (results[0]) wx.showToast({ title: '已刷新', icon: 'none', duration: 800 })
    } finally {
      this.refreshing = false
    }
  },

  onCategoryTap(e) {
    const type = e.currentTarget.dataset.type
    wx.navigateTo({ url: `/pages/list/list?type=${type}` })
  },

  onItemTap(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` })
  },

  /**
   * 轮播图点击：只有配置了「跳转到分类」才响应，其余情况静默
   * linkId 是信息大类（house / secondhand / offer），直接进对应分类列表
   */
  /**
   * 轮播图点击：按管理台配的「点击行为」分三路
   *   none → 放大预览（可左右滑看全部轮播图）
   *   list → 跳对应大类列表
   *   page → 跳站内页面，路径由管理台「复制路径」得到
   * 前台不加任何提示，用户点下去才知道是哪种 —— 这是既定交互。
   */
  onBannerTap(e) {
    const item = this.data.banners[Number(e.currentTarget.dataset.index)]
    if (!item) return

    if (!item.linkType || item.linkType === 'none') {
      if (!item.image) return
      wx.previewImage({
        current: item.image,
        urls: this.data.banners.map(b => b.image).filter(Boolean)
      })
      return
    }

    if (item.linkType === 'list' && item.linkId) {
      wx.navigateTo({ url: `/pages/list/list?type=${item.linkId}` })
      return
    }

    if (item.linkType === 'page' && item.linkValue) {
      const path = String(item.linkValue)
      // 服务端已校验过白名单，这里再挡一次，避免脏数据把用户带到不存在的页面
      if (path.indexOf('/pages/') !== 0) return

      // 「关于」是 tabBar 页，只能用 switchTab，navigateTo 会直接失败
      if (path.split('?')[0] === '/pages/about/about') {
        wx.switchTab({ url: '/pages/about/about' })
        return
      }

      wx.navigateTo({
        url: path,
        fail: () => wx.showToast({ title: '页面不存在或已下架', icon: 'none' })
      })
    }
  },

  // ---------------- 隐藏管理入口：长按品牌名（系统默认长按时长） ----------------

  /** 轻震动：部分机型 / 旧基础库不支持，失败不能影响后续跳转 */
  vibrate() {
    try {
      if (wx.vibrateShort) wx.vibrateShort({ type: 'light', fail: () => {} })
    } catch (err) {}
  },

  /** 长按品牌名：轻震动 + 进管理后台（普通用户进入后会被身份校验拦截） */
  enterAdmin() {
    this.vibrate()

    // 跳转失败时兜底用 redirectTo（页面栈满 10 层时 navigateTo 会失败）
    wx.navigateTo({
      url: '/packageAdmin/manage/manage',
      fail: err => {
        console.error('[index] enterAdmin navigateTo failed', err)
        wx.redirectTo({
          url: '/packageAdmin/manage/manage',
          fail: e2 => {
            console.error('[index] enterAdmin redirectTo failed', e2)
            wx.showToast({ title: '打开管理页失败', icon: 'none' })
          }
        })
      }
    })
  },

  onShareAppMessage() {
    return {
      title: '三品信息：房源、闲置、生活信息',
      path: '/pages/index/index'
    }
  }
})
