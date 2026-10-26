---
name: dsh-browser-bridge-guide
description: 在任何工作区（any workspace），只要你用 dsh-browser 桥接的 browser_* 工具驱动页面、排查页面异常或组合这些工具，就该加载我。含：点了报成功但页面没变/新填的值没提交的判据阶梯；选择器失效的六种报错；审批卡为什么超时、提醒为什么没弹；受保护页、错误页与标签页失效的恢复顺序；页面打不开时该不该换通道；读文本、取内嵌图片、截图各用哪个工具；bug 排查与 JS 弹窗处置；绑定、安装与更新。
---

# dsh-browser 桥接的工具选择与故障排查

这份指南是 `browser_*` 工具的技术配方。用它们驱动浏览器、排查「动了但没反应」、
组合多个工具时读它；行为红线（不得凭空断言页面内容、拒绝是边界不是谜题等）在
system prompt 里，这里不重复。

遇到新的、能复现的 `browser_*` 报错，把**触发条件 + 判据 + 出口**补进对应小节。
这份文档按报错类型增补，不写事故清单。

## 一、点了报成功但页面没变 / 新填的值没提交

按这个顺序判，**每一步都要拿到证据再往下一步走**。

**① 先读效果，不读页面。** 页面上的显示可能是本地 store、缓存或未提交的草稿，
它变了不等于请求发出去了，没变也不等于后端没改。用 `browser_network` 看这次操作
真的发了什么：**列表里带体的请求带 `+body` 标记**，按 `requestId` 读它的请求体，
确认提交的值是不是新值。能碰到数据库或后端接口就交叉核对一次 —— 这类操作里它才是
真值来源。

**② 看工具结果末尾有没有那句「标签页被隐藏 / 窗口失焦」。** 内容脚本在标签页
不满足「可见且持有系统焦点」时，会在成功结果后面补一句：
`The controlled tab is hidden … No focus events reach it in this state and clipboard
writes are refused, so a step that depends on either can do nothing silently.`
隐藏或失焦的标签页收不到焦点事件、剪贴板写入被拒；依赖这两样的步骤会静默失败，
而工具本身照样报成功。**这句是警告不是失败**：只读调用（快照、读文本、查 DOM、截图、
取图片）照常返回内容，看到它不用停下来。

**③ 字段按失焦提交的话，桥接已经替你补齐了。** 扩展在点击和输入之前会主动让当前
字段失焦（`settleFocusForActivation`），窗口没系统焦点时改为补发 `blur` / `focusout`，
前后台都成立。所以「拿到的是旧值」说明原因不在这里，别在这一步耗时间。

**2026-10-13 的教训（这份文档存在的核心原因之一）：那天看起来是
`browser_click_pointer` 救了它，实测查明是候选③ —— store 里本来就是新值；
pointer 对这个场景零副作用，对症的是 blur。不要写「表单提交不了 → 换 pointer」，
这条因果是错的。**

**想知道某个控件到底注册了什么监听器，不必做实验。** 用
`browser_debug {action: 'listeners', selector: '<CSS>', type: 'blur,focus'}`——它按层列出
元素、它的祖先、直到 `document` 的监听器。注意这类框架把处理器集中挂在 `document` 上，
所以「元素那一层是 none」是常态、**不是结论**；真正要看的是 `document` 那层有没有
`blur capture`。这一步的意义是：不必为了看一眼而真的发一次保存请求（那种实验在真实
产品上可能留下副作用）。

**④ 控件绑在整段按压序列上时，用 `browser_click_pointer`。** canvas / SVG 自绘的
控件、胶片栏、工具栏监听的是 `pointerdown`/`mousedown`/`mouseup` 这一串，
`browser_click` 只发一次 `click`，不生效却报成功。顺序是**先 `browser_click`，
无效再换 `browser_click_pointer`**，不要一上来就用它。

**④ 的另一面：按压即翻转状态的控件，完整序列等于连按两次。** chosen 这类下拉
（intranet 的 Referrer 字段即此）在 `mousedown` 上展开、在紧随的 `click` 上收起，
`browser_click_pointer` 的完整序列会让它开一次又关掉，两次都报成功、界面停在原状。
要坐实这条机制，在展开状态下只发 `click` 看它是否收起：收起即此因，仍开着就换别的解释。
判据是这次按压对控件属于**触发**（激活、提交）还是**翻转**（开/收、选中/取消）：
翻转类只发一次 `mousedown` 再读状态，不要补 `click`。同类的还有一条：先确认控件把
结果写进哪个容器（chosen 是 `select` 的 `option` 与 `ul.chosen-results`，不是 jQuery UI
的 `ul.ui-autocomplete`），在错的容器里读到空不能判定没渲染 —— 这个控件在 `delay`
与请求窗口内也会把结果列表清空，同一处读到空还有时序这一种解释。

