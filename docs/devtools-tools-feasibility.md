# 调研：给 dsh-browser 追加 DevTools 类工具

> 状态：**调研完成；§0 的能力已实施**（视觉 2026-09-15，控制台 / 网络 / 执行 JS / 弹窗 2026-09-16，断点 / 单步 2026-10-13，见 §0）。DevTools 类能力已全部落地。范围：能否在现有 `dsh-browser`（host 插件 + Chrome/Firefox 扩展）里加「控制台 / 网络 / 执行 JS / 断点 / 截图」这类 DevTools 能力，以及分几步做、每步的硬约束。

## 0. 实施记录：视觉（截图）已落地

已按「路线 B 的截图子集」实现，与路线 A 无关：

- `BridgeCaps` 的 `textOnly` 双向兼容标记已于 2026-09-16 删除，改为 `proto`（握手版本，缺失即旧构建）+ `toolset`（扩展能力级别，缺失即 0），调试能力由 `debugger` 声明；`isCaps` 仍接受老扩展只报预算的 hello，宿主按 `toolset` 裁剪工具面（见[决策记录](pure-tool-bridge-decisions.md)）。
- `browser_snapshot` 默认附带**同一时刻**的截图，`visual: false` 可关；`browser_capture` 新增，参数 `fullPage` / `format` / `quality`。
- 扩展侧 `src/background/capture.ts`：`chrome.debugger` 临时 attach → `Page.getLayoutMetrics` → `Page.captureScreenshot`（CSS 像素 clip，支持 `captureBeyondViewport`）→ 按宿主 `imageLimits` 缩放/降质 → `finally` detach。字节只走内存 + base64 过桥，扩展不落盘。
- host 侧：图片经 attachment 服务 `saveImage` 变成 image block，渲染时先给一条 untrusted 提示再附图；路由不声明图片输入时降级为纯文本并说明原因。
- 权限：Chrome manifest 加 `debugger`（安装警告 "Access the page debugger backend"）；Firefox 不加，报 unsupported。截图归入页面读取审批（`PAGE_READS`），受 `sharePageContent` 策略与 blocked origins 约束。
- 测试：host 68、扩展 129 全绿（含 `tests/capture.spec.ts`、截图派发/降级/DevTools 冲突用例）。

截图部分仍然保留调研结论里的两条硬约束，实际使用时要注意：**该标签页开着 DevTools 时无法 attach**，以及**截取期间浏览器顶部会出现调试提示条**（用户点掉即断，工具会报可操作错误）。

已落地（2026-09-15 同日追加，五件套）：

- `browser_console`：CDP `Runtime.consoleAPICalled` + `Runtime.exceptionThrown` + `Log.entryAdded`，按 tab 常驻会话 + 环形缓冲（300 条），`cursor`/`level`/`text`/`limit` 增量读。
- `browser_network`：`Network.*` 缓冲（200 条，含失败原因与耗时）；`requestId` 取响应体（`Network.getResponseBody`）；`mock`/`mockClear` 走 `Fetch.enable` + `Fetch.fulfillRequest`/`failRequest`——**这是唯一能替换响应内容的路径**，规则只存在内存里。
- `browser_eval`：`Runtime.evaluate`（`awaitPromise`、`returnByValue`、`allowUnsafeEvalBlockedByCSP`），在页面自身上下文求值。
- `browser_block` / `browser_headers`：DNR **session 规则 + `tabIds`**（只作用于受控标签页，随浏览器会话结束失效），权限用 `declarativeNetRequestWithHostAccess`（无新增安装警告）。响应体不在 DNR 能力内。
- 审批：`browser_console`/`browser_network` 属页面读取（受 `sharePageContent` 约束）；`browser_eval`、`browser_headers`、`browser_network` 的 mock 变体**永不信任跳过**；`browser_block` 可按 origin 信任。日志、URL、求值结果一律过 `wrapUntrustedContent`。
- 生命周期：会话与规则都绑定受控标签页，标签页关闭时一起清理。

未做：无。`browser_debug`（断点/单步）已于 2026-10-13 落地，见下方 §0.2。

