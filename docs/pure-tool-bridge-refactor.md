# 超级重构:D-pure(纯工具桥)实施 TODO

> 分支:`refactor/pure-tool-bridge`(基底:`main` @ 1d52e66,2026-09-02 创建)
> 状态:**规划中** — 未开始动代码。本文档是本分支的事实来源,讨论结论随时回填。

## 1. 目标与范围

插件退化成"纯工具桥":**侧栏聊天全删,只保留状态展示**;保留并强化 dsh 对真实 Chrome
网页的操作能力(对非本地 / 真实会话 E2E 至关重要)。不再背着"迷你 GUI 网关"的包袱,
未来 dsh 网关怎么换都不影响工具通道。

### 做
- 聊天/会话管理/设置/凭据/审批提问等面板 UI 全部移除(宿主 + 扩展两侧)。
- 状态展示型侧栏(仅状态;最多一个 header 如"操作 xxx 页面中")。
- 宿主侧 RPC 透传层删除;`/ext/bridge` 退化为纯工具 + 协调事件通道。
- 先落到 dsh 0.1.2 可组合的基线上(见阶段 0)。

### 不做(本轮)
- 多 Chrome / 多连接注册表路由(单 Chrome 双会话的后备改造)——"再议",已挂起。
- 会话分组是否保留——开放问题,见 O2。
- Playwright/CDP 载体——未来若需要,是并行的执行端,不影响本重构。

## 2. 决策记录(讨论结论,按时间)

| 日期 | 结论 | 出处 |
|---|---|---|
| 2026-09-02 | 侧栏聊天全删;只保留状态展示(最多 header"操作 xxx 页面中") | 本分支创建前的讨论 |
| 2026-09-02 | 保留能力 = 操作真实浏览器(登录态保留、真实 Chrome),服务非本地 E2E | 同上 |
| 2026-09-02 | 单 Chrome 双会话(会话A→webA、会话B→webB)机制已支持(按 sessionId 路由、后台标签照跑);绑定/后台加固列为后备 TODO(阶段 3) | 同上 |
| 2026-09-02 | 本机 dsh = 0.1.2-alpha.4,`dsh-host-apiproxy` 已移除 → 当前 `main` 的桥在 0.1.2 上组合不起来,必须先迁移 | 同上 |
| 2026-09-02 | 上游已有 C 迁移(`upstream/feat/dsh-0.1.2-migration` @ 3ca47b9,未合 main,落后 main 7 提交);C 与 D 正交,C 保留透传结构,D 才删 | 同上 |
| 2026-09-02 | **O1**:不依赖上游,在 fork 里自己按 0.1.2 重做传输迁移;上游 C 分支仅作 0.1.2 API(typertGateway/connection)的只读参考,**不合并** | 本分支讨论(ask_user_question) |
| 2026-09-02 | **里程碑**:0+1+2 一口气做完(基线迁移 + 宿主收缩 + 扩展重写为一个交付);分阶段 commit 便于 review | 同上 |
| 2026-09-02 | **O2**:会话分组去向**搁置**,宿主收缩完成后看实际影响再定(阶段 1.6 届时激活) | 同上 |
| 2026-09-02 | **O4**:未绑定会话首次 `browser_navigate` → 自动开新标签并绑定;设置/信任配置放 options 页;审批走 popup | 同上 |

## 3. TODO

### 阶段 0 — 基线与前置(✅ 完成,commit 5e3fb89)

- [x] **0.1 自研 0.1.2 传输迁移**(O1 已定:不合并上游):`apiProxy` → `typertGateway`/`connection`,
      新增 `host-api.ts` + `remote-host-api.ts`(同源实现,内容与上游 3ca47b9 一致,见 commit 说明)。
- [ ] **0.2 0.1.2 兼容冒烟**:typecheck + 单元/组合测试全绿(桥 112 + 扩展 313);**live 冒烟待办**——
      需重启 dsh web 服务验证 `/ext/bridge-config` 404→200(本会话不能重启用户常驻服务)。
- [x] **0.3 基线回归**:两端 typecheck + vitest 全绿;e2e(真实 Chromium)自动跳过。

### 阶段 1 — 宿主侧收缩(`packages/browser/bridge-browser/src/`)(✅ 主体完成,commit 7a4e8a7)

- [x] 1.1 `server.ts` 纯工具化:删任意 `rpc` 透传/`handleRespond`/`PRIVILEGED_METHODS` 门/
      ordering;仅服务两个内部方法(`bridge.injectBrowserSnapshot`、`bridge.session.purge`),
      其余一律 `method-not-allowed`。
- [x] 1.2 **事件泵整条删除**(O3 决议:扩展侧全部事件消费都是聊天/面板面向——recent-session
      续聊、transient 状态、聊天渲染;tab-affinity/工具路由只依赖本地 tab 监听,不需要宿主事件;
      故无需"协调事件过滤流")。
- [ ] 1.3 `protocol.ts` 帧面清理(respond/respond.result/event 帧删除)——
      **随阶段 2 扩展改造一起做**(协议保留以维持过渡期扩展编译)。
