# 调研：把 Web DOM「记下来」能否省 token、提速度

> 状态：**调研完成；第 1、2 条已实施**（`browser_dom_query` + 未变框架折叠 + 导航自动快照降到 8k），其余待做。日期 2026-09-16。范围：在现有 dsh-browser 链路（host 插件 + MV3 扩展 + 内容脚本）里，「记录/缓存网页 DOM」这类做法能把 token 与耗时降到哪里、代价是什么、怎么验证。

## 0. 结论

能省，但**不是靠"缓存整棵 DOM 再整段复用"**——实测里同一次会话内**完全相同的页面文本重复率为 0%**（见 §1.2），所以"按哈希去重"这条路没有收益。真正有效的是三件更朴素的事：

1. **不再整段重发**：把「导航后自动附整页快照」和「动作后自动附变化」都改成受预算约束的**增量**（现状：导航一次最多带 32k 字符）。
2. **默认少发正文、按需拉取**：正文占了页面字符的 **50%**，而其中位数只有 69 字符——典型页面是后台表单/表格，正文几乎为空；少数长文页吃掉大头。把正文默认截到小额度、让模型用 `browser_get_text` 拉，按需付费。
3. **把"常驻框架"折叠起来**：清单占 33%，而主 frame 的 48 条额度里大量是每次都不变的导航链接。未变化的区块用一行引用代替（`[unchanged since snapshot v3: 48 nav links]`）。

速度侧另有一条独立的账：快照路径对**每个候选元素**都做 `getComputedStyle` + `getBoundingClientRect`，且中间穿插了写 `data-dsh-el` 属性的动作，大页面上存在强制重排（§3.1）。这块可以用缓存 + `MutationObserver` 增量 + 批量测量改善，和 token 无关。

## 1. 现状实测（token 花在哪）

数据来源：本地会话日志，用本次同批交付的脚本统计（可复现）：

```sh
node benchmark/tokens.mjs --project '' --days 3     # 全部工作区：7 个会话，310,546 字符 ≈ 77.6k token
node benchmark/tokens.mjs --days 3                 # 仅 dsh-browser：4 个会话，89,404 字符 ≈ 22.4k token
node benchmark/tokens.mjs --project intranet-aio --days 1   # 仅业务站：1 个会话，211,868 字符 ≈ 53k token
```

字符数按 `字符/4 ≈ token` 折算，图片按 1.5k 字符/token 当量计入。**单个会话就占了全部浏览器 token 的 68%**——省 token 的收益高度集中在少数长会话上。

### 1.1 按工具

| 工具 | 调用 | 字符 | 占比 | 单次最大 |
|---|---:|---:|---:|---:|
| `browser_navigate` | 14 | 95,266 | 30.7% | 26,704 |
| `browser_snapshot` | 19 | 76,481 | 24.6% | 16,065 |
| `browser_eval` | 46 | 65,235 | 21.0% | 7,978 |
| `browser_click` | 7 | 29,058 | 9.4% | 26,499 |
| `browser_network` | 5 | 15,509 | 5.0% | 7,829 |
| `browser_get_text` | 4 | 12,239 | 3.9% | 8,454 |
| `browser_wait` | 2 | 9,340 | 3.0% | 4,670 |
| 其余（scroll/type/press/console/bind） | 5 | 8,418 | 2.4% | — |
| **合计** | **104** | **310,546** | 100% | ≈ **77.6k token** |

三个结构性发现：

- **导航最贵**：不是"导航"本身，而是导航完成后自动附上的整页快照（`NAVIGATION_SNAPSHOT_GUIDANCE` 路径），单次可达 32k 字符上限。
- **点击也可能是整页快照**：`browser_click` 单次最大 26.5k，说明那次点击触发了文档切换，走了同一条自动快照路径；普通动作 delta 本身有 4k 上限。
- **`browser_eval` 占 21%、46 次**：多数是"DOM 考古"（找图标按钮、找接口、翻属性），不是必要的模型思考。

### 1.2 重复率：0%

把会话里每次页面文本（剥掉 nonce 与状态前缀）做 SHA-256，看是否与本次会话前面出现过的完全相同——`benchmark/tokens.mjs` 每次运行都会顺手报这个数：

