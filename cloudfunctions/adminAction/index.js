// cloudfunctions/adminAction/index.js
// 管理端统一入口：身份校验 / 发布 / 编辑 / 列表 / 统计 / 上下架 / 权重 / 导出
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const $ = db.command.aggregate

// 管理员 openid 白名单，配置在云函数「环境变量」ADMIN_OPENIDS 中
// 多个用英文逗号分隔，例如：oAAA111,oBBB222
const ADMIN_OPENIDS = String(process.env.ADMIN_OPENIDS || '')
  .split(/[,;\s]+/)
  .map(s => s.trim())
  .filter(Boolean)

const VALID_TYPES = ['house', 'secondhand', 'offer']
const VALID_STATUS = ['published', 'offline', 'deleted']

// 生活信息的行业白名单。加新分类必须同步这里，否则保存时会被静默改写成 other
const VALID_INDUSTRIES = [
  'food',
  'market',
  'netbar',
  'entertainment',
  'friend',
  'lostfound',
  'missing',
  'travel',
  'nearby',
  'other'
]

// 简化板块：只有标题 / 详细说明 / 标签 / 图片 / 联系人 / 电话，
// 不写商家名、地址、活动起止日期、广告位，也不会被定时任务置为过期
const SIMPLE_INDUSTRIES = ['friend', 'missing', 'travel', 'nearby', 'other']

// 轮播图集合（前台公开读取，仅管理员可写）
const BANNER_COLLECTION = 'banners'
// 轮播图跳转类型：none=不跳转（点击放大） / list=跳分类列表 / page=跳站内页面（存路径）
const VALID_LINK_TYPES = ['none', 'list', 'page']

/**
 * 站内跳转允许的目标页面白名单。
 *
 * 必须白名单而不是「以 /pages/ 开头就放行」：轮播图路径由管理员手填，
 * 一旦允许任意路径，填错一个字符就是白屏，填了不存在的页面用户点了没反应，
 * 而这里能拦住的成本几乎为零。
 */
const PAGE_PATH_WHITELIST = ['/pages/detail/detail', '/pages/list/list', '/pages/about/about']
// 站内路径总长度上限（含 query，够放一个 32 位 id）
const PAGE_PATH_MAX = 300

/** 校验并规范化站内路径：只允许白名单页面 + 可选 query */
function normalizePagePath(input) {
  const raw = str(input).trim()
  if (!raw || raw.length > PAGE_PATH_MAX) return ''
  if (!/^\/[A-Za-z0-9\-_/?=&%.]*$/.test(raw)) return ''

  const path = raw.split('?')[0]
  if (PAGE_PATH_WHITELIST.indexOf(path) === -1) return ''

  return raw
}

// 公告集合（首页公告栏，前台公开读取，仅管理员可写）
const NOTICE_COLLECTION = 'notices'
// 单条公告文本上限（首页漂浮字幕，太长用户看不完）
const NOTICE_MAX_LEN = 120

const TYPE_CN = { house: '房源', secondhand: '二手', offer: '生活' }
const STATUS_CN = {
  published: '已发布',
  offline: '已下架',
  expired: '已过期',
  deleted: '已删除'
}

exports.main = async (event = {}) => {
  const ctx = cloud.getWXContext() || {}
  const { OPENID } = ctx
  if (!OPENID) {
    return { code: 401, msg: '无法识别身份，请在小程序内操作' }
  }

  const isAdmin = ADMIN_OPENIDS.includes(OPENID)
  const action = event.action || 'check'

  // 身份查询：无论是否管理员都返回自己的 openid（返回给本人，无泄漏风险）
  // 换过 AppID / 云环境后 openid 会变，靠这里取新值重新配白名单
  if (action === 'check') {
    return { code: 0, isAdmin, openid: OPENID }
  }

  // 诊断入口：一次返回 openid + 是否命中白名单 + 当前云环境 + 白名单条数
  // 用于排查「配了但不生效」（环境配错 / 分隔符写错 / 没重新部署）
  if (action === 'whoami') {
    return {
      code: 0,
      openid: OPENID,
      appid: ctx.APPID || '',
      env: ctx.ENV || process.env.TCB_ENV || '',
      isAdmin,
      whitelistCount: ADMIN_OPENIDS.length
    }
  }

  // 轮播图：前台公开读取（只返回启用中的），管理员可带 all:true 看全部
  // 放在鉴权之前，是为了让首页在未登录状态下也能拿到图；写操作仍在后面鉴权
  if (action === 'bannerList') {
    return await bannerList(event, isAdmin, OPENID)
  }

  // 公告：前台公开读取（只返回启用中的），管理员可带 all:true 看全部
  if (action === 'noticeList') {
    return await noticeList(event, isAdmin, OPENID)
  }

  // 首页首屏元数据：公告 + 轮播图合并成一次请求
  // 首页原先分两次调 noticeList / bannerList，合并后这两块只花 1 次调用，
  // 首页首屏总调用次数不变（本接口 1 次 + 推荐列表 1 次）
  if (action === 'homeMeta') {
    return await homeMeta()
  }

  if (!isAdmin) {
    // 非管理员访问管理台时，仍返回 openid，方便首次配置白名单
    if (action === 'bootstrap') {
      return { code: 0, isAdmin: false, openid: OPENID }
    }
    return { code: 403, msg: '无操作权限' }
  }

  try {
    switch (action) {
      case 'publish':
        return await publish(event, OPENID)
      case 'update':
        return await updateInfo(event, OPENID)
      case 'detail':
        return await detail(event)
      case 'list':
        return await list(event)
      case 'bootstrap':
        return await bootstrap(event)
      case 'stats':
        return await stats()
      case 'setStatus':
        return await setStatus(event)
      case 'setWeight':
        return await setWeight(event)
      case 'expire':
        return await runExpire()
      case 'export':
        return await exportCsv(event)
      case 'bannerSave':
        return await bannerSave(event)
      case 'bannerRemove':
        return await bannerRemove(event)
      case 'noticeSave':
        return await noticeSave(event, OPENID)
      case 'noticeRemove':
        return await noticeRemove(event)
      case 'seed':
        return await seedTestData()
      case 'clearTest':
        return await clearTestData()
      default:
        return { code: 400, msg: '未知操作' }
    }
  } catch (err) {
    console.error('[adminAction]', action, err)
    return { code: 500, msg: '服务异常，请稍后重试' }
  }
}

