// packageAdmin/banners/banners.js
// 首页轮播图管理：上传 / 启停 / 排序 / 跳转配置 / 删除
//
// 数据落在 banners 集合，读写都走 adminAction：
//   bannerList（公开读取，管理端带 all:true 看全部）
//   bannerSave / bannerRemove（需管理员）
const cloud = require('../../utils/cloud')

const LINK_OPTIONS = [
  { key: 'none', label: '不跳转' },
  { key: 'house', label: '跳转到「房源租售」' },
  { key: 'secondhand', label: '跳转到「二手闲置」' },
  { key: 'offer', label: '跳转到「生活信息」' }
]

Page({
  data: {
    checking: true,
    authed: false,
    openid: '',
    loading: true,
    busy: false,
    list: [],
    linkLabels: LINK_OPTIONS.map(o => o.label)
  },

  onLoad() {
    this.loadList()
  },

  /**
   * 一次调用同时拿「身份 + 列表」
   * bannerList 已带回 isAdmin / openid，不再单独调 check，
   * 每进一次页面省 1 次云函数调用
   */
  async loadList() {
    this.setData({ loading: true })
    try {
      const res =
        (await cloud.callFunction(
          'adminAction',
          { action: 'bannerList', all: true },
          { force: true }
        )) || {}

      const isAdmin = !!res.isAdmin
      this.setData({
        checking: false,
        authed: isAdmin,
        openid: res.openid || '',
        list: isAdmin ? this.decorate(res.list) : [],
        loading: false
      })
    } catch (err) {
      console.error('[banners] loadList failed', err)
      this.setData({ checking: false, authed: false, loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  /** 把 linkType/linkId 映射成 picker 的下标 */
  decorate(rawList) {
    return (rawList || []).map(item => {
      let linkIndex = 0
      if (item.linkType === 'list') {
        const i = LINK_OPTIONS.findIndex(o => o.key === item.linkId)
        linkIndex = i > 0 ? i : 0
      }
      return Object.assign({}, item, { linkIndex })
    })
  },

  /** 写操作已回带最新列表，直接渲染，不再多调一次 bannerList */
  applyList(list) {
    if (Array.isArray(list)) this.setData({ list: this.decorate(list) })
  },

  /** 选图 → 上传云存储 → 写入 banners（默认启用、不跳转，排到最后） */
  async onAdd() {
    if (this.data.busy) return

    let file = null
    try {
      const res = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sizeType: ['compressed'],
        sourceType: ['album', 'camera']
      })
      file = res.tempFiles && res.tempFiles[0]
    } catch (err) {
      // 用户取消选择，静默返回
      return
    }
    if (!file) return

    this.setData({ busy: true })
    wx.showLoading({ title: '上传中…', mask: true })

    try {
      const suffix = (file.tempFilePath.split('.').pop() || 'jpg').toLowerCase()
      const cloudPath = `banners/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${suffix}`
      const up = await wx.cloud.uploadFile({ cloudPath, filePath: file.tempFilePath })

      const save =
        (await cloud.callFunction(
          'adminAction',
          {
            action: 'bannerSave',
            image: up.fileID,
            linkType: 'none',
            linkId: '',
            sort: this.data.list.length,
            enabled: true
          },
          { force: true }
        )) || {}

      wx.hideLoading()

      if (save.code === 0) {
        cloud.clearCache('banners:')
        this.applyList(save.list)
        wx.showToast({ title: '已添加', icon: 'success' })
      } else {
        wx.showToast({ title: save.msg || '添加失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('[banners] add failed', err)
      wx.showToast({ title: '上传失败，请重试', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  /** 统一保存：以现有记录为底，覆盖 patch 里的字段 */
  async save(item, patch) {
    const payload = Object.assign(
      {
        action: 'bannerSave',
        id: item._id,
        image: item.image,
        linkType: item.linkType,
        linkId: item.linkId,
        sort: item.sort,
        enabled: item.enabled
      },
      patch
    )

    try {
      const res = (await cloud.callFunction('adminAction', payload, { force: true })) || {}
      if (res.code === 0) {
        cloud.clearCache('banners:')
        this.applyList(res.list)
        return true
      }
      wx.showToast({ title: res.msg || '操作失败', icon: 'none' })
      return false
    } catch (err) {
      console.error('[banners] save failed', err)
      wx.showToast({ title: '操作失败', icon: 'none' })
      return false
    }
  },

  onLinkChange(e) {
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.list[index]
    const opt = LINK_OPTIONS[Number(e.detail.value)]
    if (!item || !opt) return

    this.save(item, {
      linkType: opt.key === 'none' ? 'none' : 'list',
      linkId: opt.key === 'none' ? '' : opt.key
    })
  },

  onToggle(e) {
    const item = this.data.list[Number(e.currentTarget.dataset.index)]
    if (!item) return
    this.save(item, { enabled: !item.enabled })
  },

  /** 上移 / 下移：交换两条的 sort，序号相同时按位置重新赋值 */
  async onMove(e) {
    const index = Number(e.currentTarget.dataset.index)
    const dir = Number(e.currentTarget.dataset.dir)
    const target = index + dir
    const list = this.data.list

    if (target < 0 || target >= list.length) return

    const a = list[index]
    const b = list[target]

    let sortA = b.sort
    let sortB = a.sort
    if (sortA === sortB) {
      sortA = index
      sortB = target
    }

    const okA = await this.save(a, { sort: sortA })
    if (okA) await this.save(b, { sort: sortB })
  },

  onRemove(e) {
    const item = this.data.list[Number(e.currentTarget.dataset.index)]
    if (!item) return

    wx.showModal({
      title: '删除轮播图',
      content: '删除后首页不再展示这张图，确定删除？',
      confirmText: '删除',
      confirmColor: '#e34d59',
      success: async res => {
        if (!res.confirm) return
        try {
          const ret =
            (await cloud.callFunction(
              'adminAction',
              { action: 'bannerRemove', id: item._id },
              { force: true }
            )) || {}

          if (ret.code === 0) {
            cloud.clearCache('banners:')
            this.applyList(ret.list)
            wx.showToast({ title: '已删除', icon: 'success' })
          } else {
            wx.showToast({ title: ret.msg || '删除失败', icon: 'none' })
          }
        } catch (err) {
          console.error('[banners] remove failed', err)
          wx.showToast({ title: '删除失败', icon: 'none' })
        }
      }
    })
  },

  onPreview(e) {
    const item = this.data.list[Number(e.currentTarget.dataset.index)]
    if (!item) return
    wx.previewImage({ current: item.image, urls: [item.image] })
  }
})