```
page text sent 171,624 chars; repeated verbatim 0 (0.0%)
```

结论：**"同一段页面文本别重发"没有可省的量**——页面确实在变（状态行、动态内容、或干脆是不同页面）。省 token 只能靠"少发"，不能靠"去重"。

### 1.3 快照内部构成

对 24 次带页面文本的返回做切分：

| 区块 | 合计字符 | 占比 | 中位数 | 最大 |
|---|---:|---:|---:|---:|
| Main content（正文） | 90,714 | **50.2%** | 69 | 15,925 |
| Interactive elements（清单） | 60,370 | **33.4%** | 1,323 | 9,476 |
| 头部（Title/URL/Status） | 11,487 | 6.4% | 467 | 840 |
| 其余（iframe/表单字段） | 18,010 | 10.0% | 334 | 3,626 |

中位数 69 字符 vs 均值 3,779：**正文开销高度集中在少数长文页**。这决定了"默认截断正文、按需拉取"是安全的：对多数页面本来就没正文，对少数长文页才需要显式再拉。

### 1.4 现有机制（已经做到的）

- 每个文档一份基线（`documentId`），`delta: true` 只回变化元素编号；
- 元素编号跨快照稳定（`ElementIds` + `data-dsh-el`），动作不必重读清单；
- 字符预算 `snapshotMaxChars`（默认 32k）与条目预算 `maxInteractiveItems`（默认 60；主 frame 48，子 frame 分 12）；
- 动作 delta 上限 4,000 字符（`ACTION_DELTA_MAX_CHARS`）。

缺的正是"预算之外"的部分：自动快照的**触发条件**太宽（导航后无条件整页），正文**默认额度**太松（32k 里正文可占一半）。

## 2. 「记录 DOM」的六种可能形态

按"省 token / 提速度"拆开，收益与代价各不相同。

### D1 页面文本缓存 + 检索（host 侧）

- **机制**：快照文本渲染后在 host 侧留一份（按 session + tab + 文档版本），新增窄查询工具：`page_find(query)`、`page_slice(offset, len)`、`page_region(selector)`；模型只把命中的几十行带进上下文。
- **预计收益**：把"读整页"换成"读片段"，对长文页可省 80%+，对后台类页面基本不省（本来就短）。按 §1.3 的分布，整体预期落在**正文那 50% 的 3–5 成**。
- **风险**：缓存与真实 DOM 可能不同步（用 `documentId` + 版本号做键可缓解）；模型基于旧文本行动；host 内存里留住页面内容（隐私面，需随会话结束清理）。
- **代价**：中。host 侧新增缓存与 3 个工具；extension 不变。

### D2 DOM 句柄注册表 + 窄查询（extension 侧）

- **机制**：内容脚本维护 `元素 → {可访问名, 选择器, 属性}` 注册表并在快照时刷新；新增 `dom_query(selector, fields)` 返回**指定字段**（如 `{name, href, class}`），不再让模型用 `browser_eval` 把整个 DOM 片段读回来。
- **预计收益**：直接对冲 §1.1 里 `browser_eval` 的 **21%**（46 次调用）；单次返回从平均 1.4k 字符降到几十~几百。
- **风险**：字段白名单要设计好，否则它退化成第二个 eval；只读、不执行，安全面比 eval 小得多。
- **代价**：小-中。与已有 `isChromeLandmark`/`accessibleName`/`uniqueSelector` 复用度高。

### D3 采集结果缓存 + 增量失效（速度）

- **机制**：缓存 `collectInteractive` 的结果与每个元素的可见性/位置；`MutationObserver` 标记脏子树，只对脏节点重测；把 `getComputedStyle` + `getBoundingClientRect` 的逐元素调用换成一次批量测量（先读完再写 `data-dsh-el`，避免读写交替造成的强制重排）。
- **预计收益**：省的是**延迟**不是 token。大页面（数百交互元素）上预期把快照的采集阶段从"每元素两次强制布局"降到"一次批量 + 增量"。
- **风险**：缓存失效写错会给出过时的清单（编号错位是硬故障），需要"脏了就全量"的保守兜底。
- **代价**：中。

### D4 结构化 DOM 摘要替代长文本

