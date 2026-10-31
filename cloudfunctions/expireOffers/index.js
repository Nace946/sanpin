// cloudfunctions/expireOffers/index.js
// 定时触发器：每小时整点执行，把已过期（ext.expireAt < 当前时间）的优惠信息置为 expired
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

exports.main = async () => {
  const now = Date.now()

  try {
    const res = await db.collection('infos')
      .where({
        type: 'offer',
        status: 'published',
        'ext.expireAt': _.lt(now)
      })
      .update({
        data: {
          status: 'expired',
          updatedAt: db.serverDate()
        }
      })

    const updated = (res && res.stats && res.stats.updated) || 0
    console.log('[expireOffers] 已置为过期:', updated)
    return { code: 0, updated }
  } catch (err) {
    console.error('[expireOffers] error', err)
    return { code: 500, msg: '执行失败' }
  }
}