**⑤ 以上都不成立，再回头核对目标。** 重取一次快照；用 `browser_dom_query` 拿
它验证过的唯一选择器，不要手写 `:nth-of-type(N)` 猜。下面这些报错都出在这一步，
按文案对号，不要换着猜：

- `Unknown field(s)`：`fields` 只认白名单（href / src / alt / value / id / class /
  title / aria-label / role / name / type / checked / disabled / visible / text /
  placeholder / options）。要读 `onclick` 这类 JS 属性，用 `browser_eval` 取一次，
  别当字段传。
- `No element … matches selector`：先确认页面没换。一次点击让 URL 变了（结果里会写
  `Page change v2 (https://…)`），旧选择器就作废，原地再点同一个 selector 必然找不到 ——
  重读快照，或换新页面上的 selector。
- 属性选择器按 DOM 里的**字面值**匹配。`href="client_users.php?client_user_ID=1"`
  这种相对链接，写成 `a[href="/client_users.php?…"]` 不匹配；拿不准就退成
  `a[href*="client_user_ID=1"]`。
- 框架生成的类名（`MuiButton-contained`、`MuiFormControlLabel-root`）随版本变，
  优先用 `browser_dom_query` 验证过的 selector，或按可见文本定位。
- `… is not visible`：先 `browser_scroll`，或点包住它的可见元素（复选框常见是
  `span.MuiCheckbox-root`），别反复点同一个不可见节点。
- 在会自动轮询的页面（邮箱、实时面板）上发起导航，可能报
  `The page changed while approval was pending`。这不是失败信号，重试一次；两次都不行
  就直接打开目标 URL，别从轮询页点走。

## 二、读什么用什么

- 读页面或某一段的文字：`browser_get_text`，可带 `selector`，或 `find` + `context`
  直接跳到某个短语。**不要**用 `browser_eval` 写脚本扫 DOM 来凑文字。
- 页面内嵌的图片（图表、示意图、截图）：先用 `browser_dom_query` 定位那个元素，
  再 `browser_image` —— 它返回图片本身、原分辨率、不需要截图，DevTools 开着也能用。
- 外观 / 布局 / 样式 / canvas 或图表 / 某样东西到底渲染出来没有：`browser_capture`。
  它要求该标签页没有 DevTools，否则拿不到画面。
- 只需要文字更新：`browser_snapshot` 传 `visual: false`。快照文本计费，页面还在加载
  用 `browser_wait` 等，别反复拍；连续读同一页用 `delta: true`，只读某块用 `region`，
  只要一小段用 `maxChars`。

## 三、出问题时的工具

- `browser_console`：读该标签页的控制台消息与未捕获错误，从首次调用起开始记录。
- `browser_network`：读请求与响应（url / 方法 / 状态 / 耗时），按 `requestId` 读
  某一个请求或响应体，`+body` 标记表示列表里带体。
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

## 四、JavaScript 弹窗冻住了页面

alert / confirm / prompt 是**浏览器 UI，不是页面内容**：弹窗一开，它所属的页面就被
冻住，所有面向页面的工具会被拒绝，**拒绝文案里带着弹窗原文**。此时用 `browser_dialog`
回答（accept / dismiss，prompt 可带 text）—— 它走 CDP，页面冻着也能用。

**已经在跑的那次调用也会被截断**：页面动作（点击、输入、读取、求值）发出之后页面才
弹窗时，桥接不再让它干等到超时，当场以「弹窗开着、原文是…」返回。看到这句话就说明原
动作可能在你答完弹窗后才落地——先 `browser_snapshot` 重读页面，不要直接重发同一次点击。

## 五、审批、绑定与恢复

### 审批卡：60 秒窗口，以及「为什么没看到提醒」

