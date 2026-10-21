# 调研：单会话多 tab（dsh-browser）

> 状态：调研完成，方案定稿，未实施。2026-10-21。
>
> 范围：一个 dsh 对话会话（sessionId 由宿主的 `exec.agent.id` 提供）绑定多个受控 Chrome tab；页面工具按 tab id 寻址；串行操作，不做同一 step 内的并行；跨会话独占保留。
>
> 结论：可行，Chrome 层不改。重点在亲和模型、工具面、按 tab 的授权与生命周期、面板。单人约 2 周，改动约 1.5–2k 行。

## 1. 目标与口径

- 一个会话可以绑定 N 个受控 tab，工具调用按 tab id 指定操作对象。
- 串行即可：同一时刻只操作一个 tab，靠切换 id 在两个页面之间来回，不要求同一 step 并行。
- 绑定关系按会话记账；跨会话仍然是“一次只有一个会话操作浏览器”。
- N=1 时行为与现在一致；N≥2 才进入多 tab 语义。
- 工具参数的口径：N=1 时 `tab` 可选（默认唯一的 tab）；N≥2 时页面工具必须带 `tab`，缺了直接报错并列出已绑 tab。

## 2. 为什么不做并行

宿主对工具调用按 `isConcurrencySafe` 分类：只有显式声明并返回 true 才并行，否则 exclusive、被拆成单调用组。本仓库 23 个页面工具一个都没声明，所以同一 step 的浏览器调用本来就是一个接一个执行。

串行方案因此不需要改宿主调度，也不需要 per-tab 队列；反过来，如果要做“同时操作两个 tab”，就得加宿主 opt-in、per-tab 队列，并把审批/授权/资源按并发重新审一遍，成本从约 2 周涨到 4–5 周。用户 2026-10-21 明确串行即可，本方案按串行设计。

## 3. 现状边界（代码事实）

### 3.1 派发本来就按 tab

- `resolveToolTab(sessionId)` 取出会话的 tab，`dispatchToolCall` 收 `targetTab`，最后 `chrome.tabs.sendMessage(tabId, ...)` 发给该 tab 的内容脚本：`extensions/dsh-browser/src/background/index.ts:744`、`1727`、`1737`；`extensions/dsh-browser/src/background/tools.ts:1012`、`272`。
- 调试、弹窗、网络规则、帧、截图都已按 tab 记账：`devtools.ts`、`js-debug.ts`、`net-rules.ts`（规则带 `tabIds`，`net-rules.ts:27`）、`frames.ts`（`listTabFrames(tabId)`）、`tools.ts:138`（快照缓存按 tab）。
- 也就是说，“操作哪个 tab”在内部一直有，缺的是“这次调用点名哪个 tab”。

### 3.2 工具面没有 tab 参数

- 23 个页面工具都没有 `tab`：`packages/browser/bridge-browser/src/tools.ts:1890-2318`。
- `browser_list_tabs` 只是扩展的虚拟动作，由宿主 `choosePage` 调用给用户选页，模型看不到：`extensions/dsh-browser/src/background/index.ts:1498`、`1579`；`packages/browser/bridge-browser/src/tools.ts:558`。
- snapshot 的文本只有 URL/title，没有 tab id：`extensions/dsh-browser/src/content/snapshot.ts:448-449`。
- 模型偶尔能在 `browser_bind_interactive` 的返回和 page-choice 重试的结果行里看到 tab id（`index.ts:1632`；`packages/browser/bridge-browser/src/tools.ts:629`），但没有工具消费、没有枚举、结果不回显，不能据此可靠寻址。

### 3.3 亲和模型是“会话→1 个 tab”

- 内存里是 `Map<sessionId, AffinityTab>` 加单值 `controlled`/`active`：`extensions/dsh-browser/src/background/tab-affinity.ts:53-61`、`117`、`238`、`386`。
- 持久化是 `{ controlledTabId, sessionTabs: Record<sessionId, tab> }`：`index.ts:543-570`；恢复按会话逐个 `chrome.tabs.get` 剪枝：`index.ts:610-670`。
- `active` 是浏览器当前激活 tab，不是主 tab 能派生出来的；`handoff`/`pinned`/`keptActiveTabId`/`decide`/`restorePinned`/`bindInitial` 没有生产调用者（只在测试里）。
- `unbindSession` 只删 `sessionTabs` 和 `focusedSessionId`，不清 `controlled`（`tab-affinity.ts:122-128`）；`storedAffinity` 仍会写 `controlledTabId`（`index.ts:543-558`），worker 重启后 `restoreControlled` 会把已解绑的 tab 恢复成 controlled，而 `controlledTabInfo()` 因 focused 为空返回 null。

