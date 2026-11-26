# dsh 浏览器操作

[English](README.md) | **中文**

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 接到你正在用的 Chrome 标签页。模型可以读取页面内容、点击控件、填写表单、滚动和导航，登录态、会话和 Cookie 都留在你的浏览器里。点工具栏图标打开状态视图，能看到连接状态、当前受控页面和等你确认的审批。

`dsh` 是 DeepSeek AI 开发的开源、插件化 agent 框架（智能体框架）。本仓库是配套的浏览器桥接插件与 Chrome MV3 扩展，作为一个独立的 pnpm workspace 分发。

页面会转成结构化文本和带编号的交互清单，模型用编号定位元素。`browser_snapshot` 同时返回这份文本和同一时刻的截图，`browser_capture` 只返回截图；截图只存在内存里，不写磁盘，纯文本模型只拿到文本快照。截图走 `chrome.debugger`，需要扩展设置里的「允许浏览器调试」。

三个取舍决定了它的形态：操作你真实的浏览器而不是无头副本，所以登录态还在；页面接口以文本为主、截图作补充；走调试器的能力默认不注册，要用得自己打开。

> [!IMPORTANT]
> npm 上未加 scope 的 [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) 包属于另一个项目，与本仓库无关。本项目没有发布 npm 包，请使用下面的安装器。

## 快速安装

安装器同时装两半：dsh 桥接插件和 Chrome 扩展，一条命令完成。

macOS 与 Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/WensH77/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

Windows（PowerShell）：

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/WensH77/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

安装器做四步：

1. 把仓库取到 `~/.dsh/dsh-browser`（在本地 clone 里运行则直接用当前目录），`pnpm install` 后先构建扩展、再构建桥接插件。
2. 把 `dsh-bridge-browser` 注册到本机 dsh 的 `web` profile；更早的包名会先移除。
3. 把仓库里的技能装到 `~/.dsh/skills`，之后任何工作区的会话都能用到。
4. 把扩展构建同步到 `~/.dsh/browser-extension`，在那里写 `install-info.json`，打开 `chrome://extensions`，并把扩展目录复制到剪贴板。

剩下只有一步手点：在 `chrome://extensions` 里把 `~/.dsh/browser-extension` 作为已解压的扩展加载。已经有「AI 浏览器助手」卡片就点**重新加载**。dsh 正在运行时插件通常几秒内热加载；没有加载就重启一次 dsh。

更新：重跑同一条安装命令，再到 Chrome 点一次**重新加载**。不确定该跑哪一条时，让助手用 `browser_update` 打印这台机器的那一条，它只打印不执行。

## 环境要求

| 项 | 要求 |
|---|---|
| 浏览器 | Chrome 116 或更新（扩展的 `minimum_chrome_version`）。安装器也认 Chromium，其余 Chromium 内核浏览器未验证 |
| Node.js | 跟随仓库 pin 的 dsh：当前这一版要求 `^24.22.3 \|\| >=26.13.1`。安装器只检查 `node` 是否存在，版本不满足时由 dsh 自己报错 |
| pnpm | 建议用 Corepack 启用。仓库声明 `packageManager: pnpm@11.7.0` |
| 安装器的额外依赖 | macOS/Linux 还需要 `curl`、`tar`、`rsync`；Windows 需要系统自带的 PowerShell 5.1 或 PowerShell 7+ |

## 启动

托管安装：

```sh
cd ~/.dsh/dsh-browser && pnpm start
```

从 clone 安装就在仓库根目录跑 `pnpm start`。它就是 `dsh web`，默认地址 `http://127.0.0.1:3080`；`dsh` 来自该 workspace 自己的依赖，不需要另装。

打开任意 `http://` 或 `https://` 页面，等状态视图显示**已连接**即可使用。`chrome://` 等浏览器页、扩展商店，以及别的扩展自己的页面都不能操作。

## 工具一览