- **机制**：默认只回"可访问性树/大纲"（标题层级 + 区块计数 + 清单），正文完全不发。
- **判断**：**不作为默认**。读文章、读邮件、读工单正文是主要用例，去掉正文会让模型必须多轮拉取，总延迟反而上升。可作为 `mode: 'outline'` 选项。

### D5 不重发相同文本（会话级去重）

- **判断**：**实测无收益**（§1.2 重复率 0%）。不要做。

### D6 常驻框架折叠（新，来自实测）

- **机制**：对"上一次快照里出现过、这次逐字节未变"的区块（典型是 nav/header 的几十条链接、以及未变的 iframe 段），用一行引用代替整段：`[unchanged since snapshot v3: 48 nav links, 6 form fields]`；模型需要时用 `browser_get_text region` 或 `delta:false` 强拉。
- **预计收益**：清单占 33%，后台站点的清单里导航常占多数——保守估计能砍掉清单的 1/3 到 1/2；配合 D1 是**最直接的结构性削减**。
- **风险**：模型可能误以为"没列出来就是不存在"。要用明确措辞 + 保留"如何取回"的指令，并在变化时立刻恢复全量。
- **代价**：中（渲染层 + 变化检测，已有 delta 基础设施可复用）。

## 3. 速度侧的独立账

### 3.1 现在的采集路径

`buildSnapshot` 的顺序是：`collectInteractive`（对每个候选元素 `isVisible`：`getComputedStyle` + rect）→ `ids.assign`（**写** `data-dsh-el`）→ `isInViewport`（**再读** rect）→ `accessibleName`（读属性/文本）→ 排序取前 N。读写交替 + 逐元素两轮测量，在数百元素的页面上会产生多次强制样式/布局重算。

### 3.2 可验证的改法

- 先批量读（一次性收集所有候选的 rect/可见性），再统一写 `data-dsh-el`；
- 用 `IntersectionObserver` 维护"在视口内"的集合，替代每次全量 rect 读；
- 用 `MutationObserver` 做脏标记，未变子树直接复用上次结果。

这三条都不改变模型看到的内容，因此**可以用 benchmark 的耗时指标单独验收**，不需要 A/B 模型效果。

## 4. 建议的落地顺序

0. **D7 缓冲区随绑定预热**（本文调研期间从真实会话发现的漏采问题）：绑定标签页即 `attach` + `Network/Runtime/Log.enable`，避免"第一次调用才开始录"漏掉页面加载期的请求。已实施。

1. ~~**D6 + 收紧自动快照**~~ **已实施**：导航后自动附的快照上限 8k（`NAVIGATION_SNAPSHOT_MAX_CHARS`）；逐字节未变的 nav/header/footer 条目折叠为一行，编号保持有效。
2. ~~**D2 `browser_dom_query`**~~ **已实施**：`{ selector, fields?, limit?, frame? }` → 每个匹配回「标签 + 可访问名 + 唯一选择器 + 点名字段」，归入页面读取审批、受共享策略约束。
3. **D3 增量采集**（提速度，纯收益）。
4. **D1 页面文本缓存 + 检索**（省 token，但引入第二个事实源，最后做）。
5. D4/D5 不做。

## 5. 验收口径（可复现）

- **token**：统计脚本已固化为 `benchmark/tokens.mjs`（`pnpm --dir benchmark run tokens`）——读 `~/.dsh/sessions/**` 里指定工作区的会话日志，按工具汇总字符数与调用数（本轮调研用的就是它，6 会话 307k 字符）。改造前后跑同一批任务对比，目标：**同任务成功率不降，页面字符总量降 ≥30%**。
- **速度**：用现有 `benchmark/` 的端到端耗时与工具调用数（基线见根 README：平均 5.32s / 3.4 次调用），并在内容脚本里加 `performance.now()` 分段计时（collect / assign / render），单独看采集阶段。
- **正确性**：折叠与增量都要有"变化即全量"的回归用例，避免编号错位这类硬故障。

## 6. 参考

- 现有实现：`extensions/dsh-browser/src/content/snapshot.ts`（渲染与预算）、`src/content/extract.ts`（可见性与可访问名）、`src/background/tools.ts`（自动快照与 delta 路径）、`packages/browser/bridge-browser/src/protocol.ts`（`snapshotMaxChars` / `maxInteractiveItems`）。
- 评测：`benchmark/README.md`。
- 相关决策：`docs/pure-tool-bridge-decisions.md`（清单排序、选择器寻址、调试能力同意）。