- [ ] 1.4 `remote-host-api.ts` 缩面:events()/respond() 及瀑布机制已成死代码(733 → 仅
      session.list 的 call),待下一轮精简 + spec 重写。
- [x] 1.5 删除 `session-deferral.ts`(已删,含 spec)。
- [x] 1.6 `session-workspace.ts` 已删(O2 落定:扩展不再经桥建会话,桥通道级分组无意义;
      将来如需要分组特性,上移 host 服务级,另行记录)。
- [x] 1.7 `tools.ts`/`browser-context.ts`/`session-purge.ts`/`token.ts`/hello·工具帧保留不动。

### 阶段 2 — 扩展侧:聊天全删 + 状态面板(✅ 完成,commit 49efa51 + 15c5dec)

- [x] 2.1 删除 panel 聊天栈;2.2 状态侧栏("操作 xxx 页面中" header);2.3 options 设置页;
      2.4 action popup 审批;2.6 编排器精简(启动即连、runtime 消息面、push 广播);2.7 协议删
      respond/respond.result/event 帧;2.8 首调自动绑定(前轮)。扩展 typecheck + 149 测试绿,
      chrome 构建产出 panel/options/popup 三页(manifest 接线验证过)。


- [ ] 2.1 删除 `src/panel/` 聊天/会话/设置/审批栈(≈4.7k 行:App.tsx、api.ts、composer、
      events、sessions、updates、questions、attachments、markdown、MessageImages 等)。
- [ ] 2.2 新建极简状态面板:连接状态、受控标签(header"操作 xxx 页面中")、会话标识(≈150–300 行)。
- [ ] 2.3 设置与信任配置迁出面板 → options 页(bridgeUrl/token、sharePageContent、
      trustedActionOrigins、approvalNotifications)——见 O4。
- [ ] 2.4 授权/审批呈现迁出面板 → `chrome.action` popup;确认 CI/无头预信任覆盖。
- [ ] 2.5 keep/follow/handoff 决策:无面板后由 popup/状态面板承载(保留 fail-closed 语义),
      或按 O4 的"未绑定→navigate 开新标签绑定"演化——见 O3 决议后的交互设计。
- [ ] 2.6 清理 `background/index.ts`(1431 行)panel 专属端口/广播面;保留 bridge/tools/
      tab-affinity/content 全套。
- [ ] 2.7 协议帧清理(1.3 落地):删 `respond`/`respond.result`/`event` 帧 + 类型守卫。
- [x] **2.8 无面板首调自动绑定**(commit b070ec9):未绑定会话首个 `tool.call` 绑定用户当前活动页
      (bindInitial),替代聊天面板"提交即绑定";TabAffinityController 新增 `hasBinding`;已绑标签被
      关后下次调用自动重绑。扩展 typecheck + 314 测试绿。

**阶段 2 侦察(2026-09-02,函数级 KEEP/CUT 清单)** — background/index.ts:
- KEEP(核心执行,原样/小改):discoverBridge/probeBridge/BridgeClient 接线(startBridge 的门控需改)、
  routeToolCall/cancelToolCall/cancelAllToolCalls、resolveToolTab/ensureInitialTabBinding/
  affinityFailure、authorizeToolCall + approvals 协调(投递目标改 popup)、refreshFollowedPage/
  refreshSessionSnapshot(跟随注入,保留,触发面简化)、summarizeTab/syncActiveTab/restoreTabAffinity/
  tab 事件监听、内容脚本 DSH_* 消息面、keepalive(门控从 panelPorts 改为"有受控会话/显式开启")。
- CUT(纯面板/聊天):panelPorts 端口面、broadcastEvent/broadcastTabAffinity(面板向)、
  selections/SelectionTracker/quote 相关(content 用户划词=聊天引用)、recentSession/
  session-continuity(续聊)、transientEvents、interactionResponses(respond 宿主提问)、
  gatewayRpc/rpc 门面(会话 list/create/prompt…)、UpdateCard/updates、settings 面板编辑流(迁 options)、
  autoResumeSession、openAssistantPanel 的 action 行为(改为打开状态面板,保留)。
- 端口消息类型(panel↔bg)待逐条删除:approval.response/request、tab-affinity.*、session.active/
  resume-hint、selection.*、event 广播等。

**新 UI 文件(拟)**:panel 状态视图(index.html/main/App 精简版)、options 页(settings)、
action popup(approvals+quick status)。沿用 React+vite 现有构建;`strings.ts` 大幅精简。

### 阶段 3 — 单 Chrome 双会话 E2E 加固(后备,多会话议题再议后启用)

- [ ] 3.1 绑定语义:未绑定会话首次 `browser_navigate` → 开新标签并绑定(替代 bindInitial=活动标签,
      消除双会话并发启动绑错标签的竞态);需契约设计。
- [ ] 3.2 后台标签加固:受控标签 `autoDiscardable:false`(防 Memory Saver 冻结);
      工具调用前确认内容脚本存活、必要时重注入;容忍后台节流。
- [ ] 3.3 (不做,仅记录)多 Chrome/多连接:注册表 + session↔connection 绑定路由。

