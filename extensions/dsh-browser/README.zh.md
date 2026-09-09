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
- **content script**（`src/content/`）：纯文本快照（可读性主文 + 编号交互清单 + 表单字段）、**稳定编号**（`data-dsh-el`）、delta 变化、点击/输入/按键/滚动/导航动作与敏感字段掩码。
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
   npx @deepseek-ai/dsh@0.1.5-alpha.1 web
   ```

   两种命令都会从本机 `web` profile 加载同一个 bundle。默认端口为 3080；如被占用，可追加 `--port <port>`。

   **DSH Desktop 用户**：桌面版默认让系统随机分配本地 Web 端口（`dsh-desktop.port: 0`），自动探测无法预知随机端口。请在桌面版设置中把端口固定为 `43189`（见 [deepseek-harness-desktop 用户指南](https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/docs/user-guide.md)），扩展的自动探测会覆盖该端口；或直接在扩展 options 中手动填写 `http://127.0.0.1:<端口>`。

   扩展加载后即连接自动探测到的桥，并带退避持续重连；即使你在其它标签页工作，审批也能在状态窗中弹出。连接掉线或被另一浏览器 Profile 顶替时，扩展会自动重连。

3. **开始使用**：打开普通的 `http://` 或 `https://` 页面，点击 DeepSeek 鲸鱼图标。两个构建都会自动探测本机 dsh。Chrome 回环连接无需地址或 Token；Firefox 的 `moz-extension://` UUID 不能证明扩展身份，必须在设置中填入 `~/.dsh/ext-bridge-token`。

页面即使在扩展安装或重载之前已经打开，也会在第一次操作时自动补加载内容脚本，无需手动刷新。`chrome://`、Chrome Web Store 等浏览器内置或受保护页面不支持读取和操作。

如果只开发扩展，Chrome 从 `chrome://extensions` 加载 `extensions/dsh-browser/dist/`；Firefox 运行 `build:firefox` 后，从 `about:debugging#/runtime/this-firefox` 加载 `extensions/dsh-browser/dist-firefox/manifest.json`。代码更新后需重新构建并重新加载。

## 为什么浏览器操作仍采用纯文本

- **快照即视图**：模型对页面的全部认知 = 结构化文本（标题/URL/正文/编号元素/表单），默认预算 32k 字符（插件可配，经 `hello.ok` 协商给扩展）。
- **页面文字是不可信输入**：快照和局部文本读取会放进带随机 nonce 的信任边界，并明确要求模型不得把网页中的命令当成指令。这只是纵深防御；扩展侧的操作审批才是强制安全边界。
- **稳定编号**：元素编号跨快照保持（WeakMap + `data-dsh-el`），模型可以说"点 7 号"；页面大改时显式提示"编号已重排"。
- **delta 模式**：`browser_snapshot({delta:true})` 只返回变化元素的编号，省 token。
- **隐私**：密码/卡号字段的值永远以 `••••` 呈现，绝不回传；可访问名称从不使用敏感字段的当前值。
- **标签页绑定**：首次浏览器工具调用时会把当时的活动标签页绑定给该会话。手动切换标签页或窗口后，后续工具会暂停，并通过状态窗中的审批询问助手继续原页面还是跟随当前页。选择原页面后允许后台操作，但不会改变用户正在看的页面；选择跟随后会重置页面引用状态。受控页关闭后失败关闭，直到下一次调用显式选择页面；切页还会撤销尚未完成的操作审批。
- **分级审批**：默认「自动共享」允许模型按需读取受控标签页而不额外弹窗；「每次询问」可恢复逐次读取确认，「关闭」会阻断读取。在「每次询问」模式下，读取弹窗可以仅允许一次，也可以持久切回自动读取，之后仍可在设置中关闭。状态变更工具仍然失败关闭，并显示实际 origin 和脱敏动作摘要；用户可拒绝、仅允许一次，或信任单个 origin 用于当前会话。临时信任在 Service Worker 重启时清空；永久信任需在扩展 options 页中显式管理。审批最多保留 60 秒；启用通知后，系统通知可打开状态窗供用户处理。调用方取消或桥接超时时，会先撤销尚未完成的审批，过期动作不会继续执行。

## 权限说明

Chrome 使用 `sidePanel`，Firefox 使用 `sidebar_action`。两者都申请 `storage`（设置）、`notifications`（没有状态窗打开时可选的审批提醒）、`tabs` + `activeTab` + `scripting`（观察切页，并向用户显式选择的受控标签页注入/发消息；安装前已打开的页面也会按需补注入）、`webNavigation`（枚举该标签页中的 frame，并把消息绑定到具体文档）、`alarms`（后台保活）和 `http/https`（内容脚本注入普通网页）。Firefox AMO manifest 如实声明扩展会把浏览活动、网页内容/操作和对话内容发送给用户配置的 dsh/模型服务。扩展绝不改变用户正在看的标签页，也不会静默跟随手动切页；只有用户选择继续原页面后，助手才会在后台操作。

## 已知限制

- 同时只有一个扩展连接桥。未打开侧栏的浏览器 Profile 不会抢占连接；另一个浏览器 Profile 顶替连接后，被替换的一端会主动让权，不再反复重连互踢。
- 标签页绑定属于整个扩展连接，而不是单个对话会话。
- 可访问的跨源 iframe 会进入快照，并通过稳定的 `(frame, index)` 地址执行操作；受保护或已销毁的 frame 会标记为不可访问，不影响整页快照。
- 验证码/纯图片按钮无法处理——工具结果会标注"存在无文本可访问名的元素"，提示用户手动完成该步。
- 令牌无自动轮换。
- `browser_press` 的合成按键不触发浏览器原生默认行为（Tab 焦点移动、方向键、Enter 激活等），仅用于框架内的键盘事件；依赖原生行为的场景请手动操作。
- `browser_wait` 以加载完成 + 固定静默窗口为准，不观察持续 DOM 更新（连续刷新的 SPA 可能被报为稳定）。
