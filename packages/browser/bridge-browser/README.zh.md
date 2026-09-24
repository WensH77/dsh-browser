# @yuxianglin/dsh-bridge-browser

[English](README.md) | 中文

dsh 的**纯浏览器工具桥**：在宿主 webserver 上挂载一个 **token 认证的 WebSocket 通道**（`/ext/bridge`），供 Chrome 扩展连接，并注册 `browser_*` 工具集——经扩展在真实浏览器中读取页面、点击元素、填写表单、滚动与导航，登录态保留。桥**只承载工具帧**：聊天、设置、凭据、事件流都不再经过它，dsh 网关再怎么演进都不影响这份契约。聊天与会话属于标准 dsh 客户端（web GUI/CLI）；扩展侧只有状态视图与 options/审批弹窗。

**文本为主、按需视觉**：页面快照仍是结构化文本（标题、正文、带编号的交互清单、敏感值打码的表单字段），所有浏览器动作按稳定编号寻址。`browser_snapshot` 会额外返回同一时刻的截图，`browser_capture` 按需只返回截图——仅当调用方的模型路由声明支持图片输入时才附上，且只作为内存中的图片附件：扩展从不把截图写入磁盘。

## 配置

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `token` | `string` | 自动生成 | 固定 bearer token。缺省时首次启动生成，写入 `~/.dsh/ext-bridge-token`（0600）并打印在启动日志。 |
| `toolTimeoutMs` | `number` | 90000 | 单次工具调用预算，为扩展的 60 秒审批窗口预留时间。 |
| `snapshotMaxChars` | `number` | 32000 | 单次快照渲染字符上限，最小为 500（经 `hello.ok` caps 协商给扩展）。 |
| `maxInteractiveItems` | `number` | 60 | 单次快照交互清单条数上限。 |

## 使用

远程安装器会下载一个由脚本托管的 workspace，构建插件，并将它的官方 bundle 注册到本机 dsh 的 `web` profile。该方式无需 Git，也无需提前 clone：

```sh
curl -fsSL https://raw.githubusercontent.com/WensH77/dsh-browser/refs/heads/main/scripts/install.sh | bash
cd ~/.dsh/dsh-browser && pnpm start
```

Windows 请改用 PowerShell 安装器：

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/WensH77/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
cd $HOME\.dsh\dsh-browser; pnpm start
```

开发者也可以 clone 仓库，在 checkout 中依次运行 `./scripts/install.sh` 和 `pnpm start`。本地模式直接使用当前分支，不会下载或覆盖源码。两种安装模式都会注册同一个 profile bundle；构建工具只从选定的 workspace 解析，绝不读取父 checkout 或父目录的 `node_modules`。

钉定的 0.1.7 预发布版运行时即可加载已注册的 bundle；不支持 0.1.2 之前的运行时：

```sh
npx @deepseek-ai/dsh@0.1.7-rc.1 web
```

安装器会把已解压扩展复制到 `~/.dsh/browser-extension` 并打开 `chrome://extensions`。在 Chrome 中加载这个稳定目录，然后使用助手窗（状态侧栏或浮窗，依设置）。扩展会自动发现回环连接，无需输入 token；非回环部署仍需要配置的 bearer token。

## 安全模型

- 桥路径在 `/api` 信任栅栏**之外**（栅栏只罩 client-connection 注册的路由），因此自带 bearer token 认证：首帧必须是 `hello`（5 秒内），常量时间比对，失败即断开。
- `/api` 载体钉在回环上的方法（`settings.*`、`credentials.*`、`host.pickDirectory`、`host.openPath`）对非回环来源**即使 token 正确也拒绝**——对 `--host 0.0.0.0` 部署的纵深防御。
- 同一时刻仅一个活动连接，新认证连接顶替旧连接。
- 桥是 confused-deputy 边界而非通用认证层：不要把 `dsh web --host 0.0.0.0` 暴露在不信任的网络上。
- 抽取的页面文字会标记为模型的不可信输入。页面读取遵循扩展的询问/自动/关闭策略；状态变更工具必须经过按 origin 的审批，未获批准时失败关闭。同源后续操作可只在当前会话中临时信任，永久信任仍需显式设置。

## 线协议

帧为按 `t` 判别的 JSON 对象，定义在 [`protocol.ts`](src/protocol.ts)，是通过 workspace 包的 `./src/*` export 与扩展共享的真源。构建后的包还会发布 `@yuxianglin/dsh-bridge-browser/protocol`，供外部消费方使用。

- 客户端 → 服务端：`hello`（认证 + caps）、`rpc`（两个 GDrive 内部方法之一）、`tool.result`、`pong`。
- 服务端 → 客户端：`hello.ok`（回显协商后的 caps）、`rpc.result`、`tool.call`、`tool.cancel`、`ping`、`error`。

`tool.call` 携带稳定 id，扩展在其 `tool.result` 中回显；`expiresAt` 让过期调用以 `timeout` 结算。桥只是请求/响应通道——认证完成后不再有事件帧。

两个半边的版本在 `hello`/`hello.ok` 里协商：`proto` 是握手版本（不发该字段的旧构建读作 1），`toolset` 是扩展的能力级别（缺失为 0）。宿主若无法服务更新的扩展，用关闭码 `4003` + 原因拒绝，扩展把原因原样显示；扩展声明的级别较低时，宿主**收窄工具面**（不注册 `browser_dom_query`/`browser_block`/`browser_headers`，且 `browser_click`/`browser_type` 的 schema 去掉 `selector`），而不是等到调用时才报参数错误。扩展在选项页与侧栏显示这处错配，并点名下一步（重启 dsh，或重载扩展）。

