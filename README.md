# 三品信息

本地便民信息小程序（微信原生 + 云开发）。内容由管理员统一发布，用户只读浏览。

## 功能

- **三个大类**：房源租售（招租 / 求租）、二手闲置（出售 / 求购）、生活信息（含失物招领、餐饮、超市、娱乐等分类）
- 首页长按标题进入管理后台（隐藏入口，仅白名单 openid 可用）
- 管理台：发布 / 编辑 / 上下架 / 权重 / 统计 / 轮播图 / 公告 / 剪贴板批量导入 / 测试数据
- 详情页长文折叠（超过 6 行显示「展开全文」）、图片预览、联系与复制
- 自定义 tabBar，中间为「联系客服」（`open-type="contact"`）

## 目录结构

```
sanpin/
├── miniprogram/
│   ├── app.js / app.json / app.wxss
│   ├── custom-tab-bar/        自定义底部导航（含联系客服）
│   ├── pages/                 主包：index / list / detail / about
│   ├── packageAdmin/          分包：manage / publish / notices / banners
│   └── utils/                 cloud / config / util / infoQuery / noticeQuery
├── cloudfunctions/
│   ├── infoList/              列表查询（分页 + 筛选 + 缓存）
│   ├── infoDetail/            详情查询（浏览量自增）
│   ├── adminAction/           管理端统一入口（发布 / 管理 / 轮播 / 公告 / 导入）
│   └── expireOffers/          定时任务：过期活动自动下架
└── project.config.json
```

## 本地运行

1. 用微信开发者工具「导入项目」，选择本目录
2. 在 `project.config.json` 把 `appid` 换成你自己的小程序 AppID（云开发需要真实 AppID）
3. 开通云开发，创建环境后把环境 ID 填到 `miniprogram/app.js` 的 `CLOUD_ENV`
4. 在云开发控制台建集合 `infos`、`banners`、`notices`，给 `infos` 建索引：`status + type + updatedAt`
5. 右键 `cloudfunctions` 下每个函数「上传并部署：云端安装依赖」
6. 配置云函数环境变量 `ADMIN_OPENIDS`（管理员 openid，多个用英文逗号分隔）
7. 编译运行，首页长按标题进入后台，用「写入测试数据」灌入示例数据

## 数据模型

`infos` 集合统一存放三类信息，公共字段 `title / summary / content / tags / images / contact / views / status / weight`，分类差异放在 `ext`：

| 类型 | `ext` 关键字段 |
|---|---|
| `house` | `dealType`(rent_out/rent_in)、`noAgency`、`district`、`community`、`layout`、`area`、`floor`、`rent`、`isAd` |
| `secondhand` | `dealType`(sell/buy)、`category`、`condition`、`price` |
| `offer` | `industry`（`lostfound` 表示失物招领）、`lfType`(lost/found)、`itemName`、`address`、`happenAt`、`reward`、`expireAt`、`isAd` |

## 注意

- 详细说明上限 2000 字，云函数 `adminAction` 的 `buildPayload` 也是 2000，再放宽需同步修改
- 云存储图片需把权限设为「所有用户可读」，否则他人看不到图
- 内容发布前会走 `security.msgSecCheck` 安全检测
