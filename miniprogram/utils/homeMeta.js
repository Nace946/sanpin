// utils/homeMeta.js
// 首页首屏元数据：公告 + 轮播图，合并成一次云函数调用
//
// 为什么合并：首页要同时展示这两块，分开调 noticeList / bannerList 就是 2 次调用。
// 合并后首页首屏 = 本接口 1 次 + 推荐列表 1 次，和原来持平，轮播图等于「免费」。
//
// 缓存有效期 = min(距下一个公告刷新点, config.HOME_CACHE_MAX_TTL)
//   - 公告沿用 NOTICE_REFRESH_HOURS（默认 8:00 / 17:00）的节奏
//   - 轮播图最多等 HOME_CACHE_MAX_TTL（默认 2 小时）生效
//
// 缓存键 home:v2，管理端改动公告/轮播图后由管理页 clearCache('home:') 主动失效。
//   v1 → v2：轮播图新增 linkValue（站内跳转路径），旧缓存里没有这个字段，
//            不升版本的话首批用户 2 小时内看不到「站内页面」跳转配置。

const config = require('./config')
const cloud = require('./cloud')
const { currentTtl } = require('./noticeQuery')

const CACHE_KEY = 'home:v2'

/** 取两种节奏中更短的那个，最少 1 分钟 */
function ttlOf() {
  const toNextRefresh = currentTtl()
  const max = config.HOME_CACHE_MAX_TTL || toNextRefresh
  return Math.max(60 * 1000, Math.min(toNextRefresh, max))
}

/** 每次都返回新对象，避免调用方改到共享引用 */
function empty() {
  return { banners: [], notices: [] }
}

/**
 * 拉取首页公告与轮播图
 * @param {object} [options] { force: true 强制跳过缓存 }
 * @returns {Promise<{banners: Array, notices: Array}>}
 */
async function fetchHomeMeta(options) {
  const opts = options || {}

  try {
    const result =
      (await cloud.callFunction(
        'adminAction',
        { action: 'homeMeta' },
        {
          cacheKey: CACHE_KEY,
          ttl: ttlOf(),
          persist: config.PERSIST_CACHE,
          force: !!opts.force
        }
      )) || {}

    // 图片为空的历史脏数据直接跳过，避免首页出现空白块
    const banners = (Array.isArray(result.banners) ? result.banners : []).filter(
      item => item && item.image
    )
    // 空文本的公告跳过，避免字幕条出现空白
    const notices = (Array.isArray(result.notices) ? result.notices : []).filter(
      item => item && item.content
    )

    return { banners, notices }
  } catch (err) {
    console.error('[homeMeta] 首页数据读取失败', err)
    return empty()
  }
}

module.exports = {
  fetchHomeMeta,
  CACHE_KEY
}
