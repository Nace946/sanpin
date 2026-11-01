// packageAdmin/utils/bannerQuery.js
// 【已废弃】单独拉轮播图的查询封装：走 adminAction 的公开 action（bannerList），带 1 小时缓存
//
// 现状（2026-11-02）：首页已重新接入轮播图，但不是单独请求，而是与公告合并成
// 一次 adminAction.homeMeta（见 miniprogram/utils/homeMeta.js）。
// 因此本文件不再被任何页面调用，仅作历史参考保留在分包内，不占主包体积。
//
// 注意：
//   1. bannerList 是公开读取，非管理员也能拿到「启用中」的图，停用的不会被返回
//   2. 缓存键固定为 banners:v1，管理员改动后由管理端 clearCache('banners:') 主动失效

const config = require('./config')
const cloud = require('./cloud')

const CACHE_KEY = 'banners:v1'

/**
 * 拉取启用中的轮播图
 * @param {object} [options] { force: true 强制跳过缓存 }
 * @returns {Promise<Array<{ _id, image, linkType, linkId, sort }>>}
 */
async function fetchBanners(options) {
  const opts = options || {}

  try {
    const result =
      (await cloud.callFunction(
        'adminAction',
        { action: 'bannerList' },
        {
          cacheKey: CACHE_KEY,
          ttl: config.BANNER_CACHE_TTL,
          persist: config.PERSIST_CACHE,
          force: !!opts.force
        }
      )) || {}

    const list = Array.isArray(result.list) ? result.list : []
    // 图片字段为空的历史脏数据直接跳过，避免首页出现空白块
    return list.filter(item => item && item.image)
  } catch (err) {
    console.error('[bannerQuery] 轮播图读取失败', err)
    return []
  }
}

module.exports = {
  fetchBanners,
  CACHE_KEY
}
