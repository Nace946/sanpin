// utils/util.js 通用工具

const TYPE_LABEL = {
  house: '房源租售',
  secondhand: '二手闲置',
  offer: '生活信息'
}

// 二级分类中文映射
const SUB_LABEL = {
  rent_out: '招租',
  rent_in: '求租',
  sell: '出售',
  buy: '求购',
  // 生活信息-失物招领的两种性质：lost = 我在找（寻物启事），found = 我捡到了（招领）
  lost: '寻物',
  found: '招领'
}

const INDUSTRY_LABEL = {
  food: '餐饮',
  market: '超市',
  netbar: '网吧',
  entertainment: '娱乐',
  // 失物招领不是行业，放在生活信息的分类里作为其中一项
  lostfound: '失物招领',
  other: '其他'
}

/** 时间戳/日期字符串 -> YYYY-MM-DD */
function formatDate(input) {
  if (!input) return ''
  const d = input instanceof Date ? input : new Date(input)
  if (isNaN(d.getTime())) return ''
  const p = n => (n < 10 ? '0' + n : '' + n)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 相对时间：今天 / 昨天 / 3天前 / YYYY-MM-DD */
function formatRelative(input) {
  if (!input) return ''
  const d = input instanceof Date ? input : new Date(input)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const diffDay = Math.floor((now - d) / 86400000)
  if (diffDay <= 0) return '今天'
  if (diffDay === 1) return '昨天'
  if (diffDay < 7) return `${diffDay}天前`
  return formatDate(d)
}

/** 价格格式化：分转元 或 直接展示 */
function formatPrice(value) {
  if (value === null || value === undefined || value === '') return '面议'
  const num = Number(value)
  if (isNaN(num)) return String(value)
  return num % 1 === 0 ? String(num) : num.toFixed(2)
}

/** 给列表项补充展示字段，避免在 WXML 里写复杂逻辑 */
function decorateItem(item) {
  if (!item) return item
  const ext = item.ext || {}
  const out = {
    _id: item._id,
    type: item.type,
    typeLabel: TYPE_LABEL[item.type] || '信息',
    title: item.title,
    summary: item.summary || '',
    // 列表「详细说明」一行：列表接口已按「摘要优先、否则正文开头」截好，直接透传
    desc: item.desc || item.summary || '',
    cover: (item.images && item.images[0]) || '',
    imageCount: (item.images && item.images.length) || 0,
    timeText: formatRelative(item.createdAt),
    tagText: '',
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 3) : [],
    priceText: '',
    priceValue: '',
    priceUnit: '',
    areaText: '',
    // 首页卡片按「竖线分隔」逐段渲染，故另外提供数组形式
    areaParts: [],
    isAd: false,
    // 招租信息是否标记「无中介」
    noAgency: false
  }

  if (item.type === 'house') {
    out.tagText = SUB_LABEL[ext.dealType] || '房源'
    // 无中介：招租信息的一个可选标记（不是独立分类），卡片上叠加一个小标签
    out.noAgency = ext.dealType === 'rent_out' && ext.noAgency === true
    out.priceText = ext.rent ? `¥${formatPrice(ext.rent)}/月` : '面议'
    // 首页卡片把金额与单位分开排版：金额大号、单位小号灰色
    out.priceValue = ext.rent ? formatPrice(ext.rent) : ''
    out.priceUnit = ext.rent ? '元/月' : '面议'
    out.areaText = [ext.district, ext.layout, ext.area ? ext.area + '㎡' : '']
      .filter(Boolean)
      .join(' · ')
    out.areaParts = [ext.district, ext.layout, ext.area ? ext.area + '㎡' : ''].filter(Boolean)
  } else if (item.type === 'secondhand') {
    out.tagText = SUB_LABEL[ext.dealType] || '闲置'
    out.priceText = ext.price ? `¥${formatPrice(ext.price)}` : '面议'
    out.priceValue = ext.price ? formatPrice(ext.price) : ''
    out.priceUnit = ext.price ? '元' : '面议'
    out.areaText = [ext.category, ext.condition].filter(Boolean).join(' · ')
    out.areaParts = [ext.category, ext.condition].filter(Boolean)
  } else if (item.type === 'offer') {
    // 失物招领是生活信息下的一个分类（industry === 'lostfound'），不是独立大类
    const isLostfound = ext.industry === 'lostfound'
    if (isLostfound) {
      // 卡片刻意不重复物品名（标题里已有），只标寻物/招领 + 地点与酬谢
      out.tagText = SUB_LABEL[ext.lfType] || '失物招领'
      const reward = ext.reward ? `酬谢 ${ext.reward}` : ''
      out.areaText = [ext.address, reward].filter(Boolean).join(' · ')
      out.areaParts = [ext.address, reward].filter(Boolean)
    } else {
      out.tagText = INDUSTRY_LABEL[ext.industry] || '生活'
      out.areaText = [ext.merchantName, ext.address].filter(Boolean).join(' · ')
      out.areaParts = [ext.merchantName, ext.address].filter(Boolean)
    }
    out.priceText = ''
    // 优惠类没有金额，卡片不渲染价格行（由页面 wx:if 判断）
    out.isAd = !isLostfound && !!ext.isAd
  }

  // 缓存可能保留了已过期的优惠，列表层直接过滤掉，避免用户点进去看到"已结束"
  out.isExpired = item.type === 'offer' && !!ext.expireAt && Number(ext.expireAt) < Date.now()

  // 列表副行：areaText 靠左、timeText 靠右下角，由页面 WXML 分别渲染

  return out
}

/** 简单节流，防止重复点击 */
function throttle(fn, wait = 600) {
  let last = 0
  return function (...args) {
    const now = Date.now()
    if (now - last < wait) return
    last = now
    return fn.apply(this, args)
  }
}

module.exports = {
  TYPE_LABEL,
  SUB_LABEL,
  INDUSTRY_LABEL,
  formatDate,
  formatRelative,
  formatPrice,
  decorateItem,
  throttle
}
