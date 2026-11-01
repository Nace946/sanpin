// pages/list/list.js
const util = require('../../utils/util')
const infoQuery = require('../../utils/infoQuery')

const PAGE_SIZE = 10

Page({
  data: {
    type: 'all',
    keyword: '',
    autoFocus: false,
    segs: [],
    tabs: [],
    activeTab: '',
    list: [],
    page: 1,
    size: PAGE_SIZE,
    loading: false,
    hasMore: true
  },

  onLoad(options) {
    const type = options.type || 'all'
    const autoFocus = options.focus === '1'
    const segs = this.buildSegs(type)
    const tabs = this.buildTabs(type)

    // 生活信息允许从外部指定分类：详情页分享后被「返回列表」打开，或带 tab 的小程序码。
    // 只认 tabs 里存在的 key，避免手改 url 传进无效值导致列表空
    let activeTab = segs.length ? segs[0].key : ''
    const tab = options.tab || ''
    if (type === 'offer' && tab && tabs.some(t => t.key === tab)) activeTab = tab

    this.setData({ type, autoFocus, segs, tabs, activeTab })
    wx.setNavigationBarTitle({ title: this.typeTitle(type) })
    this.load(true)

    // 分享卡片落地链的第二环：首页 → 本页 → 详情。
    // 本页照常 load(true)，数据在详情页盖住时异步回来，
    // 用户侧滑回列表时看到的就是完整内容（不是空白再加载）。
    if (options.open) {
      let url = `/pages/detail/detail?id=${options.open}&type=${type}`
      if (type === 'offer' && activeTab) url += `&tab=${activeTab}`
      wx.navigateTo({ url })
    }
  },

  onReachBottom() {
    if (this.data.loading || !this.data.hasMore) return
    this.setData({ page: this.data.page + 1 })
    this.load(false)
  },

  /** 房源/二手：搜索框上方的分段切换（招租·求租 / 出售·求购），省掉一行筛选 */
  buildSegs(type) {
    if (type === 'house') {
      return [
        { key: 'rent_out', label: '招租' },
        { key: 'rent_in', label: '求租' }
      ]
    }
    if (type === 'secondhand') {
      return [
        { key: 'sell', label: '出售' },
        { key: 'buy', label: '求购' }
      ]
    }
    return []
  },

  /** 根据信息类型生成二级 Tab */
  buildTabs(type) {
    // 房源 / 二手改用上方 seg 切换，不再需要二级 Tab
    if (type === 'house' || type === 'secondhand') return []

    if (type === 'offer') {
      // 生活信息的分类：十个，排两行（5 + 5），每项带一个线性图标。
      // icon 只决定 wxss 里用哪张背景图，筛选逻辑仍然只看 key
      return [
        { key: '', label: '全部', icon: 'all' },
        { key: 'food', label: '餐饮', icon: 'food' },
        { key: 'market', label: '超市', icon: 'market' },
        { key: 'entertainment', label: '娱乐', icon: 'fun' },
        { key: 'friend', label: '交友', icon: 'friend' },
        // 寻物：原「失物招领」，内部值仍是 lostfound
        { key: 'lostfound', label: '寻物', icon: 'lost' },
        { key: 'missing', label: '寻人', icon: 'missing' },
        { key: 'travel', label: '出行', icon: 'travel' },
        { key: 'nearby', label: '周边', icon: 'nearby' },
        { key: 'other', label: '其他', icon: 'other' }
      ]
    }
    // all：Tab 用于切换信息大类
    return [
      { key: 'all', label: '全部' },
      { key: 'house', label: '房源' },
      { key: 'secondhand', label: '二手' },
      { key: 'offer', label: '生活' }
    ]
  },

  typeTitle(type) {
    return util.TYPE_LABEL[type] || '全部信息'
  },

  async load(reset) {
    if (this.data.loading) return

    const { type, activeTab, keyword } = this.data
    const page = reset ? 1 : this.data.page

    const params = { page, size: this.data.size }
    if (type !== 'all') params.type = type
    if (type !== 'all' && activeTab) params.sub = activeTab
    if (keyword.trim()) params.keyword = keyword.trim()

    this.setData({ loading: true })

    try {
      // 1 小时内同条件直接读本机缓存（含冷启动），不重复消耗调用次数
      const result = await infoQuery.fetchList(params)
      const rawList = (result && result.list) || []
      const decorated = rawList.map(util.decorateItem).filter(item => !item.isExpired)

      this.setData({
        list: reset ? decorated : this.data.list.concat(decorated),
        hasMore: rawList.length >= this.data.size,
        loading: false
      })
    } catch (err) {
      console.error('[list] load failed', err)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败，请稍后重试', icon: 'none' })
    }

    // 加载过程中外部要求切筛选（详情页返回），这次结束后补上
    if (this._pendingFilter) {
      const pending = this._pendingFilter
      this._pendingFilter = null
      this.applyFilter(pending)
    }
  },

  onTabTap(e) {
    const key = e.currentTarget.dataset.key

    if (this.data.type === 'all') {
      // all 模式下 Tab 切换的是信息大类
      const nextType = key
      const segs = this.buildSegs(nextType)
      this.setData({
        type: nextType,
        segs,
        tabs: this.buildTabs(nextType),
        activeTab: segs.length ? segs[0].key : '',
        list: [],
        page: 1,
        hasMore: true
      })
      wx.setNavigationBarTitle({ title: this.typeTitle(nextType) })
      this.load(true)
      return
    }

    if (key === this.data.activeTab) return
    this.setData({ activeTab: key, list: [], page: 1, hasMore: true })
    this.load(true)
  },

  /**
   * 从页面外指定筛选条件（详情页底部「返回「xx」列表」用）。
   *
   * 为什么不 reLaunch 重建列表页：那样会把整个页面栈清成一层，
   * 用户返回首页后就没法再侧滑回去了。就地切 setData 不改变栈，
   * 也不会白屏闪一下。
   */
  applyFilter(target) {
    const t = target || {}
    let nextType = t.type || this.data.type
    let nextTab = t.tab || ''

    // 正在加载时先记下来，等这次 load 收尾再切 —— 否则会被 load 里的 loading 守卫直接吞掉
    if (this.data.loading) {
      this._pendingFilter = { type: nextType, tab: nextTab }
      return
    }

    // 混合列表（type=all）里选的是信息大类，转成 type 处理
    if (this.data.type === 'all' && nextType === 'all' && nextTab) {
      nextType = nextTab
      nextTab = ''
    }

    const tabs = this.buildTabs(nextType)
    if (nextTab && !tabs.some(x => x.key === nextTab)) nextTab = ''

    if (nextType !== this.data.type) {
      const segs = this.buildSegs(nextType)
      let activeTab = segs.length ? segs[0].key : ''
      if (nextType === 'offer' && nextTab) activeTab = nextTab
      this.setData({ type: nextType, segs, tabs, activeTab, list: [], page: 1, hasMore: true })
      wx.setNavigationBarTitle({ title: this.typeTitle(nextType) })
      this.load(true)
      return
    }

    // 大类没变，只切二级分类；房源 / 二手的 seg 由页面自己管，不接受外部 tab
    if (!this.data.tabs.length) return
    if (nextTab === this.data.activeTab) return
    this.setData({ activeTab: nextTab, list: [], page: 1, hasMore: true })
    this.load(true)
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value })
  },

  onSearch() {
    this.setData({ list: [], page: 1, hasMore: true })
    this.load(true)
  },

  onClearKeyword() {
    this.setData({ keyword: '', list: [], page: 1, hasMore: true })
    this.load(true)
  },

  onItemTap(e) {
    const id = e.currentTarget.dataset.id
    // 按当前筛选条件拼参数：详情页分享时会把它们写进 path，
    // 接收方打开后「返回列表」才能落回同一个分类，而不是首页
    const { type, activeTab } = this.data
    let url = `/pages/detail/detail?id=${id}`
    if (type) url += `&type=${type}`
    if (type === 'offer' && activeTab) url += `&tab=${activeTab}`
    wx.navigateTo({ url })
  }
})
