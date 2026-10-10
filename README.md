# Anything Hub / 创意工坊

一个还在试验中的开源想法：作品中心只提供目录、搜索与统一入口；用户自己的电脑从公开 Git 仓库下载游戏，需要时安装依赖、构建并运行。游戏文件和问题报告留在运行启动器的电脑上。

**这是原型草稿，暂未作为正式产品维护。** 当前试验覆盖 Windows x64 网页游戏，桌面启动器打开浏览器。欢迎以后从这里继续完善。

[Windows 便携包与版本](https://github.com/ColorC/anything-hub/releases) · [仓库接入约定](docs/repository-format.md) · [反馈组件](docs/feedback.md)

## 已实现的部分

- 作品浏览、搜索、详情、我的游戏、下载任务和问题记录；界面参考 itch.io 的作品浏览结构。
- 粘贴公开仓库地址添加作品，显示来源、许可证、README 与下载后的 Git commit。
- 静态 HTML5 游戏直接运行；约定格式的 npm 网页项目在运行电脑上构建。
- 问题位置圈选、截图、有限错误记录、本地构建日志，以及可导出的 HTML / JSON 报告。
- Windows 桌面 EXE 启动已打包的核心与界面，无需用户先安装中心的开发环境。

顶栏显示实际运行主机名。通过远程浏览器访问时，下载、构建和报告仍发生在该主机上；游戏画面在当前浏览器中显示。

## 使用 Windows 便携包

到 [Releases](https://github.com/ColorC/anything-hub/releases) 下载 `AnythingHub-windows-x64.zip`，解压后双击 `anything-hub/创意工坊.exe`。浏览器会打开 `http://127.0.0.1:42100/`，不需要登录中心账号。

包内带有预先构建的核心、界面，以及便携 Node/npm 和 MinGit。游戏按需下载，包内不预装游戏和用户报告；首次下载与源码构建需要网络。运行数据保存在解压目录的 `runtime/` 中。

## 从源码运行

需要 Node.js 24、npm 和 Git：

```sh
npm ci
npm run build
npm start
```

在运行电脑的浏览器打开 `http://127.0.0.1:42100/`。默认服务只监听 loopback。`HUB_HOME` 可设置独立的绝对运行目录，`HUB_PORT` 可修改端口。远程访问需要自行配置网关和访问保护；原型不提供公共托管服务。

构建输出为 `publish/core/server.mjs` 和 `publish/web/app.js`。已经构建好的中心运行时不需要 `node_modules`；作品自身的构建依赖另行下载。

维护者在 Windows 上构建便携包：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File src/package-windows.ps1
```

该命令需要 Windows 自带的 .NET Framework C# 编译器和 curl，输出 `publish/windows/AnythingHub-windows-x64.zip`，不修改全局 Node/Git 配置。

## 接入约定与范围

当前适配两类仓库：

1. 含 `index.html`、使用相对本地资源路径的静态网页。
2. 根目录含 `package.json`、`package-lock.json` 和 `scripts.build`，输出 `dist/index.html` 或 `build/index.html` 的 npm 项目。

可以指定分支、标签或其它相对输出目录。用户添加的作品保存到 `runtime/catalog.json`，不需要修改中心代码。识别、下载或构建失败会保留具体原因与日志。

Windows 上已实际从 GitHub 下载并运行 [2048](https://github.com/gabrielecirulli/2048)、[Hello 猜单词](https://github.com/lynn/hello) 和 [Hextris](https://github.com/Hextris/hextris)，其中 Hello 执行了本地 npm 构建。作品使用各自的许可证，公开地址本身不代表有开源许可。

GitHub、Gitee、GitLab、Codeberg 地址格式可以识别；后三者仅验证过 URL 与本地测试夹具，尚未完成真实网络安装验证。国内网络能否下载取决于具体 Git 源和依赖源。

尚未实现通用构建沙箱、任意引擎适配、发布版本 ZIP 导入、自动提交外部 issue、创作者账号服务与 macOS/Linux 桌面包。手机目前可作为浏览器连接一台已运行的主机，不能独立安装或构建游戏。

构建脚本会以运行用户的权限执行，请只安装自己信任的仓库。游戏页面会限制外部自动加载资源，但这不隔离 npm 构建脚本的权限。

## 数据与恢复

`runtime/` 独立保存新增目录、安装状态、游戏源码、npm 缓存、构建日志和用户主动保存的问题报告。升级前保留该目录；关闭中心后换用新程序，再使用同一 `HUB_HOME`。删除运行数据前应先导出报告和自定义目录。

公开仓库保存源码、接入说明和测试；预构建包放在 Releases。重新开始开发只需克隆仓库并执行上面的构建命令。

## 验证与许可

```sh
npm test
```

测试覆盖仓库来源核验、接入约定、静态资源限制、安装失败和本地报告读写。截图、游戏键盘操作和手机布局仍需要浏览器验证。

中心代码使用 MIT；第三方声明见 [THIRD_PARTY_NOTICES](docs/THIRD_PARTY_NOTICES.md)。便携工具保留官方许可证，游戏及其依赖遵循各自的许可。