| 工具 | 作用 |
|---|---|
| `browser_snapshot` | 读当前页：标题、URL、正文、编号交互清单、表单字段（敏感值掩码）。`delta: true` 只返回变化，`visual: false` 不附带截图 |
| `browser_capture` † | 视口截图，`fullPage: true` 取整页；截图只存在内存。优先用视口，长页面的整页截图会被压到模型的图像预算里，文字读不出来 |
| `browser_console` † / `browser_network` † | 控制台消息与未捕获错误（带 cursor 增量）；网络请求列表（状态、耗时）、按 id 取响应体、在内存里替换响应 |
| `browser_eval` † | 在页面自身的 JS 上下文里求值，不受页面 CSP 限制 |
| `browser_dialog` † | 应答 `alert` / `confirm` / `prompt`。这类弹窗会冻住页面，期间的页面类工具被拒绝并把弹窗内容原样带回 |
| `browser_debug` † | 行断点与 XHR/fetch 断点、暂停/恢复/单步、读暂停现场、在暂停的调用帧里求值、列出脚本与事件监听 |
| `browser_cookies` | 经 CDP 读写删站点 Cookie，包括 `document.cookie` 看不到的 HttpOnly；写入会进浏览器 cookie jar，后续导航也带新值。不受调试开关控制，但每次调用会临时附加调试器 |
| `browser_block` / `browser_headers` | 阻断匹配的请求，或改写请求/响应头；规则装在当时受控的标签页上，清规则、关标签页或浏览器会话结束才失效 |
| `browser_click` | 按编号或 CSS 选择器点击；目标为原生 `<select>` 时用 `option` 按值或可见文本选中 |
| `browser_click_pointer` | 在元素中心派发完整指针事件序列；用于 Google Slides 这类画布编辑器的「点击回报成功但页面没反应」 |
| `browser_slides_open_page` | 按页码打开 Slides 演示文稿的某一页，比点胶片栏缩略图可靠 |
| `browser_type` / `browser_press` / `browser_scroll` | 输入文本（`replace` 清空重填，兼容 React/Vue 受控组件）、按键、滚动视口 |
| `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | 受控标签页内的导航、历史前进后退与刷新 |
| `browser_get_text` | 读局部或懒加载文本；`find` 按文本定位并返回有界窗口 |
| `browser_dom_query` | 按 CSS 选择器读指定字段，每个匹配都带一个经校验唯一的选择器 |
| `browser_image` | 取回页面里的图片（img/canvas/SVG/背景图），按原分辨率返回，不需要调试能力 |
| `browser_wait` | 等页面加载与渲染稳定 |
| `browser_bind_interactive` | 列出可绑定页面（最多 60 个），让用户选一个并绑定本会话；它总是询问，即使只开了一个页面 |
| `browser_status` / `browser_setup` / `browser_update` | 桥接自检、重新镜像扩展文件并把加载路径复制到剪贴板、打印本机的更新命令 |
| `google_drive_export` | 导出 Google Docs 或 Sheets：Docs 出 Markdown（为空则 HTML），Sheets 下载后问分析哪个 sheet 并落成 CSV；只认这两类链接，其它 Google 链接按普通页面读 |

† 这六个工具走 `chrome.debugger`，由扩展设置里的**「允许浏览器调试」**控制，首次安装时是关闭的。关着的时候插件根本不注册它们，模型看不到也调不到；打开后桥接会重连，能力随握手带过来。`browser_snapshot` 本身不受影响，但它默认附带的那张截图同样要调试器，关着时只返回文本并说明原因。同一标签页开着 DevTools 时 Chrome 拒绝第二个调试器，工具会直接说这一点。

另有一道**扩展工具集级别**的门槛：`browser_cookies`、`browser_click` 的 `option`、`browser_slides_open_page`、`browser_click_pointer`、`browser_image`、`browser_get_text` 的 `find`、CSS 选择器目标，都是逐级加进来的（级别 1–8）。旧扩展构建缺这些工具或参数，`browser_status` 会报出两边级别不一致并建议重载扩展。`browser_cookies` 要级别 8：扩展停在 7 时它会直接消失，而调试开关与它无关；真拿不到 `chrome.debugger`（企业策略、或 Chrome 老于 116）时它会报 unsupported。

## 审批与信任

写操作默认失败关闭，没有你的批准什么都不做：`browser_click`、`browser_click_pointer`、`browser_type`、`browser_press`、`browser_navigate`、`browser_back`、`browser_forward`、`browser_reload`、`browser_block`，以及 Google Drive 导出。被拒绝或没人应答的调用不会发出任何请求。

审批卡上有两种长期选项：

- 能定位到站点的动作可以**信任此站点**。授权写进扩展设置，在设置页里显式管理。
- 没有「信任此站点」的动作只给**本会话内允许**：在页面里执行 JS、调试页面 JS、改写请求头、回应 JS 弹窗、读写 Cookie、替换网络响应、历史前进后退。授权按会话 + 动作记住（能定位到站点的，还按站点分开）；解绑、改绑到别的标签页、标签页被关掉或替换、或浏览器会话结束就失效。
- `browser_navigate` 不给会话级授权，避免一次批准变成整个会话可去任意站点；它按目标站点逐个询问，同样可以记住信任。
- `browser_eval` 默认每次调用都要批准；卡上可以给本会话允许，或让「信任此站点」覆盖 JS 执行（设置里单独打开）。

页面读取由设置里的**页面内容共享**决定，作用于 `browser_snapshot`、`browser_get_text`、`browser_dom_query`、`browser_image`、`browser_capture`、`browser_console` 和 `browser_network`：默认「自动共享」，只读受控标签页、不额外弹窗；「每次询问」逐次确认，可以只允许一次或切回自动；「关闭」完全阻断。读到的页面文字会发给当前选择的模型。

导航默认只能去当前受控页所在的主机；换主机要先绑定到目标页、或用会话的首次导航（它会开一个新标签并绑给这个会话），要放开得在设置里打开**允许跨域导航**。设置里另有一份**禁止的站点**，命中即拒绝读取和操作。Google Drive 导出走同一套审批：按文档所在的站点授权，信任之后不再询问。

审批卡出现在 dsh 页面里，所以你得能切回去点它。60 秒无人应答就超时，超时后重发同一调用会重新弹卡。

## 标签页绑定

会话还没有页面时，`browser_navigate` 走另一条路：批准后开一个后台新标签并绑给这个会话，不抢你正在看的页面。其它页面工具则先列可绑定的页面（只算 http/https，排除 dsh 自己的页面和浏览器受保护页）：只有一个就直接绑，有多个才弹选页框让你选，一分钟内可作答，然后接着执行这次调用。同一步里的几个工具一起被拒时只弹一次选页框，绑好后各自重跑。

已经绑定页面的会话不会被自动挪走，你手动切到别的标签页也一样。如果它的页面变成谁也操作不了的页（`chrome://`、别的扩展的页面、本地文件），调用会失败并说明这一点，三条出路：切到普通页面后 Unbind、用 `browser_navigate` 打开新页面，或用 `browser_bind_interactive` 挑一个已打开的页面。这种情况不会替你改绑。

