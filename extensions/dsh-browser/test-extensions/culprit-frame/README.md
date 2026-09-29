# DSH culprit frame（手动加载的测试扩展）

一个**只用于复现**的最小扩展：往每个页面的**每个 frame** 注入两个隐藏 iframe，它们的文档属于这个扩展自己（`chrome-extension://<它自己的 ID>/frame1.html`）。这就是密码管理器、阅读器、PDF 查看器在页面里留下的东西，也是让 Chrome 拒绝 `chrome.debugger` 的全部条件。

dsh 自己**永远不会**加载它。它只在你要复现"整个标签页不可调试"时由开发者手动装一次。

## 为什么要它

Chrome 在 attach 之前遍历整个 tab 的 frame 树（`ExtensionMayAttachToWebContents` → `ForEachRenderFrameHostWithAction` → `ExtensionMayAttachToURL`），只要有一个 frame 的 URL 是别的扩展的页面，就拒绝整个标签页——截图、console、network、求值全部不可用。真实页面里这个 frame 往往来自某个你装的扩展，你无法控制它何时出现、也无法只靠改页面来制造它；这个扩展把它变成确定的一件事。

`browser_remove_foreign_frames`（扩展侧的内部动作，模型看不到）就是为了绕开它：把这类 frame 从 DOM 上取下来 → 重新 attach → 立刻按原位置放回。

## 怎么用

1. chrome://extensions → 打开开发者模式 → 「加载已解压的扩展程序」→ 选这个目录
2. 刷新任意普通网页（http/https）——content script 只在新加载的页面里注入
3. 此时该标签页不可调试：`browser_console` / `browser_capture` / `browser_eval` 都会先被 Chrome 拒绝，再由扩展摘掉 frame、重新 attach

想让它生效需要一个**新的 attach**（Chrome 只在 attach 那一刻检查帧树）：重载 dsh 的浏览器扩展、或在面板 Unbind 之后重新绑定一个已经带着这些 frame 的页面。已经建立好的会话不受影响。

## 变体

- **只往子 frame 注入**：在 `inject.js` 的 `start()` 里取消注释 `if (window.top === window) return`。用来单独验证"子 frame 里的外来 frame 是否也阻止 attach"（实测：会阻止）。
- **模拟两个扩展同时注入**：把整个目录复制一份（例如 `culprit-frame-two/`），改一下 `manifest.json` 的 `name`。**目录不同 = 扩展 ID 不同**，于是页面帧树里会出现两个不同扩展的 frame，覆盖"多扩展"场景。

## 卸载

chrome://extensions → 找到 `DSH culprit frame (manual test extension)` → 移除。它不写任何数据，只注入 iframe；移除后刷新页面即可恢复干净。

## 相关

- 判定与绕过的完整分析：`docs/service-worker-lifetime.md`
- 摘除/放回的实现：`extensions/dsh-browser/src/content/actions.ts`（`browser_remove_foreign_frames` / `browser_restore_foreign_frames`）与 `src/background/tools.ts`（`withForeignFrameRetry`）
