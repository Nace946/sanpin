// pages/detail/detail.js
const util = require('../../utils/util')
const cloud = require('../../utils/cloud')
const config = require('../../utils/config')

Page({
  data: {
    loading: true,
    info: null,
    expired: false,
    extFields: [],
    imgIndex: 0,
    // 详细说明折叠：needFold 表示内容够长、需要「展开全文」按钮；folded 表示当前处于收起状态
    needFold: false,
    folded: true
  },

  onLoad(options) {
    this.infoId = options.id || ''
    if (!this.infoId) {
      this.setData({ loading: false })
      return
    }
    this.loadDetail()
  },

  async loadDetail() {
    try {
      // 详情缓存 DETAIL_CACHE_TTL（默认 10 分钟）：
      // 命中缓存时不请求云函数 → 浏览量不会自增，同一设备反复进出也刷不了数。
      // 缓存存的是云函数原始返回，展示层的改动不受影响。
      const result =
        (await cloud.callFunction('infoDetail', { id: this.infoId }, {
          cacheKey: `detail:v2:${this.infoId}`,
          ttl: config.DETAIL_CACHE_TTL
        })) || {}

      if (!result.data) {
        this.setData({ loading: false, info: null })
        return
      }

      const info = util.decorateItem(result.data)
      info.images = result.data.images || []
      info.content = result.data.content || ''
      info.contact = result.data.contact || {}
      info.views = result.data.views || 0
      info.ext = result.data.ext || {}

      // 优惠类：判断是否已过期
      let expired = false
      if (info.type === 'offer' && info.ext.expireAt) {
        expired = new Date(info.ext.expireAt).getTime() < Date.now()
      }

      this.setData({
        loading: false,
        info,
        expired,
        extFields: this.buildExtFields(info),
        needFold: this.needFold(info.content),
        folded: true
      })

      wx.setNavigationBarTitle({ title: info.typeLabel || '详情' })
    } catch (err) {
      console.error('[detail] loadDetail failed', err)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败，请稍后重试', icon: 'none' })
    }
  },

  /**
   * 详细说明是否需要折叠：默认只露 6 行（32rpx 字号下约 160 字）。
   * 换行多的短文本也会把卡片撑很高，所以行数也算一个判据。
   */
  needFold(content) {
    const text = content || ''
    if (text.length > 160) return true
    return text.split('\n').length > 7
  },

  onToggleFold() {
    this.setData({ folded: !this.data.folded })
  },

  /** 按信息类型生成扩展字段展示 */
  buildExtFields(info) {
    const ext = info.ext || {}
    const fields = []

    if (info.type === 'house') {
      if (ext.dealType) fields.push({ label: '信息类型', value: util.SUB_LABEL[ext.dealType] || '' })
      // 无中介是招租下的一个属性，单独一行展示
      if (ext.dealType === 'rent_out' && ext.noAgency) fields.push({ label: '中介情况', value: '无中介（房东直租）' })
      if (ext.district) fields.push({ label: '所在区域', value: ext.district })
      if (ext.community) fields.push({ label: '小区 / 位置', value: ext.community })
      if (ext.layout) fields.push({ label: '户型', value: ext.layout })
      if (ext.area) fields.push({ label: '面积', value: ext.area + ' ㎡' })
      if (ext.floor) fields.push({ label: '楼层', value: ext.floor })
      if (ext.rent) fields.push({ label: '租金', value: '¥' + util.formatPrice(ext.rent) + ' / 月' })
    } else if (info.type === 'secondhand') {
      if (ext.dealType) fields.push({ label: '信息类型', value: util.SUB_LABEL[ext.dealType] || '' })
      if (ext.category) fields.push({ label: '物品分类', value: ext.category })
      if (ext.condition) fields.push({ label: '成色', value: ext.condition })
      if (ext.price) fields.push({ label: '价格', value: '¥' + util.formatPrice(ext.price) })
    } else if (info.type === 'offer') {
      // 生活信息里的失物招领：属性换成物品/地点/时间/酬谢，不显示商家那套
      if (ext.industry === 'lostfound') {
        if (ext.lfType) fields.push({ label: '信息类型', value: util.SUB_LABEL[ext.lfType] || '' })
        if (ext.itemName) fields.push({ label: '物品', value: ext.itemName })
        if (ext.address) fields.push({ label: '地点', value: ext.address })
        if (ext.happenAt) fields.push({ label: '时间', value: util.formatDate(ext.happenAt) })
        if (ext.reward) fields.push({ label: '酬谢', value: ext.reward })
      } else {
        if (ext.merchantName) fields.push({ label: '商家 / 发布方', value: ext.merchantName })
        if (ext.industry) fields.push({ label: '行业', value: util.INDUSTRY_LABEL[ext.industry] || '' })
        if (ext.address) fields.push({ label: '商家地址', value: ext.address })
        if (ext.startAt) fields.push({ label: '开始日期', value: util.formatDate(ext.startAt) })
        if (ext.expireAt) fields.push({ label: '截止日期', value: util.formatDate(ext.expireAt) })
      }
    }

    return fields.filter(f => f.value !== '' && f.value !== null && f.value !== undefined)
  },

  onSwiperChange(e) {
    this.setData({ imgIndex: e.detail.current || 0 })
  },

  onPreview(e) {
    const index = Number(e.currentTarget.dataset.index) || 0
    const urls = this.data.info.images || []
    if (!urls.length) return
    wx.previewImage({ current: urls[index], urls })
  },

  /**
   * 图片加载失败打点
   * 云存储图片由「当前访问者」的身份去 CDN 取，取不到时只裂图不裂文字，
   * 把 src 与错误信息打到控制台，真机调试就能直接看出是 403（权限）还是 404（文件/环境不对）
   */
  onImgError(e) {
    console.error('[detail] 图片加载失败', {
      src: (e.currentTarget.dataset && e.currentTarget.dataset.src) || '',
      detail: e.detail
    })
  },

  onCopyPhone() {
    const phone = (this.data.info.contact || {}).phone
    if (!phone) return
    wx.setClipboardData({
      data: phone,
      success: () => wx.showToast({ title: '号码已复制', icon: 'none' })
    })
  },

  onCallPhone() {
    const phone = (this.data.info.contact || {}).phone
    if (!phone) return
    wx.makePhoneCall({ phoneNumber: phone }).catch(() => {})
  },

  onGoAbout() {
    // 关于页已是 tabBar 页面（微信）。tabBar 页面只能用 switchTab 跳转，
    // 且 url 不允许带参数（官方文档：wx.switchTab 的 url 路径后不能带参数）
    wx.switchTab({ url: '/pages/about/about' })
  },

  onBackHome() {
    wx.reLaunch({ url: '/pages/index/index' })
  },

  onShareAppMessage() {
    const info = this.data.info
    return {
      title: info ? info.title : '三品信息',
      path: `/pages/detail/detail?id=${this.infoId}`
    }
  }
})
