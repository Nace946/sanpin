// packageAdmin/publish/publish.js
const cloud = require('../../utils/cloud')

// 详细说明的字数上限，wxml 的 maxlength 与计数器都读这个值（改一处即可）
const CONTENT_MAX = 2000

const TYPES = [
  { key: 'house', label: '房源' },
  { key: 'secondhand', label: '二手闲置' },
  { key: 'offer', label: '生活信息' }
]

const DEAL_MAP = {
  house: [{ key: 'rent_out', label: '招租' }, { key: 'rent_in', label: '求租' }],
  secondhand: [{ key: 'sell', label: '出售' }, { key: 'buy', label: '求购' }]
}

const INDUSTRIES = [
  { key: 'food', label: '餐饮' },
  { key: 'market', label: '超市' },
  { key: 'netbar', label: '网吧' },
  { key: 'entertainment', label: '娱乐' },
  // 失物招领放在生活信息的分类里，选中它时表单切换成失物字段
  { key: 'lostfound', label: '失物招领' },
  { key: 'other', label: '其他' }
]

// 失物招领的两种性质：寻物（我在找）/ 招领（我捡到）
const LF_OPTIONS = [
  { key: 'lost', label: '寻物（我在找）' },
  { key: 'found', label: '招领（我捡到）' }
]

