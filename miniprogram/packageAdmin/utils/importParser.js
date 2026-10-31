// packageAdmin/utils/importParser.js
// 剪贴板文本 → 发布表单草稿
// 只被分包 packageAdmin 引用，故放在分包内，不占主包体积
//
// 文本格式：一行一个「字段：值」，冒号中英文都认
//   - 以 # 开头的行 = 注释，忽略
//   - 以【或[ 开头的行 = 装饰标题，忽略
//   - 没有冒号的行：如果上一行是「说明」，则作为说明的续行追加
//
// 各字段的中文叫法见 COMMON_ALIAS / TYPE_ALIAS，同一字段可以有多个叫法。

/* ---------------- 常量 ---------------- */

// 详细说明的字数上限，与 publish.js 的 CONTENT_MAX 保持一致（发布页首行）
const CONTENT_MAX = 2000

/* ---------------- 模板 ---------------- */

const TEMPLATES = {
  house: [
    '# 房源模板：把冒号后面的示例改成实际内容，整段复制，回到小程序点「读取剪贴板导入」',
    '# 用不到的项可以整行删掉，值留空也不会填进去',
    '# 类型可选：招租 / 求租（写「无中介租房」会自动勾上无中介）',
    '类型：招租',
    '标题：阳光小区两室一厅整租',
    '摘要：家电齐全，可短租',
    '区域：城东',
    '小区：阳光小区 3 栋',
    '户型：2室1厅',
    '面积：89',
    '楼层：6/18层',
    '租金：1800',
    '联系人：张先生',
    '电话：13800138000',
    '权重：0',
    '说明：简单装修，家电齐全，随时看房，押一付三。'
  ].join('\n'),

  secondhand: [
    '# 二手闲置模板：把冒号后面的示例改成实际内容，整段复制，回到小程序点「读取剪贴板导入」',
    '# 用不到的项可以整行删掉，值留空也不会填进去',
    '类型：出售',
    '标题：九成新滚筒洗衣机转让',
    '摘要：自用一年，功能完好',
    '分类：家电',
    '成色：九成新',
    '价格：800',
    '联系人：李女士',
    '电话：13800138001',
    '权重：0',
    '说明：因搬家转让，可小刀，城东自提，介意勿扰。'
  ].join('\n'),

  offer: [
    '# 生活信息模板：把冒号后面的示例改成实际内容，整段复制，回到小程序点「读取剪贴板导入」',
    '# 分类可填：餐饮 / 超市 / 网吧 / 娱乐 / 其他',
    '# 失物招领也在这里发：分类写「失物招领」，再加 物品 / 地点 / 日期 / 酬谢 四项',
    '# 失物招领示例：分类：失物招领  物品：黑色钱包  地点：人民公园东门  日期：2026-11-28  酬谢：200 元',
    '# 日期可填 2026-11-30，也可以写 11月30日',
    '标题：老王麻辣烫满 20 减 5',
    '摘要：工作日全天可用',
    '商家：老王麻辣烫',
    '分类：餐饮',
    '地址：人民路 12 号',
    '开始：2026-11-01',
    '截止：2026-11-30',
    '广告：否',
    '联系人：王老板',
    '电话：13800138002',
    '权重：0',
    '说明：堂食使用，每桌限用一次，不与店内其他优惠同享。'
  ].join('\n')
}

/* ---------------- 字段别名 ---------------- */

const COMMON_ALIAS = {
  title: ['标题', '主题'],
  summary: ['摘要', '简介', '副标题'],
  content: ['说明', '详细说明', '内容', '描述', '备注', '详情', '介绍'],
  contactName: ['联系人', '姓名'],
  contactPhone: ['电话', '联系电话', '手机', '手机号', '联系方式'],
  weight: ['权重', '排序']
}

const TYPE_ALIAS = {
  house: {
    dealType: ['类型', '租售类型', '交易类型'],
    district: ['区域', '所在区域', '地区'],
    community: ['小区', '小区位置', '位置'],
    layout: ['户型'],
    area: ['面积'],
    floor: ['楼层'],
    rent: ['租金', '月租', '房租', '预算', '价格', '价位']
  },
  secondhand: {
    dealType: ['类型', '买卖类型', '交易类型'],
    category: ['分类', '物品分类', '类别'],
    condition: ['成色', '新旧'],
    price: ['价格', '售价', '金额', '预算', '价位']
  },
  offer: {
    merchantName: ['商家', '商家名称', '店名', '店铺', '商户'],
    industry: ['行业', '所属行业', '类别', '分类', '所属分类'],
    address: ['地址', '商家地址', '门店地址', '位置', '地点'],
    startAt: ['开始', '开始日期', '活动开始'],
    expireAt: ['截止', '截止日期', '结束', '结束日期', '有效期至', '到期'],
    isAd: ['广告', '广告位', '是否广告'],
    // 失物招领（生活信息下的一个分类）：写了这些字段就自动归到「失物招领」
    lfType: ['类型', '信息类型', '招领性质'],
    itemName: ['物品', '物品名称', '丢失物品', '拾获物品', '东西'],
    happenAt: ['日期', '时间', '丢失时间', '拾获时间', '发生时间'],
    reward: ['酬谢', '酬金', '感谢费', '悬赏']
  }
}