/* ---------------- 发布 / 编辑 ---------------- */

async function publish(event, openid) {
  const payload = buildPayload(event)
  if (payload.error) return { code: 400, msg: payload.error }

  const check = await securityCheck(payload, openid)
  if (check.block) return { code: 4001, msg: check.msg }

  const res = await db.collection('infos').add({
    data: Object.assign({}, payload, {
      status: 'published',
      views: 0,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    })
  })

  return { code: 0, id: res._id, warning: check.msg || '' }
}

async function updateInfo(event, openid) {
  const id = str(event.id)
  if (!id) return { code: 400, msg: '缺少信息 ID' }

  const doc = await db.collection('infos').doc(id).get().catch(() => null)
  if (!doc || !doc.data) return { code: 404, msg: '信息不存在' }

  const payload = buildPayload(event)
  if (payload.error) return { code: 400, msg: payload.error }

  const check = await securityCheck(payload, openid)
  if (check.block) return { code: 4001, msg: check.msg }

  const data = Object.assign({}, payload, { updatedAt: db.serverDate() })

  // 编辑页可顺带调整状态，但只允许这三个值
  if (VALID_STATUS.includes(event.status)) {
    data.status = event.status
  }

  await db.collection('infos').doc(id).update({ data })

  return { code: 0, id, warning: check.msg || '' }
}

/** 统一校验并清洗入参，返回 payload 或 { error } */
function buildPayload(event) {
  const type = event.type
  if (!VALID_TYPES.includes(type)) return { error: '信息类型不合法' }

  const title = str(event.title).slice(0, 60)
  const summary = str(event.summary).slice(0, 80)
  const content = str(event.content).slice(0, 2000)

  const contact = event.contact || {}
  const phone = String(contact.phone || '').replace(/[^\d]/g, '')

  // 只接受本环境云存储的文件 ID
  const images = Array.isArray(event.images)
    ? event.images
        .filter(f => typeof f === 'string' && f.indexOf('cloud://') === 0)
        .slice(0, 6)
    : []

  if (!title) return { error: '标题不能为空' }
  if (!content) return { error: '详细说明不能为空' }
  // 联系电话改为选填：留空直接跳过格式校验
  if (phone && !/^\d{6,20}$/.test(phone)) return { error: '联系电话格式不正确' }

  const ext = buildExt(type, event.ext || {})
  if (type === 'offer') {
    if (ext.industry === 'lostfound') {
      // 寻物：物品名称必填，且不需要截止日期
      if (!ext.itemName) return { error: '请填写丢失 / 拾获的物品' }
    } else if (SIMPLE_INDUSTRIES.includes(ext.industry)) {
      // 简化板块（交友 / 寻人 / 出行 / 周边 / 其他）：没有活动日期，也没有必填的扩展字段
    } else if (!ext.expireAt) {
      return { error: '请设置活动截止日期' }
    }
  }

  return {
    type,
    title,
    summary,
    content,
    tags: sanitizeTags(event.tags),
    images,
    contact: {
      name: str(contact.name).slice(0, 20),
      phone
    },
    ext,
    weight: clampWeight(event.weight)
  }
}