## 0.1 网络拦截/改写能力核对（2026-09-15，官方文档 + CDP 协议）

决定后续做哪组工具的真实边界：

| 诉求 | DNR（不需要 `debugger`） | CDP `Fetch`（需要 `debugger`） |
|---|---|---|
| 真的阻断请求 | 能（`block`，可按 `tabIds` 只作用于受控页） | 能（`Fetch.failRequest` 可指定失败原因；`Network.setBlockedURLs` 只按通配屏蔽、无逐请求回调） |
| 改写请求头/响应头 | 能（`modifyHeaders`：set/append/remove，需 host 权限） | 能（`continueRequest` 改 url/method/headers/postData；`fulfillRequest` / `continueResponse` 改响应码与响应头） |
| 替换响应体 | **不能**——action 全集是 block/redirect/allow/allowAllRequests/upgradeScheme/modifyHeaders | 能（`fulfillRequest` 带 `body` base64；响应阶段可只覆盖部分字段） |
| 拦截阶段 | 声明式规则，无逐请求回调 | Request / Response / AuthRequired（后者需 `handleAuthRequests: true`） |

权限与代价：

- `declarativeNetRequest` 的安装警告是「Block content on any page」；`declarativeNetRequestWithHostAccess` **本身不产生警告**，但每个动作都要求 host 权限——本扩展已申请 `http(s)://*/*`，走这条路径新增警告为零。`declarativeNetRequestFeedback`（调试用）另有「Read your browsing history」警告。
- `modifyHeaders` 细节：请求头 `append` 只有 20 项白名单（accept/cookie/user-agent 等，大小写敏感），响应头不受该限制；`responseHeaders` 条件匹配要 Chrome 128+；进入响应阶段后请求已发出，此时 block/redirect 已无效。
- DNR 规则上限：动态安全规则 3 万 / 非安全 5 千，session 规则 ≤5000，正则规则合计 ≤1000。
- Firefox 支持 DNR（113+），但 `getMatchedRules` 需 about:config 打开 `extensions.dnr.feedback`，且同优先级下 session>dynamic>static 的排序不保证与 Chrome 一致——别依赖同级优先级。
- MV3 普通扩展不能用 `webRequestBlocking`（仅 policy 安装的扩展可用）。
- CDP 侧的代价与截图相同：`debugger` 权限、attach 期间与 DevTools 互斥。

内容脚本近似（MAIN world 包装 `fetch`/`XHR`）只覆盖走 fetch/XHR 的请求：`<script src>`、`<img>`、`<link>`、导航、WebSocket/EventSource/sendBeacon、`document_start` 之前已发出的请求、Service Worker 发出的请求都做不到。所以「真的 block」和「真的替换」都不该走这条路。

## 0.2 实施记录：`browser_debug`（断点 / 单步，2026-10-13）

按 §4.2 的映射落地，一个工具九个动作：`scripts`（已解析脚本清单）、`break`（行断点 `url`/`urlRegex` + 0 基 `lineNumber` + 可选 `condition`；`kind: "xhr"` 走 `Debugger.setXHRBreakpoint`）、`unbreak`（单条或 `all`）、`list`、`pause`/`resume`/`step`、`wait`（暂停环形缓冲 + cursor，读时按需取栈顶帧变量）、`eval`（`Debugger.evaluateOnCallFrame`）。