- **要审批的是动作，不是读取。** 读类（`browser_snapshot`、`browser_get_text`、
  `browser_dom_query`、`browser_console`、`browser_network` 的查看、`browser_capture`、
  `browser_image`）在 `sharePageContent = auto` 时直接跑，只有 `ask` 模式才逐次问。
  写类（`browser_navigate` / `back` / `forward` / `reload` / `click` /
  `click_pointer` / `type` / `press` / `browser_eval` / `browser_headers` /
  `browser_dialog` / `browser_debug` / `browser_block` / `browser_network` 的 mock）
  都要过审批卡。
- **卡片在扩展自己的界面里，窗口固定 60 秒。** 超时有两种文案，含义相同，都是「卡
  弹过、没人应答、动作没执行」：导航类报
  `The browser approval request for "<工具名>" timed out before the user responded.`
  其余动作报 `The approval prompt for "<工具名>" expired before it was answered, so
  nothing ran.`（后者会直接告诉你下一步：让用户先看卡、再决定要不要重发）。这两句
  都是扩展产生的，**不等于宿主把审批关掉了**。
- **别把宿主那句 `Approval prompts are disabled in this session` 读成「本会话没有
  浏览器能力」。** 那句管的是沙箱提权（写文件、跳出沙箱的命令），和浏览器审批卡是两
  套东西。宿主侧同场景的报错文案是 `got no answer within Nms — the bridge's own
  budget`，两者按文案就能分开。看到带 `browser approval request for` 的那句，说明卡
  确实弹过、只是没人应答 —— 这种情况**重试永远无效**。
- **提醒有三种，每一种都可能不响。** ①助手窗口开着且不在前台时发系统通知；②没有任何
  助手页面时，尝试打开状态窗（浮动窗形态能打开，侧栏形态没有用户手势会被 Chrome 拒绝，
  于是只剩通知）；③宿主在调用静默 20 秒后会向用户提问「是不是有个确认卡在等」。
  通知开关在设置里（默认开），创建失败会记进扩展 debug log 的 `notification-failed`。
  窗口在前台时不发通知，所以「用户就坐在 Chrome 前面」也可能什么都没弹。
- **通知一条都不出现时，先查系统，不是查代码。** macOS 的通知设置里同一个 app 可能登记了
  两条（旧通知通道与 Chrome 152+ 的原生通道各一条），其中一条是「关闭」时，扩展的通知会
  被系统静默丢掉，而 `chrome.notifications.create` 照样成功、debug log 里也不会有失败。
  让用户把两条都设为允许通知。代码层能自证的只有一句：日志里没有 `notification-failed`。
- **子代理不要直接调 `browser_*`。** 浏览器一次只被一个会话持有，子代理既看不到扩展
  的卡、也收不到宿主那句提问，只会把 60 秒超时当成「站点打不开」来回试。

### 受保护页、错误页与标签页失效

- **加载失败会明说。** 标签停在 Chrome 错误页时（页面没加载出来，`ERR_EMPTY_RESPONSE`、
  `ERR_CONNECTION_RESET`、`ERR_NAME_NOT_RESOLVED`），工具会返回
  `This tab is showing Chrome's error page for a load that failed: net::ERR_… (<url>)`，
  并告诉你下一步：告知用户、`browser_bind_interactive` 换一个页面、没有别的页就让用户
  Unbind 后 `browser_navigate`。这不是受保护页，重试同一个调用不会好。
- **失败原因出现在「绑定」的回答里，不在页面列表里。** 选页列表的行格式和宿主之间有
  契约（`ID=<n> | <title> | <url>`），任何后缀都会让宿主丢掉整行，所以错误页在列表里
  看起来仍是普通网页；一旦绑上，回答里会写明 `that page failed to load (net::ERR_…)`。
- **`The content script could not be loaded on this page. Chrome internal and protected
  pages do not support browser operations.` 才是受保护页**（`chrome://…`、扩展页、下载页、
  PDF 查看器）。它说明这个文档根本没有内容脚本可用，重试无意义。
- **怎么判断是不是本机出口的问题**：文案已带 `net::ERR_` 时，用一次
  `curl -I <同一个 URL>` 确认：服务端空回复（curl 退出码 52）或连接重置，说明这台机器
  到那个域名就是不通，**换浏览器通道没有意义**，直接走镜像 / 译文 / 官方 RSS（见第七节）。
  `browser_capture` 截图只在文案没提 `net::ERR_` 时才需要 —— 用来确认标签是不是停在错误页。