回环连接可以免 bearer token，但只对一个扩展生效：`Origin` 里的 ID 必须在 `BRIDGE_EXTENSION_IDS` 里，且扩展自报的 `caps.extensionId` 要与它一致。其它任何 `chrome-extension://` origin 都以 `4002` 拒绝——`Origin` 只是个请求头，若照原样接受前缀，用户装的**每一个**扩展都能抢占唯一的工具槽位并读到模型的工具调用。固定的这个 ID 由扩展 manifest 里的公钥推出（`scripts/extension-id.mjs`，另有测试断言两者一致），因此跨安装稳定。这不是密码学意义上的身份证明：知道该 ID 的本机进程仍可伪造该头，所以非回环连接一律要求 token。

## 工具

| 工具 | 用途 |
|---|---|
| `browser_snapshot` | 结构化文本快照（标题/URL/正文/清单/表单）；`delta: true` 只返回变化；除 `visual: false` 外都配一张同刻截图。 |
| `browser_capture` | 视口截图（`fullPage: true` 为整页），作为 image block 返回；仅内存、不落盘。 |
| `browser_image` | 按引用取回页面里的一张图片（`<img>` / `<canvas>` / SVG `<image>` / CSS background），原分辨率返回，不需要 `chrome.debugger`——DevTools 开着或标签页在后台都能用。 |
| `browser_click` / `browser_type` / `browser_press` | 按稳定编号操作清单元素；click 与 type 也接受 CSS `selector`，用于清单叫不出名字的控件（纯图标按钮）。 |
| `browser_scroll` / `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | 页面移动。 |
| `browser_get_text` / `browser_wait` | 读区域文本 / 稳定检测。`find`（配 `context`）在整个范围内定位一段文字，按命中返回有界窗口，一次调用即可回答「这一段讲了什么」，无需写 JS 翻 DOM。 |
| `browser_dom_query` | 窄查询：按 CSS 选择器读指定字段，每个匹配都带一个经校验唯一的选择器。 |
| `browser_console` / `browser_network` | 控制台消息与未捕获错误；请求列表、按 id 取一个响应体、内存内响应替换。 |
| `browser_dialog` | 回应页面的 JS 弹窗——页面被 `alert`/`confirm` 冻住时的唯一出路。 |
| `browser_eval` | 在页面自身上下文求值（不受页面 CSP 限制）。 |
| `browser_block` / `browser_headers` | 阻断匹配请求，或改写请求/响应头；session 规则，只作用于受控标签页。 |
| `browser_status` | 宿主侧自检，扩展连没连都能用：连接状态、扩展 id/构建版本与它声明的 `proto`/`toolset` 对本插件的结论（直接说「重载扩展」还是「重启 dsh」）、镜像的扩展文件是否最新，以及唯一一个下一步动作。不受调试开关与扩展能力级别影响。 |
| `browser_setup` | 宿主侧装机辅助：把扩展文件重新同步到 `~/.dsh/browser-extension`、打开 `chrome://extensions`、有剪贴板工具时把该路径复制进去，并点明剩下唯一那个手动动作。幂等。 |
| `browser_update` | 打印更新本机这套安装的命令：托管安装给一行安装器、checkout 给本地脚本、Windows 给 PowerShell 形式。它**不会执行**该命令——更新会写入 `~/.dsh`、替换 Chrome 加载的目录、首次还需要在 Chrome 点一次，所以那是用户的动作。 |
| `browser_bind_interactive` | 列出可绑定的页面、用标准提问让用户选一个，并绑定本会话——模型只需调这一个工具。 |
| `google_drive_export` | 用已登录会话导出 Google Doc（`/document/d/…`）或 Sheet（`/spreadsheets/d/…`）；其余 Google 链接改用浏览器读。 |

## 模型体验

- **Token 影响**：一次 `browser_snapshot`（默认 32k 字符）对常见英文文本约为 8–10k token，具体取决于语言和分词器；delta 快照只需零头。系统提示段落引导模型按需快照而非囤积页面文本。
- **KV 缓存影响**：无（快照不做服务端缓存）。
- **延迟**：每次动作等待扩展在真实页面执行 + 稳定检测（通常 0.2–2s；导航最长 5s）。
- **失败模式**：`bridge-closed`（扩展未连接）、`timeout`、`no-active-tab`、`content-unavailable`（页面需刷新）、`action-failed`（编号过期——模型应重新快照）。

## 扩展点

- 工具集是消费面；seam 是桥接线（`protocol.ts`）。在 `ctx.tools` 注册新工具并经由桥分发即可，扩展的 content script 按动作名分发。
- 协商 caps（`hello.ok`）让插件无需共享配置文件即可向扩展下达快照预算。

## 已知限制与后续工作

- 仅一个活动扩展连接（第二个窗口顶替第一个）。
- 可访问的跨源 iframe 会进入快照，并通过稳定的 `(frame, index)` 地址执行操作；受保护或已销毁的 frame 会标记为不可访问，不影响整页快照。
- token 手动轮换（改 `~/.dsh/ext-bridge-token` 或配置 `token`），无过期。
- 审批由扩展 service worker 强制执行，而不是依赖模型自觉。未来接入 dsh 工具管线时可以把同一策略暴露给其它客户端。