- `Debugger` 域加进 `debugger-session.ts` 的 `DebuggerDomains`，但**不参与预热**：只有模型真的调 `browser_debug` 才 enable（它会让 V8 为后续每个脚本收集脚本事件与单步元数据）。会话仍是那一个共享的 per-tab attach。
- 事件不挂在 devtools 的 console/network 路由器上，而是 `js-debug.ts` 自己装 `chrome.debugger.onEvent`：那个路由器会丢掉"没有缓冲记录"的标签页的事件，而暂停必须对派发器可见——即使这个标签页从没预热过。
- **暂停也是一种冻结**，与弹窗同级。`pausedAtBreakpoint` 让 `dispatchToolCall` 在取审批之前就拒掉页面类工具（`PAUSED_SAFE_TOOLS` 之外的），并点名 `browser_debug { action: "resume" }`。与弹窗一致：拒绝文案带暂停位置，console/network 缓冲照常可读。
- 生命周期：`dropJsDebug`（resume + `Debugger.disable`，清断点）在标签页关闭、解绑、以及**关掉调试开关**时执行——后者尤其重要，开关关掉后 `browser_debug` 会被 `debugToolRefusal` 拒掉，留下的断点就没有任何工具能解开。Chrome 侧 detach 走模块自己的 `onDetach` 监听，只清内存。
- 工具集级别：`TOOLSET_JS_DEBUG = 7`（`BRIDGE_TOOLSET` 6 → 7）。调试工具原本只看 `caps.debugger` 注册，而 `browser_debug` 是唯一一个旧构建没有对应 wire case 的动作，所以注册条件改为"调试能力 ∧ 级别 ≥ 7"；`setClientToolset` 在级别变化时同步这道交集。
- 审批：归入 `UNTRUSTABLE_ACTIONS`（与 `browser_eval` / `browser_headers` / `browser_dialog` 同级），每次单独审批、`canTrust: false`——`trustJsExecution` 不覆盖调试器；审批卡按动作给出中文/英文摘要（"在暂停的调用帧里求值" ≠ "恢复页面运行"）。
- 隐私：`sharePageContent: 'off'` 下拒掉会带回页面数据的动作（`scripts`/`break`/`wait`/`eval`），但保留纯控制动作（`pause`/`resume`/`step`/`list`/`unbreak`）——全部拒掉会让停在断点上的页面无路可走。
- 已知边界：暂停期间任何内容脚本工具都会挂到调用上限；`eval` 不支持 await（`Debugger.evaluateOnCallFrame` 协议上没有该参数，promise 只能作为对象返回）；`Debugger.paused` 的调用帧 id 只在"当前这次暂停"有效，旧条目按 stale 渲染。
- **真机冒烟结果（2026-10-13，本机 Chrome + 本地测试页 `http://127.0.0.1:8731`）**：已实测通过 `scripts`、`break`（唯一子串解析到真实 URL、返回已绑定位置）、`break {kind:"xhr"}`（暂停 `reason` 为 `XHR`，停在 fetch 之前）、`wait`（调用帧 + 栈顶帧局部/闭包/全局变量、`nextCursor` 分页、旧暂停标 stale）、`eval`（`input + 1` → 30）、`step over`（`reason step`，停到下一行且 `doubled` 已赋值）、`pause`、`list`、`unbreak {all:true}`、`resume`、暂停期间页面类工具被拒并带暂停位置、以及**关掉调试开关后页面立刻恢复**（`resume` + `Debugger.disable`，页面工具随即正常）。
- 真机冒烟（2026-10-13）修正两处只有真机才暴露的问题：XHR/fetch 断点走 `DOMDebugger.setXHRBreakpoint`（`Debugger` 域没有这个方法，实测返回 `-32601`）；`Debugger.CallFrame.url` 会为空，帧的 URL 改用 `location.scriptId` 回查脚本清单。`Debugger.pause` 还可能停在别的扩展注入的脚本里（实测），要精确请用 `break`。
- **未验证 / 有意保守的地方**（2026-10-13 复核后确认，都不是"忘了做"）：
  1. **worker 重启会丢暂停记录，但 attach 可能还在**。`debugger-session.ts` 的 `attach-reused` 分支承认 attach 能跨 worker 重启存活，而本模块的 scripts/pauses/breakpoints 全在内存里；真发生这种组合时页面仍被暂停、而 `pausedAtBreakpoint` 已返回 undefined，守卫要到下一次 `browser_debug` 调用重新 enable 域时才可能自愈（`Debugger.enable` 对已暂停目标是否重发 `Debugger.paused`，需真机 MV3 重启才能确认）。仓库里 `debug-log.ts` 与 `debugger-session.ts` 两条注释对"重启是否带走 attach"说法相反，本机无法判定。缓解：`detachDevtoolsSession` 现在无条件走 `releaseDebuggerDomain`，即便内存记录已丢也会发一次 `Debugger.disable`（它会连带清断点、放开暂停）。
  2. **暂停期间 `browser_capture` / `browser_snapshot` 被拒**。它们走 CDP，理论上可能拍得到暂停画面（DevTools 就能），但未实测；保守起见按"冻结"处理，拒绝文案带暂停位置。
  3. **弹窗在时 `browser_debug` 也被拒**（不在 `DIALOG_SAFE_TOOLS`）：那会儿该先答弹窗，且 Debugger 命令只会排在弹窗后面。
  4. **共享的 `pageBufferText` 只统计被 `maxChars` 挤掉的行**，不统计被 `limit` 跳过的条目；被截断的一页仍会把 `nextCursor` 推到"已选中的最后一条"，因此按打印出来的 cursor 翻页可能跳过没印出来的条目（`browser_console` / `browser_network` 一直如此，本次未改）。

