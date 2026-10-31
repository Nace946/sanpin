// utils/noticeQuery.js
// 首页公告查询：走 adminAction 的公开 action（noticeList）
//
// 缓存策略：不是固定 TTL，而是「到下一个刷新点为止」
//   - 每日 8:00 与 17:00 各刷新一次（时间点见 config.NOTICE_REFRESH_HOURS）
//   - 例：7:30 打开 → 缓存 30 分钟，8:00 到期重新拉
//         10:00 打开 → 缓存 7 小时，17:00 到期重新拉
//         18:00 打开 → 缓存到次日 8:00
//   - 也就是「每天两次真正调用云函数」，其余时间全部命中本地缓存

const config = require('./config')
const cloud = require('./cloud')

const CACHE_KEY = 'notices:v1'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/**
 * 计算下一个刷新点的时间戳（8:00 或 17:00，跨天则取次日第一个时段）
 * @param {number} now 当前时间戳
 * @returns {number}
 */
function nextRefreshAt(now) {
  const d = new Date(now)
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const hours = config.NOTICE_REFRESH_HOURS || [8, 17]

  for (let i = 0; i < hours.length; i++) {
    const at = midnight + hours[i] * HOUR
    if (at > now) return at
  }
  return midnight + hours[0] * HOUR + DAY
}

/** 本次请求的缓存有效期：距下一个刷新点的毫秒数，最小 1 分钟 */
function currentTtl() {
  const now = Date.now()
  return Math.max(60 * 1000, nextRefreshAt(now) - now)
}

/**
 * 拉取启用中的公告（按 sort 升序）
 * @param {object} [options] { force: true 强制跳过缓存 }
 * @returns {Promise<Array<{ _id, content, sort }>>}
 */
async function fetchNotices(options) {
  const opts = options || {}

  try {
    const result =
      (await cloud.callFunction(
        'adminAction',
        { action: 'noticeList' },
        {
          cacheKey: CACHE_KEY,
          ttl: currentTtl(),
          persist: config.PERSIST_CACHE,
          force: !!opts.force
        }
      )) || {}

    const list = Array.isArray(result.list) ? result.list : []
    // 空文本的历史脏数据直接跳过，避免公告栏出现空字幕
    return list.filter(item => item && item.content)
  } catch (err) {
    console.error('[noticeQuery] 公告读取失败', err)
    return []
  }
}

module.exports = {
  fetchNotices,
  nextRefreshAt,
  currentTtl,
  CACHE_KEY
}