### 3.4 生命周期按会话处理

- 一次调用发现自己的页面没了，走 `releaseLostBinding` 解绑整个会话并撤全部授权：`index.ts:697-735`、`749-799`。
- 关 tab：`chrome.tabs.onRemoved` 对 affected sessions 调 `forgetSession(..., 'closed')`：`index.ts:2062-2071`。
- 换 tab（Chrome replaced）：`onReplaced` 同样对 affected sessions 撤授权：`index.ts:2046-2060`。
- 已绑会话没有“新开一个 tab 并加入”的路径；`chrome.tabs.create` 只在未绑会话首次导航的 `openBoundTab` 里（`index.ts:941`、`1022-1035`），且先建 tab 后 `hasBinding` 早退会留下孤儿 tab（`1032`）。

### 3.5 授权与审批没有 tab 维度

- 会话授权 key 只有工具名，`browser_network#mock` 是唯一变体：`extensions/dsh-browser/src/security/session-allowance.ts:137-140`；可会话授权的动作只有 7 个：network（含 `#mock`）、headers、dialog、eval、debug、back、forward（`155-166`）。
- key 是用原始 `call.args` 算的，默认走主 tab 的调用里没有 tab：`index.ts:842`、`859`。
- 审批卡只渲染 action/summary/origins，没有 tab，也没有 sessionId：`extensions/dsh-browser/src/panel/App.tsx:375-405`；`ApprovalRequest.sessionId` 字段存在（`security/approval.ts:42-45`）。
- `ApprovalCoordinator.cancelAll(sessionId)` 按会话取消，不能按 tab 过滤：`approval-coordinator.ts:66`。
- `trust-origin` 有按钮，写入全局 `trustedActionOrigins`（`panel/approval-buttons.ts:39-42`、`index.ts:834-836`）；`always-allow-reads` 把 `sharePageContent` 持久化成 `auto`（`index.ts:820-823`）。这两条是全局授权，per-tab session key 管不到。

### 3.6 bindings 上报只支持一条

- `BindingsReport` 的数组形状是给未来留的，注释明确写“controller currently allows one binding at a time, so this holds at most one entry”：`packages/browser/bridge-browser/src/protocol.ts:97-104`。
- 扩展只按会话发一条：`index.ts:1291`；host 路由只映射 `{sessionId, tabId}`：`packages/browser/bridge-browser/src/index.ts:542`。
- dsh 会话列表的浏览器图标是按会话标记，不是按 tab：`packages/browser/bridge-browser/src/client/client.js:93`。

### 3.7 资源与并发

- eager debugger attach（`primedTabs`）上限 3，超过就静默不 attach：`index.ts:396-410`、`398`、`412-419`；文档也写了这只影响多 tab：`docs/service-worker-lifetime.md:130`。
- `net-rules` 的 `addRule`（86-98）和 `clearTabRules`（146-153）都是无锁的 read-modify-write。
- 跨会话独占目前不是原子的：`browser_bind_tab` 的检查在 `tabs.get`/`affinityReady` 之前（`index.ts:1605`、`1618-1623`），未绑会话首次导航的检查在最长 60 秒审批之前（`index.ts:934`、`943`），`openBoundTab` 不再查竞争者（`1022-1037`）。

## 4. 设计定稿

### 4.1 寻址

- 23 个页面工具加可选 `tab`（数字，来自 `browser_list_tabs` 或绑定结果）。
- N=1 时 `tab` 可选，默认唯一的 tab；N≥2 时必填，缺了返回 `tab-required` 并列出本会话已绑 tab。
- `tab` 只在本会话已绑集合内解析；未绑定或已关闭返回 `tab-not-bound`，不复用 `needsPageChoice`（那是“完全没有页”的语义，宿主会拿旧参数重试）。
- 不静默退回主 tab；不把 tab 参数当“按 id 绑定”的入口（绑定仍走用户选页）。