## 1. 结论

能做，但要分成两条本质不同的路：

| | 路线 A：内容脚本 + webRequest 近似 | 路线 B：`chrome.debugger`（真 CDP） |
|---|---|---|
| 安装期新权限 | `webRequest`（不改现有 host 权限；可能无新增警告文案，待实测） | `debugger`，警告文案 "Access the page debugger backend"，**且不可声明为 `optional_permissions`** |
| 浏览器 | Chrome + Firefox 一套代码 | 仅 Chrome、Safari 也没有 |
| 控制台 | MAIN world 包装，能拿注入之后的日志（静态 `document_start` 可覆盖首屏） | `Runtime.consoleAPICalled` / `Log.entryAdded` |
| 网络 | `webRequest`：URL/方法/请求头/响应头/状态码/请求体；**拿不到响应体** | `Network.*`：全部字段 + **`Network.getResponseBody` 响应体** |
| 执行 JS | isolated world 只能读写 DOM，看不到页面 JS 变量；MAIN world 受页面 CSP 限制（不能 eval） | `Runtime.evaluate`，页面上下文、支持 await、不受页面 CSP 限制 |
| 断点/单步 | 不可能 | `Debugger` domain 可以 |
| 截图 | 不可能 | `Page.captureScreenshot` |
| 用户可见代价 | 无 | 顶部常驻黄条「XX started debugging this browser」，点掉即断；**该标签页不能同时开 DevTools** |
| 会话稳定性 | 无状态 | Chrome 118+ 起活动 debugger 会话会保活 service worker（见 §4.1），主要风险变成用户手动关闭 |

**建议的落地顺序**：

1. **先做路线 A**：`browser_eval`（isolated world，DOM 层）+ `browser_console`（MAIN world hook）+ `browser_network`（`webRequest` 观察）。零体验代价、Firefox 一起可用，覆盖「页面报什么错、哪个请求 404、跑段 JS 看看」这类日常需求。
2. **路线 B 作为 Chrome-only 可选增强**：工具名不变、实现分流到 CDP，独有能力是响应体、页面上下文求值、断点、截图。前提是先跑 §8 的三个实验。
3. **不建议**用「装一个外部 CDP 插件」替代本仓库链路：Chrome 136+ 对默认数据目录禁用远程调试端口，外部插件只能另起一个 `--user-data-dir` 的 Chrome，登录态与「用户真实浏览器」这个前提就没了（见 §5）。

真正的工作量不在新工具的 schema，而在四处现有约束：

