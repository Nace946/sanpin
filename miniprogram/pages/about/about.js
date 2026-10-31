// pages/about/about.js
// 关于页：文案与联系方式全部写死在 utils/config.js 的 SITE / CONTACT
// 无网络请求、无缓存、无云函数调用，纯静态渲染
const config = require('../../utils/config')

Page({
  data: {
    appName: '',
    slogan: '',
    version: '',
    contact: {
      wechat: '',
      workTime: ''
    }
  },

  onLoad() {
    this.setData({
      appName: config.SITE.appName,
      slogan: config.SITE.slogan,
      version: config.SITE.version,
      contact: {
        wechat: config.CONTACT.wechat,
        workTime: config.CONTACT.workTime
      }
    })
  },

  onShow() {
    // 自定义 tabBar：切到关于页时同步选中态
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 })
    }
  },

  /** 复制客服微信号（微信号无法直接跳转，复制后到微信搜索添加） */
  onCopyWechat() {
    const wechat = this.data.contact.wechat
    if (!wechat) {
      wx.showToast({ title: '暂未配置客服微信', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: wechat,
      success: () => {
        wx.showModal({
          title: '微信号已复制',
          content: '打开微信「添加朋友」粘贴搜索，即可添加客服微信。',
          showCancel: false
        })
      }
    })
  }
})
