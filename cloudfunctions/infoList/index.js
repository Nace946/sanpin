// cloudfunctions/infoList/index.js
// 信息列表查询：支持类型筛选、子分类筛选、关键词搜索、分页
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const MAX_SIZE = 20
// 列表卡片「详细说明」一行最多回传的字数：单行 24rpx 约显示 26 字，
// 这里是给不同屏宽留余量的上限，超出交给前端 ellipsis 省略
const DESC_MAX = 60

/** 列表副行文案：优先取摘要，没填摘要就用详细说明的开头 */
function buildDesc(doc) {
  const text = String(doc.summary || '').trim() || String(doc.content || '').trim()
  return text.replace(/\s+/g, ' ').slice(0, DESC_MAX)
}

/* ---------------- 首页「信息推荐」排序 ---------------- */

// 浏览量按 1% 计入，权重按 100% 计入，两者相加得到排序分：
//   score = views × 0.01 + weight × 1
// 含义：权重差 1 就压过 100 次浏览量的差距；权重相同时，浏览量高的排在前面。
const VIEW_RATIO = 0.01
const WEIGHT_RATIO = 1

function recommendScore(doc) {
  const views = Number(doc.views) || 0
  const weight = Number(doc.weight) || 0
  return views * VIEW_RATIO + weight * WEIGHT_RATIO
}

/** createdAt 可能是 Date / 时间戳 / ISO 字符串，统一转毫秒，用于同分排序 */
function timeOf(doc) {
  const t = doc && doc.createdAt
  if (!t) return 0
  const ms = new Date(t).getTime()
  return isNaN(ms) ? 0 : ms
}

exports.main = async (event = {}) => {
  try {
    const page = Math.max(1, parseInt(event.page, 10) || 1)
    const size = Math.min(MAX_SIZE, Math.max(1, parseInt(event.size, 10) || 10))
    const type = event.type && event.type !== 'all' ? event.type : ''
    const sub = event.sub || ''
    const keyword = String(event.keyword || '').trim()

    // 基础条件：只查已发布
    const base = { status: 'published' }
    if (type) base.type = type
    if (sub) {
      if (type === 'offer') base['ext.industry'] = sub
      else base['ext.dealType'] = sub
    }
    // pinned：只取推荐位（weight > 0），用于首页「信息推荐」
    if (event.pinned) base.weight = _.gt(0)

    // 关键词：标题 / 摘要模糊匹配
    let where = base
    if (keyword) {
      const safe = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const reg = db.RegExp({ regexp: safe, options: 'i' })
      where = _.and([base, _.or([{ title: reg }, { summary: reg }])])
    }

    const fields = {
      type: true,
      title: true,
      summary: true,
      content: true,
      tags: true,
      images: true,
      ext: true,
      createdAt: true
    }

    let rawList = []

    if (event.pinned) {
      // 首页推荐位：按 score = 浏览量 × 1% + 权重 × 100% 排序（见 recommendScore）
      //
      // 数据库 orderBy 不支持计算字段，而推荐位候选集很小（管理员手动加推荐的少量信息），
      // 所以先取候选池、在内存里算分排序、再按页码切片。
      // limit 100 是云函数单次 get 的上限，正常运营远远达不到。
      const pool = await db.collection('infos')
        .where(where)
        .orderBy('weight', 'desc')
        .limit(100)
        .field(Object.assign({ views: true, weight: true }, fields))
        .get()

      const scored = (pool.data || [])
        .map(item => ({ item, score: recommendScore(item) }))
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score
          // 同分时新发布的在前，避免老信息永远压住新信息
          return timeOf(b.item) - timeOf(a.item)
        })

      const start = (page - 1) * size
      rawList = scored.slice(start, start + size).map(x => x.item)
    } else {
      // 列表页（含搜索）：纯按发布时间倒序，不看权重。
      // 权重只用于首页「信息推荐」位的排序（见上面 pinned 分支），
      // 列表页保持时间序，避免管理员推荐的旧信息长期压在最新信息前面。
      const res = await db.collection('infos')
        .where(where)
        .orderBy('createdAt', 'desc')
        .skip((page - 1) * size)
        .limit(size)
        .field(fields)
        .get()

      rawList = res.data || []
    }

    const list = rawList.map(item => ({
      _id: item._id,
      type: item.type,
      title: item.title,
      summary: item.summary || '',
      // 列表一行「详细说明」：摘要优先，没摘要取正文开头（截断在服务端做，别把 2000 字全文传到前端）
      desc: buildDesc(item),
      tags: (item.tags || []).slice(0, 3),
      ext: item.ext || {},
      images: (item.images || []).slice(0, 1),
      createdAt: item.createdAt ? new Date(item.createdAt).getTime() : 0
    }))

    return { code: 0, list }
  } catch (err) {
    console.error('[infoList] error', err)
    return { code: 500, msg: '查询失败', list: [] }
  }
}