/** 时间戳 -> 'YYYY-MM-DD'（北京时间），用于回填日期选择器 */
function tsToDate(ts) {
  if (!ts) return ''
  const d = new Date(new Date(ts).getTime() + 8 * 3600 * 1000)
  if (isNaN(d.getTime())) return ''
  const p = n => (n < 10 ? '0' + n : '' + n)
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

Page({
  data: {
    checking: true,
    authed: false,
    openid: '',

    type: 'house',
    typeIndex: 0,
    typeLabels: TYPES.map(t => t.label),

    dealIndex: 0,
    dealLabels: DEAL_MAP.house.map(d => d.label),

    industryIndex: 0,
    industryLabels: INDUSTRIES.map(i => i.label),
    // 当前选中的行业 key，用于判断是否「失物招领」（wxml 里不比较中文字符串）
    industryKey: INDUSTRIES[0].key,

    lfIndex: 0,
    lfLabels: LF_OPTIONS.map(o => o.label),

    form: {
      title: '',
      summary: '',
      content: '',
      contactName: '',
      contactPhone: '',
      images: []
    },

    // 详细说明上限，供 wxml 的 maxlength 与「已输入/上限」计数器共用
    contentMax: CONTENT_MAX,

    ext: {
      district: '',
      community: '',
      layout: '',
      area: '',
      floor: '',
      rent: '',
      // 招租信息可标记「无中介」（不是独立分类，只是招租下的一个属性）
      noAgency: false,
      category: '',
      condition: '',
      price: '',
      merchantName: '',
      address: '',
      startAt: '',
      expireAt: '',
      isAd: false,
      // 失物招领（生活信息下的一个分类）：地点复用 address，日期用 happenAt
      lfType: 'lost',
      itemName: '',
      happenAt: '',
      reward: ''
    },

    weight: 0,
    infoId: '',
    editMode: false,
    loadingInfo: false,
    submitting: false,
    importTip: '',

    // 自定义标签：最多 3 个、每个 6 字内，提交时存进 infos.tags
    tags: [],
    tagInput: ''
  },

  onLoad(options) {
    const id = (options && options.id) || ''
    const fromImport = !!(options && options.from === 'import')

    if (id) {
      this.setData({ infoId: id, editMode: true })
      wx.setNavigationBarTitle({ title: '编辑信息' })
    }

    // 管理台「一键导入」带过来的草稿，先填表，等人工核对
    if (fromImport) this.applyImportDraft()

    this.checkAuth()
    if (id) this.loadDetail(id)
  },

  /** 把一键导入解析出来的草稿填进表单 */
  applyImportDraft() {
    const app = getApp()
    const draft = app && app.globalData && app.globalData.importDraft
    if (!draft) return

    // 用完即弃，避免下次新建时又被填一遍
    app.globalData.importDraft = null

    const type = draft.type || 'house'
    const typeIndex = Math.max(0, TYPES.findIndex(t => t.key === type))
    const dealList = DEAL_MAP[type] || []
    const dealIndex = Math.max(0, dealList.findIndex(d => d.key === draft.dealType))
    const industryIndex = Math.max(0, INDUSTRIES.findIndex(i => i.key === draft.industry))
    const form = draft.form || {}

    // 有没认出来的字段就一起提示，避免用户以为全填好了
    const unknown = (draft.unknown || []).filter(Boolean)
    let importTip = '已按模板导入，请核对每项内容后再发布'
    if (unknown.length) {
      importTip += `；未识别：${unknown.slice(0, 3).join('、')}`
    }

    this.setData({
      type,
      typeIndex,
      dealIndex,
      dealLabels: dealList.map(d => d.label),
      industryIndex,
      industryKey: (INDUSTRIES[industryIndex] || INDUSTRIES[0]).key,
      lfIndex: Math.max(0, LF_OPTIONS.findIndex(o => o.key === (form.lfType || (draft.ext || {}).lfType))),
      weight: draft.weight || 0,
      form: {
        title: form.title || '',
        summary: form.summary || '',
        content: form.content || '',
        contactName: form.contactName || '',
        contactPhone: form.contactPhone || '',
        images: []
      },
      ext: Object.assign({}, this.data.ext, draft.ext || {}),
      tags: [],
      tagInput: '',
      importTip
    })
  },

  /** 编辑模式：拉取任意状态的信息并回填表单 */
  async loadDetail(id) {
    this.setData({ loadingInfo: true })
    try {
      const result = (await cloud.callFunction('adminAction', { action: 'detail', id }, { force: true })) || {}
      if (result.code !== 0 || !result.data) {
        wx.showToast({ title: result.msg || '加载失败', icon: 'none' })
        return
      }
      this.fillForm(result.data)
    } catch (err) {
      console.error('[publish] loadDetail failed', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
    } finally {
      this.setData({ loadingInfo: false })
    }
  },

  fillForm(data) {
    const type = data.type || 'house'
    const ext = data.ext || {}
    const contact = data.contact || {}

    const typeIndex = Math.max(0, TYPES.findIndex(t => t.key === type))
    const dealList = DEAL_MAP[type] || []
    const dealIndex = Math.max(0, dealList.findIndex(d => d.key === ext.dealType))
    const industryIndex = Math.max(0, INDUSTRIES.findIndex(i => i.key === ext.industry))

    const toStr = v => (v === null || v === undefined ? '' : String(v))

    this.setData({
      type,
      typeIndex,
      dealIndex,
      dealLabels: dealList.map(d => d.label),
      industryIndex,
      industryKey: (INDUSTRIES[industryIndex] || INDUSTRIES[0]).key,
      lfIndex: Math.max(0, LF_OPTIONS.findIndex(o => o.key === ext.lfType)),
      weight: data.weight || 0,
      tags: Array.isArray(data.tags) ? data.tags.slice(0, 3) : [],
      tagInput: '',
      form: {
        title: data.title || '',
        summary: data.summary || '',
        content: data.content || '',
        contactName: contact.name || '',
        contactPhone: contact.phone || '',
        images: data.images || []
      },
      ext: {
        district: ext.district || '',
        community: ext.community || '',
        layout: ext.layout || '',
        area: toStr(ext.area),
        floor: ext.floor || '',
        rent: toStr(ext.rent),
        noAgency: ext.noAgency === true,
        category: ext.category || '',
        condition: ext.condition || '',
        price: toStr(ext.price),
        merchantName: ext.merchantName || '',
        address: ext.address || '',
        startAt: tsToDate(ext.startAt),
        expireAt: tsToDate(ext.expireAt),
        isAd: !!ext.isAd,
        lfType: ext.lfType === 'found' ? 'found' : 'lost',
        itemName: ext.itemName || '',
        happenAt: tsToDate(ext.happenAt),
        reward: ext.reward || ''
      }
    })
  },

  async checkAuth() {
    try {
      // 管理员身份 60 秒内复用（manage 页 bootstrap 已确认过），省一次调用。
      // 非管理员绝不复用：此时本页要显示当前 openid，必须是真实值，
      // 否则换了微信账号 / AppID 后会复制到旧 openid，怎么配都配不上。
      const app = getApp()
      const authAt = (app && app.globalData && app.globalData.adminAuthAt) || 0
      if (authAt && Date.now() - authAt < 60000) {
        this.setData({ checking: false, authed: true, openid: '' })
        return
      }

      // 不传 cacheKey：身份校验结果不进缓存层。
      // 否则白名单刚改完、或刚换了微信账号，60 秒内仍会拿到旧的 isAdmin / openid。
      const result = await cloud.callFunction(
        'adminAction',
        { action: 'check' },
        { force: true }
      )
      const isAdmin = !!(result && result.isAdmin)
      if (isAdmin && app && app.globalData) app.globalData.adminAuthAt = Date.now()

      this.setData({
        checking: false,
        authed: isAdmin,
        openid: (result && result.openid) || ''
      })
    } catch (err) {
      console.error('[publish] checkAuth failed', err)
      this.setData({ checking: false, authed: false })
      wx.showToast({ title: '身份校验失败', icon: 'none' })
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

  onTypeChange(e) {
    const index = Number(e.detail.value)
    const type = TYPES[index].key
    const dealList = DEAL_MAP[type] || []

    this.setData({
      typeIndex: index,
      type,
      dealIndex: 0,
      dealLabels: dealList.map(d => d.label)
    })
  },

  onDealChange(e) {
    const dealIndex = Number(e.detail.value)
    const patch = { dealIndex }

    // 切到「求租」时把无中介复位，避免开关藏起来了值还留着
    if (this.data.type === 'house' && dealIndex !== 0) patch['ext.noAgency'] = false

    this.setData(patch)
  },

  onIndustryChange(e) {
    const industryIndex = Number(e.detail.value)
    this.setData({
      industryIndex,
      industryKey: (INDUSTRIES[industryIndex] || INDUSTRIES[0]).key
    })
  },

  /** 失物招领：寻物（我在找）/ 招领（我捡到） */
  onLfTypeChange(e) {
    const lfIndex = Number(e.detail.value)
    this.setData({
      lfIndex,
      'ext.lfType': (LF_OPTIONS[lfIndex] || LF_OPTIONS[0]).key
    })
  },

  onStartDate(e) {
    this.setData({ 'ext.startAt': e.detail.value })
  },

  onExpireDate(e) {
    this.setData({ 'ext.expireAt': e.detail.value })
  },

  /** 失物招领：丢失 / 拾获的日期 */
  onHappenDate(e) {
    this.setData({ 'ext.happenAt': e.detail.value })
  },

  onAdChange(e) {
    this.setData({ 'ext.isAd': e.detail.value })
  },

  /** 招租信息的「无中介」开关 */
  onNoAgencyChange(e) {
    this.setData({ 'ext.noAgency': e.detail.value })
  },

  onFormInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: e.detail.value })
  },

  onExtInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`ext.${field}`]: e.detail.value })
  },

  onWeightInput(e) {
    this.setData({ weight: e.detail.value })
  },

  /* ---------------- 自定义标签 ---------------- */

  onTagInput(e) {
    this.setData({ tagInput: e.detail.value })
  },

  /** 添加标签：最多 3 个、每个 6 字，自动去掉空白与分隔符 */
  onTagAdd() {
    const text = String(this.data.tagInput || '')
      .replace(/[\s\r\n\t#＃,，、|/]+/g, '')
      .slice(0, 6)

    if (!text) return

    const tags = this.data.tags.slice()
    if (tags.length >= 3) {
      wx.showToast({ title: '最多添加 3 个标签', icon: 'none' })
      return
    }
    if (tags.indexOf(text) !== -1) {
      wx.showToast({ title: '这个标签已经有了', icon: 'none' })
      return
    }

    tags.push(text)
    this.setData({ tags, tagInput: '' })
  },

  onTagDelete(e) {
    const index = Number(e.currentTarget.dataset.index)
    const tags = this.data.tags.slice()
    tags.splice(index, 1)
    this.setData({ tags })
  },

  async onChooseImage() {
    const remain = 6 - this.data.form.images.length
    if (remain <= 0) return

    try {
      const res = await wx.chooseMedia({
        count: remain,
        mediaType: ['image'],
        sizeType: ['compressed'],
        sourceType: ['album', 'camera']
      })

      wx.showLoading({ title: '上传中…', mask: true })

      const uploaded = []
      for (const file of res.tempFiles) {
        const suffix = (file.tempFilePath.split('.').pop() || 'jpg').toLowerCase()
        const cloudPath = `infos/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${suffix}`
        const up = await wx.cloud.uploadFile({ cloudPath, filePath: file.tempFilePath })
        uploaded.push(up.fileID)
      }

      this.setData({ 'form.images': this.data.form.images.concat(uploaded) })
      wx.hideLoading()
    } catch (err) {
      wx.hideLoading()
      console.error('[publish] upload failed', err)
      wx.showToast({ title: '图片上传失败', icon: 'none' })
    }
  },

  onDeleteImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    const images = this.data.form.images.slice()
    images.splice(index, 1)
    this.setData({ 'form.images': images })
  },

  validate() {
    const { type, form, ext, industryKey } = this.data

    if (!form.title.trim()) return '请填写标题'
    if (!form.content.trim()) return '请填写详细说明'

    const phone = form.contactPhone.replace(/[-\s]/g, '')
    if (!/^\d{6,20}$/.test(phone)) return '请填写正确的联系电话'

    if (type === 'offer') {
      // 失物招领走另一套必填项：物品名称必填，不需要商家与截止日期
      if (industryKey === 'lostfound') {
        if (!String(ext.itemName || '').trim()) return '请填写丢失 / 拾获的物品'
      } else {
        if (!ext.merchantName.trim()) return '请填写商家 / 发布方'
        if (!ext.expireAt) return '请选择活动截止日期'
      }
    }

    return ''
  },

  async onSubmit() {
    if (this.data.submitting) return

    const errMsg = this.validate()
    if (errMsg) {
      wx.showToast({ title: errMsg, icon: 'none' })
      return
    }

    const { type, dealIndex, industryIndex, form, ext } = this.data

    // 组装扩展字段
    const payloadExt = Object.assign({}, ext)
    if (type === 'house') {
      payloadExt.dealType = (DEAL_MAP.house[dealIndex] || DEAL_MAP.house[0]).key
      // 只有招租才有「无中介」的说法，求租一律置 false
      payloadExt.noAgency = payloadExt.dealType === 'rent_out' && ext.noAgency === true
    } else if (type === 'secondhand') {
      payloadExt.dealType = (DEAL_MAP.secondhand[dealIndex] || DEAL_MAP.secondhand[0]).key
    } else {
      const industry = (INDUSTRIES[industryIndex] || INDUSTRIES[0]).key
      payloadExt.industry = industry
      // 失物招领多一个寻物/招领的性质
      if (industry === 'lostfound') {
        payloadExt.lfType = (LF_OPTIONS[this.data.lfIndex] || LF_OPTIONS[0]).key
      }
    }

    const payload = {
      action: this.data.editMode ? 'update' : 'publish',
      type,
      title: form.title.trim(),
      summary: form.summary.trim(),
      content: form.content.trim(),
      tags: this.data.tags,
      contact: {
        name: form.contactName.trim(),
        phone: form.contactPhone.replace(/[-\s]/g, '')
      },
      images: form.images,
      ext: payloadExt,
      weight: Number(this.data.weight) || 0
    }

    if (this.data.editMode) payload.id = this.data.infoId

    this.setData({ submitting: true })

    try {
      const result = (await cloud.callFunction('adminAction', payload, { force: true })) || {}

      if (result.code === 0) {
        // 内容有变，清掉列表与详情缓存，保证返回后能看到最新数据
        cloud.clearCache('list:')
        cloud.clearCache('detail:')
        // 告知管理台：数据变了，返回时必须重拉一次（否则 onShow 的节流会跳过）
        const app = getApp()
        if (app && app.globalData) app.globalData.adminListDirty = true
        const doneText = this.data.editMode ? '保存成功' : '发布成功'
        if (result.warning) {
          wx.showModal({
            title: doneText,
            content: result.warning,
            showCancel: false,
            success: () => wx.navigateBack()
          })
        } else {
          wx.showToast({ title: doneText, icon: 'success' })
          setTimeout(() => wx.navigateBack(), 800)
        }
      } else if (result.code === 403) {
        wx.showToast({ title: '无发布权限', icon: 'none' })
      } else {
        wx.showToast({ title: result.msg || '发布失败', icon: 'none' })
      }
    } catch (err) {
      console.error('[publish] submit failed', err)
      wx.showToast({ title: '发布失败，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  resetForm() {
    this.setData({
      weight: 0,
      tags: [],
      tagInput: '',
      form: {
        title: '',
        summary: '',
        content: '',
        contactName: '',
        contactPhone: '',
        images: []
      },
      ext: {
        district: '',
        community: '',
        layout: '',
        area: '',
        floor: '',
        rent: '',
        category: '',
        condition: '',
        price: '',
        merchantName: '',
        address: '',
        startAt: '',
        expireAt: '',
        isAd: false
      }
    })
  }
})
