# dsh 浏览器操作

[English](README.md) | **中文**

<img width="1701" height="897" alt="dsh 浏览器操作" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 连接到你正在使用的 Chrome 或 Firefox 标签页。模型可以读取页面内容、点击控件、填写表单、滚动与导航，同时保留登录态、会话和 Cookie。状态面板会显示当前正在操作哪个页面。

`dsh` 是由 DeepSeek AI 开发的开源、插件化 agent harness（智能体框架）。本仓库将配套的浏览器桥插件与 Chrome/Firefox MV3 扩展组成一个独立的 pnpm workspace。

页面会转换为结构化文本和带编号的交互元素清单，模型通过编号定位元素。`browser_snapshot` 会把这份文本与同一时刻的截图一起返回，`browser_capture` 按需只返回截图——两者都只对支持图片输入的模型生效，且截图只存在内存里：扩展不落盘；纯文本模型会降级为文本快照并说明原因。

> [!IMPORTANT]
> 当前迁移分支的运行时 pin 为 `0.1.5-rc.1`（2026-09-09 由 `0.1.2-rc.1` 升到 `0.1.5-alpha.1`，2026-09-10 再升到 `0.1.5-rc.1`，详见 [升级记录](docs/dsh-0.1.5-rc-upgrade.md)）；0.1.5 稳定版发布到 npm 后再切到正式 tag。

## 快速安装

本项目不能只使用标准的 `dsh plugin` 命令安装。它同时包含 dsh bridge plugin 和浏览器扩展。一行安装器目前会安装 Chrome 构建。

macOS 与 Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

Windows（PowerShell）：

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

