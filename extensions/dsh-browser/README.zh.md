# dsh 浏览器操作扩展（Chrome 与 Firefox MV3）

[English](README.md) | 中文

dsh 的**纯浏览器操作端**：让模型直接读取并操作你在浏览器里打开的页面——抓取内容、点击元素、填写表单、滚动与导航，全部在真实页面执行、登录态保留。这是**纯工具扩展**：面板里没有聊天。对话与会话请用官方 dsh 界面；扩展启动即连 dsh 桥（自动探测），会话第一次浏览器调用时把当前标签页交给 Agent，并提供最小状态视图（正在操作哪个页面）、options 页（连接/共享/信任源/通知）与 action popup（待审批操作）。

## 模型能做什么

| 能力 | 动作 | 说明 |
|---|---|---|
| 读取页面 | `browser_snapshot` | 标题/URL/正文/编号交互清单/表单字段（敏感值掩码）；`delta: true` 只返回变化，省 token |
| 点击元素 | `browser_click` | 按编号点击（链接/按钮/复选框…），React/Vue 组件兼容 |
| 填写表单 | `browser_type` | 输入文本，`replace` 清空重填 |
| 按键 | `browser_press` | Enter/Tab/Escape/方向键等 |
| 滚动 | `browser_scroll` | 视口滚动（up/down/top/bottom） |
| 导航 | `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | 受控标签页内跳转，登录态保留 |
| 读区域 | `browser_get_text` | 懒加载内容 / 局部文本 |
| 等待 | `browser_wait` | 页面加载与渲染稳定检测 |

## 架构

```
状态面板 / options / popup ◄─runtime messages─► background SW/事件页 ◄─WS─► dsh bridge plugin
                                 │
                     tabs.sendMessage (DSH_ACTION / DSH_BUDGET / DSH_CONTENT_READY)
                                 ▼
                        content script (snapshot/actions/privacy)
```

- **background**（`src/background/`）：桥连接（token 认证 + 指数退避重连 + 保活）、两个桥内部 RPC 调用，以及**失败关闭地分发工具到用户受控标签页**。
- **content script**（`src/content/`）：文本快照（可读性主文 + 编号交互清单 + 表单字段）、**稳定编号**（`data-dsh-el`）、delta 变化、点击/输入/按键/滚动/导航动作与敏感字段掩码。
- **截图**（`src/background/capture.ts`）：仅 Chrome，走 `chrome.debugger`（`Page.captureScreenshot`）。每次截取临时 attach、按宿主图片上限缩放重编码、`finally` 里 detach；字节只在内存中，以 base64 过桥。
- **panel / options**（`src/panel/`、`src/options/`）：两个精简 React 页面——状态面板（依 `statusMode` 设置，也会以浮窗 popup 打开同一页面）展示连接状态、受控标签页、最近操作与待审批项；options 页管理桥 URL/token、页面共享、信任源与审批通知。
- **协议**：`@yuxianglin/dsh-bridge-browser` workspace 包中的 `protocol.ts` 是两端共享的真源，具体通过该包的源码 export 共享。

## 构建

```sh
pnpm install
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

请在仓库根目录执行这些命令。Chrome 产物输出到 `extensions/dsh-browser/dist/`；Firefox 产物输出到 `extensions/dsh-browser/dist-firefox/`。

## 安装与使用

推荐的零配置命令无需安装 Git，也无需提前 clone：

1. **构建并安装扩展**：

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
   ```

   Windows 请改在 PowerShell 中运行：

   ```powershell
   $s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
   ```

   脚本会把托管 workspace 下载到 `~/.dsh/dsh-browser`，构建桥插件，把它的官方 bundle 注册到本机 dsh 的 `web` profile，再构建扩展并把产物复制到稳定目录 `~/.dsh/browser-extension`，然后打开 `chrome://extensions`。开启开发者模式，选择「加载已解压的扩展程序」，加载扩展目录。再次运行该命令会更新托管安装。

   clone 得到的 checkout 也使用同一个安装器，而且不会下载或覆盖源码：

   ```sh
   git clone https://github.com/Lum1104/dsh-browser.git
   cd dsh-browser
   ./scripts/install.sh
   ```

   Windows checkout 请运行 `.\scripts\install.ps1`。