// 文本字段：原样写入
const TEXT_FIELDS = [
  'title', 'summary', 'content', 'contactName', 'contactPhone',
  'district', 'community', 'layout', 'floor', 'category', 'condition',
  'merchantName', 'address', 'itemName', 'reward'
]

const INDUSTRY_MAP = [
  // 失物招领要排最前：写「寻物」「招领」也归到它，不能被后面的行业词抢走
  ['lostfound', ['失物招领', '寻物', '招领', '丢失', '遗失', '拾获', '捡到', '认领']],
  ['food', ['餐饮', '美食', '小吃', '饭店', '餐厅', '烧烤', '火锅', '饮品']],
  ['market', ['超市', '生鲜', '便利店', '菜店', '水果']],
  ['netbar', ['网吧', '网咖', '电竞']],
  ['entertainment', ['娱乐', 'ktv', '影院', '电影', '洗浴', '游乐', '健身']]
]

/* ---------------- 工具函数 ---------------- */

const pad = n => (n < 10 ? '0' + n : '' + n)

/** 去掉空白与括号里的说明，如「面积（㎡）」→「面积」 */
function normalizeKey(key) {
  return String(key)
    .replace(/[\s　]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[＊*]/g, '')
}

/** 按第一个冒号切分；没有冒号返回 null */
function splitLine(line) {
  const idx = line.search(/[：:]/)
  if (idx <= 0) return null
  return {
    key: line.slice(0, idx).trim(),
    value: line.slice(idx + 1).trim()
  }
}

/** 从「89㎡」「￥1,800/月」里取数字 */
function parseNum(value) {
  const m = String(value).replace(/,/g, '').match(/\d+(\.\d+)?/)
  return m ? m[0] : ''
}