### 4.2 绑定

- `browser_bind_interactive` 追加并 promote：用户选中的 tab 加入会话并成为当前 tab；旧 tab 保留绑定和授权，不按切换撤销。
- 释放 tab 从面板做；模型侧没有 release 工具（若以后需要，再加工具）。
- 已绑会话是否允许模型新开 tab 并加入，仍是待裁决项；首版由用户手动开第二个 tab 再 bind。

### 4.3 数据模型

- 内存：`sessionTabs: Map<sessionId, Map<tabId, AffinityTab>>` 加每会话 `currentTabId`。
- `controlled` 从当前会话的 `currentTabId` 派生，不再保留第二份真值；`active`、`handoff`、`pinned`、`keptActiveTabId`、`decide`、`restorePinned`、`bindInitial` 删除。
- 无 session 的 `resolveTarget()` 只返回当前 tab 或 initial；`onActivated` 与 `syncActiveTab` 随 `active` 删除。

### 4.4 持久化与恢复

- record 升 version 2：`{ sessions: { [sid]: { tabs: AffinityTab[], currentTabId, boundAt } } }`。
- `lost` 变每会话状态：会话没有存活 tab 才 lost 并进入选页。
- 旧 `{ controlledTabId, sessionTabs }` 迁移：`controlledTabId` 映射到 focused 会话的当前 tab；旧 tab 的 `boundAt` 默认 0。
- 迁移要清 `controlled`（见 3.3 的 unbind 分叉），否则重启会把已解绑的 tab 恢复成 controlled。
- 当前 tab 失效的提升规则：
  - 运行时：提升最近使用的存活 tab（`lastUsedAt` 随派发更新），并列取 `boundAt` 最大，再并列取 tabId 最小。
  - 重启：`lastUsedAt` 不持久化，按 `boundAt` 最大；再并列取 tabId 最小。
  - 没有存活 tab：该会话 lost。
- `dropCompetingBindings` 仍按会话粒度，不丢同一会话的其它 tab。

### 4.5 授权与审批

- 会话授权 key 用解析后的 tab 计算，不能用原始 `call.args` 里的 tab（很多调用默认走当前 tab，args 里没有）。
- 审批卡渲染会话短 id、tab id、标题/URL；无 tab 的 prompt（`gdrive.fetch`、未绑会话 navigate）条件渲染。
- `ApprovalCoordinator.cancelAll` 增加可选 tab 过滤；per-tab 解绑和关 tab 只取消该 tab 的待批，只撤该 tab 的授权。
- `trust-origin` 与 `always-allow-reads` 仍是全局授权，per-tab key 覆盖不到；是否收紧到当前页/当前 origin 是待裁决项。

### 4.6 bindings 上报与 GUI

- `reportBindings` 摊平成每个 (session, tab) 一条，并加可选 `current`；`BindingsReport` 的“最多一条”注释同步改。
- host 路由从 `{sessionId, tabId}` 扩成带 `current`；旧 host 忽略未知字段，向后兼容。
- dsh 会话列表保持每会话一个图标；两 tab 时图标不消失。GUI 消费者不在本仓库，需要真机验证。
- `browser_status` 增加“本会话已绑 tab + 当前 tab + primed”。

### 4.7 生命周期

- `onRemoved`/`onReplaced` 按 tab 处理：只摘掉这个 tab 的绑定、授权、待批；会话还有其它 tab 时不判 lost。
- `openBoundTab` 的 `hasBinding` 早退改成 upsert，避免孤儿 tab。
- 新增 per-tab 解绑消息；面板每行一个解绑入口。
- 已绑会话追加新 tab 的路径按 4.2 的待裁决处理。

### 4.8 资源

- eager debugger attach 上限 3→5，按 LRU 淘汰；`browser_status` 列 primed；5 条调试横幅的用户可见成本要真机确认。
- `net-rules` 的所有 mutator 加互斥，不只 `addRule`。
- 预算和保活发给所有已绑 tab；解绑后恢复 `autoDiscardable`。

### 4.9 工具面与兼容