- **`browser_navigate` 报受保护页，说的是发起导航时受控标签的当前状态，不是目标地址
  打不开。** 同一会话里换个目标再 navigate 常常直接成功，别据此给站点判死刑。
- **`browser_bind_interactive` 可能把你绑到坏页上**（返回里写 `chosen by the user`）。
  绑完立刻用 `browser_snapshot {visual: false}` 验证一次：仍报内容脚本失败或加载失败，
  就换页或请用户关掉那个标签页，再 `browser_navigate` 新开。
- **别在错误页上 `browser_reload`**：会得到 `The controlled tab changed during the
  operation`，之后可能变成 `The controlled tab was closed`。错误页直接关标签、重新
  navigate。
- 恢复到正常页的顺序：`browser_bind_interactive` 请用户挑一个正常页面（返回
  `No page was chosen` 表示用户没选，这是等你操作、不是失败，把选择交回用户）；用户
  不在或不想选，就直接说「受控标签页卡在受保护页，请关掉它或新开一个」，关掉后再
  `browser_navigate` 新开标签页。别指望 `browser_status` —— 它只报桥接连通性。
- 落到受保护页的原因多数是手拼了跳转型端点（SSO、cross-auth、短链）。这类 URL 的
  `href` 从页面上取，不要自己拼 —— 少一个参数就可能落到错误页或非 http 页。
- **一次只有一个会话能操作浏览器。** 受控标签页已被另一个会话持有时，绑定会失败并在
  文案里点出那个会话（`browser_navigate` 的首次调用也一样）。这种情况什么都不会执行：
  请用户点 dsh 浏览器面板里的 Unbind，或继续在另一个会话里工作并把答案带回来。
- 工具报「没有绑定页面」或「受控标签页已消失」时，不要重试同一调用：用
  `browser_navigate` 打开目标 URL（会新开标签页并绑定本会话），或用
  `browser_bind_interactive` 让用户在已打开的页面里挑一个。

### 安装与更新

- 工具连不上、或某个工具像是缺了：第一站是 `browser_status`，它会给出唯一的下一个
  动作。首次安装，或它的文案说扩展文件刚刷新过，用 `browser_setup` 准备文件并打开
  扩展页。
- 用户问怎么更新：让他们点扩展面板里的 **Update** 按钮（它把命令放进剪贴板），或者调
  `browser_update` 把命令打印出来交给用户自己跑 —— 两者都**不会替用户执行**，因为更新
  要写进用户的 dsh home，跑完还要在 chrome://extensions 点一下 Reload。
  **两者给的命令不一样，别混**：按钮**总是**给已发布版本的安装命令
  `curl -fsSL …/scripts/install.sh | bash`；`browser_update` 则按本机安装方式给——仓库内
  安装（checkout）是 `./scripts/install.sh`。所以**要更新的是本地 checkout 的改动时，用
  `./scripts/install.sh`（在仓库里跑），别用按钮给的那条**——那条装的是已发布版本，会把
  本地树覆盖掉。

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

## 七、页面打不开时，先分类再决定换不换通道

浏览器和命令行在同一台机器、同一条出口上，所以「换浏览器试试」只对一类失败有用。

- **Cloudflare 或人机校验页**（403 加 `Just a moment` / `Checking your browser`）：
  值得用浏览器过一下，浏览器有真实指纹和登录态。
- **服务端空回复、连接重置、DNS 或 TLS 直接失败**（curl 退出码 52 / 56、Chrome 的
  `ERR_EMPTY_RESPONSE` / `ERR_CONNECTION_RESET` / `ERR_NAME_NOT_RESOLVED`）：换通道
  没有任何意义，因为出口是同一条。直接换来源。
- **换个来源的常用路径**：发行商官方 RSS 常带全文（很多评测的正文就在 CDATA 里，例如
  `https://www.gamespot.com/feeds/reviews/`），能绕开挑战页；外文长文常能找到可交叉
  验证的译文站。用二手来源时说明它是二手，并尽量用原文或另一处交叉核对。

判断顺序固定为：先 `curl -I` 看出口通不通，再看是不是挑战页，最后才谈浏览器里的操作。
先开浏览器绕，会把「这个站从这台机器打不开」误判成「受控标签卡住了」。

## 八、下一步

被驱动的这个页面是（或变成）Google Slides 时，接着加载 `google-slides-via-browser`：
胶片栏 / 工具栏控件、按页码切页、以及编辑器控件点了没反应，都在那份里。