受控标签页关掉后，扩展还会找它 60 秒（调用里先等 2 秒）；找到就静默重绑，找不到会话暂停，等下一次调用重新绑定。

扩展设置里还有**自动跟随的站点**：这些站点上新开的页面会自动成为受控页。只跟随绑定之后新开的页面，默认不跟随；另一个环境（比如测试站和预发站）的页面会先问一次，跟随页自己关掉会退回原页。

一个扩展连接同一时间只服务一个会话，新的扩展连接会顶掉旧的。第二个会话来绑定时会被拒绝，并报出占用它的会话 id，而不是抢走标签页。

## 状态视图与会话指示灯

点工具栏图标（DeepSeek 鲸鱼图标）打开状态视图。它默认是浮窗，可在扩展设置里改成 Chrome 侧边栏：显示连接状态、当前受控标签页、本会话已授予的权限和最近的操作，并列出等你确认的审批。没有界面能显示审批时，可以打开系统通知。

dsh Web GUI 的侧边栏会给「当前持有受控标签页」的会话标一个小地球图标，颜色跟随会话行的状态点。它只是标记，不是按钮。标记跟着扩展上报的绑定状态出现和消失：socket 上报里有会话 id、标签 id、窗口 id 和标签标题，而界面读的 `GET /bridge-browser/bindings` 只暴露会话 id 和标签 id；页面 URL 和内容始终不出扩展。该路由在 `/api` 之外，自行套用与 GUI 其余请求相同的 Host/Origin 与浏览器认证检查。

## 故障排查