2. **启动 dsh 并挂载桥插件**。可以使用 workspace 固定的运行时：

   ```sh
   cd ~/.dsh/dsh-browser && pnpm start
   ```

   如果使用 clone，请改为在仓库根目录运行 `pnpm start`。

   或使用受支持的精确公开版本（钉定 0.1.5 预发布版）：

   ```sh
   npx @deepseek-ai/dsh@0.1.5-rc.1 web
   ```

   两种命令都会从本机 `web` profile 加载同一个 bundle。默认端口为 3080；如被占用，可追加 `--port <port>`。

   **DSH Desktop 用户**：桌面版默认让系统随机分配本地 Web 端口（`dsh-desktop.port: 0`），自动探测无法预知随机端口。请在桌面版设置中把端口固定为 `43189`（见 [deepseek-harness-desktop 用户指南](https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/docs/user-guide.md)），扩展的自动探测会覆盖该端口；或直接在扩展 options 中手动填写 `http://127.0.0.1:<端口>`。

   扩展加载后即连接自动探测到的桥，并带退避持续重连；即使你在其它标签页工作，审批也能在状态窗中弹出。连接掉线或被另一浏览器 Profile 顶替时，扩展会自动重连。

3. **开始使用**：打开普通的 `http://` 或 `https://` 页面，点击 DeepSeek 鲸鱼图标。两个构建都会自动探测本机 dsh。Chrome 回环连接无需地址或 Token；Firefox 的 `moz-extension://` UUID 不能证明扩展身份，必须在设置中填入 `~/.dsh/ext-bridge-token`。

页面即使在扩展安装或重载之前已经打开，也会在第一次操作时自动补加载内容脚本，无需手动刷新。`chrome://`、Chrome Web Store 等浏览器内置或受保护页面不支持读取和操作。

如果只开发扩展，Chrome 从 `chrome://extensions` 加载 `extensions/dsh-browser/dist/`；Firefox 运行 `build:firefox` 后，从 `about:debugging#/runtime/this-firefox` 加载 `extensions/dsh-browser/dist-firefox/manifest.json`。代码更新后需重新构建并重新加载。

## 为什么以文本为主视图（以及视觉何时加入）

