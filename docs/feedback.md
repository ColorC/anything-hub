# 本地问题反馈

`src/web/feedback.js` 导出 `setupFeedback({ frame, game, getBase })`。`frame` 是同源游戏 iframe；`game` 是包含 `id`、`commit` 的对象或返回该对象的函数；`getBase()` 返回宿主基础 URL。返回的 `open()` 打开反馈面板；`stop()` 清除该实例的监听、console/fetch 包装、圈选覆盖层和面板。切换游戏时先调用 `stop()`，再创建新实例。共享 CSS 只注入一次。

反馈面板可填写问题简述和复现步骤，圈选 DOM 元素或拖动圈选区域，生成 PNG 预览，复制定位链接、导出 JSON 或主动保存本地报告。圈选 DOM 时同一位置重复点击循环选择 `elementsFromPoint()` 的下层元素；圈选过程阻止点击触发游戏按钮；覆盖层本身不参与命中。选中后点击“完成圈选”，移除覆盖层后再调用 html2canvas 生成截图。

Canvas 内部绘制内容没有 DOM 节点：只能定位整个画布或手动框选区域。截图通过 html2canvas 克隆页面中的 canvas；未保留绘制缓冲的 WebGL 画布可能出现空白，用户应检查预览。截图只包含游戏当前可见视口；跨源图像由浏览器与 html2canvas 的 CORS 规则限制。跨源 iframe 不尝试绕过同源限制，仍允许保存文字描述。

html2canvas 的临时 about:blank 文档可能使用宿主页的基础 URL，导致游戏的相对 CSS 地址失效。截图克隆保留原游戏的 `document.baseURI`，重新加载指向原文档绝对地址的 stylesheet，并等待样式和字体加载，各最多 5 秒；样式失败直接提示截图失败。样式完成后恢复捕获前的滚动位置；排除源页面原本不显示的 noscript 备用内容。范围滑块保留位置，文字输入仍遮盖。截图验收需要与真实 iframe 的浏览器截图比较网格、字体、按键尺寸，不能仅检查 PNG 非空。浏览器原生表单控件边框、背景边缘和抗锯齿可能存在 html2canvas 渲染近似差异，不声称像素一致。

在 iframe 加载后仅收集有限的 `console.warn` / `console.error`、window error、未处理 Promise rejection、fetch 拒绝及非成功 HTTP 状态。原始 console 方法和 fetch 响应保持游戏行为；停止时只恢复仍属于本实例的包装。用户点击反馈入口后才收集点击、滚动和按键类别，不读取输入文字、请求正文、响应正文或任意对象属性。所有类别共用最大 100 条的内存环形缓冲；URL 去除用户名、密码、query 和 fragment；文本截断并遮盖常见 token/密码形式。截图清空输入框、可编辑内容，并排除 `input[type=password]` 和 `[data-feedback-private]`。额外敏感游戏元素应标为 `data-feedback-private`。不使用全面会话录制。

保存按钮主动发送同源 `POST api/reports`；在此之前没有上传。请求包含 `gameId`、`summary`、`details`、`selector`、`selection`、`screenshot`、`diagnostics`、`commit`。`selection` 使用游戏文档坐标，结构为 `{ x, y, width, height }`；截图为 PNG data URL。诊断包含 events、console、errors、network、environment 与 capturedAt。服务器应返回 `{ report: { id, url, downloadUrl, createdAt } }`；前端只接受同源 HTTP(S) 报告链接。组件不向 GitHub/Gitee 创建 issue。

游戏未运行或构建失败时同样能填写和保存报告；页面圈选与截图按钮禁用并显示原因。安装/构建日志由报告服务保存报告时自动附加，不在浏览器重复拉取。保存请求有 15 秒截止时间，截图的图像加载等待最多 8 秒。

“导出 JSON”直接用浏览器下载当前记录，不调用报告接口。“复制定位链接”使用 `?game=<id>&pick=<CSS selector>`；宿主页应按 `game` 选择游戏，组件在 iframe 加载后定位 `pick` 元素。定位链接仅指向页面元素，不包含用户输入或网络凭据。

需要 `html2canvas` 依赖，由宿主页的 esbuild 流程打包。可用 `node --check src/web/feedback.js` 验证语法；实际截图、圈选及报告保存必须在浏览器中验收。
