---
name: dsh-browser-bridge-guide
description: 在任何工作区（any workspace），只要你用 dsh-browser 桥接的 browser_* 工具驱动页面、排查页面异常或组合这些工具，就该加载我。含：点了报成功但页面没变/新填的值没提交的判据阶梯；读文本、取内嵌图片、截图各用哪个工具；bug 排查与 JS 弹窗处置；绑定、安装与更新。
---

# dsh-browser 桥接的工具选择与故障排查

这份指南是 `browser_*` 工具的技术配方。用它们驱动浏览器、排查「动了但没反应」、
组合多个工具时读它；行为红线（不得凭空断言页面内容、拒绝是边界不是谜题等）在
system prompt 里，这里不重复。

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
而工具本身照样报成功。

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

**⑤ 以上都不成立，再回头核对目标。** 重取一次快照；用 `browser_dom_query` 拿
它验证过的唯一选择器，不要手写 `:nth-of-type(N)` 猜。

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

## 五、绑定、安装与更新

- 用户说「绑定到这个页面」时用 `browser_bind_interactive`：它列出页面、问用户、
  一次完成绑定。
- **一次只有一个会话能操作浏览器。** 如果受控标签页已被另一个会话持有，绑定会失败
  并在文案里点出那个会话（`browser_navigate` 的首次调用也一样）。这种情况什么都
  不会执行：请用户点 dsh 浏览器面板里的 Unbind，或继续在另一个会话里工作并把答案
  带回来 —— 不要重试原调用。
- 工具报「没有绑定页面」或「受控标签页已消失」时，也不要重试同一调用：用
  `browser_navigate` 打开目标 URL（会新开标签页并绑定本会话），或用
  `browser_bind_interactive` 让用户在已打开的页面里挑一个。
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

## 七、下一步

被驱动的这个页面是（或变成）Google Slides 时，接着加载 `google-slides-via-browser`：
胶片栏 / 工具栏控件、按页码切页、以及编辑器控件点了没反应，都在那份里。
