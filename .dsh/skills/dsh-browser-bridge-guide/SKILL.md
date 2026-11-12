---
name: dsh-browser-bridge-guide
description: 任何工作区（any workspace）用 dsh-browser 的 browser_* 工具驱动页面时加载我：读文字/图片/截图该用哪个、多个工具怎么组合；点了报成功但页面没变、或新填的值没提交；工具报错看不懂；JS 弹窗冻住页面；审批卡超时、提醒没弹；受控页被换掉、被关掉、绑到或落到受保护页与错误页；浏览器被另一个会话占着；扩展工具栏与扩展页点不到；页面打不开该不该换通道；安装与更新。
---

# dsh-browser 桥接的工具选择与故障排查

这份指南是 `browser_*` 工具的入口：先判断这一次是哪一类，再走到对应的小节或兄弟文件。
行为红线（不得凭空断言页面内容、拒绝是边界不是谜题等）在 system prompt 里，这里不重复。

## Step 0 — 先判断这一次是哪一类，再往下走

| 这一次要做的 | 去哪里 |
|---|---|
| 读文字、取内嵌图片、截图、PDF | 第二节 |
| 驱动页面（点、输入、导航），或点了报成功但没反应 | 第一节 |
| 工具报错、行为跟预期不符 | 第三节，按文案对号 |
| 页面打不开、受保护页、标签页失效 | `page-failure.md` |
| 审批卡卡住、页面被自动跟随改绑 | `approval-and-binding.md` |
| 操作扩展工具栏、扩展弹窗 | `desktop-click.md` |
| 安装、更新、工具连不上 | `install-update.md` |
| 目标页是（或途中变成）Google Slides | `google-slides-via-browser` |

审批、子代理、单会话持有这些每次都用得到的规则留在本文件，不在各分册重复。遇到新的、
能复现的 `browser_*` 报错，把**触发条件 + 判据 + 出口**补进对应小节 —— 这份文档按报错
类型增补，不写事故清单。

## 一、点了报成功但页面没变 / 新填的值没提交

按这个顺序判，**每一步都要拿到证据再往下一步走**。

**① 先读效果，不读页面。** 页面上的显示可能是本地 store、缓存或未提交的草稿，
它变了不等于请求发出去了，没变也不等于后端没改。用 `browser_network` 看这次操作
真的发了什么：**列表里带体的请求带 `+body` 标记**，按 `requestId` 读它的请求体，
确认提交的值是不是新值。能碰到数据库或后端接口就交叉核对一次 —— 这类操作里它才是
真值来源。

**做完了，能指出这一条：**`browser_network` 列表里这次操作对应的那条请求（`requestId`），以及按它读到的请求体里，目标字段是刚填的新值。

**② 看工具结果末尾有没有那句「标签页被隐藏 / 窗口失焦」。** 内容脚本在标签页
不满足「可见且持有系统焦点」时，会在成功结果后面补一句，首句随状态变：
`The controlled tab is hidden.`（页面不可见）、`The controlled tab is in a window that
does not hold system focus.`（窗口失焦）、`The controlled tab is hidden and its window
does not hold system focus.`（两者都中）。三句后面都接
`No focus events reach it in this state and clipboard writes are refused, so a step that depends on either can do nothing silently.`
隐藏或失焦的标签页收不到焦点事件、剪贴板写入被拒；依赖这两样的步骤会静默失败，
而工具本身照样报成功。**这句是警告不是失败**：只读调用（快照、读文本、查 DOM、截图、
取图片）照常返回内容，看到它不用停下来。

**做完了，能指出这一条：**这次工具结果的末尾有没有 `The controlled tab is …` 那段（三句之一）；没有出现，就说明标签页可见且持有焦点。

**③ 字段按失焦提交的话，桥接已经替你补齐了。** 扩展在点击和输入之前会主动让当前
字段失焦（`settleFocusForActivation`），窗口没系统焦点时改为补发 `blur` / `focusout`，
前后台都成立。所以「拿到的是旧值」说明原因不在这里，别在这一步耗时间。

**2026-10-13 的教训（这份文档存在的核心原因之一）：那天看起来是
`browser_click_pointer` 救了它，实测查明是候选③ —— store 里本来就是新值；
pointer 对这个场景零副作用，对症的是 blur。不要写「表单提交不了 → 换 pointer」，
这条因果是错的。**

