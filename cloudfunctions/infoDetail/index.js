// cloudfunctions/infoDetail/index.js
// 信息详情：返回完整内容，并将浏览量 +1
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

exports.main = async (event = {}) => {
  const id = event.id
  if (!id || typeof id !== 'string') {
    return { code: 400, msg: '缺少信息 ID', data: null }
  }

  try {
    const doc = await db.collection('infos').doc(id).get().catch(() => null)

    if (!doc || !doc.data || doc.data.status !== 'published') {
      return { code: 404, msg: '信息不存在或已下架', data: null }
    }

    // 浏览量自增，失败不影响主流程
    await db.collection('infos').doc(id)
      .update({ data: { views: _.inc(1) } })
      .catch(() => {})

    const d = doc.data

    return {
      code: 0,
      data: {
        _id: d._id,
        type: d.type,
        title: d.title,
        summary: d.summary || '',
        content: d.content || '',
        tags: Array.isArray(d.tags) ? d.tags.slice(0, 3) : [],
        images: d.images || [],
        contact: d.contact || {},
        ext: d.ext || {},
        views: (d.views || 0) + 1,
        createdAt: d.createdAt ? new Date(d.createdAt).getTime() : 0
      }
    }
  } catch (err) {
    console.error('[infoDetail] error', err)
    return { code: 500, msg: '查询失败', data: null }
  }
}