/** 2026-11-01 / 2026/11/1 / 2026年11月1日 / 11月1日 → 2026-11-01 */
function parseDate(value) {
  const s = String(value).trim()
  if (!s) return ''

  let m = s.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/)
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`

  m = s.match(/(\d{1,2})\s*[-/.月]\s*(\d{1,2})/)
  if (m) return `${new Date().getFullYear()}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`

  return ''
}

/** 招租 / 求租 / 出售 / 求购（「无中介」不是类型，见 parseDraft 里的 noAgency 标记） */
function parseDealType(value, type) {
  const s = String(value)
  if (type === 'house') {
    if (/求租|找房|想租|租入/.test(s)) return 'rent_in'
    if (/招租|出租|整租|转租|合租|租出/.test(s)) return 'rent_out'
    return ''
  }
  if (type === 'secondhand') {
    if (/求购|求买|收购|想收|求收/.test(s)) return 'buy'
    if (/出售|转让|转卖|出|卖/.test(s)) return 'sell'
    return ''
  }
  return ''
}

/** 失物招领的性质：招领（我捡到）/ 寻物（我在找）；不是失物返回空 */
function parseLfType(value) {
  // 「失物招领」是分类名，本身不代表性质，先整词去掉再判断，
  // 否则「分类：失物招领」会被里面的「招领」二字误判成 found
  const s = String(value).replace(/失物招领/g, '')
  if (!s) return ''
  // 先判「招领」：捡到东西的人写「拾获」「捡到」
  if (/招领|拾到|拾获|捡到|拣到|认领/.test(s)) return 'found'
  if (/寻物|丢失|遗失|丢了|寻找|找东西|寻/.test(s)) return 'lost'
  return ''
}

function parseIndustry(value) {
  const s = String(value).toLowerCase()
  for (let i = 0; i < INDUSTRY_MAP.length; i++) {
    const key = INDUSTRY_MAP[i][0]
    const words = INDUSTRY_MAP[i][1]
    if (words.some(w => s.indexOf(w) >= 0)) return key
  }
  return 'other'
}

function parseBool(value) {
  return /^(是|要|需要|有|广告|true|1|y|yes)$/i.test(String(value).trim())
}

function clip(str, max) {
  const s = String(str || '')
  return s.length > max ? s.slice(0, max) : s
}

/* ---------------- 主函数 ---------------- */

/**
 * 解析剪贴板文本
 * @param {string} text 原始文本
 * @param {string} type house | secondhand | offer
 * @returns {object} { ok, type, dealType, industry, lfType, weight, form, ext, unknown }
 */
function parseDraft(text, type) {
  const targetType = type === 'secondhand' || type === 'offer' ? type : 'house'

  const draft = {
    ok: false,
    type: targetType,
    dealType: '',
    industry: '',
    // 失物招领的性质（lost / found），命中时同时把 industry 设为 lostfound
    lfType: '',
    weight: 0,
    form: {
      title: '',
      summary: '',
      content: '',
      contactName: '',
      contactPhone: ''
    },
    ext: {
      district: '',
      community: '',
      layout: '',
      area: '',
      floor: '',
      rent: '',
      category: '',
      condition: '',
      price: '',
      merchantName: '',
      address: '',
      startAt: '',
      expireAt: '',
      isAd: false,
      // 失物招领（生活信息下的一个分类），地点复用 address
      lfType: 'lost',
      itemName: '',
      happenAt: '',
      reward: '',
      // 招租的「无中介」标记（不是独立分类）
      noAgency: false
    },
    unknown: []
  }

  // 合并别名表：通用 + 当前类型
  const aliasMap = {}
  const collect = group => {
    Object.keys(group || {}).forEach(field => {
      group[field].forEach(alias => {
        aliasMap[alias] = field
      })
    })
  }
  collect(COMMON_ALIAS)
  collect(TYPE_ALIAS[targetType])

  let lastName = ''
  const lines = String(text || '').split(/\r?\n/)

  lines.forEach(raw => {
    const line = String(raw).trim()
    if (!line) return
    if (/^[#＃]/.test(line)) return // 注释
    if (/^[【\[]/.test(line)) return // 【标题】装饰行

    const pair = splitLine(line)

    // 无冒号：作为上一条「说明」的续行
    if (!pair) {
      if (lastName === 'content') {
        draft.form.content += (draft.form.content ? '\n' : '') + line
      }
      return
    }

    const field = aliasMap[normalizeKey(pair.key)]
    if (!field) {
      if (pair.key) draft.unknown.push(pair.key)
      return
    }

    const value = pair.value
    if (!value) return

    if (field === 'dealType') {
      // 「类型：无中介租房」这类写法：类型仍是招租，只把无中介标记打上
      if (targetType === 'house' && /无中介|直租|没有中介/.test(value)) draft.ext.noAgency = true
      draft.dealType = parseDealType(value, targetType) || draft.dealType
      lastName = field
      return
    }
    if (field === 'industry') {
      draft.industry = parseIndustry(value)
      // 「分类：失物招领」时顺手识别寻物/招领
      if (draft.industry === 'lostfound') {
        const lf = parseLfType(value)
        if (lf) {
          draft.lfType = lf
          draft.ext.lfType = lf
        }
      }
      lastName = field
      return
    }
    if (field === 'lfType') {
      const lf = parseLfType(value)
      if (lf) {
        draft.lfType = lf
        draft.ext.lfType = lf
        // 写了寻物/招领，就归到「失物招领」这个分类下
        draft.industry = 'lostfound'
      }
      lastName = field
      return
    }
    if (field === 'weight') {
      const num = parseNum(value)
      draft.weight = num ? Number(num) : /置顶|推荐/.test(value) ? 100 : 0
      lastName = field
      return
    }
    if (field === 'area' || field === 'rent' || field === 'price') {
      draft.ext[field] = parseNum(value)
      lastName = field
      return
    }
    if (field === 'startAt' || field === 'expireAt' || field === 'happenAt') {
      draft.ext[field] = parseDate(value)
      lastName = field
      return
    }
    if (field === 'isAd') {
      draft.ext.isAd = parseBool(value)
      lastName = field
      return
    }

    if (TEXT_FIELDS.indexOf(field) >= 0) {
      if (field === 'contactPhone') {
        draft.form.contactPhone = String(value).replace(/[^\d]/g, '')
      } else if (field === 'title') {
        draft.form.title = clip(value, 30)
      } else if (field === 'summary') {
        draft.form.summary = clip(value, 40)
      } else if (field === 'content') {
        draft.form.content = clip(value, CONTENT_MAX)
      } else if (field === 'contactName') {
        draft.form.contactName = clip(value, 20)
      } else if (draft.ext.hasOwnProperty(field)) {
        draft.ext[field] = value
      } else {
        draft.form[field] = value
      }
      lastName = field
    }
  })

  // 兜底：什么都没写标题，说明里第一行当标题
  if (!draft.form.title && draft.form.content) {
    const firstLine = draft.form.content.split('\n')[0].trim()
    if (firstLine) draft.form.title = clip(firstLine, 30)
  }

  draft.form.content = clip(draft.form.content, CONTENT_MAX)
  draft.ok = !!(draft.form.title || draft.form.content)
  return draft
}

module.exports = {
  TEMPLATES,
  parseDraft
}