/** 自定义标签：最多 6 个，每个 6 字内，去重、去掉分隔符与控制字符 */
function sanitizeTags(input) {
  if (!Array.isArray(input)) return []

  const out = []
  input.forEach(raw => {
    const text = str(raw)
      .replace(/[\r\n\t]/g, '')
      .replace(/[#＃,，、|/]+/g, '')
      .trim()
      .slice(0, 6)

    if (!text) return
    if (out.indexOf(text) === -1) out.push(text)
  })

  return out.slice(0, 6)
}

/* ---------------- 查询 ---------------- */

async function detail(event) {
  const id = str(event.id)
  if (!id) return { code: 400, msg: '缺少信息 ID', data: null }

  const doc = await db.collection('infos').doc(id).get().catch(() => null)
  if (!doc || !doc.data) return { code: 404, msg: '信息不存在', data: null }

  return { code: 0, data: normalize(doc.data) }
}

async function list(event) {
  const page = Math.max(1, parseInt(event.page, 10) || 1)
  const size = Math.min(20, Math.max(1, parseInt(event.size, 10) || 10))
  const type = event.type && event.type !== 'all' ? event.type : ''
  const status = event.status || 'all'
  const keyword = str(event.keyword)

  const where = {}
  if (type) where.type = type

  if (status === 'all') {
    where.status = _.neq('deleted')
  } else if (VALID_STATUS.includes(status) || status === 'expired') {
    where.status = status
  } else {
    return { code: 400, msg: '状态参数不合法', list: [] }
  }

  let query = where
  if (keyword) {
    const safe = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const reg = db.RegExp({ regexp: safe, options: 'i' })
    query = _.and([where, _.or([{ title: reg }, { summary: reg }])])
  }

  const res = await db.collection('infos')
    .where(query)
    .orderBy('weight', 'desc')
    .orderBy('createdAt', 'desc')
    .skip((page - 1) * size)
    .limit(size)
    .get()

  return { code: 0, list: (res.data || []).map(normalize) }
}

/**
 * 管理台一次进入所需的全部数据：身份 + 统计 + 第一页列表
 * 合并成一个 action，把「check + stats + list」3 次调用压成 1 次
 */
async function bootstrap(event) {
  const listRes = await list(event)
  const statsRes = await stats()

  return {
    code: 0,
    isAdmin: true,
    list: listRes.list || [],
    stats: statsRes.stats
  }
}

async function stats() {
  const res = await db.collection('infos')
    .aggregate()
    .group({
      _id: { type: '$type', status: '$status' },
      count: $.sum(1),
      views: $.sum('$views')
    })
    .end()

  const byType = { house: 0, secondhand: 0, offer: 0 }
  const byStatus = { published: 0, offline: 0, expired: 0, deleted: 0 }
  let totalViews = 0
  let total = 0

  ;(res.list || []).forEach(item => {
    const meta = item._id || {}
    const count = item.count || 0
    const views = item.views || 0

    if (byStatus[meta.status] !== undefined) byStatus[meta.status] += count

    if (meta.status !== 'deleted') {
      if (byType[meta.type] !== undefined) byType[meta.type] += count
      totalViews += views
      total += count
    }
  })

  const testRes = await db.collection('infos').where({ isTest: true }).count()
    .catch(() => ({ total: 0 }))

  return {
    code: 0,
    stats: {
      byType,
      byStatus,
      totalViews,
      total,
      testCount: (testRes && testRes.total) || 0
    }
  }
}

/* ---------------- 状态 / 权重 ---------------- */

async function setStatus(event) {
  const id = str(event.id)
  const status = str(event.status)

  if (!id) return { code: 400, msg: '缺少信息 ID' }
  if (!VALID_STATUS.includes(status)) return { code: 400, msg: '状态不合法' }

  await db.collection('infos').doc(id).update({
    data: { status, updatedAt: db.serverDate() }
  })

  return { code: 0 }
}

async function setWeight(event) {
  const id = str(event.id)
  if (!id) return { code: 400, msg: '缺少信息 ID' }

  const weight = clampWeight(event.weight)

  await db.collection('infos').doc(id).update({
    data: { weight, updatedAt: db.serverDate() }
  })

  return { code: 0, weight }
}

/* ---------------- 过期清理 ---------------- */

/**
 * 手动补跑过期清理。
 * 与定时云函数 expireOffers 完全同一套条件，用于「每日 00:00 定时任务没生效」时兜底：
 * 管理台点一下按钮就能立刻把过期的生活信息置为 expired，前台列表随之不再返回。
 * 内联实现而不是 callFunction 调 expireOffers，省一次云函数调用。
 */
async function runExpire() {
  const res = await db.collection('infos')
    .where({
      type: 'offer',
      status: 'published',
      'ext.expireAt': _.lt(Date.now())
    })
    .update({
      data: {
        status: 'expired',
        updatedAt: db.serverDate()
      }
    })

  const updated = (res && res.stats && res.stats.updated) || 0
  return { code: 0, updated }
}

/* ---------------- 导出 ---------------- */

async function exportCsv(event) {
  const type = event.type && event.type !== 'all' ? event.type : ''
  const status = event.status || 'all'

  const where = {}
  if (type) where.type = type
  if (status === 'all') {
    where.status = _.neq('deleted')
  } else {
    where.status = status
  }

  const res = await db.collection('infos')
    .where(where)
    .orderBy('weight', 'desc')
    .orderBy('createdAt', 'desc')
    .limit(1000)
    .get()

  const rows = (res.data || []).map(d => {
    const ext = d.ext || {}
    const contact = d.contact || {}
    return [
      TYPE_CN[d.type] || d.type,
      d.title || '',
      d.summary || '',
      STATUS_CN[d.status] || d.status,
      d.weight || 0,
      d.views || 0,
      formatTime(d.createdAt),
      contact.name || '',
      contact.phone || '',
      ext.merchantName || ext.community || ext.category || ext.itemName || ext.address || '',
      String(d.content || '').replace(/\r?\n/g, ' ')
    ]
  })

  const header = ['类型', '标题', '摘要', '状态', '权重', '浏览量', '发布时间', '联系人', '联系电话', '商家/位置', '详情']
  const csv = '\ufeff' + [header].concat(rows).map(r => r.map(csvCell).join(',')).join('\r\n')

  return { code: 0, csv, count: rows.length }
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value)
  return '"' + s.replace(/"/g, '""') + '"'
}

/* ---------------- 轮播图 ---------------- */

/**
 * 读取轮播图原始列表（只返回数组，供 bannerList 与写操作复用）
 * all=true 返回全部（含已停用），否则只返回启用中的
 */
async function readBanners(all) {
  try {
    const where = all ? {} : { enabled: true }

    const res = await db.collection(BANNER_COLLECTION)
      .where(where)
      .orderBy('sort', 'asc')
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get()

    return (res.data || []).map(b => ({
      _id: b._id,
      image: b.image || '',
      linkType: VALID_LINK_TYPES.includes(b.linkType) ? b.linkType : 'none',
      linkId: b.linkId || '',
      // 站内页面跳转的目标路径，如 /pages/detail/detail?id=xxx
      linkValue: b.linkValue || '',
      sort: Number(b.sort) || 0,
      enabled: b.enabled !== false
    }))
  } catch (err) {
    // 集合尚未创建（-502005）：按「没有轮播图」处理，返回空数组让前台能缓存住，
    // 否则每次进入首页都会重复调用并打日志
    const code = err && (err.errCode || err.errcode)
    if (code === -502005) return []
    throw err
  }
}

/** 写操作后回带最新全量列表：管理页直接用返回值渲染，省掉一次额外的 list 调用 */
async function safeReadBanners() {
  try {
    return await readBanners(true)
  } catch (err) {
    console.error('[adminAction] readBanners after write failed', err)
    return []
  }
}

/**
 * 读取轮播图
 * 前台：只返回 enabled 的记录，按 sort 升序（同序按创建时间倒序）
 * 管理端：isAdmin 且 all=true 时返回全部（含已停用）
 *
 * 同时带回 isAdmin / openid：管理页据此判断权限，
 * 省掉「先 check 再 list」的额外一次云函数调用。
 */
async function bannerList(event, isAdmin, openid) {
  const admin = !!isAdmin
  const meta = { isAdmin: admin, openid: openid || '' }

  try {
    const list = await readBanners(admin && !!(event && event.all))
    return Object.assign({ code: 0, list }, meta)
  } catch (err) {
    console.error('[adminAction] bannerList failed', err)
    return Object.assign({ code: 500, msg: '轮播图读取失败', list: [] }, meta)
  }
}

/**
 * 首页首屏元数据：公告 + 轮播图，一次返回
 *
 * 为什么合并：首页要同时展示这两块，分开调用就是 2 次云函数调用。
 * 合并成 1 次后，首页首屏 = 本接口 1 次 + 推荐列表 1 次，次数没有增加。
 *
 * 两块各自 try/catch 降级：轮播图集合读失败不能把公告也一起带崩。
 */
async function homeMeta() {
  const [banners, notices] = await Promise.all([
    readBanners(false).catch(err => {
      console.error('[adminAction] homeMeta 读取轮播图失败', err)
      return []
    }),
    readNotices(false).catch(err => {
      console.error('[adminAction] homeMeta 读取公告失败', err)
      return []
    })
  ])

  return { code: 0, banners, notices }
}

/** 新增或更新一张轮播图 */
async function bannerSave(event) {
  const image = str(event.image)
  if (image.indexOf('cloud://') !== 0) {
    return { code: 400, msg: '请先上传轮播图图片' }
  }

  const linkType = VALID_LINK_TYPES.includes(event.linkType) ? event.linkType : 'none'
  const linkId = linkType === 'list' ? str(event.linkId).slice(0, 32) : ''
  const linkValue = linkType === 'page' ? normalizePagePath(event.linkValue) : ''

  if (linkType === 'list' && !VALID_TYPES.includes(linkId)) {
    return { code: 400, msg: '请选择跳转的分类' }
  }

  if (linkType === 'page' && !linkValue) {
    return { code: 400, msg: '站内路径不合法，需形如 /pages/detail/detail?id=xxx' }
  }

  const data = {
    image,
    linkType,
    linkId,
    linkValue,
    sort: Math.max(0, Math.min(999, parseInt(event.sort, 10) || 0)),
    enabled: event.enabled !== false,
    updatedAt: db.serverDate()
  }

  const id = str(event.id)
  if (id) {
    await db.collection(BANNER_COLLECTION).doc(id).update({ data })
    return { code: 0, id, list: await safeReadBanners() }
  }

  const res = await db.collection(BANNER_COLLECTION).add({
    data: Object.assign({ createdAt: db.serverDate() }, data)
  })

  return { code: 0, id: res._id, list: await safeReadBanners() }
}

async function bannerRemove(event) {
  const id = str(event.id)
  if (!id) return { code: 400, msg: '缺少轮播图 ID' }

  await db.collection(BANNER_COLLECTION).doc(id).remove()
  return { code: 0, list: await safeReadBanners() }
}

/* ---------------- 公告（首页公告栏） ---------------- */

/**
 * 读取公告原始列表（只返回数组，供 noticeList 与写操作复用）
 * all=true 返回全部（含已停用）
 */
async function readNotices(all) {
  try {
    const where = all ? {} : { enabled: true }

    const res = await db.collection(NOTICE_COLLECTION)
      .where(where)
      .orderBy('sort', 'asc')
      .orderBy('createdAt', 'asc')
      .limit(20)
      .get()

    return (res.data || []).map(n => ({
      _id: n._id,
      content: n.content || '',
      sort: Number(n.sort) || 0,
      enabled: n.enabled !== false
    }))
  } catch (err) {
    // 集合尚未创建（-502005）：按「没有公告」处理，返回空数组让前台能缓存住
    const code = err && (err.errCode || err.errcode)
    if (code === -502005) return []
    throw err
  }
}

/** 写操作后回带最新全量列表：管理页直接用返回值渲染，省掉一次额外的 list 调用 */
async function safeReadNotices() {
  try {
    return await readNotices(true)
  } catch (err) {
    console.error('[adminAction] readNotices after write failed', err)
    return []
  }
}

/**
 * 读取公告
 * 前台：只返回 enabled 的记录，按 sort 升序（同序按创建时间正序，保证「按顺序」播放）
 * 管理端：isAdmin 且 all=true 时返回全部（含已停用）
 *
 * 同时带回 isAdmin / openid：管理页据此判断权限，省掉一次 check 调用
 */
async function noticeList(event, isAdmin, openid) {
  const admin = !!isAdmin
  const meta = { isAdmin: admin, openid: openid || '' }

  try {
    const list = await readNotices(admin && !!(event && event.all))
    return Object.assign({ code: 0, list }, meta)
  } catch (err) {
    console.error('[adminAction] noticeList failed', err)
    return Object.assign({ code: 500, msg: '公告读取失败', list: [] }, meta)
  }
}

/** 新增或更新一条公告（文本过内容安全检测） */
async function noticeSave(event, openid) {
  const content = str(event.content).slice(0, NOTICE_MAX_LEN)
  if (!content) return { code: 400, msg: '请填写公告内容' }

  const check = await securityCheck({ title: content, ext: {} }, openid)
  if (check.block) return { code: 400, msg: check.msg }

  const data = {
    content,
    sort: Math.max(0, Math.min(999, parseInt(event.sort, 10) || 0)),
    enabled: event.enabled !== false,
    updatedAt: db.serverDate()
  }

  const id = str(event.id)
  if (id) {
    await db.collection(NOTICE_COLLECTION).doc(id).update({ data })
    return { code: 0, id, list: await safeReadNotices() }
  }

  const res = await db.collection(NOTICE_COLLECTION).add({
    data: Object.assign({ createdAt: db.serverDate() }, data)
  })

  return { code: 0, id: res._id, list: await safeReadNotices() }
}

async function noticeRemove(event) {
  const id = str(event.id)
  if (!id) return { code: 400, msg: '缺少公告 ID' }

  await db.collection(NOTICE_COLLECTION).doc(id).remove()
  return { code: 0, list: await safeReadNotices() }
}

/* ---------------- 测试数据 ---------------- */

const DAY = 86400000

/** 测试数据：覆盖三种类型、全部子分类、面议/有价、过期/下架等边界 */
function buildSeedDocs() {
  const ts = days => db.serverDate({ offset: -days * DAY })
  // 优惠起止时间按当前时间相对推算，避免写死日期后过期
  const at = days => Date.now() + days * DAY
  const fmt = ms => {
    const d = new Date(ms + 8 * 3600 * 1000)
    const p = n => (n < 10 ? '0' + n : '' + n)
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
  }

  const startLong = at(-10)
  const endFood = at(30)
  const startMarket = at(-6)
  const endMarket = at(20)
  const startNetbar = at(-26)
  const endNetbar = at(-7)
  const startCinema = at(-10)
  const endCinema = at(64)

  return [
    // 1. 房源 · 招租 · 有租金 · 权重 100（应排第一）
    {
      type: 'house',
      title: '阳光花园 2室1厅 整租 南北通透',
      summary: '家电齐全，近实验小学，房东直租无中介费',
      content: [
        '房屋位于阳光花园 3 号楼，2 室 1 厅 1 卫，南北通透，采光好。',
        '室内配有冰箱、洗衣机、热水器、空调、双人床、衣柜，可直接入住。',
        '周边 300 米内有菜市场和公交站，步行 10 分钟到实验小学。',
        '租金 1600 元/月，押一付三，水电燃气按表自理。',
        '房东直租，可长租，具体可电话沟通。'
      ].join('\n'),
      images: [],
      contact: { name: '张先生', phone: '13800138001' },
      ext: {
        dealType: 'rent_out',
        district: '城关区',
        community: '阳光花园',
        layout: '2室1厅',
        area: 89,
        floor: '6/18层',
        rent: 1600
      },
      weight: 100,
      views: 46,
      status: 'published',
      createdAt: ts(1),
      updatedAt: ts(1)
    },

    // 2. 房源 · 求租 · 预算低
    {
      type: 'house',
      title: '求租 1室1厅 近一中 预算1000以内',
      summary: '两人居住，希望有独立卫生间，长租一年以上',
      content: [
        '工作调动到本地，想在市一中附近租一套 1 室 1 厅，两个人住。',
        '希望有独立卫生间和厨房，能做饭，楼层不限，有电梯更好。',
        '预算 1000 元/月以内，计划长租一年以上，可押一付三。',
        '有合适房源请联系。'
      ].join('\n'),
      images: [],
      contact: { name: '李女士', phone: '13800138002' },
      ext: {
        dealType: 'rent_in',
        district: '城关区',
        community: '',
        layout: '1室1厅',
        area: 45,
        floor: '',
        rent: 1000
      },
      weight: 0,
      views: 12,
      status: 'published',
      createdAt: ts(3),
      updatedAt: ts(3)
    },

    // 3. 房源 · 招租 · 租金为空（测试「面议」展示）
    {
      type: 'house',
      title: '解放路临街门面房 60㎡ 可做小生意',
      summary: '一层临街，水电齐全，人流量稳定，价格面议',
      content: [
        '解放路临街门面，一层，使用面积约 60 平方米，门头宽 4 米。',
        '已通水电，有独立卫生间，之前做小超市，货架可协商保留。',
        '临街人流量稳定，附近有两个小区和一所小学。',
        '租金面议，可整租也可分租，具体电话沟通。'
      ].join('\n'),
      images: [],
      contact: { name: '王先生', phone: '13800138003' },
      ext: {
        dealType: 'rent_out',
        district: '老城区',
        community: '解放路临街',
        layout: '门面房',
        area: 60,
        floor: '1层',
        rent: null
      },
      weight: 0,
      views: 8,
      status: 'published',
      createdAt: ts(5),
      updatedAt: ts(5)
    },

    // 4. 二手 · 出售 · 权重 20
    {
      type: 'secondhand',
      title: '九成新山地自行车 21速 转让',
      summary: '骑行不到半年，配件齐全，送头盔和车锁',
      content: [
        '去年买的 21 速山地车，骑了不到半年，平时放在家里，车况良好。',
        '前后变速正常，刹车灵敏，轮胎花纹还很深。',
        '随车送头盔一个、U 型车锁一把。',
        '价格 480 元，可当面看车，地点在阳光花园附近。'
      ].join('\n'),
      images: [],
      contact: { name: '陈同学', phone: '13800138004' },
      ext: {
        dealType: 'sell',
        category: '交通工具',
        condition: '九成新',
        price: 480
      },
      weight: 20,
      views: 33,
      status: 'published',
      createdAt: ts(2),
      updatedAt: ts(2)
    },

    // 5. 二手 · 求购
    {
      type: 'secondhand',
      title: '求购 二手书桌 1.2米左右',
      summary: '学生用，能正常使用即可，可自提',
      content: [
        '给孩子买一张书桌，长度 1.2 米左右即可，带抽屉更好。',
        '成色要求不高，结构稳固、能正常使用就行，有轻微划痕无所谓。',
        '价格 100 元以内，我可以自己上门搬。'
      ].join('\n'),
      images: [],
      contact: { name: '刘女士', phone: '13800138005' },
      ext: {
        dealType: 'buy',
        category: '家具',
        condition: '不限',
        price: 100
      },
      weight: 0,
      views: 5,
      status: 'published',
      createdAt: ts(4),
      updatedAt: ts(4)
    },

    // 6. 优惠 · 餐饮 · 未过期 · 权重 30
    {
      type: 'offer',
      title: '巷子口麻辣烫 堂食满30减6',
      summary: '活动期间堂食、打包均可使用，不与店内其他优惠同享',
      content: [
        '活动内容：单笔消费满 30 元减 6 元，满 60 元减 15 元。',
        '适用范围：堂食、打包均可，酒水饮料不参与。',
        '使用条件：每单限用一次，不与店内其他优惠同享。',
        `活动时间：${fmt(startLong)} 至 ${fmt(endFood)}。`,
        '地址：兴华路 18 号（阳光花园北门对面）。',
        '信息来源：商家提供，本平台仅作展示，不参与交易。'
      ].join('\n'),
      images: [],
      contact: { name: '巷子口麻辣烫', phone: '13800138006' },
      ext: {
        merchantName: '巷子口麻辣烫',
        industry: 'food',
        address: '兴华路 18 号',
        startAt: startLong,
        expireAt: endFood,
        isAd: false
      },
      weight: 30,
      views: 61,
      status: 'published',
      createdAt: ts(1),
      updatedAt: ts(1)
    },

    // 7. 优惠 · 超市 · 未过期
    {
      type: 'offer',
      title: '惠民生活超市 满88减10',
      summary: '生鲜日用全场参与，每日限用一次',
      content: [
        '活动内容：单笔消费满 88 元减 10 元。',
        '参与品类：生鲜、粮油、日用百货全场参与，烟酒不参与。',
        '使用条件：每日每单限用一次，不与其他满减活动叠加。',
        `活动时间：${fmt(startMarket)} 至 ${fmt(endMarket)}。`,
        '地址：人民路 66 号（一楼服务台可咨询）。',
        '信息来源：商家提供，本平台仅作展示，不参与交易。'
      ].join('\n'),
      images: [],
      contact: { name: '惠民生活超市', phone: '13800138007' },
      ext: {
        merchantName: '惠民生活超市',
        industry: 'market',
        address: '人民路 66 号',
        startAt: startMarket,
        expireAt: endMarket,
        isAd: false
      },
      weight: 0,
      views: 27,
      status: 'published',
      createdAt: ts(2),
      updatedAt: ts(2)
    },

    // 8. 优惠 · 网吧 · 已过期但仍是 published（用于验证定时下架）
    {
      type: 'offer',
      title: '极光网咖 工作日下午场 20元/5小时',
      summary: '周一至周五 12:00—18:00 可用，需凭身份证登记',
      content: [
        '周一至周五 12:00—18:00，20 元可上机 5 小时。',
        '需凭本人身份证登记上机，未成年人不得入内。',
        `活动时间：${fmt(startNetbar)} 至 ${fmt(endNetbar)}（本条为过期测试数据）。`,
        '地址：建设路 9 号二楼。'
      ].join('\n'),
      images: [],
      contact: { name: '极光网咖', phone: '13800138008' },
      ext: {
        merchantName: '极光网咖',
        industry: 'netbar',
        address: '建设路 9 号二楼',
        startAt: startNetbar,
        expireAt: endNetbar,
        isAd: false
      },
      weight: 0,
      views: 40,
      status: 'published',
      createdAt: ts(9),
      updatedAt: ts(9)
    },

    // 9. 优惠 · 娱乐 · 已下架（前台不显示，管理台可见）
    {
      type: 'offer',
      title: '星光影城 周二会员日 全场半价',
      summary: '每周二全天会员购票半价，特殊厅除外',
      content: [
        '每周二全天，会员购票全场半价（特殊厅除外）。',
        '需现场办理会员卡，每人每场限购 4 张。',
        `活动时间：${fmt(startCinema)} 至 ${fmt(endCinema)}（本条为已下架测试数据）。`,
        '地址：中心广场 5 楼。'
      ].join('\n'),
      images: [],
      contact: { name: '星光影城', phone: '13800138009' },
      ext: {
        merchantName: '星光影城',
        industry: 'entertainment',
        address: '中心广场 5 楼',
        startAt: startCinema,
        expireAt: endCinema,
        isAd: false
      },
      weight: 0,
      views: 19,
      status: 'offline',
      createdAt: ts(3),
      updatedAt: ts(3)
    },

    // 10. 生活信息 · 失物招领（寻物，我在找）
    {
      type: 'offer',
      title: '寻找黑色钱包，内有身份证和银行卡',
      summary: '在人民公园东门附近丢失，证件很重要，拾到必有重谢',
      content: [
        '前天下午 5 点左右，在人民公园东门到 3 路公交站之间丢了一个黑色短款钱包。',
        '里面有身份证、两张银行卡和少量现金。现金可以不要，证件对我很重要。',
        '如有拾到请电话联系，必有重谢。'
      ].join('\n'),
      images: [],
      contact: { name: '王女士', phone: '13800138010' },
      ext: {
        industry: 'lostfound',
        lfType: 'lost',
        itemName: '黑色短款钱包',
        address: '人民公园东门 · 3 路公交站',
        happenAt: at(-2),
        reward: '200 元'
      },
      weight: 0,
      views: 12,
      status: 'published',
      createdAt: ts(2),
      updatedAt: ts(2)
    },

    // 11. 生活信息 · 失物招领（招领，我捡到了）· 权重 10
    {
      type: 'offer',
      title: '捡到一串钥匙，挂着小熊挂件',
      summary: '在阳光花园南门花坛边捡到，已放门卫室，失主可认领',
      content: [
        '今天早上在阳光花园南门花坛边捡到一串钥匙，共 4 把，挂着一个小熊挂件。',
        '已经交到小区门卫室，失主可以凭描述认领，也可以先电话联系我确认。'
      ].join('\n'),
      images: [],
      contact: { name: '李先生', phone: '13800138011' },
      ext: {
        industry: 'lostfound',
        lfType: 'found',
        itemName: '一串钥匙（小熊挂件）',
        address: '阳光花园南门花坛',
        happenAt: at(-1),
        reward: ''
      },
      weight: 10,
      views: 6,
      status: 'published',
      createdAt: ts(1),
      updatedAt: ts(1)
    }
  ]
}

async function seedTestData() {
  // 幂等：先清掉上一批测试数据，避免重复写入
  const removed = await clearTestData(true)
  const docs = buildSeedDocs()

  let added = 0
  for (const doc of docs) {
    await db.collection('infos').add({
      data: Object.assign({ isTest: true }, doc)
    })
    added++
  }

  return { code: 0, added, removed: removed.removed || 0, msg: `已写入 ${added} 条测试数据` }
}

async function clearTestData(silent) {
  try {
    const res = await db.collection('infos').where({ isTest: true }).remove()
    const removed = (res && res.stats && res.stats.removed) || 0
    if (silent) return { removed }
    return { code: 0, removed, msg: `已清除 ${removed} 条测试数据` }
  } catch (err) {
    console.error('[adminAction] clearTest failed', err)
    if (silent) return { removed: 0 }
    return { code: 500, msg: '清除失败' }
  }
}

/* ---------------- 通用 ---------------- */

/** 文本内容安全检测 */
async function securityCheck(payload, openid) {
  const content = [
    payload.title,
    payload.summary,
    payload.content,
    (payload.tags || []).join(' '),
    payload.ext.merchantName,
    payload.ext.address,
    payload.ext.community,
    payload.ext.category,
    payload.ext.itemName,
    payload.ext.reward
  ]
    .filter(Boolean)
    .join('\n')

  if (!content) return { block: false, msg: '' }

  try {
    const res = await cloud.openapi.security.msgSecCheck({
      content: content.slice(0, 2500),
      version: 2,
      scene: 3, // 3=论坛/信息发布
      openid
    })

    const suggest = res && res.result && res.result.suggest
    if (suggest && suggest !== 'pass') {
      return { block: true, msg: '内容未通过安全检测，请修改后重试' }
    }
    return { block: false, msg: '' }
  } catch (err) {
    const code = err && (err.errCode || err.errcode)
    if (code === 87014) {
      return { block: true, msg: '内容包含违规信息，请修改' }
    }
    // 常见原因：云函数未配置 openapi 权限（config.json），或接口临时不可用
    console.error('[adminAction] msgSecCheck failed', err)
    return { block: false, msg: '内容安全检测暂不可用，本次已跳过检测，请自行确认内容合规' }
  }
}

/** 按类型清洗扩展字段，防止写入任意结构 */
function buildExt(type, ext) {
  const num = v => {
    if (v === '' || v === null || v === undefined) return null
    const n = Number(v)
    return isNaN(n) ? null : n
  }

  if (type === 'house') {
    // 租售类型仍是二值；「无中介」是招租下的一个属性，单独存 noAgency
    const dealType = str(ext.dealType) === 'rent_in' ? 'rent_in' : 'rent_out'
    return {
      dealType,
      noAgency: dealType === 'rent_out' && !!ext.noAgency,
      district: str(ext.district).slice(0, 30),
      community: str(ext.community).slice(0, 60),
      layout: str(ext.layout).slice(0, 30),
      area: num(ext.area),
      floor: str(ext.floor).slice(0, 20),
      rent: num(ext.rent),
      // 图片是否按原比例展示（三类通用）
      rawImage: !!ext.rawImage
    }
  }

  if (type === 'secondhand') {
    return {
      dealType: ext.dealType === 'buy' ? 'buy' : 'sell',
      category: str(ext.category).slice(0, 30),
      condition: str(ext.condition).slice(0, 20),
      price: num(ext.price),
      rawImage: !!ext.rawImage
    }
  }

  // 生活信息：寻物是其中一个分类（industry = 'lostfound'），字段单独一套；
  // 交友 / 寻人 / 出行 / 周边 / 其他 是简化板块，只有基础字段
  const industry = VALID_INDUSTRIES.includes(ext.industry) ? ext.industry : 'other'
  const isLostfound = industry === 'lostfound'
  const isSimple = SIMPLE_INDUSTRIES.includes(industry)
  // 商家类（餐饮 / 超市 / 网吧 / 娱乐）才有商家名、地址、活动起止日期、广告位
  const isMerchant = !isLostfound && !isSimple

  return {
    industry,
    merchantName: isMerchant ? str(ext.merchantName).slice(0, 40) : '',
    // 地点：寻物与商家类共用 address，简化板块留空
    address: isSimple ? '' : str(ext.address).slice(0, 80),
    startAt: isMerchant ? toTimestamp(ext.startAt, false) : null,
    expireAt: isMerchant ? toTimestamp(ext.expireAt, true) : null,
    isAd: isMerchant ? !!ext.isAd : false,
    // 图片是否按原比例展示（三类通用）
    rawImage: !!ext.rawImage,
    // 以下是寻物专属字段，其他分类一律留空，避免脏数据
    lfType: isLostfound ? (ext.lfType === 'found' ? 'found' : 'lost') : '',
    itemName: isLostfound ? str(ext.itemName).slice(0, 40) : '',
    happenAt: isLostfound ? toTimestamp(ext.happenAt, false) : null,
    reward: isLostfound ? str(ext.reward).slice(0, 20) : ''
  }
}

/** 'YYYY-MM-DD' -> 北京时间时间戳；兼容已是时间戳的入参 */
function toTimestamp(dateStr, endOfDay) {
  if (typeof dateStr === 'number' && dateStr > 0) return dateStr

  const s = str(dateStr)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null

  const suffix = endOfDay ? '23:59:59' : '00:00:00'
  const ts = new Date(`${s}T${suffix}+08:00`).getTime()
  return isNaN(ts) ? null : ts
}

/** 权重：0 ~ 9999 的整数，越大越靠前 */
function clampWeight(v) {
  const n = Number(v)
  if (isNaN(n)) return 0
  return Math.max(0, Math.min(9999, Math.round(n)))
}

/** 统一输出格式，Date -> 时间戳 */
function normalize(doc) {
  return {
    _id: doc._id,
    type: doc.type,
    title: doc.title || '',
    summary: doc.summary || '',
    content: doc.content || '',
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    images: doc.images || [],
    contact: doc.contact || {},
    ext: doc.ext || {},
    status: doc.status,
    weight: doc.weight || 0,
    views: doc.views || 0,
    createdAt: doc.createdAt ? new Date(doc.createdAt).getTime() : 0,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).getTime() : 0
  }
}

/** 云函数运行在 UTC，导出时间需转北京时间 */
function formatTime(value) {
  if (!value) return ''
  const t = new Date(new Date(value).getTime() + 8 * 3600 * 1000)
  if (isNaN(t.getTime())) return ''
  const p = n => (n < 10 ? '0' + n : '' + n)
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`
}

function str(v) {
  if (v === null || v === undefined) return ''
  return String(v).trim()
}
