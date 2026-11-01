// packageAdmin/banners/banners.js
// 首页轮播图管理：上传 / 启停 / 排序 / 点击行为配置 / 删除
//
// 数据落在 banners 集合，读写都走 adminAction：
//   bannerList（公开读取，管理端带 all:true 看全部）
//   bannerSave / bannerRemove（需管理员）
//
// 点击行为（linkType）三种：
//   none → 前台点击放大预览
//   list → 跳分类列表（linkId 存 house / secondhand / offer）
//   page → 跳站内页面（linkValue 存 /pages/xxx 路径，由管理台「复制路径」得到）
const cloud = require('../../utils/cloud')

const LINK_OPTIONS = [
  { key: 'none', label: '不跳转（点击放大）', hit: '点击可放大' },
  { key: 'house', label: '跳转到「房源租售」', hit: '点击跳转 · 房源' },
  { key: 'secondhand', label: '跳转到「二手闲置」', hit: '点击跳转 · 二手' },
  { key: 'offer', label: '跳转到「生活信息」', hit: '点击跳转 · 生活' },
  { key: 'page', label: '站内页面（粘贴路径）', hit: '点击跳转 · 站内页面' }
]

// 站内路径格式：与云函数 normalizePagePath 的前端侧保持一致的宽松校验
const PAGE_PATH_RE = /^\/pages\/[A-Za-z0-9\-_/]+(\?[A-Za-z0-9\-_=&%.]*)?$/

Page({
  data: {
    checking: true,
    authed: false,
    openid: '',
    loading: true,
    busy: false,
    list: [],
    linkLabels: LINK_OPTIONS.map(o => o.label),

    // 站内路径编辑弹窗
    editShow: false,
    editIndex: 0,
    editValue: '',
    editTip: ''
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

  /** 把 linkType/link 映射成 picker 下标 + 卡片上要显示的角标文案 */
  decorate(rawList) {
    return (rawList || []).map(item => {
      let linkIndex = 0
      if (item.linkType === 'list') {
        const i = LINK_OPTIONS.findIndex(o => o.key === item.linkId)
        linkIndex = i > 0 ? i : 0
      } else if (item.linkType === 'page') {
        const i = LINK_OPTIONS.findIndex(o => o.key === 'page')
        linkIndex = i > 0 ? i : 0
      }

      const opt = LINK_OPTIONS[linkIndex] || LINK_OPTIONS[0]
      const jumping = item.linkType === 'list' || item.linkType === 'page'

      return Object.assign({}, item, {
        linkIndex,
        // 角标：一眼看出这张图点下去是放大还是跳转
        hitText: opt.hit,
        jumping
      })
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
            linkValue: '',
            sort: this.data.list.length,
            enabled: true
          },
          { force: true }
        )) || {}

      wx.hideLoading()

      if (save.code === 0) {
        // 首页走 homeMeta 合并缓存，改完轮播图要把这块一起清掉
        cloud.clearCache('banners:')
        cloud.clearCache('home:')
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
        linkId: item.linkId || '',
        linkValue: item.linkValue || '',
        sort: item.sort,
        enabled: item.enabled
      },
      patch
    )

    try {
      const res = (await cloud.callFunction('adminAction', payload, { force: true })) || {}
      if (res.code === 0) {
        cloud.clearCache('banners:')
        cloud.clearCache('home:')
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

    // 站内页面要先填路径，弹编辑框，确定后才真正写库
    if (opt.key === 'page') {
      this.openEdit(index)
      return
    }

    this.save(item, {
      linkType: opt.key === 'none' ? 'none' : 'list',
      linkId: opt.key === 'none' ? '' : opt.key,
      linkValue: ''
    })
  },

  /* ---------------- 站内路径编辑弹窗 ---------------- */

  openEdit(index) {
    const item = this.data.list[index]
    if (!item) return
    this.setData({
      editShow: true,
      editIndex: index,
      editValue: item.linkValue || '',
      editTip: '在「信息管理」里点某条信息的「复制路径」，回到这里点「粘贴」即可'
    })
  },

  /** 已配好路径的卡片上直接点「改路径」 */
  onEditPath(e) {
    this.openEdit(Number(e.currentTarget.dataset.index))
  },

  onEditInput(e) {
    this.setData({ editValue: e.detail.value, editTip: '' })
  },

  /** 读取剪贴板：从信息管理页复制过来的路径，一键粘进来 */
  onEditPaste() {
    wx.getClipboardData({
      success: res => {
        const v = String(res.data || '').trim()
        if (!v) {
          this.setData({ editTip: '剪贴板是空的' })
          return
        }
        this.setData({ editValue: v, editTip: '已粘贴，确认无误后点「确定」' })
      },
      fail: () => {
        this.setData({ editTip: '读取剪贴板失败，可长按输入框手动粘贴' })
      }
    })
  },

  onEditCancel() {
    this.setData({ editShow: false })
    // picker 已经切到「站内页面」但没写库，重绘一次让显示回到真实值
    this.setData({ list: this.decorate(this.data.list) })
  },

  async onEditConfirm() {
    const raw = String(this.data.editValue || '').trim()

    if (!raw) {
      this.setData({ editTip: '请填写路径，或点「粘贴」从信息管理页取' })
      return
    }
    if (!PAGE_PATH_RE.test(raw)) {
      this.setData({ editTip: '路径需以 /pages/ 开头，例如 /pages/detail/detail?id=xxx' })
      return
    }

    const item = this.data.list[this.data.editIndex]
    if (!item) {
      this.setData({ editShow: false })
      return
    }

    this.setData({ editShow: false })
    const ok = await this.save(item, { linkType: 'page', linkId: '', linkValue: raw })
    if (!ok) wx.showToast({ title: '保存失败，请重试', icon: 'none' })
  },

  onNoop() {},

  /* ---------------- 其它操作 ---------------- */

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
            cloud.clearCache('home:')
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

  /**
   * 点图片：不跳转的图直接放大；设了跳转的图不放大，避免和真实点击行为不一致
   * （想无条件看大图用操作区的「预览」）
   */
  onThumbTap(e) {
    const item = this.data.list[Number(e.currentTarget.dataset.index)]
    if (!item) return

    if (!item.jumping) {
      this.preview(item)
      return
    }
    wx.showToast({ title: '该图点击会跳转，不放大', icon: 'none' })
  },

  onPreview(e) {
    const item = this.data.list[Number(e.currentTarget.dataset.index)]
    if (item) this.preview(item)
  },

  preview(item) {
    const urls = this.data.list.map(x => x.image).filter(Boolean)
    wx.previewImage({ current: item.image, urls: urls.length ? urls : [item.image] })
  }
})