**做完了，能指出这一条：**拿到的值是旧值还是新值，以及旧值的原因不在这条路径上 —— 桥接在点击和输入之前已经补过 `blur` / `focusout`（`settleFocusForActivation`）。

**想知道某个控件到底注册了什么监听器，不必做实验。** 用
`browser_debug {action: 'listeners', selector: '<CSS>', type: 'blur,focus'}`（能力与开关见
第三节）。这类框架把处理器集中挂在 `document` 上，所以「元素那一层是 none」是常态、
**不是结论**；真正要看的是 `document` 那层有没有 `blur capture`。不必为了看一眼而真的
发一次保存请求（那种实验在真实产品上可能留下副作用）。

**④ 控件绑在整段按压序列上时，用 `browser_click_pointer`。** canvas / SVG 自绘的
控件、胶片栏、工具栏监听的是 `pointerdown`/`mousedown`/`mouseup` 这一串，
`browser_click` 只发一次 `click`，不生效却报成功。顺序是**先 `browser_click`，
无效再换 `browser_click_pointer`**，不要一上来就用它。

**④ 的另一面：按压即翻转状态的控件，完整序列等于连按两次。** chosen 这类下拉
（某个业务系统的 Referrer 字段即此）在 `mousedown` 上展开、在紧随的 `click` 上收起，
`browser_click_pointer` 的完整序列会让它开一次又关掉，两次都报成功、界面停在原状。
要坐实这条机制，在展开状态下只发 `click` 看它是否收起：收起即此因，仍开着就换别的解释。
判据是这次按压对控件属于**触发**（激活、提交）还是**翻转**（开/收、选中/取消）：
翻转类只发一次 `mousedown` 再读状态，不要补 `click`。同类的还有一条：先确认控件把
结果写进哪个容器（chosen 是 `select` 的 `option` 与 `ul.chosen-results`，不是 jQuery UI
的 `ul.ui-autocomplete`），在错的容器里读到空不能判定没渲染 —— 这个控件在 `delay`
与请求窗口内也会把结果列表清空，同一处读到空还有时序这一种解释。

**做完了，能指出这一条：**这个控件把这次按压当**触发**还是**翻转**，以及因此用的是 `browser_click` 还是 `browser_click_pointer`；翻转类只发一次 `mousedown` 后读到的状态。

**自绘的联想框不是 jQuery UI，别拿它的 API 试。** `$el.autocomplete('search')` 报
「prior to initialization」就说明这个控件自己实现了联想：触发条件可能是 `keyup`
（几百毫秒 debounce）而不是 `input`，结果插在 `body` 下，点中 `li` 才把选择写进隐藏
字段。做法是「focusin → 写搜索框 → trigger `keyup` → 等菜单出来 → 点目标 `li`」，点完
**回读隐藏的 id 字段**确认写进去了；只把文本塞进输入框会留下空的 id，页面自己会弹
「找不到该公司」这类提示。公司这类实体的候选列表，用同一个 finder 接口多拉几条、按唯一
键（页面给的链接、地址）对齐，别取第一个同名结果。

**⑤ 以上都不成立，再回头核对目标。** 重取一次快照；用 `browser_dom_query` 拿
它验证过的唯一选择器，不要手写 `:nth-of-type(N)` 猜。下面这些报错都出在这一步，
按文案对号，不要换着猜：

- `Unknown field(s)`：`fields` 只认白名单（href / src / alt / value / id / class /
  title / aria-label / role / name / type / checked / disabled / visible / text /
  placeholder / options）。要读 `onclick` 这类 JS 属性，用 `browser_eval` 取一次，
  别当字段传。
- `No element in this frame matches selector "…"`（点击）或 `No element matched selector: "…"`（`browser_dom_query` 零匹配）：先确认页面没换。一次点击让 URL 变了（结果里会写
  `Page change v2 (https://…)`），旧选择器就作废，原地再点同一个 selector 必然找不到 ——
  重读快照，或换新页面上的 selector。
- 属性选择器按 DOM 里的**字面值**匹配。`href="report.php?record_ID=1"`
  这种相对链接，写成 `a[href="/report.php?…"]` 不匹配；拿不准就退成
  `a[href*="record_ID=1"]`。