安装器打开 `chrome://extensions` 后，请按提示加载或重新加载 **dsh 浏览器助手**。如果 dsh 已经在运行，安装完成后请重启。前置要求、启动命令、更新方式和开发者安装详见[详细安装与使用](#详细安装与使用)。

> [!IMPORTANT]
> npm 上未加 scope 的 [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) 包属于另一个项目，与本仓库无关。本项目目前没有发布 npm 包，请使用上方安装器。

## 性能基准

在 2026 年 8 月 18 日完成的 60 次配对端到端评测中，两个后端分配到的 30 次运行均全部成功；dsh 浏览器操作使用了更少的模型/工具轮次，并以更短时间完成任务：

| 后端 | 成功率 | 平均端到端耗时 | 平均浏览器工具调用 |
|---|---:|---:|---:|
| **dsh 浏览器操作** | **30/30** | **5.32 秒** | **3.4** |
| 对齐工具契约的 Playwright 基线 | 30/30 | 6.67 秒 | 4.7 |

Playwright / 扩展的配对耗时比为 **1.24**（95% CI **1.16–1.34**）：Playwright 耗时约多 24%；等价地说，dsh 浏览器操作将延迟降低约 20%，每个任务平均节省 1.35 秒。评测使用 6 个浏览器任务、5 个确定性 seed、相同的 DSH profile 与模型（`deepseek-v4-flash`），并通过独立页面状态验证结果。详见[评测方法与复现说明](benchmark/README.md)。

## 核心能力

| 能力 | 工具 | 说明 |
|---|---|---|
| 读取页面 | `browser_snapshot` | 结构化文本快照：标题/URL/正文/编号交互清单/表单字段（敏感值掩码）；`delta: true` 只返回变化；默认附带同刻截图，`visual: false` 可关 |
| 截取页面 | `browser_capture` | 返回视口截图（`fullPage: true` 为整页），仅内存、不落盘 |
| 读控制台与网络 | `browser_console` / `browser_network` | 控制台消息与未捕获错误（带 cursor 增量）；请求列表含状态与耗时、按 id 取响应体、内存内响应替换 |
| 回应用户弹窗 | `browser_dialog` | 确认或取消 `alert` / `confirm` / `prompt`；这类弹窗会冻住页面，回应之前其它工具都会卡住 |
| 执行页面 JS | `browser_eval` | 在页面自身上下文求值，不受页面 CSP 限制；每次单独审批 |
| 阻断/改写请求 | `browser_block` / `browser_headers` | 阻断匹配请求，或改写请求/响应头；仅作用于受控标签页、仅当前浏览器会话 |
| 点击元素 | `browser_click` | 按编号点击链接/按钮/复选框等 |
| 点击绑定在按压上的控件 | `browser_click_pointer` | 在元素矩形中心派发 `pointerdown`、`mousedown`、`pointerup`、`mouseup`、`click`；用于 Google Slides 这类画布/SVG 编辑器——`browser_click` 回报成功但页面没反应时改用它 |
| 填写表单 | `browser_type` | 输入文本（React/Vue 受控组件兼容），`replace` 清空重填 |
| 按键 | `browser_press` | 键盘事件（Enter/Tab/Escape/方向键…） |
| 滚动 | `browser_scroll` | 视口滚动（up/down/top/bottom） |
| 页面导航 | `browser_navigate` / `browser_back` / `browser_forward` / `browser_reload` | 受控标签页内导航，保留登录态 |
| 读取区域 | `browser_get_text` | 懒加载内容 / 局部文本；`find`（配 `context`）按文本定位并返回有界窗口 |
| 查询元素 | `browser_dom_query` | 按 CSS 选择器读指定字段，每个匹配都带一个经校验唯一的选择器可直接操作 |
| 看图 | `browser_image` | 按引用取回页面里的图片（img/canvas/SVG/背景图），原分辨率返回；不需要调试能力，DevTools 开着或后台标签页都能用 |
| 绑定页面 | `browser_bind_interactive` | 列出可绑定页面、让用户选一个并绑定本会话 |
| 导出 Google 文档 | `google_drive_export` | 仅 Docs/Sheets；Slides 与 Drive 文件按普通页面用浏览器工具读 |
| 等待稳定 | `browser_wait` | 页面加载与渲染稳定检测 |

## 组成

```
packages/browser/bridge-browser/
  cordis.patch.yml
extensions/dsh-browser/
.dsh/skills/
scripts/install.sh
scripts/install.ps1
scripts/install-skills.mjs
```

## 为什么这样设计

- **使用你的真实浏览器，而不是无头副本**：模型操作你已经打开的页面，登录态、会话和 Cookie 均会保留。
- **纯文本页面接口**：编号控件、跨快照稳定 ID、delta 更新和敏感值掩码，使模型无需截图也能操作页面。
- **收窄隐私边界**：密码和支付卡字段始终显示为 `••••`，字段值不会离开页面。
- **受保护的桥连接**：远程连接使用认证握手；桥只服务浏览器工具帧和两个桥内部 RPC；扩展把工具绑定到一个由用户控制的标签页。

## 详细安装与使用

前置要求：Node.js `^22.19` 或 `>=24`、Corepack/pnpm，以及 Chrome 116+ 或 Firefox 140+。Windows 还需要系统自带的 Windows PowerShell 5.1，或 PowerShell 7+。

### 安装或更新

托管安装请运行：

```sh
curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

Windows 请运行：

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

安装器会下载 `main`、构建并注册桥插件、把 Chrome 扩展构建到 `~/.dsh/browser-extension`，然后打开 `chrome://extensions`。首次安装时，请把该目录作为已解压扩展加载；更新时点击**重新加载**。如果 dsh 已在运行，请重启。

`scripts/install.sh` 覆盖 macOS 与 Linux，`scripts/install.ps1` 覆盖 Windows；两者写入同一个托管工作区和同一份安装元数据。当系统提供剪贴板工具（`pbcopy`、`wl-copy`、`xclip`、`xsel` 或 PowerShell 的 `Set-Clipboard`）时，安装器会把扩展路径复制到剪贴板；无论是否复制成功都会打印该路径。若未检测到 Chrome/Chromium，安装器会打印对应的安装命令；设置 `DSH_INSTALL_BROWSER=1` 可让安装器尝试自动安装。

Windows 命令先下载 `install.ps1` 再执行，而不是管道给 `Invoke-Expression`：脚本是带 BOM 的 UTF-8，Windows PowerShell 依赖 BOM 才能正确显示中文，而 `Invoke-Expression` 无法处理开头的 BOM。

如需从源码 checkout 安装当前分支：

```sh
git clone https://github.com/Lum1104/dsh-browser.git
cd dsh-browser
./scripts/install.sh
```

Windows 请在 checkout 中运行 `.\scripts\install.ps1`。拉取或切换版本后，请重新运行安装器并重新加载扩展。

### 随仓库分发的技能

仓库同时把这些工具对应的操作经验作为技能放在 `.dsh/skills/` 下。放在仓库里的原因：浏览器行为的改动和针对该行为的经验能一起评审、一起提交；安装到 `~/.dsh/skills/` 的原因：技能文件系统提供方会扫描项目根目录（优先级 100）和用户目录 `~/.dsh/skills`（优先级 400），只留在仓库里的话，只有从本仓库启动的会话能用到。

`scripts/install-skills.mjs`（安装脚本的第 4 步，也可单独执行 `pnpm run skills:install`）把每个技能链接到 `~/.dsh/skills`；`--copy` 改为复制，Windows 安装脚本用的就是复制，因为在那里创建链接需要开发者模式或管理员权限。macOS 和 Linux 默认用符号链接，因此改仓库里的那份立即生效，安装出来的副本也不会与仓库脱节。技能只在其描述与当前任务匹配时才会加载，例如 `google-slides-via-browser` 只在受控标签页是 Google Slides 编辑器时加载。

### Firefox 源码构建

Firefox 使用独立的 MV3 manifest、事件页后台和 Sidebar。在 checkout 中构建后，打开 `about:debugging#/runtime/this-firefox`，选择「临时载入附加组件」，再选取 `extensions/dsh-browser/dist-firefox/manifest.json`：

```sh
pnpm install
pnpm --filter dsh-browser-extension run build:firefox
```

桥地址仍会自动探测。Firefox 的 `moz-extension://` UUID 不能证明扩展身份，因此需要把 `~/.dsh/ext-bridge-token` 中的 bearer token 填入扩展设置（dsh 启动日志会报告该文件路径）。签名发布时可直接使用同一份 `dist-firefox/` 产物。

### 启动与使用

启动托管安装：

```sh
cd ~/.dsh/dsh-browser && pnpm start
```

使用源码 checkout 时，请在仓库根目录运行 `pnpm start`。当前受支持的精确公开版本为钉定的 0.1.5 预发布版：

```sh
npx @deepseek-ai/dsh@0.1.5-rc.1 web
```

Chrome 本机使用无需配置；Firefox 需要填写上述本地桥 token。打开任意 `http://` 或 `https://` 页面，点击 DeepSeek 鲸鱼图标，等待状态面板显示**已连接**。已有标签页会在第一次操作时自动加载；浏览器受保护页面和扩展商店不受支持。

## 故障排查

**状态面板一直显示「未连接」**

- 确认本机 dsh web 正在运行（默认 `http://127.0.0.1:3080`）。
- 确认桥接已加载：浏览器打开 `http://127.0.0.1:3080/ext/bridge-config`，应返回类似 `{"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}` 的 JSON。如果返回的是网页而不是 JSON，说明当前运行的 dsh 早于桥接注册——重启 dsh 并刷新页面即可，扩展会自动重连。
- 扩展会自动探测 3080/3081/3090/14389/43189（dsh Desktop）端口。若 dsh 运行在其它端口，或使用 `--host 0.0.0.0` 远程部署，请在扩展设置页中填写地址与桥接 token。Firefox 始终需要 token。

## 开发

桥接插件和 Chrome/Firefox 扩展都属于本仓库 workspace；所有命令均在本仓库根目录执行。首次开发安装运行 `pnpm install`。

```sh
pnpm run build
pnpm run typecheck
pnpm run test

pnpm --filter @yuxianglin/dsh-bridge-browser run build
pnpm --filter @yuxianglin/dsh-bridge-browser run typecheck
pnpm --filter @yuxianglin/dsh-bridge-browser run test

pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

注意：

- 启动前桥接插件必须已有 `lib/` 供 Loader 加载；`scripts/install.sh` 和根目录 `pnpm run build` 都会先构建插件再构建扩展。
- `@deepseek-ai/dsh` 与桥接插件的依赖固定在同一条经过验证的公开发布线上；升级时必须同时更新 manifest、锁文件并重跑根目录检查。

## 安全

- 桥路径在 `/api` 信任栅栏之外，自带 bearer token 认证。
- Chrome 扩展的本地 Origin 保留零配置回环访问；Firefox Origin 是每次安装生成的 UUID，必须携带 bearer token。
- 特权网关方法（`settings.*`/`credentials.*`/`host.open*`）对非回环来源一律拒绝。
- 单活动连接；页面读取默认走文本，模型路由声明支持图片输入时 `browser_snapshot` 会附带截图。截图依赖 Chrome 扩展的 `debugger` 权限（截取期间 Chrome 会显示调试提示条），只存在内存中、不写磁盘；密码和卡号值永不回传。
- 助手开始操作页面时，会在首次浏览器工具调用时绑定当时的活动标签页。用户手动切页后，后续浏览器操作会暂停，助手会询问让助手继续原页面还是跟随新页面；选择原页面后允许在后台继续，但扩展绝不静默改绑或切换用户正在看的页面。受控标签页关闭后也会暂停，直到下一次调用显式选择当前页面。
- 网页文字会标记为不可信输入。默认「自动共享」只按需读取受控标签页且不额外弹窗；对隐私敏感时可选择「每次询问」，或用「关闭」完全阻断读取。在「每次询问」模式下，读取弹窗可以仅允许一次，也可以持久切回自动读取；之后仍可在设置中关闭。读取的页面文字会发送给当前选择的模型。
- 点击、输入、按键、导航、历史跳转和刷新默认失败关闭，必须由用户批准。会话的首次 `browser_navigate` 也是在批准之后才创建新标签，被拒绝或未应答的调用不会发出任何请求。Google Drive 导出走同一套审批：按文档所在 origin 授权，信任该 origin 后不再询问。可以信任某个 origin 用于当前会话；永久信任需在扩展设置页中显式管理。显式跨域 `browser_navigate` 和未知目标的历史跳转始终重新询问。
- 无法归到单一 origin 的动作（`browser_eval`、`browser_headers`、`browser_dialog`、`browser_network` 的 `mock`/`mockClear`、历史前进后退）没有「信任此网站」，改为提供「本会话内允许」：按会话 + 动作记住，本会话内同名动作不再询问，解绑、切换绑定标签页、标签页关闭或浏览器会话结束即失效。`browser_navigate` 不在其中——它的风险就是目标地址，会话级授权等于一次批准后本会话可去任意站点，所以它仍然每次询问（跨站导航始终询问，单一 origin 可用「信任此网站」停止询问）。授权面板超时（60 秒未应答）后仍可让模型重发同一调用，重新弹出确认。