- **虚拟工具完全绕过审批**：`browser_list_tabs`/`browser_bind_tab`/`gdrive.fetch` 在 `handleVirtualTool` 分支直接返回，早于 `dispatchToolCall` 的 `authorize` 回调（`extensions/dsh-browser/src/background/index.ts:1049`）。DevTools 工具若由后台自己应答，必须补一条审批路径，否则等于给模型开了无审批的任意 JS 执行。
- **授权策略是「不在名单里就不弹审批」**：`approvalPromptForCall` 决定哪些调用需要弹窗，除 `PAGE_READS` / `STATE_CHANGING_ACTIONS` 两个集合外，还有 `UNTRUSTABLE_ACTIONS`（eval / headers / dialog）、`REMOTE_FETCH_ACTIONS`（gdrive.fetch）与 `browser_network` 的 mock 专判，共五组（见 `src/background/authorization.ts`）。新增工具忘了归类就是静默放行。
- **能力必须协商**：Firefox 无 `chrome.debugger`。这条路径现在存在：`BridgeServerDeps.onCapabilities` 在握手/替换/断连时通知工具注册表，调试工具按 `caps.debugger` 注册或注销，工具面按 `caps.toolset` 裁剪。模型路由是否支持图片输入仍在宿主每次调用前解析。
- **text-only 曾是显式产品决策**（原 `BridgeCaps.textOnly: true`，该字段已于 2026-09-16 随 `proto` 化删除），现已按 §0 改成「文本为主视图 + 按需视觉」：截图走 attachment + image block（DSH 支持，见 §6.3），并要求模型路由声明图片输入，否则回退纯文本。

## 2. 现有链路（改造落点）

```
模型 ── tool.call ──> host 插件 tools.ts ── WS ──> 扩展 background/index.ts
                                                      ├─ 虚拟工具：handleVirtualTool（后台自答，不碰页面，无审批）
                                                      └─ 普通工具：resolveToolTab → dispatchToolCall → 审批 → content script
```

- host：`packages/browser/bridge-browser/src/{tools,protocol,server,index}.ts`。
- 扩展：`extensions/dsh-browser/src/background/{index,tools,authorization}.ts`、`src/content/{index,actions}.ts`、`src/security/{approval,untrusted,trusted-origins}.ts`。
- 成本差别：新增「走 content script 的工具」动 5 个文件；新增「虚拟工具」动 3 个 + 自己补审批。

## 3. 路线 A：不新增 debugger 权限的近似实现

### 3.1 控制台（MAIN world hook）

- 注入方式：manifest 第二条 `content_scripts`，`"world": "MAIN"` + `"run_at": "document_start"`。**必须用静态声明**：官方明确 `scripting.executeScript` 配 `injectImmediately` 也「不保证早于页面加载」，抓首屏只能用静态注入。
- 包装 `console.*`、`window.onerror`、`unhandledrejection`，把条目（时间、level、序列化文本）写入后台环形缓冲，模型按 `cursor` 增量读。
- MAIN world 拿不到 `chrome.*`，需要 `window.postMessage` 与现有 isolated content script 通信（或后台分别与两个脚本通信）。序列化要自己处理循环引用、DOM 节点、超长字符串。
- **CSP**：官方原文「content script 注入 MAIN world 时，页面的 CSP 生效」——注入本身不被拦，但 MAIN world 里不能 `eval`、不能加载外链脚本。hook 不需要 eval，所以不受影响。

### 3.2 网络（`chrome.webRequest`）

比在内容脚本里包装 `fetch`/`XHR` 可靠得多，且能看到跨 frame/worker 请求：

- 可见：URL、方法、请求头（`extraHeaders` 解锁 CORS 受限头）、响应头、状态行、redirect 链、请求体（`requestBody`）。
- 不可见：**响应体**（API 无此能力）；service worker 睡着期间错过的请求不补发（本仓库常开 WS + 心跳，SW 基本不睡）。
- 需要 `webRequest` 权限 + 对应 host 权限（现有 `http://*/*`、`https://*/*` 已覆盖）。
- 备选（零新权限，但精度低）：包装 `fetch`/`XHR`（能拿页面实际消费的 body/状态，但会被页面察觉）或 `PerformanceResourceTiming`（`responseStatus` 非 Baseline，跨域无 CORS 头时为 0，且没有头信息）。

### 3.3 执行 JS

- isolated world：能跑任意 JS、读写 DOM、返回值可序列化；**看不到页面自己的 JS 全局变量**（`window.__NUXT__`、框架内部状态等）。对「读 DOM 里的数据」够用。
- MAIN world：能碰页面变量，但 `eval`/`new Function` 受页面 CSP 限制，GitHub 这类严格 CSP 站点会直接失败——要在工具返回里把这类失败表达成明确错误，而不是静默空结果。