- 框架生成的类名（`MuiButton-contained`、`MuiFormControlLabel-root`）随版本变，
  优先用 `browser_dom_query` 验证过的 selector，或按可见文本定位。
- `… is not visible`：先 `browser_scroll`，或点包住它的可见元素（复选框常见是
  `span.MuiCheckbox-root`），别反复点同一个不可见节点。
- 在会自动轮询的页面（邮箱、实时面板）上发起导航，可能报
  `The page changed while approval was pending`。这不是失败信号，重试一次；两次都不行
  就直接打开目标 URL，别从轮询页点走。

**做完了，能指出这一条：**重取的快照、一个 `browser_dom_query` 验证过的唯一选择器，以及这次报错文案对上了上面哪一条。

## 二、读什么用什么

- 读页面或某一段的文字：`browser_get_text`，可带 `selector`，或 `find` + `context`
  直接跳到某个短语。**不要**用 `browser_eval` 写脚本扫 DOM 来凑文字。
- 页面内嵌的图片（图表、示意图、截图）：先用 `browser_dom_query` 定位那个元素，
  再 `browser_image` —— 它返回图片本身、原分辨率、不需要截图，DevTools 开着也能用。
- 外观 / 布局 / 样式 / canvas 或图表 / 某样东西到底渲染出来没有：`browser_capture`。
  它要求该标签页没有 DevTools，否则拿不到画面。
- PDF 页面（Chrome 内置查看器）：内容脚本照常注入，文本工具读到的内容是空的 —— `browser_snapshot`
  给空内容、`browser_dom_query` 只有一个空 `body`。要看内容用 `browser_capture` 截图，
  渲染后的页面在截图里。
- 只需要文字更新：`browser_snapshot` 传 `visual: false`。快照文本计费，页面还在加载
  用 `browser_wait` 等，别反复拍；连续读同一页用 `delta: true`，只读某块用 `region`，
  只要一小段用 `maxChars`。

**做完了，能指出这一条：**这次读页面用到的每个工具，都能在上面五条里找到对应的一行；没有一条是临时用 `browser_eval` 扫 DOM 顶上的。

## 三、出问题时的工具

- `browser_console`：读该标签页的控制台消息与未捕获错误，从首次调用起开始记录。
- `browser_network`：读请求与响应（url / 方法 / 状态 / 耗时），按 `requestId` 读
  某一个请求或响应体。
- `browser_network mock`：用内存里的响应顶替匹配的请求（状态、头、体，或直接失败），
  用来验错误分支；`mockClear` 撤掉。
- `browser_block` / `browser_headers`：在受控标签页里拦截匹配的请求，或改写请求头/
  响应头。
- `browser_eval`：页面上下文里执行 JS，走「不可信动作」审批。只在上面这些都不够用时
  才用，别当常规手段。
- `browser_debug`：断点 / 单步 / 暂停现场（`wait`、`eval`），以及 `listeners` —— 列出
  某个元素及其祖先链上注册的事件监听器，可用 `type` 收窄（如 `blur,focus`），也可以
  不给 `selector` 直接读 `document`。它需要「Allow browser debugging」开关，且**每次
  调用都要审批**，所以当排查手段用、别当日常动作。

**做完了，能指出这一条：**这次排查动用的每个工具，都能对应上面的一行，并说得出它的输出里看的是哪个字段（控制台错误文本 / 请求状态与耗时 / mock 的状态码）。

## 四、JavaScript 弹窗冻住了页面

alert / confirm / prompt 是**浏览器 UI，不是页面内容**：弹窗一开，它所属的页面就被
冻住，所有面向页面的工具会被拒绝，**拒绝文案里带着弹窗原文**。此时用 `browser_dialog`
回答（accept / dismiss，prompt 可带 text）—— 它走 CDP，页面冻着也能用。

**已经在跑的那次调用也会被截断**：页面动作（点击、输入、读取、求值）发出之后页面才
弹窗时，桥接不再让它干等到超时，当场以「弹窗开着、原文是…」返回。看到这句话就说明原
动作可能在你答完弹窗后才落地——先 `browser_snapshot` 重读页面，不要直接重发同一次点击。

