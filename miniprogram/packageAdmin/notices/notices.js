// packageAdmin/notices/notices.js
// 首页公告管理：新增 / 编辑 / 排序 / 启停 / 删除
//
// 数据落在 notices 集合，读写都走 adminAction：
//   noticeList（公开读取，管理端带 all:true 看全部）
//   noticeSave / noticeRemove（需管理员）
//
// 首页展示形态见 pages/index：一条播完接下一条，按 sort 升序循环。
const cloud = require('../../utils/cloud')

Page({
  data: {
    checking: true,
    authed: false,
    openid: '',
    loading: true,
    busy: false,
    list: []
  },

  onLoad() {
    this.loadList()
  },

  /**
   * 一次调用同时拿「身份 + 列表」
   * noticeList 已带回 isAdmin / openid，不再单独调 check，
   * 每进一次页面省 1 次云函数调用（非管理员同样能拿到自己的 openid 用于配白名单）
   */
  async loadList() {
    this.setData({ loading: true })
    try {
      const res =
        (await cloud.callFunction(
          'adminAction',
          { action: 'noticeList', all: true },
          { force: true }
        )) || {}

      const isAdmin = !!res.isAdmin
      this.setData({
        checking: false,
        authed: isAdmin,
        openid: res.openid || '',
        list: isAdmin ? res.list || [] : [],
        loading: false
      })
    } catch (err) {
      console.error('[notices] loadList failed', err)
      this.setData({ checking: false, authed: false, loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  /** 写操作已回带最新列表，直接渲染，不再多调一次 noticeList */
  applyList(list) {
    if (Array.isArray(list)) this.setData({ list })
  },

  /** 弹一个可输入的对话框：新增与编辑共用 */
  openEditor(options) {
    return new Promise(resolve => {
      wx.showModal({
        title: options.title,
        editable: true,
        placeholderText: '一句话说清，建议 30 字以内',
        content: options.content || '',
        confirmText: '保存',
        success: res => resolve(res),
        fail: () => resolve({ confirm: false })
      })
    })
  },

  async onAdd() {
    if (this.data.busy) return

    const res = await this.openEditor({ title: '新增公告', content: '' })
    if (!res.confirm) return

    const content = String(res.content || '').trim()
    if (!content) {
      wx.showToast({ title: '公告内容不能为空', icon: 'none' })
      return
    }

    this.setData({ busy: true })
    try {
      const ret =
        (await cloud.callFunction(
          'adminAction',
          { action: 'noticeSave', content, sort: this.data.list.length, enabled: true },
          { force: true }
        )) || {}

      if (ret.code === 0) {
        cloud.clearCache('notices:')
        this.applyList(ret.list)
        wx.showToast({ title: '已添加', icon: 'success' })
      } else {
        wx.showToast({ title: ret.msg || '添加失败', icon: 'none' })
      }
    } catch (err) {
      console.error('[notices] add failed', err)
      wx.showToast({ title: '添加失败', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },

  async onEdit(e) {
    if (this.data.busy) return

    const item = this.data.list[Number(e.currentTarget.dataset.index)]
    if (!item) return

    const res = await this.openEditor({ title: '编辑公告', content: item.content })
    if (!res.confirm) return

    const content = String(res.content || '').trim()
    if (!content) {
      wx.showToast({ title: '公告内容不能为空', icon: 'none' })
      return
    }
    if (content === item.content) return

    await this.save(item, { content })
  },

  /** 统一保存：以现有记录为底，覆盖 patch 里的字段 */
  async save(item, patch) {
    this.setData({ busy: true })
    const payload = Object.assign(
      {
        action: 'noticeSave',
        id: item._id,
        content: item.content,
        sort: item.sort,
        enabled: item.enabled
      },
      patch
    )

    try {
      const res = (await cloud.callFunction('adminAction', payload, { force: true })) || {}
      if (res.code === 0) {
        cloud.clearCache('notices:')
        this.applyList(res.list)
        return true
      }
      wx.showToast({ title: res.msg || '操作失败', icon: 'none' })
      return false
    } catch (err) {
      console.error('[notices] save failed', err)
      wx.showToast({ title: '操作失败', icon: 'none' })
      return false
    } finally {
      this.setData({ busy: false })
    }
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
      title: '删除公告',
      content: '删除后首页公告栏不再播放这条内容，确定删除？',
      confirmText: '删除',
      confirmColor: '#e34d59',
      success: async res => {
        if (!res.confirm) return
        try {
          const ret =
            (await cloud.callFunction(
              'adminAction',
              { action: 'noticeRemove', id: item._id },
              { force: true }
            )) || {}

          if (ret.code === 0) {
            cloud.clearCache('notices:')
            this.applyList(ret.list)
            wx.showToast({ title: '已删除', icon: 'success' })
          } else {
            wx.showToast({ title: ret.msg || '删除失败', icon: 'none' })
          }
        } catch (err) {
          console.error('[notices] remove failed', err)
          wx.showToast({ title: '删除失败', icon: 'none' })
        }
      }
    })
  }
})