### 3.4 局限（必须写进工具描述）

enable 之前的历史日志拿不到；worker 内部日志拿不到；跨域 iframe 需要 `all_frames` + host 权限匹配（`match_origin_as_fallback` 只覆盖 about:/data:/blob:/filesystem:）；页面可以绕过包装。

## 4. 路线 B：`chrome.debugger`（真 CDP）

### 4.1 平台事实（已核对官方文档与 Chromium 源码）

- **权限**：只要 `"permissions": ["debugger"]`，不需要额外 host 权限；安装警告 "Access the page debugger backend"；**不能作为 `optional_permissions`**——意味着只要声明，所有用户安装时都会看到这条警告，无法「用到才授权」。这是路线 B 最实在的产品成本。
- **可用 domain** 是白名单，我们要的都在：`Runtime`（evaluate / consoleAPICalled）、`Log`、`Network`（含 `getResponseBody`）、`Page.captureScreenshot`、`DOM`、`Target`、`Debugger`、`Performance`、`Input` 等。
- **attach 范围**：普通 http(s) 可以；`chrome://`、`devtools://`、别人的 `chrome-extension://` 页面不行（`Cannot attach to this target`）；`file://` 需用户开启文件访问。
- **与 DevTools 互斥**：用户在该标签页打开 DevTools 时，Chrome 会抢断扩展会话（`onDetach`，reason `canceled_by_user`）；反向 attach 报 `Another debugger is already attached`。对开发者工具场景这是高频撞车，UI 必须给「请先关闭该标签页的 DevTools」这类可操作提示。
- **黄条**：`"<扩展名> started debugging this browser"`，用户不手动关闭就不消失；用户点掉即断（`canceled_by_user`）。
- **service worker 生命周期**：**Chrome 118+ 起，活动的 debugger 会话本身就会保活 SW**，官方已把 WebSocket 保活列为次优方案。也就是说早期担心的「SW 回收断会话」在本仓库的目标版本（Chrome 118+）上基本不成立；剩余风险是标签页关闭（`target_closed`）、用户关黄条、用户开 DevTools。
- **数据是事件流**（console/network 由 CDP 主动推），而现有协议只有 `tool.call → tool.result` 请求/响应。最省事的映射：后台订阅事件写环形缓冲，工具读缓冲返回 `{ items, nextCursor }`，不必给线协议加新帧类型。`dsh-chrome-cdp` 的参数形状（`level?` / `text?` / `cursor?` / `limit?`）可直接抄。
- iframe 与 worker 用 `Target.setAutoAttach({flatten: true})` 覆盖，比现在按 `frameId` 找 content script 更完整。

### 4.2 能力映射

| 工具 | CDP |
|---|---|
| `browser_eval` | `Runtime.evaluate`（`awaitPromise`、`returnByValue`） |
| `browser_console` | `Runtime.enable` + `Log.enable`，缓冲 `Runtime.consoleAPICalled` / `Log.entryAdded` |
| `browser_network` | `Network.enable`，缓冲 request/response/failed；正文按需 `Network.getResponseBody` |
| `browser_screenshot` | `Page.captureScreenshot` → attachment |
| 断点/单步（已落地） | `Debugger.enable` / `setBreakpointByUrl` / `setXHRBreakpoint` / `paused` / `evaluateOnCallFrame` |

### 4.3 与路线 A 的合并方式

工具名与参数保持一致（`browser_console` / `browser_network` / `browser_eval`），`hello` caps 增加后端字段（`devtools: 'none' | 'hook' | 'cdp'`），宿主据此决定注册哪些工具、以及在描述里声明能力边界（例如 hook 后端明确写「无响应体」）。老的扩展不报该字段时按 `none` 处理；`isCaps` 目前是宽松校验，加可选字段不破坏兼容。

## 5. 路线 C：复用外部 CDP 插件（不推荐作为主路）

生态里已有现成实现，能力面比我们要做的更宽：

