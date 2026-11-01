// packageAdmin/manage/manage.js
const util = require('../../utils/util')
const cloud = require('../../utils/cloud')
const { TEMPLATES, parseDraft } = require('../utils/importParser')

const STATUS_LABEL = {
  published: '已发布',
  offline: '已下架',
  expired: '已过期',
  deleted: '已删除'
}

const PAGE_SIZE = 10

Page({
  data: {
    checking: true,
    authed: false,
    openid: '',

    stats: {
      byType: { house: 0, secondhand: 0, offer: 0 },
      byStatus: { published: 0, offline: 0, expired: 0, deleted: 0 },
      totalViews: 0,
      total: 0,
      testCount: 0
    },

    typeTabs: [
      { key: 'all', label: '全部' },
      { key: 'house', label: '房源' },
      { key: 'secondhand', label: '二手' },
      { key: 'offer', label: '生活' }
    ],
    activeType: 'all',

    statusTabs: [
      { key: 'all', label: '全部状态' },
      { key: 'published', label: '已发布' },
      { key: 'offline', label: '已下架' },
      { key: 'expired', label: '已过期' },
      { key: 'deleted', label: '已删除' }
    ],
    activeStatus: 'all',

    keyword: '',
    list: [],
    page: 1,
    size: PAGE_SIZE,
    loading: false,
    hasMore: true,
    seeding: false,

    // 一键导入
    importShow: false,
    importType: 'house',
    importTemplate: TEMPLATES.house,
    importTypes: [
      { key: 'house', label: '房源' },
      { key: 'secondhand', label: '二手' },
      { key: 'offer', label: '生活' }
    ]
  },

  onLoad() {
    this.bootstrap()
  },

  onShow() {
    // 首次进入由 onLoad 统一拉取，这里只决定「回来时要不要重拉」。
    // bootstrap 会连带跑一次聚合统计（1 次调用 + 3 次数据库查询），所以按两条规则节流：
    //   1) 发布/编辑页确实改过数据（globalData.adminListDirty）→ 立即重拉
    //   2) 距上次拉取超过 60 秒（去看了公告页、微信切后台很久）→ 重拉
    // 其余情况（来回切子页面、快速切后台）直接跳过，省掉一次云函数调用
    if (!this.inited) return

    const g = getApp().globalData || {}
    const dirty = !!g.adminListDirty
    const stale = Date.now() - (this.lastLoadAt || 0) > 60000
    if (!dirty && !stale) return

    g.adminListDirty = false
    this.bootstrap()
  },

  onPullDownRefresh() {
    this.bootstrap(true)
  },

  onReachBottom() {
    if (this.data.loading || !this.data.hasMore) return
    this.setData({ page: this.data.page + 1 })
    this.loadList(false)
  },

  /** 列表项补齐展示字段 */
  decorate(rawList) {
    return (rawList || []).map(item => ({
      _id: item._id,
      title: item.title,
      type: item.type,
      typeLabel: util.TYPE_LABEL[item.type] || '信息',
      status: item.status,
      statusLabel: STATUS_LABEL[item.status] || item.status,
      weight: item.weight || 0,
      views: item.views || 0,
      timeText: util.formatRelative(item.createdAt)
    }))
  },

  /**
   * 一次调用拿到「身份 + 统计 + 第一页列表」
   * 原来要 3 次调用（check / stats / list），现在 1 次
   */
  async bootstrap(isRefresh) {
    if (this.data.loading) {
      if (isRefresh) wx.stopPullDownRefresh()
      return
    }
    this.setData({ loading: true })

    try {
      const result = await cloud.callFunction('adminAction', {
        action: 'bootstrap',
        type: this.data.activeType,
        status: this.data.activeStatus,
        keyword: this.data.keyword.trim(),
        page: 1,
        size: this.data.size
      }, { force: true })

      if (!result) throw new Error('empty result')

      if (!result.isAdmin) {
        this.setData({
          checking: false,
          authed: false,
          openid: result.openid || '',
          loading: false
        })
        return
      }

      const rawList = result.list || []
      this.inited = true
      this.lastLoadAt = Date.now()

      // 记下管理员身份确认时间，发布页 60 秒内可省掉一次身份校验调用
      const app = getApp()
      if (app && app.globalData) app.globalData.adminAuthAt = Date.now()

      this.setData({
        checking: false,
        authed: true,
        stats: result.stats || this.data.stats,
        list: this.decorate(rawList),
        page: 1,
        hasMore: rawList.length >= this.data.size,
        loading: false
      })
    } catch (err) {
      console.error('[manage] bootstrap failed', err)
      this.setData({ checking: false, loading: false })
      wx.showToast({ title: '加载失败，请检查云函数是否已重新部署', icon: 'none' })
    } finally {
      if (isRefresh) wx.stopPullDownRefresh()
    }
  },

  /** 复制当前 openid（换过 AppID / 云环境后需重新获取） */
  onCopyOpenid() {
    const openid = this.data.openid
    if (!openid) return
    wx.setClipboardData({
      data: openid,
      success: () => wx.showToast({ title: 'openid 已复制', icon: 'none' })
    })
  },

  /** 仅加载后续分页（第 2 页起），不再重复取统计 */
  async loadList(reset) {
    if (reset) return this.bootstrap()
    if (this.data.loading) return

    this.setData({ loading: true })

    try {
      const result = await cloud.callFunction('adminAction', {
        action: 'list',
        type: this.data.activeType,
        status: this.data.activeStatus,
        keyword: this.data.keyword.trim(),
        page: this.data.page,
        size: this.data.size
      }, { force: true })

      const rawList = (result && result.list) || []

      this.setData({
        list: this.data.list.concat(this.decorate(rawList)),
        hasMore: rawList.length >= this.data.size,
        loading: false
      })
    } catch (err) {
      console.error('[manage] loadList failed', err)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  /** 操作成功后本地更新，避免再拉一次列表（省 1~2 次调用） */
  patchStatus(id, nextStatus) {
    const list = this.data.list.slice()
    const index = list.findIndex(x => x._id === id)
    if (index < 0) return

    const prev = list[index].status
    const byStatus = Object.assign({}, this.data.stats.byStatus)
    if (byStatus[prev] !== undefined) byStatus[prev] = Math.max(0, byStatus[prev] - 1)
    if (byStatus[nextStatus] !== undefined) byStatus[nextStatus] += 1

    // 当前正按某个状态筛选时，状态变了就不该继续留在列表里
    const filtered = this.data.activeStatus !== 'all' && this.data.activeStatus !== nextStatus
    if (filtered) list.splice(index, 1)
    else {
      list[index] = Object.assign({}, list[index], {
        status: nextStatus,
        statusLabel: STATUS_LABEL[nextStatus] || nextStatus
      })
    }

    this.setData({ list, 'stats.byStatus': byStatus })
  },

  patchWeight(id, weight) {
    const list = this.data.list.slice()
    const index = list.findIndex(x => x._id === id)
    if (index < 0) return
    list[index] = Object.assign({}, list[index], { weight })
    this.setData({ list })
  },

  onTypeTap(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.activeType) return
    this.setData({ activeType: key, list: [], page: 1, hasMore: true })
    this.loadList(true)
  },

  onStatusTap(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.activeStatus) return
    this.setData({ activeStatus: key, list: [], page: 1, hasMore: true })
    this.loadList(true)
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value })
  },

  onSearch() {
    this.setData({ list: [], page: 1, hasMore: true })
    this.loadList(true)
  },

  onClearKeyword() {
    this.setData({ keyword: '', list: [], page: 1, hasMore: true })
    this.loadList(true)
  },

  onCreate() {
    wx.navigateTo({ url: '/packageAdmin/publish/publish' })
  },

  /** 轮播图管理：上传、启停、排序、跳转配置 */
  /** 公告管理（首页公告栏，原轮播图位置暂时替换） */
  onNotices() {
    wx.navigateTo({ url: '/packageAdmin/notices/notices' })
  },

  /** 轮播图管理：首页轮播位暂时换成公告栏，入口已收起，页面仍保留可后续恢复 */
  onBanners() {
    wx.navigateTo({ url: '/packageAdmin/banners/banners' })
  },

  onEdit(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/packageAdmin/publish/publish?id=${id}` })
  },

  async onSetStatus(e) {
    const { id, status } = e.currentTarget.dataset
    const actionText = status === 'published' ? '上架' : '下架'

    wx.showLoading({ title: '处理中…', mask: true })
    try {
      const res = await cloud.callFunction('adminAction', { action: 'setStatus', id, status }, { force: true })
      wx.hideLoading()
      if (res && res.code === 0) {
        wx.showToast({ title: `${actionText}成功`, icon: 'none' })
        this.patchStatus(id, status)
        cloud.clearCache('list:')
        cloud.clearCache('detail:')
      } else {
        wx.showToast({ title: (res && res.msg) || '操作失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('[manage] setStatus failed', err)
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  async onTop(e) {
    const { id, weight } = e.currentTarget.dataset
    // 首页只展示置顶（weight > 0），因此置顶做成「置顶 100 / 取消置顶 0」的开关
    const current = Number(weight || 0)
    const nextWeight = current > 0 ? 0 : 100
    const isPin = nextWeight > 0

    wx.showLoading({ title: '处理中…', mask: true })
    try {
      const res = await cloud.callFunction('adminAction', { action: 'setWeight', id, weight: nextWeight }, { force: true })
      wx.hideLoading()
      if (res && res.code === 0) {
        wx.showToast({ title: isPin ? '已置顶，首页可见' : '已取消置顶', icon: 'none' })
        this.patchWeight(id, nextWeight)
        cloud.clearCache('list:')
        cloud.clearCache('detail:')
      } else {
        wx.showToast({ title: '操作失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('[manage] setWeight failed', err)
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '确认删除',
      content: '删除后前台将不再展示，可在「已删除」中恢复。',
      confirmText: '删除',
      confirmColor: '#e34d59',
      success: async res => {
        if (!res.confirm) return
        wx.showLoading({ title: '处理中…', mask: true })
        try {
          const r = await cloud.callFunction('adminAction', { action: 'setStatus', id, status: 'deleted' }, { force: true })
          wx.hideLoading()
          if (r && r.code === 0) {
            wx.showToast({ title: '已删除', icon: 'none' })
            this.patchStatus(id, 'deleted')
            cloud.clearCache('list:')
            cloud.clearCache('detail:')
          } else {
            wx.showToast({ title: '操作失败', icon: 'none' })
          }
        } catch (err) {
          wx.hideLoading()
          console.error('[manage] delete failed', err)
          wx.showToast({ title: '操作失败', icon: 'none' })
        }
      }
    })
  },

  /** 一键写入测试数据（幂等：每次写入前先清掉上一批） */
  onSeed() {
    if (this.data.seeding) return

    wx.showModal({
      title: '写入测试数据',
      content:
        '将写入 11 条示例信息：房源 3 条、二手 2 条、生活信息 6 条（其中寻物 2 条；含 1 条已下架、1 条已过期）。写入后可随时一键清除。',
      confirmText: '写入',
      success: async res => {
        if (!res.confirm) return
        this.setData({ seeding: true })
        wx.showLoading({ title: '写入中…', mask: true })

        try {
          const result = await cloud.callFunction('adminAction', { action: 'seed' }, { force: true })
          wx.hideLoading()

          if (result && result.code === 0) {
            wx.showToast({ title: `已写入 ${result.added} 条`, icon: 'success' })
            cloud.clearCache()
            this.bootstrap()
          } else {
            wx.showToast({ title: (result && result.msg) || '写入失败', icon: 'none' })
          }
        } catch (err) {
          wx.hideLoading()
          console.error('[manage] seed failed', err)
          wx.showToast({ title: '写入失败，请确认已重新部署云函数', icon: 'none' })
        } finally {
          this.setData({ seeding: false })
        }
      }
    })
  },

  /** 清除全部测试数据（只删 isTest: true，不动真实信息） */
  onClearTest() {
    wx.showModal({
      title: '清除测试数据',
      content: '将删除全部标记为测试的信息，真实发布的信息不受影响。',
      confirmText: '清除',
      confirmColor: '#e34d59',
      success: async res => {
        if (!res.confirm) return
        wx.showLoading({ title: '处理中…', mask: true })

        try {
          const result = await cloud.callFunction('adminAction', { action: 'clearTest' }, { force: true })
          wx.hideLoading()

          if (result && result.code === 0) {
            wx.showToast({ title: `已清除 ${result.removed} 条`, icon: 'none' })
            cloud.clearCache()
            this.bootstrap()
          } else {
            wx.showToast({ title: (result && result.msg) || '清除失败', icon: 'none' })
          }
        } catch (err) {
          wx.hideLoading()
          console.error('[manage] clearTest failed', err)
          wx.showToast({ title: '清除失败', icon: 'none' })
        }
      }
    })
  },

  /**
   * 手动补跑过期清理。
   * 定时云函数 expireOffers 每天 00:00 执行，这里是「触发器没跑」（未部署、被误删、执行失败）时的兜底：
   * 走 adminAction 的 expire 动作，条件与定时任务完全一致，一次调用完成批量置为 expired。
   */
  onRunExpire() {
    wx.showModal({
      title: '清理过期信息',
      content: '将把所有已过截止时间、且仍处于「已发布」的生活信息标记为「已过期」，标记后前台列表不再展示。',
      confirmText: '清理',
      success: async res => {
        if (!res.confirm) return
        wx.showLoading({ title: '处理中…', mask: true })

        try {
          const result = await cloud.callFunction('adminAction', { action: 'expire' }, { force: true })
          wx.hideLoading()

          if (result && result.code === 0) {
            const n = result.updated || 0
            wx.showToast({
              title: n > 0 ? `已清理 ${n} 条` : '暂无需要清理的信息',
              icon: 'none'
            })
            // 有新过期才刷新：列表与统计要跟着变，前台缓存也要清掉
            if (n > 0) {
              cloud.clearCache()
              this.bootstrap()
            }
          } else {
            wx.showToast({ title: (result && result.msg) || '清理失败', icon: 'none' })
          }
        } catch (err) {
          wx.hideLoading()
          console.error('[manage] onRunExpire failed', err)
          wx.showToast({ title: '清理失败，请稍后重试', icon: 'none' })
        }
      }
    })
  },

  /* ---------------- 一键导入 ----------------
   * 流程：打开弹层 → 选类型 → 复制模板去填写 → 复制回来 → 读取剪贴板解析
   *      → 草稿放进 globalData → 跳发布页自动填表，人工核对后发布
   */

  onImport() {
    this.setData({
      importShow: true,
      importType: 'house',
      importTemplate: TEMPLATES.house
    })
  },

  onImportClose() {
    this.setData({ importShow: false })
  },

  /** 弹层内部点击不关闭 */
  onSheetTap() {},

  onImportType(e) {
    const key = e.currentTarget.dataset.key
    this.setData({
      importType: key,
      importTemplate: TEMPLATES[key] || ''
    })
  },

  onCopyTemplate() {
    wx.setClipboardData({
      data: this.data.importTemplate,
      success: () => wx.showToast({ title: '模板已复制，去填写吧', icon: 'none' })
    })
  },

  onDoImport() {
    wx.getClipboardData({
      success: res => {
        const text = (res && res.data) || ''
        if (!text.trim()) {
          wx.showToast({ title: '剪贴板是空的', icon: 'none' })
          return
        }

        const draft = parseDraft(text, this.data.importType)
        if (!draft.ok) {
          wx.showToast({ title: '没认出内容，请按模板格式填写', icon: 'none' })
          return
        }

        const app = getApp()
        if (app && app.globalData) app.globalData.importDraft = draft

        this.setData({ importShow: false })
        wx.navigateTo({ url: '/packageAdmin/publish/publish?from=import' })
      },
      fail: () => {
        wx.showToast({ title: '读取剪贴板失败', icon: 'none' })
      }
    })
  }
})