- 23 个页面工具加 `tab`；`browser_navigate` 的未绑会话新建 tab 保持特例。
- 新增模型可见的 `browser_list_tabs`：id/title/url，标出本会话已绑和当前；它会把打开页面的标题/URL 送给模型，属于隐私面扩大，需要用户知情。
- toolset 升一级（新定义集 + 低级别 guard），旧扩展不暴露 `tab` 和新工具；旧扩展会忽略不认识的参数、按单绑定落页，所以门控必须在步 1 就做。
- 不要把全量 `browser_list_tabs` 直接注册给模型；新只读工具要有自己的注册位和审批/门控。

## 5. 改动范围（估算）

| 区域 | 文件 | 改动 |
|---|---|---|
| 亲和模型 | `extensions/dsh-browser/src/background/tab-affinity.ts` | 数据模型、add/remove/promote、restore、快照、旧方法签名，约 300–500 行 |
| 后台编排 | `extensions/dsh-browser/src/background/index.ts` | 47 处 `tabAffinity.`、24 处 `chrome.tabs` 中的绑定/恢复/派发/面板/事件/预算/attach 八组，约 200–400 行 |
| 派发 | `extensions/dsh-browser/src/background/tools.ts` | tab 解析、结果回显、错误码，约 50–150 行 |
| 授权/审批 | `security/session-allowance.ts`、`security/approval.ts`、`approval-coordinator.ts`、`shared/messages.ts` | grant key、prompt/request、取消过滤、`RecentOp.tabId`，约 100–200 行 |
| 面板/选项 | `panel/App.tsx`、`options/main.tsx` | tab 列表、当前标记、per-tab 解绑、审批卡/操作流标签，约 150–300 行 |
| 宿主工具面 | `packages/browser/bridge-browser/src/tools.ts`、`protocol.ts` | 23 个定义加 tab、新 level 定义集与 guard、bind 的 add+promote、page-choice 错误区分、`BindingEntry.current`，约 200–400 行 |
| 网络规则 | `extensions/dsh-browser/src/background/net-rules.ts` | 所有 mutator 串行化，约 30 行 |
| 测试/文档 | 两半的 tests、README、SKILL、决策文档 | 新增 600–1200 行用例，5–6 处文档 |

合计约 1.5–2k 行，单人约 2 周（1.5–2.5）。这是按当前工作区文件与调用点数量做的估算，没有排期验证。

## 6. 影响面积

- **用户可见**：侧栏从“一个受控页”变成一组；当前 tab 有标记；审批卡写页面；关一个 tab 不再让整个会话掉线；多个 eager attach 会多出调试横幅。
- **模型可见**：23 个页面工具多一个 `tab` 参数；N≥2 时必填；每个结果要回显 tab，否则无法自检；新增 list tabs 会带来标题/URL 的上下文成本。
- **兼容**：旧 record 要迁移；新宿主配旧扩展靠 toolset 门控；新扩展配旧宿主降级到单 tab。
- **安全**：授权跨 tab 放大是最大回归；`trust-origin`/`always-allow-reads` 是全局例外；把 bind-by-id 暴露给模型会绕过用户选页。
- **隐私**：N≥2 时读也强制带 tab，关闭“以为在新页读、实际读旧页”的静默风险；list tabs 暴露所有打开页面的标题/URL。
- **资源与测试**：多 attach 的横幅与内存；扩展约 10k 行、宿主约 5.2k 行测试里 affinity/background/tools/protocol 相关部分要改。

## 7. 风险

1. **授权/审批跨 tab**：A 页批准的 eval/debug/headers/mock 覆盖 B 页；卡片不显示 tab。必须先做 per-tab key 和卡片标签，再开放多 tab。
2. **静默错 tab**：模型带错 id 或忘了带；N≥2 强制带 tab 能挡住“忘带”，挡不住“带错”；同源同标题的 tab 需要别名或让用户选。
3. **单 tab 生命周期半迁移**：关一个 tab 解绑整会话、旧 tab 参数重试、restore 单值、孤儿 tab；合起来会“状态说绑了 B、实际落到 A”。
4. **全局授权**：`trust-origin`/`always-allow-reads` 跨 tab 仍覆盖，per-tab key 修不了。
5. **迁移**：旧 record、旧 `controlled` 残留、`boundAt` 默认值。
6. **net-rules 并发写**：关 tab 的清理可能和在途调用并发；锁要包住所有 mutator。