- **快照即视图**：模型对页面的主视图 = 结构化文本（标题/URL/正文/编号元素/表单），默认预算 32k 字符（插件可配，经 `hello.ok` 协商给扩展）。当调用方的模型路由声明支持图片输入时，`browser_snapshot` 会附带同一时刻的截图，`browser_capture` 可按需只取截图；不支持图片输入的路由会自动退回纯文本，并在结果里说明为什么没有附图。
- **页面文字是不可信输入**：快照和局部文本读取会放进带随机 nonce 的信任边界，并明确要求模型不得把网页中的命令当成指令。这只是纵深防御；扩展侧的操作审批才是强制安全边界。
- **只有图标的控件也能点**：交互元素没有文字时依次回退到 `title` / `data-original-title` / `data-tooltip`，再退到 `icon-specialist-email` 这类图标类名（可读、启发式，绝不覆盖真实文本）。清单排序也把主内容区排在常驻框架（nav/header/footer）之前，避免侧边栏一堆链接吃光条目额度。
- **页面框架不重发**：nav/header/footer 里的条目与上一次快照逐字节相同时，折叠成一行（`N unchanged … items from snapshot vK are omitted`），编号仍然有效，需要选择器时用 `browser_dom_query` 取。
- **自动读比显式读便宜**：导航后自动附的快照上限 8k 字符（`browser_snapshot` 是 32k），不够时模型再显式要。
- **页面里的图片按图返回**：`browser_image` 把 `<img>`、`<canvas>`、SVG `<image>` 或 CSS 背景图按**原始分辨率**经同一条 attachment 通路交给模型。它不需要 `chrome.debugger`，所以 DevTools 开着、标签页在后台都能用；能装下就原样透传字节，只有超过准入上限的图才会被重新拟合（此时信封里会标出原始尺寸）。
- **页面文本可搜索**：`browser_get_text` 支持 `find`（字面、大小写不敏感）与 `context`（每侧字符数，默认 300）。搜索在**整段文本**上执行而不是截断后的头部，按命中返回带字符区间的有界窗口；无命中时报告搜了多少字符——「第 10 页讲了什么」因此是一次调用，而不是一串用 `browser_eval` 切 DOM 的调用。
- **窄读 DOM**：`browser_dom_query` 只回你点名的字段（`href`/`value`/`checked`…）以及每个匹配的可访问名与唯一选择器——用 `browser_eval` 翻 DOM 的廉价只读替代品。
- **额度不够时给出路**：一旦命中条目上限，快照会列出被丢弃的前 8 个控件及其经校验唯一的选择器（`Omitted by the inventory cap`），提示语也改成「用选择器直接点」，而不是只让人去读更多文本。
- **选择器寻址**：`browser_click` / `browser_type` 支持 CSS `selector`（与 `index` 并列）；在目标 frame 内解析、优先可见匹配、先滚动到视口，并且照样走审批与稳定检测——看得到就能点，不必在 `browser_eval` 里点击。
- **SVG 控件同样可寻址**：可见性判断、唯一选择器生成与点击链路都支持 SVG（Slides 胶片栏缩略图、图表与地图控件）——`browser_dom_query` 会报告它们真实的可见性并给出经校验的 `selector=`；点击时派发真实的 `MouseEvent`，而不是调用只有 HTML 元素才有的 `click()`。`browser_dom_query` 还把每个匹配的**计算可访问名**标成 `name=`，避免被当成 `aria-label` 属性去构造选择器。
- **稳定编号**：元素编号跨快照保持（WeakMap + `data-dsh-el`），模型可以说"点 7 号"；页面大改时显式提示"编号已重排"。
- **delta 模式**：`browser_snapshot({delta:true})` 只返回变化元素的编号，省 token。
- **隐私**：密码/卡号字段的值永远以 `••••` 呈现，绝不回传；可访问名称从不使用敏感字段的当前值。截图同样属于页面读取：受同一套共享策略（`ask`/`auto`/`off`）约束，只存在内存里，扩展不写入磁盘。
- **标签页绑定**：首次浏览器工具调用时会把当时的活动标签页绑定给该会话。手动切换标签页或窗口后，后续工具会暂停，并通过状态窗中的审批询问助手继续原页面还是跟随当前页。选择原页面后允许后台操作，但不会改变用户正在看的页面；选择跟随后会重置页面引用状态。受控页关闭后失败关闭，直到下一次调用显式选择页面；切页还会撤销尚未完成的操作审批。
- **调试能力默认关闭**：截图、控制台、网络、响应替换与页面内执行 JS 都走 `chrome.debugger`，只有扩展设置里开着「允许 dsh 使用浏览器调试能力」时才注册（首次安装为关）。关闭时宿主根本不注册这些工具，模型看不到也调不到；切换该开关会重连桥，让能力随握手同步过去。
- **构建错配会明说，不靠猜**：`hello`/`hello.ok` 带 `proto`（握手版本）与 `toolset`（扩展能力级别）。宿主若服务不了本构建，会用可读原因拒绝握手，扩展把该原因原样显示在选项页与侧栏，并给出下一步（重启 dsh，或重载扩展）；宿主若从不回应，也会给出对应提示，而不是一个没有解释的「连接中…」。反方向同理：宿主会按本扩展声明的能力级别收窄模型可见的工具面，旧构建不会拿到它无法解析的 `selector`。
- **缓冲区随绑定开启**：开着调试能力时，绑定页面就 attach 调试器并打开控制台/网络缓冲，页面自己加载期的请求与早期报错会被记下来，而不是从模型第一次读取才开始。关掉调试、解绑或关闭标签页都会释放会话；用户点掉调试提示条也会被识别，下次 affinity 变化时重新预热。
- **JS 弹窗会冻结页面**：原生 `alert`/`confirm`/`prompt` 阻塞渲染进程主线程，内容脚本类工具与 `Runtime.evaluate` 都会排在它后面，直到有人应答。`browser_dialog` 经 CDP 应答（确认/取消，prompt 可带文本），并回传它关掉的那句文案；弹窗出现时也会作为一条 warning 进控制台缓冲。
- **调试类工具限定在受控标签页**：控制台/网络缓冲、响应替换与求值依赖 `chrome.debugger`（仅 Chrome，且该标签页开着 DevTools 时不可用）；阻断与改头用带 `tabIds` 的 session 规则，不碰其它标签页，随浏览器会话结束失效。`browser_eval` 默认每次都询问，只有在设置里开启「信任的站点也可直接执行 JS」后才按 origin 免询问；改头始终询问，阻断可被 origin 信任覆盖。无人应答的提示会在受控标签页变化时被撤回，工具会明确说明「什么都没执行」。
- **先同意、后请求**：会话的首次 `browser_navigate` 先按目的地取信任/审批，批准后才创建标签，被拒绝或未应答的调用不会加载 URL；绑定标签页内的后续导航走同一条「先审批」路径。
- **分级审批**：Google Drive 导出走同一套 action 门禁——按文档 origin 授权、可信任，只有在文档 host 未被信任时才询问。默认「自动共享」允许模型按需读取受控标签页而不额外弹窗；「每次询问」可恢复逐次读取确认，「关闭」会阻断读取。在「每次询问」模式下，读取弹窗可以仅允许一次，也可以持久切回自动读取，之后仍可在设置中关闭。状态变更工具仍然失败关闭，并显示实际 origin 和脱敏动作摘要；用户可拒绝、仅允许一次，或信任单个 origin 用于当前会话。临时信任在 Service Worker 重启时清空；永久信任需在扩展 options 页中显式管理。审批最多保留 60 秒；启用通知后，系统通知可打开状态窗供用户处理。调用方取消或桥接超时时，会先撤销尚未完成的审批，过期动作不会继续执行。

