# 页面拿不到内容时的判据与恢复

主文件 `SKILL.md` 里那些每次都要用的规则不在这里重复（例如「一次只有一个会话能操作浏览器」）。这份文件只在受控标签已经拿不到内容时读：停在受保护页或 Chrome 错误页、标签被关掉、绑定失败，或者目标站从这台机器根本打不开。

## 一、受控标签停在受保护页或 Chrome 错误页

- **加载失败会明说。** 标签停在 Chrome 错误页时（页面没加载出来，`ERR_EMPTY_RESPONSE`、`ERR_CONNECTION_RESET`、`ERR_NAME_NOT_RESOLVED`；不存在的域名常报 `ERR_ABORTED`，走不到 DNS 解析），工具会返回
  `This tab is showing Chrome's error page for a load that failed: net::ERR_… (<url>)`，
  并告诉你下一步：告知用户、`browser_bind_interactive` 换一个页面、没有别的页就让用户 Unbind 后 `browser_navigate`。这不是受保护页，重试同一个调用不会好。
- **失败原因出现在「绑定」的回答里，不在页面列表里。** 选页列表的行格式和宿主之间有契约（`ID=<n> | <title> | <url>`），任何后缀都会让宿主丢掉整行，所以错误页在列表里看起来仍是普通网页；一旦绑上，回答里会写明 `that page failed to load (net::ERR_…)`。
- **受保护页有两种报法，先看是哪种**（`chrome://…`、扩展页、本地文件）。最常见的是
  `<url> cannot be operated.` 开头那段，后面解释「只有它自己的扩展能碰这个页面」并给出换页建议；
  另一种是 `The content script could not be loaded on this page. Chrome internal and protected pages do not support browser operations.`，
  说明这个文档里没有内容脚本可用。两种都重试无意义。
- **怎么判断是不是本机出口的问题**：文案已带 `net::ERR_` 时，用一次 `curl -I <同一个 URL>` 确认：服务端空回复（curl 退出码 52）或连接重置，说明这台机器到那个域名就是不通，**换浏览器通道没有意义**，直接走镜像 / 译文 / 官方 RSS（见本文第四节）。`browser_capture` 截图只在文案没提 `net::ERR_` 时才需要 —— 用来确认标签是不是停在错误页。
- **`browser_navigate` 报受保护页，说的是发起导航时受控标签的当前状态，不是目标地址打不开。** 同一会话里换个目标再 navigate 常常直接成功，别据此给站点判死刑。
- **`browser_bind_interactive` 可能把你绑到坏页上**（返回里写 `chosen by the user`）。绑完立刻用 `browser_snapshot {visual: false}` 验证一次：仍报内容脚本失败或加载失败，就换页或请用户关掉那个标签页，再 `browser_navigate` 新开。
- **别在错误页上 `browser_reload`**：会得到 `The controlled tab changed during the operation`，之后可能变成 `The controlled tab was closed`。错误页直接关标签、重新 navigate。
- 落到受保护页的原因多数是手拼了跳转型端点（SSO、cross-auth、短链）。这类 URL 的 `href` 从页面上取，不要自己拼 —— 少一个参数就可能落到错误页或非 http 页。

**做完了，能指出这一条：**工具原文属于「加载失败 `net::ERR_…`」「受保护页（内容脚本加载不了）」「绑到了坏页」中的哪一类，以及对应的下一步。

## 二、标签页失效：被关掉、没有绑定页面

- 受控页被**关掉**是另一条路径：工具会报 `The controlled tab was closed`（`needsPageChoice`），宿主会弹选页，不会把用户当前看的页面偷偷绑上。
- 工具报「没有绑定页面」或「受控标签页已消失」时，不要重试同一调用：用 `browser_navigate` 打开目标 URL（会新开标签页并绑定本会话），或用 `browser_bind_interactive` 让用户在已打开的页面里挑一个。

**做完了，能指出这一条：**工具报的是「受控标签页已关闭」还是「没有绑定页面」，以及新开的标签页 URL 与本会话已绑定的页面。

## 三、标签卡住之后怎么恢复

- 恢复到正常页的顺序：`browser_bind_interactive` 请用户挑一个正常页面（返回 `No page was chosen` 表示用户没选，这是等你操作、不是失败，把选择交回用户）；用户不在或不想选，就直接说「受控标签页卡在受保护页，请关掉它或新开一个」，关掉后再 `browser_navigate` 新开标签页。别指望 `browser_status` —— 它只报桥接连通性。

**做完了，能指出这一条：**`browser_bind_interactive` 返回的是选中了某个页面（ID 与 URL），还是 `No page was chosen`；后者说明选择已交回用户。

## 四、出口判断：先分类再决定换不换通道

浏览器和命令行在同一台机器、同一条出口上，所以「换浏览器试试」只对一类失败有用。

- **Cloudflare 或人机校验页**（403 加 `Just a moment` / `Checking your browser`）：值得用浏览器过一下，浏览器有真实指纹和登录态。
- **服务端空回复、连接重置、DNS 或 TLS 直接失败**（curl 退出码 52 / 56、Chrome 的 `ERR_EMPTY_RESPONSE` / `ERR_CONNECTION_RESET` / `ERR_NAME_NOT_RESOLVED`）：换通道没有任何意义，因为出口是同一条。直接换来源。
- **换个来源的常用路径**：发行商官方 RSS 常带全文（很多评测的正文就在 CDATA 里，例如 `https://www.gamespot.com/feeds/reviews/`），能绕开挑战页；外文长文常能找到可交叉验证的译文站。用二手来源时说明它是二手，并尽量用原文或另一处交叉核对。

判断顺序固定为：先 `curl -I` 看出口通不通，再看是不是挑战页，最后才谈浏览器里的操作。先开浏览器绕，会把「这个站从这台机器打不开」误判成「受控标签卡住了」。

**做完了，能指出这一条：**`curl -I` 的退出码与状态行，这次失败属于「挑战页 / 出口不通 / 受控标签卡住」中的哪一类，以及据此选了哪条路（过浏览器、换来源、修受控标签页）。