## 7. 业界先例（外部调研，2026-09-16）

- **Playwright MCP** 返回缩进文本的 accessibility tree，交互元素带 **ref 句柄**；click/type 的 target 文档原话是「snapshot 里的 ref **或唯一的元素选择器**」——与本仓库"编号 + 选择器"两条路一致。它**明确拒绝**加 max-token 上限：维护者说 "Max tokens parameters don't work as the page snapshot becomes incomplete"、"snapshots without text … are useless"。给本仓库的启示：**不要用"截断整份快照"来省 token**，要用"少发 + 按需取"。([README](https://github.com/microsoft/playwright-mcp)、[issue #1233](https://github.com/microsoft/playwright-mcp/issues/1233))
- **`browser_find` 就是 D1 的现成范式**：在**服务端已缓存的快照**里按 text/regex 检索，只回匹配节点、上下文和它们的 ref，文档明确说这比重新抓整份快照便宜；另有 `filename` 把快照写盘、按需切片读。`browser_dom_query`（本次实现）走的是同一条思路，只是把"匹配 + 句柄"一起给出。([README](https://github.com/microsoft/playwright-mcp))
- **ref 稳定性**：Playwright MCP 只承诺 ref 对该次 snapshot 有效，不承诺跨快照稳定。本仓库的编号跨快照保持（`data-dsh-el` + `documentId` 基线）比它更强，但要注意导航后编号会重排。
- **DOM 规模的数量级**：arxiv 2508.04412（D2Snap）给出真实 DOM 常超 1 MB ≈ **1e6 量级 token**，截图基线约 **1e3 量级**（差 3 个数量级）；其下采样方案把表示压回 1e3 量级，GPT-4o 成功率 67% vs 基线 65%。这从数量级上支持"默认表示要小"，但**不支持**"完整 DOM 塞进上下文"。([ar5iv](https://ar5iv.labs.arxiv.org/html/2508.04412))
- **prompt cache 的现实约束**：官方折扣不小（OpenAI：10k+ token 前缀命中时延迟最多降 80%；Bedrock：cache read 约为未缓存输入价的 10%），但**前缀匹配**——页面文本一变就打断前缀。所以正确的方向是"少往上下文里放页面文本、把快照放在动态尾部、必要时走服务端缓存检索"，而不是指望缓存兜住重复发送。([OpenAI cookbook](https://raw.githubusercontent.com/openai/openai-cookbook/main/examples/Prompt_Caching101.ipynb)、[Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html))
- **CDP 侧的两条**：`DOMSnapshot.captureSnapshot` 返回扁平化的完整 DOM（含 iframe/template，Shadow DOM 被拉平）+ layout + 白名单样式；`Accessibility.getFullAXTree` 取整棵 AX 树（可限 `depth`）。但官方定性警告 `Accessibility.enable` 会**影响页面性能**，两者都没有公布耗时数字。([DOMSnapshot](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/)、[Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/))
- **DOM 剪枝**：browser-use 用 CDP bounds + AX 树 + `cursor:pointer` + 启发式白名单做剪枝，但**没有公开压缩比例**；唯一硬数字来自一个未合并 PR（裁工具 schema，-16.4% 成本），与 DOM 剪枝无关。([clickable_elements.py](https://github.com/browser-use/browser-use/blob/main/browser_use/dom/serializer/clickable_elements.py))
- **"带标记截图"（Set-of-Mark）**证明视觉 grounding 有效，但每轮仍要重发整张图（1e3 token 量级）且布局一变坐标即失效——与本仓库"图看现象、选择器动手"的分工一致。([arxiv 2310.11441](https://ar5iv.labs.arxiv.org/html/2310.11441))

对照结论：**D1 有官方先例（`browser_find`）**、**D2 与 Playwright MCP 的 target 契约同源**、**D5（去重）被 prompt cache 的前缀语义与本文实测双重否定**；D3、D6 没有直接先例，属于本仓库可自证收益的部分（用 `benchmark/tokens.mjs` 与 benchmark 耗时验收）。