| 症状 | 处理 |
|---|---|
| 状态视图一直显示「未连接」 | 确认本机 dsh web 在跑；浏览器打开 `http://127.0.0.1:3080/ext/bridge-config`，应返回 `{"wsUrl":...}` 形式的 JSON。返回网页说明当前运行的 dsh 早于桥接注册，重启 dsh 后扩展会自动重连 |
| dsh 不在 3080 | 扩展会探测 3080/3081/3090（dsh web）、43189（DSH Desktop）和 14389（旧桌面端口）；dsh 在本机换端口时，在扩展设置里填地址和 token |
| 桥接跑在另一台机器上 | 扩展的 CSP 只放行 `ws://127.0.0.1:*`、`http://127.0.0.1:*` 和 raw.githubusercontent.com，填远端地址会被浏览器拦下，目前连不上远端桥接 |
| 截图、控制台、网络、eval、弹窗、调试工具不存在 | 打开「允许浏览器调试」，桥接会重连并把能力带过来。`browser_debug` 还要求扩展工具集级别 ≥ 7，更旧的构建没有它 |
| 报「另一个调试器已附加」 | 受控标签页开着 DevTools。关掉该标签页的 DevTools 再试 |
| 报「页面停在断点上」 | `browser_debug { action: "wait" }` 读现场，然后 `resume` 或 `step`。期间 `browser_console` / `browser_network` 照常可用 |
| 提示另一个会话正在操作浏览器 | 在那个会话里 Unbind，或让那边的会话结束 |
| 说不清桥接哪里不对 | 问助手「浏览器桥接什么状态」。`browser_status` 会报连接、扩展版本、协议与工具集是否匹配、镜像文件是否最新、最近的调试事件，并给出唯一的下一步；需要重新镜像扩展文件用 `browser_setup` |

## 开发

桥接插件和 Chrome 扩展在同一个 workspace，所有命令都在仓库根目录执行。

```sh
pnpm install
pnpm run build        # 先构建扩展，再构建桥接插件（插件要把扩展产物打包进自己）
pnpm run typecheck
pnpm run test         # 安装器编码检查 + 技能检查 + 两个包的 vitest
pnpm run skills:install
```

单包命令：

```sh
pnpm --filter dsh-bridge-browser run build
pnpm --filter dsh-bridge-browser run typecheck
pnpm --filter dsh-bridge-browser run test

pnpm --filter dsh-browser-extension run build   # 输出到 extensions/dsh-browser/dist
pnpm --filter dsh-browser-extension run test
```

注意：

- 桥接插件必须先有 `lib/` 才能被 Loader 加载；顺序不能反过来。
- 仓库把 `@deepseek-ai` 依赖 pin 在同一批版本（当前 `0.2.3-alpha.2`，见 `package.json`）。桥接插件声明的 peer 范围是 `>=0.1.7-rc.1 <0.3.0`，同一份插件可以挂在这条范围内的 dsh 上；升级时要同时更新 manifest、锁文件并重跑根目录检查。
- `docs/` 有历史升级记录（0.1.5-alpha → 0.1.5-rc → 0.1.7-rc）和几份调研笔记；0.2.x 的升级过程还没整理成文。

## 安全

- 桥接在 `/api` 的信任栅栏之外，自带 bearer token（`~/.dsh/ext-bridge-token`，权限 0600）。回环免 token 要三个条件同时成立：对端是回环、Origin 是固定扩展 id、握手里声明的扩展 id 与它相同。
- 同一时间只接受一个扩展连接，新连接会顶掉旧的，旧连接以 replaced 关闭。
- 一个受控标签页只属于一个会话；网页文字会被标记为不可信输入。
- 走 `chrome.debugger` 的能力默认关闭，关着时插件不注册这些工具。附加调试器期间 Chrome 会显示它的调试提示条；截图只在内存里，不写磁盘。
- 密码和支付卡字段在快照里显示为 `••••`，字段值不离开页面。
- 点击、输入、按键、导航、刷新和阻断请求默认失败关闭；跨域导航默认关闭；可以配置禁止访问的站点。

## 仓库组成

```
packages/browser/bridge-browser/   桥接插件：WebSocket 通道 + browser_* 工具集
extensions/dsh-browser/            Chrome MV3 扩展（后台/内容脚本/状态视图/设置页）
.dsh/skills/                       随仓库分发的技能
scripts/install.sh                 安装器（Windows 用 install.ps1）
scripts/install-skills.mjs         技能安装（安装器的第 3 步）
docs/                              升级记录与调研笔记
```

两半各自的细节见[桥接插件 README](packages/browser/bridge-browser/README.zh.md)和[扩展 README](extensions/dsh-browser/README.zh.md)；操作经验见 `.dsh/skills/` 下的两个技能。

本仓库 fork 自 [omdsh-dev/dsh-browser](https://github.com/omdsh-dev/dsh-browser)。
