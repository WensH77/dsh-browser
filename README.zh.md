# dsh 浏览器操作

[English](README.md) | **中文**

<img width="1701" height="897" alt="dsh 浏览器操作" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 连接到你正在使用的 Chrome 标签页。模型可以读取页面内容、点击控件、填写表单、滚动与导航，同时保留登录态、会话和 Cookie。状态视图（默认浮窗，也可用侧边栏）会显示当前正在操作哪个页面。

`dsh` 是由 DeepSeek AI 开发的开源、插件化 agent harness（智能体框架）。本仓库将配套的浏览器桥插件与 Chrome MV3 扩展组成一个独立的 pnpm workspace。

页面会转换为结构化文本和带编号的交互元素清单，模型通过编号定位元素。`browser_snapshot` 会把这份文本与同一时刻的截图一起返回，`browser_capture` 按需只返回截图——两者都只对支持图片输入的模型生效，且截图只存在内存里：扩展不落盘；纯文本模型会降级为文本快照并说明原因。截图走 `chrome.debugger`，需要扩展设置里的调试开关（默认关闭，见[核心能力](#核心能力)）。

> [!IMPORTANT]
> 本仓库把运行时 pin 在 `0.1.7-rc.1`：npm 上 `@deepseek-ai/dsh` 的 `latest` 现在是 `0.1.7-rc.2`、`next` 是 `0.2.0-rc.1`，而桥插件声明的对等范围是 `>=0.1.7-rc.1 <0.3.0`，所以同一个插件可以挂在这条范围内任何 dsh 上。升级过程与版本对照见 [升级记录](docs/dsh-0.1.7-rc-upgrade.md)。

## 快速安装

本项目不能只使用标准的 `dsh plugin` 命令安装。它同时包含 dsh bridge plugin 和浏览器扩展。一行安装器目前会安装 Chrome 构建。

macOS 与 Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/WensH77/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

Windows（PowerShell）：

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/WensH77/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

安装器把扩展文件放进 `~/.dsh/browser-extension` 并打开 `chrome://extensions`：在那里加载或重新加载一次 **AI 浏览器助手**——这是浏览器侧唯一要手点的动作；然后重启一次 dsh。扩展文件的同步由插件在启动时自动完成，不用手工复制目录。扩展设置里的「允许浏览器调试」默认关闭，截图、控制台、网络、执行页面 JS 和 `browser_dialog` 这几个工具需要它，见[核心能力](#核心能力)的表注。以后每次更新：重跑同一条安装命令，再在 Chrome 点一次「重新加载」。前置要求、启动命令、更新方式和开发命令详见[详细安装与使用](#详细安装与使用)。

> [!IMPORTANT]
> npm 上未加 scope 的 [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) 包属于另一个项目，与本仓库无关。本项目目前没有发布 npm 包，请使用上方安装器。

## 核心能力

| 能力 | 工具 | 说明 |
|---|---|---|
| 读取页面 | `browser_snapshot` | 结构化文本快照：标题/URL/正文/编号交互清单/表单字段（敏感值掩码）；`delta: true` 只返回变化；默认附带同刻截图，`visual: false` 可关 |
| 截取页面 † | `browser_capture` | 返回视口截图（`fullPage: true` 为整页），仅内存、不落盘。优先用视口——长页面的整页截图会被压到模型图像预算内，文字不可读 |
| 读控制台与网络 † | `browser_console` / `browser_network` | 控制台消息与未捕获错误（带 cursor 增量）；请求列表含状态与耗时、按 id 取响应体、内存内响应替换 |
| 回应用户弹窗 † | `browser_dialog` | 确认或取消 `alert` / `confirm` / `prompt`；这类弹窗会冻住页面，回应之前其它工具都会卡住 |
| 执行页面 JS † | `browser_eval` | 在页面自身上下文求值，不受页面 CSP 限制；每次单独审批 |
| 阻断/改写请求 | `browser_block` / `browser_headers` | 阻断匹配请求，或改写请求/响应头；仅作用于受控标签页、仅当前浏览器会话 |
| 点击元素 | `browser_click` | 按编号或 CSS 选择器点击链接/按钮/复选框等；目标是原生 `<select>` 时用 `option` 传值或可见文本选中（合成点击打不开原生下拉，选项用 `browser_dom_query { fields: ["options"] }` 读） |
| 点击绑定在按压上的控件 | `browser_click_pointer` | 在元素矩形中心派发 `pointerdown`、`mousedown`、`pointerup`、`mouseup`、`click`；用于 Google Slides 这类画布/SVG 编辑器——`browser_click` 回报成功但页面没反应时改用它 |
| 跳到 Slides 某一页 | `browser_slides_open_page` | 按 1 起的页码打开演示文稿的某一页：走编辑器的网格视图，用 URL hash 核对落点，点击无效时按 hash 载入。比自己去点胶片栏缩略图可靠——胶片栏的按压是按坐标判定的 |
| 填写表单 | `browser_type` | 按编号或 CSS 选择器输入文本（React/Vue 受控组件兼容），`replace` 清空重填 |
| 按键 | `browser_press` | 键盘事件（Enter/Tab/Escape/方向键…） |
| 滚动 | `browser_scroll` | 视口滚动（up/down/top/bottom） |
| 页面导航 | `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | 受控标签页内导航，保留登录态 |
| 读取区域 | `browser_get_text` | 懒加载内容 / 局部文本；`find`（配 `context`）按文本定位并返回有界窗口 |
| 查询元素 | `browser_dom_query` | 按 CSS 选择器读指定字段，每个匹配都带一个经校验唯一的选择器可直接操作 |
| 看图 | `browser_image` | 按引用取回页面里的图片（img/canvas/SVG/背景图），原分辨率返回；不需要调试能力，DevTools 开着或后台标签页都能用 |
| 绑定页面 | `browser_bind_interactive` | 列出可绑定页面、让用户选一个并绑定本会话 |
| 导出 Google 文档 | `google_drive_export` | 仅 Docs/Sheets；这两类页面不接受页面工具，要读就用它导出。Slides 与 Drive 文件按普通页面读 |
| 查看桥状态 | `browser_status` | 连接状态、扩展 id 与版本、协议/工具集是否与插件匹配、镜像文件是否最新、最近的调试事件，以及唯一的下一步 |
| 刷新扩展文件 | `browser_setup` | 把插件里的扩展文件镜像到 `~/.dsh/browser-extension`，并打开 `chrome://extensions` |
| 打印更新命令 | `browser_update` | 只打印这台机器该跑的更新命令，不替你执行 |
| 等待稳定 | `browser_wait` | 页面加载与渲染稳定检测 |

† 这五个工具走 Chrome 的 `chrome.debugger`，由扩展设置里的**「允许浏览器调试」**控制，该项首次安装时是关闭的：关着的时候插件根本不会注册它们，模型看不到也调不到，需要时在 options 页打开（改完桥会重连，能力随握手带过来）。`browser_snapshot` 本身不受影响，但它默认附带的那张同刻截图同样要经过 `chrome.debugger`：关着时结果里只有文本，并附一句截图不可用的原因。同一标签页开着 DevTools 时 Chrome 拒绝第二个调试器，工具会直接说明这一点。

## 组成

```
packages/browser/bridge-browser/   桥插件：WebSocket 通道 + browser_* 工具集
extensions/dsh-browser/            Chrome MV3 扩展（后台/内容脚本/侧边栏与浮窗/options）
.dsh/skills/                       随仓库分发的技能
scripts/install.sh                 安装器（macOS/Linux，Windows 用 install.ps1）
scripts/install-skills.mjs         技能安装（安装脚本的第 3 步）
docs/                              升级记录与调研笔记
```

## 为什么这样设计

- **使用你的真实浏览器，而不是无头副本**：模型操作你已经打开的页面，登录态、会话和 Cookie 均会保留。
- **纯文本页面接口**：编号控件、跨快照稳定 ID、delta 更新和敏感值掩码，使模型无需截图也能操作页面。
- **收窄隐私边界**：密码和支付卡字段始终显示为 `••••`，字段值不会离开页面。
- **调试能力要显式开启**：走 `chrome.debugger` 的工具默认不注册，用户打开设置后才出现在模型面前。
- **受保护的桥连接**：远程连接使用认证握手；桥只服务浏览器工具帧和两个桥内部 RPC；扩展把工具绑定到一个由用户控制的标签页。

## 详细安装与使用

前置要求：Node.js 22 或更新（安装器只检查 `node` 与 `pnpm` 是否存在）、Corepack/pnpm，以及 Chrome 116+（扩展的 `minimum_chrome_version`）。Windows 还需要系统自带的 Windows PowerShell 5.1，或 PowerShell 7+。

### 安装或更新

托管安装请运行：

```sh
curl -fsSL https://raw.githubusercontent.com/WensH77/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

Windows 请运行：

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/WensH77/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

安装器会下载 `main`、构建并注册桥插件、把 Chrome 扩展构建到 `~/.dsh/browser-extension`，然后打开 `chrome://extensions`。首次安装时把该目录作为已解压扩展加载；此后更新只需在该页点一次**重新加载**——扩展文件由插件在启动时自动同步到该目录（不再依赖重跑安装器），但已加载的扩展代码要 Chrome 重新载入才生效。dsh 正在运行时插件会在几秒内热加载。

`scripts/install.sh` 覆盖 macOS 与 Linux，`scripts/install.ps1` 覆盖 Windows；两者写入同一个托管工作区和同一份安装元数据。当系统提供剪贴板工具（`pbcopy`、`wl-copy`、`xclip`、`xsel` 或 PowerShell 的 `Set-Clipboard`）时，安装器会把扩展路径复制到剪贴板；无论是否复制成功都会打印该路径。若未检测到 Chrome/Chromium，安装器会打印对应的安装命令；设置 `DSH_INSTALL_BROWSER=1` 可让安装器尝试自动安装。

Windows 命令先下载 `install.ps1` 再执行，而不是管道给 `Invoke-Expression`：脚本是带 BOM 的 UTF-8，Windows PowerShell 依赖 BOM 才能正确显示中文，而 `Invoke-Expression` 无法处理开头的 BOM。

更新：重跑上面那条命令拉取新版本，再在扩展页点一次「重新加载」。不知道确切命令时问助手：它会用 `browser_update` 打印你这台机器该跑的那一条（并且不会替你执行）。

### 随仓库分发的技能

仓库同时把这些工具对应的操作经验作为技能放在 `.dsh/skills/` 下。放在仓库里的原因：浏览器行为的改动和针对该行为的经验能一起评审、一起提交；安装到 `~/.dsh/skills/` 的原因：技能文件系统提供方会扫描项目根目录（优先级 100）和用户目录 `~/.dsh/skills`（优先级 400），只留在仓库里的话，只有从本仓库启动的会话能用到。

`scripts/install-skills.mjs`（安装脚本的第 3 步，也可单独执行 `pnpm run skills:install`）把每个技能链接到 `~/.dsh/skills`；`--copy` 改为复制，Windows 安装脚本用的就是复制，因为在那里创建链接需要开发者模式或管理员权限。macOS 和 Linux 默认用符号链接，因此改仓库里的那份立即生效，安装出来的副本也不会与仓库脱节。技能只在其描述与当前任务匹配时才会加载，例如 `google-slides-via-browser` 只在受控标签页是 Google Slides 编辑器时加载。

### 启动与使用

启动托管安装：

```sh
cd ~/.dsh/dsh-browser && pnpm start
```

当前受支持的精确公开版本为钉定的 0.1.7 预发布版：

```sh
npx @deepseek-ai/dsh@0.1.7-rc.1 web
```

Chrome 本机使用无需配置。点击工具栏上的 DeepSeek 鲸鱼图标会打开状态视图——默认是浮窗，可在扩展设置里改成 Chrome 侧边栏：它显示连接状态、正在操作的标签页、本会话已授予的权限和最近的调试事件。打开任意 `http://` 或 `https://` 页面，等状态显示**已连接**即可。已有标签页会在第一次操作时自动加载；`chrome://` 等浏览器受保护页面、扩展商店，以及另一个扩展自己的页面（`chrome-extension://`）都不受支持。

连不上或工具缺失时，对助手说「浏览器桥什么状态」：`browser_status` 会报告扩展有没有连上、扩展构建的版本与协议级别是否和插件匹配（并直接说该「重载扩展」还是「重启 dsh」）、镜像文件是否最新、最近的调试事件，以及唯一的下一步；需要重新镜像扩展文件时用 `browser_setup`。

## 故障排查

**状态视图一直显示「未连接」**

- 确认本机 dsh web 正在运行（默认 `http://127.0.0.1:3080`）。
- 确认桥接已加载：浏览器打开 `http://127.0.0.1:3080/ext/bridge-config`，应返回类似 `{"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}` 的 JSON。如果返回的是网页而不是 JSON，说明当前运行的 dsh 早于桥接注册——重启 dsh 并刷新页面即可，扩展会自动重连。
- 扩展会自动探测 3080/3081/3090/14389/43189（dsh Desktop）端口。若 dsh 运行在其它端口，或使用 `--host 0.0.0.0` 远程部署，请在扩展设置页中填写地址与桥接 token。

**截图、控制台、网络、执行 JS、`browser_dialog` 这些工具不存在**

它们走 `chrome.debugger`，由扩展设置里的「允许浏览器调试」控制，该项首次安装时关闭；关着的时候插件不注册这些工具，模型看不到。打开后桥会重连，能力随握手带到模型面前。

**调试类工具报「另一个调试器已附加」**

受控标签页开着 DevTools 时，Chrome 拒绝第二个调试器。关掉该标签页的 DevTools 再重试。

**另一个会话正在操作浏览器**

一个扩展连接同时只服务一个会话。占用者存在时，新会话的绑定/调用会被拒绝，并报出占用它的会话 id；在那个会话里 Unbind（或让那边的会话结束）之后即可绑定。

## 开发

桥接插件和 Chrome 扩展都属于本仓库 workspace；所有命令均在本仓库根目录执行。首次开发安装运行 `pnpm install`。

```sh
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run skills:install

pnpm --filter dsh-bridge-browser run build
pnpm --filter dsh-bridge-browser run typecheck
pnpm --filter dsh-bridge-browser run test

pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run test
```

注意：

- 启动前桥接插件必须已有 `lib/` 供 Loader 加载；`scripts/install.sh` 和根目录 `pnpm run build` 都会先构建插件再构建扩展。
- `@deepseek-ai/dsh` 与桥接插件的依赖固定在同一条经过验证的公开发布线上（插件对等范围 `>=0.1.7-rc.1 <0.3.0`）；升级时必须同时更新 manifest、锁文件并重跑根目录检查。

## 安全

- 桥路径在 `/api` 信任栅栏之外，自带 bearer token 认证。
- Chrome 扩展的本地 Origin 保留零配置回环访问。
- 特权网关方法（`settings.*`/`credentials.*`/`host.open*`）对非回环来源一律拒绝。
- 单活动连接；页面读取默认走文本，模型路由声明支持图片输入时 `browser_snapshot` 会附带截图。走 `chrome.debugger` 的能力（截图、控制台、网络、执行页面 JS、`browser_dialog`）默认关闭，关着时插件不注册这些工具；附加调试器期间 Chrome 会显示它的调试提示条，截图只存在内存中、不写磁盘。密码和卡号值永不回传。
- 助手开始操作页面时，会在首次浏览器工具调用时绑定当时的活动标签页，此后一直操作**这个**标签页：你切去看别的页面（包括 Gmail）不会打断它，也不会撤掉正在等待你确认的弹窗——弹窗就在 dsh 页面里，你得能切过去点它。受控标签页关闭后才会暂停，直到下一次调用显式选择页面；扩展也绝不静默改绑到别的标签页。一个扩展连接同时只服务一个会话，第二个会话的绑定会被拒绝并报出占用者的会话 id，而不是抢走标签页。
- 网页文字会标记为不可信输入。默认「自动共享」只按需读取受控标签页且不额外弹窗；对隐私敏感时可选择「每次询问」，或用「关闭」完全阻断读取。在「每次询问」模式下，读取弹窗可以仅允许一次，也可以持久切回自动读取；之后仍可在设置中关闭。读取的页面文字会发送给当前选择的模型。
- 点击、输入、按键、导航、历史跳转和刷新默认失败关闭，必须由用户批准。会话的首次 `browser_navigate` 也是在批准之后才创建新标签，被拒绝或未应答的调用不会发出任何请求。默认策略下 `browser_navigate` 只能去当前受控页面所在的主机（换主机要先绑定或首次导航），要放开得在扩展设置里打开「允许跨域导航」；设置里另有一份禁用 origin 黑名单，命中即拒绝读取与操作。Google Drive 导出走同一套审批：按文档所在 origin 授权，信任该 origin 后不再询问；Docs/Sheets 也不接受页面工具，只能用导出工具读。可以信任某个 origin 用于当前会话；永久信任需在扩展设置页中显式管理。
- 无法归到单一 origin 的动作（`browser_eval`、`browser_headers`、`browser_dialog`、`browser_network` 的 `mock`/`mockClear`、历史前进后退）没有「信任此网站」，改为提供「本会话内允许」：按会话 + 动作记住，本会话内同名动作不再询问，解绑、显式改绑到别的标签页、标签页关闭或浏览器会话结束即失效。`browser_navigate` 不在其中——它的风险就是目标地址，会话级授权等于一次批准后本会话可去任意站点，所以它仍然按目标询问。`browser_eval` 默认每次都要批准，除非在设置里让 origin 信任同时覆盖 JavaScript 执行。授权面板超时（60 秒未应答）后仍可让模型重发同一调用，重新弹出确认。