- [xiaobai2017666/dsh-chrome-cdp](https://github.com/xiaobai2017666/dsh-chrome-cdp)：11 个工具（`chrome_evaluate/console/network/debug/breakpoint/screenshot/click/type/list_targets/navigate/cdp`），`chrome-remote-interface` 直连，端点不通时自己拉起独立 profile 的 Chrome。1★，最后 push 2026-09-09，README 有三节正文缺失。
- [caob23/dsh-browser-control](https://github.com/caob23/dsh-browser-control)：MV3 扩展用 `chrome.debugger` 外连本地桥（与本仓库同构），工具含 `browser_evaluate/screenshot/console_log/network_log/pdf/emulate`。14★，AGPL-3.0。**它证明了「MV3 扩展 + chrome.debugger」这条路在实践上可行**。
- [lirui1024k/dsh-browser-ops](https://github.com/lirui1024k/dsh-browser-ops)（27 工具，含 `browser_diagnostics`）、[try-works/dsh-browser-agent](https://github.com/try-works/dsh-browser-agent)、[Viger1/dsh-preview](https://github.com/Viger1/dsh-preview)、[guo6x/dsh-shipcheck](https://github.com/guo6x/dsh-shipcheck) 也各自带 `evaluate`/`screenshot`/诊断工具。
- 对照：[Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser)（659★，同源路线）明确保持纯文本、不做截图。

不把它们当主路的唯一原因，但是硬约束：**Chrome 136+ 起，默认数据目录不再允许通过 TCP 端口或管道远程调试**（[Chrome 官方说明](https://developer.chrome.com/blog/remote-debugging-port)）。host 侧直连 CDP 只能对「另起 `--user-data-dir` 的 Chrome」生效，用户日常那个带登录态的浏览器进不来——与本仓库「操作真实浏览器、保留登录态」的核心决策（`docs/pure-tool-bridge-decisions.md`）冲突。它们适合作为「用户自愿另起干净实例」的补充，而不是替代。值得借鉴的是它们的工具命名与参数设计。

## 6. 要动的代码点（文件级）

### 6.1 host 插件 `packages/browser/bridge-browser`

- `src/tools.ts`：新增 `defineTool`（`browser_eval` / `browser_console` / `browser_network`，路线 B 再加 `browser_screenshot`）、加进 `BROWSER_TOOL_NAMES`、配超时预算。
- `src/protocol.ts`：`BridgeCaps` 加可选 `devtools` 字段。
- `src/index.ts`：system prompt 补一句能力边界；按 caps 动态注册需要在 `hello`/断连时 register/dispose（新路径）。
- `README{,.zh}.md`、`tests/tools.spec.ts`、`tests/composition.spec.ts`（后者断言了注册的工具集）。

### 6.2 扩展 `extensions/dsh-browser`

- `src/background/index.ts`：新工具路由；虚拟工具分支补审批；路线 B 加 attach 生命周期与事件订阅。
- `src/background/authorization.ts`：新工具必须显式归类（否则静默放行），加中英文审批摘要。
- `src/background/devtools.ts`（新）：环形缓冲、CDP attach/detach/重连、`cursor` 增量读、按需取响应体。
- `src/background/web-request.ts`（新，路线 A 网络）：`chrome.webRequest` 订阅与缓冲。
- `src/content/hooks.ts`（新）+ `manifest.json` 第二条 `content_scripts`（`world: "MAIN"`、`run_at: "document_start"`）。
- `manifest.json`：路线 A 加 `"webRequest"`；路线 B 加 `"debugger"`（且**只加 Chrome 侧**，`manifest.firefox.json` 不加；`tests/firefox-build.spec.ts` 不要求两边权限一致）。
- `src/options/*`：显式开关（默认关）；`_locales/*/messages.json` + `src/i18n.ts`：新文案；`src/panel/App.tsx`：审批卡片（若新增审批 kind）。

### 6.3 截图要走的 DSH 路径（已在本机类型定义中核实）

tool result 支持 image block：`dsh-llm/lib/types/types.d.ts` 里 `ContentBlockMap` 含 `'image': ImageBlock`，形状是 `{ type: 'image', attachment: ImageAttachmentRef }`（png/jpeg/webp/gif）。内置 `read_image` 就是这么返回的。要让模型真看到图，需要：把 PNG 存成 attachment、返回 image block，且**调用方模型路由显式声明图片输入**（`assertImageCapableRoute`）；当前生产适配器只声明 text-only 输出，所以这条路是否可用取决于模型配置，不是纯代码问题。

## 7. 安全与审批（设计重点）

- **默认关闭**：DevTools 能力在 options 里显式开启后 `hello` 才上报对应 caps。
- **每次审批，且不可信任**：`browser_eval` 等价于「在用户已登录的页面里执行任意代码」，不能进 trust-session / trustedActionOrigins 白名单，只允许 `allow-once`。
- **console/network 是页面读取**，可复用现有 `sharePageContent` 策略；但**响应体**（路线 B）敏感度更高，建议单独一档、默认不进 `auto`。
- **结果必须过 `wrapUntrustedContent`**：console 输出和响应体都是页面可控内容，是最典型的提示注入载体。
- **黑名单与绑定同样生效**：`blockedOrigins`、tab-affinity（只操作绑定/控制的标签页）在虚拟工具分支也要检查，不能因为是后台实现就跳过 `blockedOriginFailure`（`src/background/index.ts`）。
- **额度**：条目数、单条长度、响应体大小都要封顶（例如 300 条 / 单条 4KB / 正文 64KB），沿用现有快照预算思路。

## 8. 必须先跑的实验

1. **CDP 与 Playwright 冲突（只能手动验证）**：本仓库已移除浏览器 e2e 测试，调试类能力只能在真实浏览器里手工验证；若将来用 Playwright 驱动同一页面做自动化，`chrome.debugger.attach` 很可能直接失败（Another debugger is already attached），届时要么换标签页，要么仍只做手动验证。
2. **黄条关闭路径**：用户点掉黄条后工具的失败表达是否可操作（预期 `onDetach` / `canceled_by_user`）。
3. **DevTools 撞车**：先开 DevTools 再调工具，确认返回给模型的是清晰错误而不是超时。
4. **严格 CSP 页面**（GitHub / Google 系）：MAIN world 的 eval 被拒时的错误路径；isolated world 执行 JS 的实际边界。
5. **首屏覆盖**：`document_start` 静态注入能否拿到页面最早一批 console/请求。
6. **`webRequest` 权限的安装警告变化**：加权限前后 `chrome://extensions` 的权限列表差异（若无新增警告，路线 A 的权限成本基本为零）。
7. **Firefox**：确认工具集在该构建下不注册或明确报不可用，且不因缺 `debugger` 权限崩。

## 9. 工作量粗估

- 路线 A（3 个工具 + 审批 + options + 测试）：中等。主要是 MAIN world 注入与消息桥、参数序列化、`webRequest` 缓冲、CSP 边界处理。
- 路线 B（CDP 通道 + 缓冲 + 重连 + caps 协商 + 截图 attachment）：大。风险集中在 DevTools 撞车、黄条体验与截图链路的模型能力前提。
- 复用外部插件：0 代码，代价是另起 Chrome、丢登录态。

## 10. 参考

- `chrome.debugger`：<https://developer.chrome.com/docs/extensions/reference/api/debugger>（本机网络不可达官方站时可用镜像 `developer.chrome.google.cn`）
- service worker 生命周期（debugger 会话保活）：<https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- `chrome.webRequest`：<https://developer.chrome.com/docs/extensions/reference/api/webRequest>
- `devtools.network`（唯一免 debugger 能拿响应体的路径，但必须开着 DevTools）：<https://developer.chrome.com/docs/extensions/reference/api/devtools_network>
- 内容脚本与 MAIN world / CSP：<https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts>
- 远程调试开关的安全变更（Chrome 136+）：<https://developer.chrome.com/blog/remote-debugging-port>
- Firefox 侧无 debugger API：<https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/API/devtools>
- 现有架构决策：`docs/pure-tool-bridge-decisions.md`；现有工具与审批实现：`packages/browser/bridge-browser/src/tools.ts`、`extensions/dsh-browser/src/background/{index,tools,authorization}.ts`
