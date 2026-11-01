// cloudfunctions/expireOffers/index.js
// 定时触发器：每天 00:00（北京时间）执行一次，把已过期（ext.expireAt < 当前时间）的
// 生活信息（商家活动）状态置为 expired，之后列表查询（只查 published）自然不再返回。
//
// 为什么每天零点一次就够：
//   expireAt 存的是「截止日期当天 23:59:59 +08:00」，23:59:59 之后到次日 00:00 之间
//   不会有任何信息恰好过期，零点扫一次正好卡在过期瞬间，不会漏。
//   相比原来的每小时一次，调用次数从 24 次/天降到 1 次/天。
//
// 注意：列表查询只按 status = 'published' 过滤，不比对 expireAt，
// 本定时任务是「过期信息不再出现在列表」的唯一执行者，务必保证触发器在线。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

exports.main = async () => {
  const now = Date.now()

  try {
    // 一次 where + update 批量改状态：即使几十条过期，也只算 1 次数据库写入
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
    console.log('[expireOffers] 本轮置为过期:', updated)
    return { code: 0, updated }
  } catch (err) {
    console.error('[expireOffers] error', err)
    return { code: 500, msg: '执行失败' }
  }
}
