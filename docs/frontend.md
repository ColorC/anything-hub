# 浏览器入口

源码为 `src/web/index.html`、`src/web/app.js`、`src/web/styles.css`。`npm run build:web` 使用 esbuild 生成 `publish/web/app.js`，服务入口加载该预构建脚本。

结构参考实际浏览的 [itch.io HTML5 目录](https://itch.io/games/html5) 与 [Sort the Court! 作品页](https://graebor.itch.io/sort-the-court)：紧凑顶栏、左侧筛选、目录标题与排序、密集小卡片、作品标题/作者/说明/元数据和独立运行区。无首页宣传区、固定试玩、虚构评分、销量或作品封面；现有游戏使用本地原创 SVG 示意图，未复用 itch.io 品牌素材。

## 页面与深链接

| 页面 | 原生 URL | 行为 |
| --- | --- | --- |
| 目录 | `?view=browse` | 搜索与类别、许可、来源筛选，点击卡片进入详情 |
| 我的游戏 | `?view=library` | 安装过或正在准备的作品，保留目录筛选 |
| 详情 | `?view=detail&game=<id>` | 标题、仓库作者、说明、源码/作者链接、安装或开始 |
| 运行 | `?view=play&game=<id>` | 独立宽幅 iframe、返回详情、全屏打开、反馈 |
| 下载任务 | `?view=downloads` | 作品安装状态、重试和主动展开日志 |
| 问题记录 | `?view=reports` | 查看本地报告或导出给创作者 |

`q`、`genre`、`license`、`source`、`sort` 在目录 URL 保存筛选；支持 `#/detail?game=<id>` 等 hash 路由、旧 `?game=<id>#play` 链接及浏览器前进/后退。组件锚点如 `#license`、`#readme`、`#diagnostics`、`#task-<id>`、`#report-<id>` 能定位并主动展开对应区域。反馈模块追加的 `pick` 参数保留在当前作品运行链接中。复制按钮和组件右键可复制深链接；剪贴板不可用时显示可选中的链接。

详情安装完成仍留在详情，用户点击“开始游戏”才进入运行；已处于运行页的安装完成后打开 iframe。初始目录不选择作品、不设置 iframe 地址。切换作品或离开运行页停止旧反馈实例并清空 iframe；详情未运行、安装失败时同样能反馈。

## 后端资料与操作

目录读取 `GET api/catalog` 的 `games`、`reports` 和 `machine.hostname`。保留原有 `title/repo/license/status/commit/mode/task`，新增字段按后端契约读取：

- `source.repository/provider/ref/commit`：仓库来源与版本。
- `compatibility.kind/label/output/entry/reason`：接入方式及检测结果。
- `provenance.licenseText/readme/author/version`：真实许可与仓库说明。许可全文、README 默认折叠，内容通过 `textContent` 写入；未读到全文时明确提示并提供原仓库链接，不编造许可。

添加仓库使用 `POST api/catalog/import {repo,title?,ref?,output?}`，接收 `202 {gameId,task}`，关闭表单并进入新作品详情，显示安装状态与下载任务链接。仓库地址是主输入，名称、版本与网页入口目录放在可选设置中。既有安装接口为 `POST api/games/<id>/install`；日志为 `GET api/games/<id>/log`，仅在展开日志后请求。

EventSource `api/events` 更新状态与日志，断连后用有界 HTTP 请求和固定间隔备援，连接恢复停止备援。所有服务与游戏 URL 相对页面根解析并限定同源；外部源码/作者链接只允许 HTTP(S) 且拒绝嵌入凭据。问题报告仍由原有 `setupFeedback({frame,game,getBase})` 负责，不改变截图、圈选或报告接口，不向公开仓库写 Issue。

顶栏只显示 `GET api/catalog` 返回的实际 `machine.hostname`，通过 `textContent` 写入“运行主机：…”；不根据浏览器地址判断物理位置。初始、缺失或空主机名、目录请求失败及连接中断时显示“运行主机待确认”，每次成功刷新目录都会更新主机名。连接状态单独显示“已连接”或断开重试。主机菜单、报告页、导入表单说明下载、构建和报告保存所在的实际主机，网页游戏在当前浏览器中显示和操作；菜单保留 Windows 下载地址，并提供 `#runtime-info` 深链接复制按钮。移动端顶部导航换行，侧栏通过“筛选作品”展开；主机名称和其他文本保持可选中。

## 终检定位

- 详情主动作：`#detail-action`，按实际状态显示“安装游戏”“正在安装…”“重试安装”“开始游戏”。
- 原链接：`#detail-view` 内文本“源代码 ↗”“原作者 ↗”；全文折叠：`#license > summary`、`#readme > summary`、`#compatibility > summary`、`#diagnostics > summary`。
- 运行：`#game-frame`、`#back-to-detail`、`#fullscreen-link`、`#feedback-button`。
- 目录：`#game-search`、`#game-sort`、`#genre-filters`、`#license-filters`、`#source-filters`、`#toggle-filters`。
- 导入：`#add-repository`、`#repository-url`、`#repository-title`、`#repository-ref`、`#repository-output`、`#submit-import`。

源码检查使用 `node --check src/web/app.js`；视觉、实际安装和圈选截图仍需宿主构建后的真实浏览器验收，不能把静态检查当成这些功能已通过。