## 8. 分步实施计划（每步可独立验证）

每一步都不破坏现有单 tab 行为；N=1 的路径保持原样，只有绑定第二个 tab 才进入多 tab 语义。

### 步 1：工具面加 tab 参数 + list tabs + toolset 门控

- 做什么：23 个页面工具加可选 `tab`；新增模型可见的 `browser_list_tabs`（id/title/url，已绑/当前标记）；扩展校验 `tab` 属于本会话，未绑定返回 `tab-not-bound`；toolset 升一级，旧扩展不暴露 `tab` 和新工具。
- 问题点：今天工具没有 tab 参数，`browser_list_tabs` 只是扩展虚拟动作、模型看不见；旧扩展会忽略不认识的参数、按单绑定落页。
- 怎么验：工具 schema/level 单测；带当前绑定 id 的调用成功、带未绑定 id 报 `tab-not-bound`、不带 id 行为不变；模拟旧扩展时 schema 无 `tab`。

### 步 2：亲和模型支持 N 个 tab + 绑定追加 + 持久化迁移

- 做什么：`sessionTabs` 改成会话→N tab 加 `currentTabId`；`browser_bind_interactive` 追加并 promote；关一个 tab 只摘这个 tab，最后一个才 lost；record 升 v2，存 tabs/currentTabId/boundAt，迁移旧单 tab；N≥2 时页面工具不带 tab 返回 `tab-required` 并列出已绑 tab；独占检查下沉到 controller 的原子操作（修 TOCTOU）。
- 问题点：现在是会话→单 tab，bind 覆盖；`unbindSession` 不清 `controlled`（见 3.3）；独占检查散在调用方，写入前不复查（见 3.7）。
- 怎么验：绑两个 tab 分别用 id 操作；关一个后另一个仍可用；重启恢复两个 tab 和当前 tab；旧 record 迁移；N≥2 无 tab 报 `tab-required`；并发绑定的竞态测试。

### 步 3：授权与审批按 tab 隔离

- 做什么：会话授权 key 用解析后的 tab 计算；审批卡渲染会话短 id、tab id、标题/URL（无 tab 的 gdrive/navigate prompt 条件渲染）；`cancelAll` 支持按 tab 过滤；关/换绑只撤该 tab 的授权和待批。
- 问题点：`scopeKeyForCall` 只有 action（见 3.5），A 页批准的 eval/debug/headers/mock 会覆盖 B 页；卡片不显示 tab。
- 怎么验：在 A 页给 `browser_eval` 会话授权，B 页仍弹卡；关 B 不影响 A 的授权；卡片显示页面。

### 步 4：面板与操作流显示多个 tab

- 做什么：受控 tab 列表、当前 tab 标记、per-tab 解绑；`RecentOp` 加 tabId 和标题/URL；`SessionGrant` 加页面元数据；options 页同步。
- 问题点：面板只有单值受控页（`App.tsx:464-470`），操作流只有 sessionId（`messages.ts:23-40`），授权列表看不出是哪个 tab。
- 怎么验：两个 tab 时面板列出两条、当前标记正确、解绑一个不影响另一个；操作流和授权行显示页面。

### 步 5：bindings 上报与 GUI 图标

- 做什么：`reportBindings` 摊平成每个 (session, tab) 一条并加 `current`；host 路由映射扩展；dsh 会话列表图标保持每会话一个；`browser_status` 显示已绑 tab。
- 问题点：`BindingsReport` 注释写明当前最多一条（`protocol.ts:97-104`），路由只映射 sessionId/tabId（`index.ts:542`）；GUI 消费者不在本仓库。
- 怎么验：`GET /bridge-browser/bindings` 返回两条且 current 正确；GUI 会话行仍有一个图标；两 tab 时图标不消失。

### 步 6：资源与并发加固

