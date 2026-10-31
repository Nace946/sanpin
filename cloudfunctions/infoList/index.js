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
    // pinned：只取置顶信息（weight > 0），用于首页
    if (event.pinned) base.weight = _.gt(0)

    // 关键词：标题 / 摘要模糊匹配
    let where = base
    if (keyword) {
      const safe = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const reg = db.RegExp({ regexp: safe, options: 'i' })
      where = _.and([base, _.or([{ title: reg }, { summary: reg }])])
    }

    const res = await db.collection('infos')
      .where(where)
      .orderBy('weight', 'desc')
      .orderBy('createdAt', 'desc')
      .skip((page - 1) * size)
      .limit(size)
      .field({
        type: true,
        title: true,
        summary: true,
        content: true,
        tags: true,
        images: true,
        ext: true,
        createdAt: true
      })
      .get()

    const list = (res.data || []).map(item => ({
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
