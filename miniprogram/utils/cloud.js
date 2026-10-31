// utils/cloud.js
// 统一云函数调用层：内存缓存 + 持久缓存（Storage）+ 并发去重 + 调用计数
//
// 两层缓存的作用不同：
//   内存缓存：同一次运行内有效，页面来回切换不重复请求
//   持久缓存：写进 Storage，小程序退出重进（冷启动）依然有效
//
// 只有 TTL ≥ 5 分钟的请求才会写入 Storage，避免把短时效数据（如身份校验）长期落盘。

const config = require('./config')

const memory = {} // cacheKey -> { result, expire, at }
const pending = {} // cacheKey -> Promise
const STORAGE_PREFIX = 'wbcache:'
const PERSIST_MIN_TTL = 5 * 60 * 1000

const counter = { calls: 0, memHits: 0, storageHits: 0 }
let writeCount = 0

/* ---------------- 持久层 ---------------- */

function readStorage(key) {
  try {
    const entry = wx.getStorageSync(STORAGE_PREFIX + key)
    if (!entry || !entry.expire) return null
    if (entry.expire <= Date.now()) {
      wx.removeStorageSync(STORAGE_PREFIX + key)
      return null
    }
    return entry
  } catch (err) {
    return null
  }
}

function writeStorage(key, entry) {
  try {
    wx.setStorageSync(STORAGE_PREFIX + key, entry)

    // 每写 10 次顺手清一遍已过期条目，避免搜索过多个关键词后 Storage 堆积
    writeCount++
    if (writeCount % 10 === 0) pruneStorage()
  } catch (err) {
    // Storage 满或不可用时静默失败，不影响功能
    console.warn('[cloud] 写入缓存失败', err)
  }
}

/** 清理所有已过期的持久缓存 */
function pruneStorage() {
  try {
    const info = wx.getStorageInfoSync()
    ;(info.keys || []).forEach(k => {
      if (k.indexOf(STORAGE_PREFIX) !== 0) return
      const entry = wx.getStorageSync(k)
      if (!entry || !entry.expire || entry.expire <= Date.now()) {
        wx.removeStorageSync(k)
      }
    })
  } catch (err) {
    // 忽略
  }
}

/** 给返回结果附加缓存元信息，页面可用于显示"更新于 X 前" */
function withMeta(entry, fromCache) {
  return Object.assign({}, entry.result, {
    __cacheAt: entry.at,
    __fromCache: fromCache
  })
}

/**
 * 调用云函数
 * @param {string} name
 * @param {object} data
 * @param {object} [options]
 * @param {string} [options.cacheKey] 缓存键；不传则不缓存
 * @param {number} [options.ttl] 缓存有效期（毫秒），默认 60 秒
 * @param {boolean} [options.force] 强制跳过缓存（下拉刷新 / 管理端操作用）
 * @param {boolean} [options.persist] true 强制写 Storage，false 强制不写
 */
function callFunction(name, data, options) {
  const opts = options || {}
  const key = opts.cacheKey || ''
  const ttl = typeof opts.ttl === 'number' ? opts.ttl : 60000
  const persist =
    opts.persist === true ||
    (opts.persist !== false && config.PERSIST_CACHE && ttl >= PERSIST_MIN_TTL)

  if (key && !opts.force) {
    // 1) 内存
    const hit = memory[key]
    if (hit && hit.expire > Date.now()) {
      counter.memHits++
      return Promise.resolve(withMeta(hit, true))
    }

    // 2) Storage（冷启动后靠这一层）
    if (persist) {
      const saved = readStorage(key)
      if (saved) {
        memory[key] = saved // 回填内存，后续同页请求走内存
        counter.storageHits++
        return Promise.resolve(withMeta(saved, true))
      }
    }

    // 3) 同一请求正在飞，直接复用，避免重复调用
    if (pending[key]) {
      counter.memHits++
      return pending[key]
    }
  }

  counter.calls++

  const task = wx.cloud
    .callFunction({ name, data: data || {} })
    .then(res => (res && res.result) || null)
    .then(result => {
      const ok = result && (result.code === 0 || result.code === undefined)
      const at = Date.now()

      if (key && ok) {
        const entry = { result, expire: at + ttl, at }
        memory[key] = entry
        if (persist) writeStorage(key, entry)
      }

      delete pending[key]
      return result ? Object.assign({}, result, { __cacheAt: at, __fromCache: false }) : null
    })
    .catch(err => {
      delete pending[key]
      throw err
    })

  if (key) pending[key] = task
  return task
}

/** 清理缓存（内存 + Storage）；不传前缀则清空全部 */
function clearCache(prefix) {
  Object.keys(memory).forEach(k => {
    if (!prefix || k.indexOf(prefix) === 0) delete memory[k]
  })

  try {
    const info = wx.getStorageInfoSync()
    ;(info.keys || []).forEach(k => {
      if (k.indexOf(STORAGE_PREFIX) !== 0) return
      const bare = k.slice(STORAGE_PREFIX.length)
      if (!prefix || bare.indexOf(prefix) === 0) wx.removeStorageSync(k)
    })
  } catch (err) {
    // 忽略
  }
}

/** 本次运行期的调用与命中情况：getApp().cloudStats() */
function getStats() {
  return {
    calls: counter.calls,
    hits: counter.memHits + counter.storageHits,
    memHits: counter.memHits,
    storageHits: counter.storageHits,
    cacheKeys: Object.keys(memory).length
  }
}

module.exports = {
  callFunction,
  clearCache,
  getStats
}
