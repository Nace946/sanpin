// utils/infoQuery.js
// 前台信息查询统一入口
//
// 两条读取路径，由 config.DIRECT_READ 决定：
//   1) 直连数据库（不消耗云函数调用次数）
//   2) 云函数 infoList（消耗调用次数，但有缓存与去重）
//
// 两条路径返回结构完全一致：{ code, list: [{ _id, type, title, summary, ext, images, createdAt }] }
// 因此页面代码无需关心用的是哪条路径。

const config = require('./config')
const cloud = require('./cloud')

const COLLECTION = 'infos'
const MAX_SIZE = 20
// 与云函数 infoList 保持一致：列表「详细说明」一行最多取 60 字，再长由前端省略号截断
const DESC_MAX = 60

function buildDesc(item) {
  const text = String(item.summary || '').trim() || String(item.content || '').trim()
  return text.replace(/\s+/g, ' ').slice(0, DESC_MAX)
}

/** createdAt 可能是 Date / 时间戳 / ISO 字符串，统一转毫秒（推荐位同分排序用） */
function timeOf(doc) {
  const t = doc && doc.createdAt
  if (!t) return 0
  const ms = new Date(t).getTime()
  return isNaN(ms) ? 0 : ms
}

// 直连失败熔断：一旦权限没配好，本次运行期不再尝试，避免反复报错
let directBroken = false

function db() {
  return wx.cloud.database()
}

function escapeReg(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 组装查询条件，与云函数 infoList 保持完全一致 */
function buildWhere(params) {
  const _ = db().command
  const base = { status: 'published' }

  if (params.type && params.type !== 'all') base.type = params.type
  if (params.sub) {
    if (params.type === 'offer') base['ext.industry'] = params.sub
    else base['ext.dealType'] = params.sub
  }
  // pinned：只取置顶信息（weight > 0），用于首页
  if (params.pinned) base.weight = _.gt(0)

  if (!params.keyword) return base

  const reg = db().RegExp({ regexp: escapeReg(params.keyword), options: 'i' })
  return _.and([base, _.or([{ title: reg }, { summary: reg }])])
}

/** 统一成与云函数相同的精简结构（Date -> 毫秒时间戳） */
function slim(item) {
  return {
    _id: item._id,
    type: item.type,
    title: item.title,
    summary: item.summary || '',
    desc: buildDesc(item),
    tags: (item.tags || []).slice(0, 3),
    ext: item.ext || {},
    images: (item.images || []).slice(0, 1),
    createdAt: item.createdAt ? new Date(item.createdAt).getTime() : 0
  }
}

async function directList(params) {
  const page = Math.max(1, parseInt(params.page, 10) || 1)
  const size = Math.min(MAX_SIZE, Math.max(1, parseInt(params.size, 10) || 10))
  const FIELDS = {
    type: true,
    title: true,
    summary: true,
    content: true,
    tags: true,
    images: true,
    ext: true,
    createdAt: true
  }

  // 首页推荐位：与云函数 infoList 的 pinned 分支完全一致
  // score = 浏览量 × 1% + 权重 × 100%，数据库 orderBy 不支持计算字段，故取池子内存排序
  if (params.pinned) {
    const pool = await db()
      .collection(COLLECTION)
      .where(buildWhere(params))
      .orderBy('weight', 'desc')
      .limit(100)
      .field(Object.assign({ views: true, weight: true }, FIELDS))
      .get()

    const scored = (pool.data || [])
      .map(item => ({
        item,
        score: (Number(item.views) || 0) * 0.01 + (Number(item.weight) || 0)
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        // 同分时新发布的在前
        return timeOf(b.item) - timeOf(a.item)
      })

    const start = (page - 1) * size
    return { code: 0, list: scored.slice(start, start + size).map(x => slim(x.item)) }
  }

  // 普通列表（含搜索）：与云函数 infoList 一致，纯按发布时间倒序，不看权重
  const res = await db()
    .collection(COLLECTION)
    .where(buildWhere(params))
    .orderBy('createdAt', 'desc')
    .skip((page - 1) * size)
    .limit(size)
    .field(FIELDS)
    .get()

  return { code: 0, list: (res.data || []).map(slim) }
}

function cacheKeyOf(params) {
  return [
    // v4：列表开始回传 desc（详细说明一行），旧缓存里没有这个字段，升版本让老条目自然失效
    // v5：首页推荐位排序改为「浏览量×1% + 权重×100%」，旧缓存里的顺序是旧规则排的，必须作废
    // v6：列表页改为纯时间倒序（不再按权重），旧缓存是「权重优先」的顺序，必须作废
    'list:v6',
    params.type || 'all',
    params.sub || '',
    params.keyword || '',
    params.pinned ? 'pin' : 'all',
    params.page || 1,
    params.size || 10
  ].join(':')
}

/**
 * 拉取列表
 * @param {object} params { type, sub, keyword, pinned, page, size }
 * @param {object} [options] { force: true 强制跳过缓存 }
 *
 * 返回结构：{ code, list, __cacheAt, __fromCache }
 */
async function fetchList(params, options) {
  const opts = options || {}

  // 直连模式：本身就是实时的，且不消耗云函数调用，因此不走 TTL 缓存
  if (config.DIRECT_READ && !directBroken) {
    try {
      return await directList(params)
    } catch (err) {
      directBroken = true
      console.warn(
        '[infoQuery] 直连数据库失败，已回退云函数。请检查 infos 集合权限是否为「所有用户可读」',
        err
      )
    }
  }

  return cloud.callFunction('infoList', params, {
    cacheKey: cacheKeyOf(params),
    ttl: config.LIST_CACHE_TTL,
    persist: config.PERSIST_CACHE,
    force: !!opts.force
  })
}

module.exports = {
  fetchList,
  cacheKeyOf
}