**做完了，能指出这一条：**这次弹窗的原文，以及 `browser_dialog` 给的 accept 还是 dismiss；原调用被截断的话，重读页面后看到的状态。

## 五、审批、绑定与恢复

- **要审批的是动作，不是读取。** 读类（`browser_snapshot`、`browser_get_text`、
  `browser_dom_query`、`browser_console`、`browser_network` 的查看、`browser_capture`、
  `browser_image`）在 `sharePageContent = auto` 时直接跑，只有 `ask` 模式才逐次问。
  写类（`browser_navigate` / `back` / `forward` / `reload` / `click` /
  `click_pointer` / `type` / `press` / `browser_eval` / `browser_headers` /
  `browser_dialog` / `browser_debug` / `browser_block` / `browser_network` 的 mock）
  都要过审批卡。
- **子代理不要直接调 `browser_*`。** 浏览器一次只被一个会话持有，子代理既看不到扩展
  的卡、也收不到宿主那句提问，只会把 60 秒超时当成「站点打不开」来回试。
- **一次只有一个会话能操作浏览器。** 受控标签页已被另一个会话持有时，绑定会失败并在
  文案里点出那个会话（`browser_navigate` 的首次调用也一样）。这种情况什么都不会执行：
  请用户点 dsh 浏览器面板里的 Unbind，或继续在另一个会话里工作并把答案带回来。
- **批量任务：一次选页，整批复用。** 同一批条目在当前受控页里用 `browser_navigate` 推进；
  `browser_bind_interactive` 留给「目标页已经在别处打开、而且只能在那里操作」这一种情况 ——
  选一次之后，整批都在选中的那一页上做，用户在整个批次里只被打断一次。

下面这些情况不在本文件展开：

- 审批卡 60 秒超时、提醒一条都没弹、或页面被自动跟随改绑时，读 `approval-and-binding.md`——超时的两种文案、通知为什么不响、改绑后那行提示的判据都在那里。
- 受控标签停在受保护页或 Chrome 错误页、被关掉、工具报「没有绑定页面」或「受控标签页已消失」、或 `browser_bind_interactive` 把你绑到坏页上时，读 `page-failure.md`；标签卡住之后怎么恢复也在这份里。
- 页面根本打不开、要判断是这台机器的出口还是浏览器时，读 `page-failure.md` 的「出口判断：先分类再决定换不换通道」一节：顺序是先 `curl -I`、再看是不是挑战页、最后才动浏览器。

**做完了，能指出这一条：**这次动过的每个写类调用，各自对应「过了审批卡」「审批超时」「被另一个会话持有」里的哪一种；受控页仍是本会话持有的那一页，或已按上面某条指针交出去；批量任务里选页用了几次、每次是不是必要。

## 六、页面链接与表格

- 页面链接不是只有一种走法：**只有 `/document/d/…` 与 `/spreadsheets/d/…` 归
  `google_drive_export`**；Slides、Drive 文件以及其它任何链接都是普通页面，用
  `browser_navigate` 打开再快照 / 截图 / 查 DOM，**不要**把它们塞进 HTML 视图或
  页面类工具去读。
- 表格类链接：`google_drive_export` 会把工作簿下载下来，**并问你要分析哪张 sheet**；
  回答一个 sheet 名或 `all`。
- 浏览器动作可能停在「等用户在助手窗口里确认」那一步，**确认之后才返回**。如果你
  确认了、动作又像是没改任何东西，先重新取一次快照再下结论 —— 别把「还没确认」或
  「确认后没重读」误判成「操作无效」。

**做完了，能指出这一条：**这次遇到的每个链接归哪条路（`google_drive_export` 的两个路径，还是 `browser_navigate`），表格类还指出选了哪张 sheet。

## 七、桥接够不到的地方：工具栏图标与扩展自己的页面

- 按扩展的工具栏图标、在扩展弹窗里点按钮、或驱动 `chrome-extension://` 页面时，读 `desktop-click.md`：系统层点击、坐标换算与复验都在那里。

## 八、安装与更新

- 工具连不上、`browser_status` 报扩展文件刚刷新过、或用户问怎么更新时，读 `install-update.md`：Update 按钮给的是已发布版本的命令，要更新本地 checkout 用 `browser_update` 给的那条。
