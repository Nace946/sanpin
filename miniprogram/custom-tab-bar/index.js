// custom-tab-bar/index.js
// 自定义底部导航：首页 / 联系客服 / 关于
//
// 为什么不用原生 tabBar：原生 tabBar 的每一项只能「切换页面」，无法直接唤起客服会话；
// 自定义后中间项可以是一个 open-type="contact" 的按钮，点一下就直接进客服对话。
//
// 两种客服模式（由 utils/config.js 的 CONTACT 决定）：
//   1) 默认：小程序原生客服 —— 后台「客服」里添加客服人员微信即可，点击直接开会话
//   2) 企业微信「微信客服」—— CONTACT.corpId + CONTACT.serviceUrl 都填写后自动切换，
//      点击调用 wx.openCustomerServiceChat，支持欢迎语、转人工等能力
const config = require('../utils/config')

Component({
  data: {
    selected: 0,
    tabs: [
      { index: 0, text: '首页', pagePath: '/pages/index/index' },
      { index: 1, text: '关于', pagePath: '/pages/about/about' }
    ],
    // 企业微信客服配置（为空则走小程序原生客服）
    kfCorpId: '',
    kfUrl: ''
  },

  lifetimes: {
    attached() {
      const c = config.CONTACT || {}

      // 首次渲染时按「当前所在页面」决定高亮：页面 onShow 有可能早于本组件创建，
      // 只靠页面回写会出现一瞬高亮错位（尤其从分享卡片直接进关于页时）
      let selected = 0
      try {
        const pages = getCurrentPages()
        const route = pages.length ? pages[pages.length - 1].route || '' : ''
        selected = route.indexOf('pages/about') === 0 ? 1 : 0
      } catch (err) {
        console.warn('[tabbar] 读取当前页面失败，使用默认高亮', err)
      }

      this.setData({
        selected,
        kfCorpId: c.corpId || '',
        kfUrl: c.serviceUrl || ''
      })
    }
  },

  methods: {
    /** 首页 / 关于：普通 tab 切换 */
    onTabTap(e) {
      const index = Number(e.currentTarget.dataset.index)
      const tab = this.data.tabs[index]
      if (!tab) return

      this.setData({ selected: index })
      wx.switchTab({ url: tab.pagePath })
    },

    // ---------------- 隐藏功能：长按首页项 = 强制刷新 ----------------

    /**
     * 长按（系统默认时长，约 350ms）后执行：
     * - 已在首页：直接调用页面的 onLongPressRefresh
     * - 在关于页：先切回首页，用 globalData 标记让首页 onShow 接上刷新
     * 界面上没有任何文字说明；原生 longpress 触发后微信不会再补发 tap，因此无需额外拦截
     */
    onHomeLongPress() {
      const pages = getCurrentPages()
      const page = pages.length ? pages[pages.length - 1] : null
      const isIndex = !!page && (page.route || '').indexOf('pages/index') === 0

      if (isIndex) {
        if (typeof page.onLongPressRefresh === 'function') page.onLongPressRefresh()
        return
      }

      const app = getApp()
      if (app && app.globalData) app.globalData.homeRefreshPending = true
      wx.switchTab({ url: '/pages/index/index' })
    },

    /** 企业微信客服模式：点击中间项直接打开客服会话 */
    onServiceTap() {
      const { kfCorpId, kfUrl } = this.data
      if (!kfCorpId || !kfUrl) return

      wx.openCustomerServiceChat({
        extInfo: { url: kfUrl },
        corpId: kfCorpId,
        showMessageCard: false,
        fail: err => {
          console.error('[tabbar] openCustomerServiceChat failed', err)
          wx.showToast({ title: '客服会话打开失败，请稍后重试', icon: 'none' })
        }
      })
    }
  }
})