### 阶段 4 — 测试与验证(✅ 代码验证完成)

- [x] 4.1/4.2 组合与单元测试重写(桥 87、扩展 149);e2e 冒烟重写为纯工具契约
      (options 指向测试宿主 → 启动即连 → browser_snapshot 往返,无 Chromium 自动跳过)。
- [x] 4.3 根 `pnpm run typecheck && pnpm run test && pnpm run build` 全绿。
- [ ] **0.2 live 冒烟(待用户)**:重启 dsh web → /ext/bridge-config 200;扩展自动连接;
      真实 Chrome + GUI 会话跑一次 browser_snapshot。

### 阶段 5 — 文档(✅ 主要完成)

- [x] 桥/扩展 README(en+zh)去除旧配置与聊天定位,更新纯工具定位与 UI;cordis.patch 已更新。
- [ ] 遗留润色:扩展 README 图表与命令详述、firefox 构建实测(build:firefox)。



- [ ] 4.1 组合测试重写(`tests/composition.spec.ts` 等):注入面从
      `webServer+apiProxy+tools+agents` → `webServer+typertGateway+connection+tools+agents`。
- [ ] 4.2 e2e 基准回归(`benchmark/` + 真实 Chrome):登录态保留、快照编号、审批流、交接、
      工具通道;状态面板冒烟。
- [ ] 4.3 `pnpm run typecheck && pnpm run test && pnpm run build` 全绿。

### 阶段 5 — 文档

- [ ] 5.1 README(含 zh/i18n):能力定位变化(聊天移出、状态面板、纯工具桥)。
- [ ] 5.2 协同升级纪律更新(钉 dsh 版本线的方式)。

## 3b. 阶段 2 完成后的收尾清单(预写,待扩展改造落地后执行)

- 协议帧清理(2.7):protocol.ts 删 respond/respond.result/event + RespondResult/isRespondResult/
  守卫 + server.ts 残留 ignore case + protocol.spec 对应用例 + 桥包回归(当前 87/87 基线)。
- 阶段 4:重写 bridge-extension.e2e.spec(现引用已删 host-api 类型、旧 BridgeServer 依赖,且扩展
  行为已变为"启动即连+首调绑定")为新纯工具契约冒烟;桥/扩展两侧全量 typecheck+test;
  根 `pnpm run typecheck && pnpm run test && pnpm run build`。
- 阶段 5:桥 README(删 workspace/defer 配置说明,纯工具定位)、扩展 README(聊天移除、
  状态侧栏/options/popup、启动即连策略)、根 README 协同升级线(0.1.2+)。
- 0.2 live 冒烟(需用户配合重启 dsh web):/ext/bridge-config 404→200;扩展启动即连;
  一次 GUI 会话→browser_snapshot→扩展首调绑当前页往返;退出状态面板显示"操作 xxx 页面中"。
- D-pure 完成定义(DoD):宿主只服务工具帧+2 内部 RPC;扩展无任何聊天/会话 UI;协议无
  respond/event 帧;双端 typecheck/test 绿;e2e 冒烟脚本可跑;文档无残留旧配置引用。

## 4. 开放问题(待讨论)

- ~~**O1 基底**~~ → **已定(2026-09-02):不依赖上游,自研 0.1.2 迁移;上游 C 只读参考不合并。**
- **O2 会话分组去向** → **已定:搁置**,宿主收缩完成后(阶段 1.6)按实际影响再定。
  当前记录:桥通道级拦截在扩展不再建会话后失效;备选 = host 服务级拦截 / 接受失效。
- **O3 协调事件精确集合**(仍开放):tab-affinity 交接时机依赖 `turn/start|end`;审批瞬时态依赖
  `question/*`。砍聊天后是否还需要 `question/*`(审批作答方变为标准客户端)?逐条核对扩展后台消费。
- ~~**O4 无面板交互归属**~~ → **已定(2026-09-02):未绑定会话首次 `browser_navigate` 开新标签并绑定;
  设置/信任配置 → options 页;审批 → popup。** 阶段 3.1 的契约设计按此展开。
- **O5 上游同步策略**(仍开放):本 fork 独走本重构;完成后是否反向 PR 上游,以及期间
  upstream main 若合入 C、本分支如何处理,待后续讨论。

## 5. 参考资料(关键文件)

- 宿主:`packages/browser/bridge-browser/src/{index,server,protocol,tools,remote-host-api,
  session-workspace,session-deferral,browser-context,session-purge,token}.ts`
- 扩展:`extensions/dsh-browser/src/panel/*`(删)、`background/{bridge,tools,tab-affinity,
  session-continuity,transient-events,approval-coordinator,authorization}.ts`(留/改)、`content/*`(留)
- 上游迁移:`upstream/feat/dsh-0.1.2-migration` @ `3ca47b9`
- 运行环境:dsh 0.1.2-alpha.4(无 `dsh-host-apiproxy`;`dsh-client-connection` 浏览器会话
  = SameSite=Strict cookie + Host/Origin 围栏 → 扩展面板无法自当标准客户端)
