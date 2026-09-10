# ADR: D-pure 纯工具桥（决策记录与开放问题）

> 状态：**主体已完成并合并入 `refactor/pure-tool-bridge`**（原实施 TODO 见 git 历史：阶段 0-5 分别落地，随后一轮全仓瘦身又删除了无调用方的 purge/inject RPC 链、划词捕获链等）。本文件只保留仍有价值的决策记录与尚未关闭的开放问题。

## 决策记录

| 日期 | 结论 |
|---|---|
| 2026-09-02 | 侧栏聊天全删；只保留状态展示（最多 header「操作 xxx 页面中」）。 |
| 2026-09-02 | 保留能力 = 操作真实浏览器（登录态保留、真实 Chrome），服务非本地 E2E。 |
| 2026-09-02 | 单 Chrome 双会话（会话A→webA、会话B→webB）机制已支持（按 sessionId 路由、后台标签照跑）；绑定/后台加固列为后备（原阶段 3）。 |
| 2026-09-02 | **O1**：不依赖上游迁移分支，在 fork 里自研 0.1.2 传输迁移（`apiProxy` → `typertGateway`/`connection`）；上游 `feat/dsh-0.1.2-migration` 仅作只读参考，**不合并**。 |
| 2026-09-02 | **O2**：会话分组去向**搁置**——扩展不再经桥建会话，桥通道级分组无意义；将来如需分组上移 host 服务级。 |
| 2026-09-02 | **O4**：未绑定会话首次 `browser_navigate` → 自动开新标签并绑定；设置/信任配置放 options 页；审批走 popup/状态窗。 |
| 2026-09-02 | 版本线：运行时与依赖统一 pin 到 `0.1.2-rc.1`（0.1.2 稳定发布后再切正式 tag）。 |
| 2026-09-09 | 版本线升级：运行时与依赖统一对齐 dsh `0.1.5-alpha.1`（当时运行 harness 已是 0.1.5-alpha.1；peer/devDeps/root CLI 与 lockfile 同升，见 [升级记录](dsh-0.1.5-alpha-upgrade.md)）。 |
| 2026-09-10 | 版本线升级：运行时与依赖统一对齐 dsh `0.1.5-rc.1`（运行 harness 已切到 `latest` = 0.1.5-rc.1；peerDeps/devDeps/root CLI 与 lockfile 同升，见 [升级记录](dsh-0.1.5-rc-upgrade.md)）。 |

## 开放问题

- **O3 协调事件集合**：tab-affinity 交接时机曾依赖 `turn/start|end`，审批瞬时态依赖 `question/*`；砍聊天后 `question/*`（审批作答方变为宿主标准客户端）的去留需逐条核对扩展后台消费。
- **O5 上游同步策略**：本 fork 独走本重构；完成后是否反向 PR 上游，以及 upstream main 若合入 C（0.1.2 迁移）后本分支如何处理，待后续讨论。

## 参考

- 实施范围与阶段划分：git 历史 `refactor/pure-tool-bridge` 提交说明。
- 运行环境：dsh `0.1.5-rc.1`（peer/devDeps/root CLI 统一此线，2026-09-10 升级）。