## 权限说明

Chrome 额外申请 `debugger`（经 CDP 截图、控制台/网络缓冲、页面求值与响应替换；attach 期间 Chrome 会显示调试提示条，且该标签页开着 DevTools 时无法 attach）与 `declarativeNetRequestWithHostAccess`（阻断与改头；扩展已持有 http/https host 权限，因此不产生额外安装警告）。Firefox 没有 `debugger` API，构建里不含该权限，截图会明确报不支持。

Chrome 使用 `sidePanel`，Firefox 使用 `sidebar_action`。两者都申请 `storage`（设置）、`notifications`（没有状态窗打开时可选的审批提醒）、`tabs` + `activeTab` + `scripting`（观察切页，并向用户显式选择的受控标签页注入/发消息；安装前已打开的页面也会按需补注入）、`webNavigation`（枚举该标签页中的 frame，并把消息绑定到具体文档）、`alarms`（后台保活）和 `http/https`（内容脚本注入普通网页）。Firefox AMO manifest 如实声明扩展会把浏览活动、网页内容/操作和对话内容发送给用户配置的 dsh/模型服务。扩展绝不改变用户正在看的标签页，也不会静默跟随手动切页；只有用户选择继续原页面后，助手才会在后台操作。

## 已知限制

- 同时只有一个扩展连接桥。未打开侧栏的浏览器 Profile 不会抢占连接；另一个浏览器 Profile 顶替连接后，被替换的一端会主动让权，不再反复重连互踢。
- 标签页绑定属于整个扩展连接，而不是单个对话会话。
- 可访问的跨源 iframe 会进入快照，并通过稳定的 `(frame, index)` 地址执行操作；受保护或已销毁的 frame 会标记为不可访问，不影响整页快照。
- 验证码/纯图片按钮无法处理——工具结果会标注"存在无文本可访问名的元素"，提示用户手动完成该步。
- 令牌无自动轮换。
- `browser_press` 的合成按键不触发浏览器原生默认行为（Tab 焦点移动、方向键、Enter 激活等），仅用于框架内的键盘事件；依赖原生行为的场景请手动操作。
- `browser_wait` 以加载完成 + 固定静默窗口为准，不观察持续 DOM 更新（连续刷新的 SPA 可能被报为稳定）。