- 做什么：eager debugger attach 上限 3→5 并按 LRU；`net-rules` 的 `addRule`/`clearTabRules` 加互斥；预算和保活发给所有已绑 tab；解绑后恢复 `autoDiscardable`；`browser_status` 列 primed。
- 问题点：上限 3 时第 4 个 tab 静默不 attach（`index.ts:412-419`）；`net-rules` 是 read-modify-write 无锁（86-98、146-153）。
- 怎么验：4–5 个 tab 都能抓加载期 console/network；并发加/清规则不丢记录；关 tab 后规则清理干净。

### 步 7：文档、系统提示与端到端

- 做什么：README/zh、扩展 README、两份 SKILL、`docs/pure-tool-bridge-decisions.md`、宿主系统提示去掉“一个会话一个受控页”的表述；补两 tab 流程的端到端测试。
- 问题点：README 164/195 行仍写单会话独占和已删除的自动绑行为；系统提示说一次一个受控页。
- 怎么验：文档一致性检查；真机跑“绑 A → 操作 → 绑 B → 操作 → 切回 A”全流程。

## 9. 待裁决

- 已绑会话是否允许模型新开 tab 并加入（`browser_open_tab` 或 `navigate` 的 `newTab`）。
- 同源两个 tab 的别名/区分：绑定时命名、自动序号，还是敏感操作让用户选。
- `trust-origin` / `always-allow-reads` 是否收紧到当前页/当前 origin。
- 模型是否需要 release tab 工具；首版只从面板解绑。

## 10. 需真机验证

- 4–5 个已绑 tab 的 eager attach 横幅数量、内存和加载期 console/network 抓取。
- 新宿主 + 旧扩展的 guard：旧级别下不暴露 `tab` 和 list tabs，带 tab 的调用不会落到错误页面。
- 同源双 tab 的别名/选择交互是否够用。
- GUI 会话列表在两 tab 时的图标表现。

## 11. 未验证

- GUI 消费者不在本仓库，图标行为只按 `client.js` 的会话级标记推断。
- 旧扩展收到 `tab` 参数后“静默忽略”是按 `resolveToolTab` 和不读未知参数的实现推断的，没拿旧构建实测。
- 多 tab attach 的资源表现未实测。
- 宿主是否在同一 step 并发下发不影响本方案（串行设计），但“宿主默认串行”已由 `dsh-tools` 的 `executionMode` 确认。

## 12. 关键代码位置

- 派发：`extensions/dsh-browser/src/background/index.ts:744`、`1727`、`1737`；`extensions/dsh-browser/src/background/tools.ts:1012`、`272`。
- 工具定义：`packages/browser/bridge-browser/src/tools.ts:1890-2318`。
- 亲和：`extensions/dsh-browser/src/background/tab-affinity.ts:53-61`、`117`、`238`、`386`；持久化 `index.ts:543-570`，恢复 `610-670`。
- 授权：`extensions/dsh-browser/src/security/session-allowance.ts:137-140`、`155-166`；`index.ts:842`、`859`。
- 审批：`security/approval.ts:42-45`；`approval-coordinator.ts:66`；`panel/App.tsx:375-405`、`464-470`；`panel/approval-buttons.ts:39-42`。
- 生命周期：`index.ts:697-735`、`2062-2071`、`2046-2060`、`1022-1037`。
- bindings：`protocol.ts:97-104`；`index.ts:1291`；`packages/browser/bridge-browser/src/index.ts:542`；`client/client.js:93`。
- 资源：`index.ts:396-410`、`398`、`412-419`；`net-rules.ts:86-98`、`146-153`。
- 并发分类：本机 dsh 0.2.1-rc.2 的 `dsh-tools/lib/index.js:3155-3157`（`executionMode`）。

## 13. 决策记录

- 2026-10-19/20：完成单会话多 tab 的可行性与影响面调研；确认扩展侧按 tab 派发、亲和模型单值、授权/审批/生命周期按会话。
- 2026-10-20：复核确认宿主默认串行（`isConcurrencySafe` 缺省 exclusive），并行需额外成本；跨会话独占存在 TOCTOU。
- 2026-10-21：用户确认串行即可，agent 在两个 tab 之间切换操作；去掉并行相关改动。
- 2026-10-21：工具面口径定为“每次调用带 tab id”，`browser_list_tabs` 列出 id；N=1 可选、N≥2 必填。
