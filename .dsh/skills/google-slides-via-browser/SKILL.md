---
name: google-slides-via-browser
description: Use in any workspace when the page being driven through the dsh-browser bridge (browser_* tools) is or becomes Google Slides — a docs.google.com/presentation/... URL, "第 N 页/这一页讲了什么", 切换/点击幻灯片缩略图, 胶片栏(filmstrip)操作, 或任何对 Slides 编辑器控件的点击/输入失败时。也适用于同类的 Google 编辑器(docs/sheets)控件无响应时作为排查起点。
---

# 用 dsh-browser 驱动 Google Slides

适用场景：任何工作区里，通过 dsh-browser 的 `browser_*` 工具操作浏览器，而目标页是 Google Slides 编辑器。

Slides 的编辑器不是普通网页：控件是 SVG + 自绘，交互绑定在**完整指针序列**上。当普通页面点，会得到"成功但没反应"的假象。

## 一、判据：什么时候该想起这份经验

- 你要操作的页面是 `docs.google.com/presentation/d/…/edit`
- 用户问"第 N 页讲了什么"、"切到第 N 页"、"点某个缩略图"
- **`browser_click` 返回成功、但页面状态没变**（最强的信号，Slides 上很常见）

## 二、核心事实：`browser_click` 对 Slides 控件大概率无效

`browser_click` 最终走 `activateElement()`（`extensions/dsh-browser/src/content/actions.ts`）：HTML 元素用 `el.click()`，非 HTML 用一次 `dispatchEvent(new MouseEvent('click'))`。**两者都只发一个 `click` 事件**；Slides 的缩略图与工具栏控件监听的是 `mousedown`/`mouseup`，所以只发 `click` 不生效——工具照样回报 "Clicked selector …"。

**实测（2026-09-17，真实 Slides）**：

| 序列 | 是否切页 |
|---|---|
| 只 `pointerdown` | ❌ |
| `pointerdown + pointerup + click` | ❌ |
| **`pointerdown + mousedown + pointerup + mouseup + click`** | ✅ |

**必需的正是那两个 mouse 事件。** 这条结论用 URL hash 前后差复现过三次。

## 三、首选手法：`browser_click_pointer`

上面的五件套已经固化成一个独立工具，直接调它，不要手抄 JS：

```
browser_click_pointer { "selector": "<缩略图选择器>" }
```

也接受 `index`（快照编号），参数与 `browser_click` 相同。它按元素矩形中心派发全部五个事件；**坐标必须落在元素矩形内**，否则命中测试不过——这是工具替你算的部分。

为什么是独立工具而不是改 `browser_click`：`click` 覆盖 80–90% 的普通网页场景，给公共点击路径补鼠标事件会带来"对普通按钮重复触发"的回归风险。已与用户确认：**公共路径保持不动，指针序列单独成工具**。

顺序上：**先 `browser_click`，失败或无效再换 `browser_click_pointer`**，不要一上来就用它。

### 拿到缩略图的选择器

缩略图是 SVG `g`（`.punch-filmstrip-thumbnail`），用 dom_query 让它给出可复用的唯一选择器，别手写 `:nth-of-type()` 猜：

```
browser_dom_query { "selector": ".punch-filmstrip-thumbnail", "fields": ["visible", "text"], "limit": 15 }
```

`name=` 前缀里带页码，可用来确认目标页。

## 四、兜底：`browser_click_pointer` 也不行时才 escape 到页面

只有工具失效（例如要点的不是单个元素、需要自定义坐标或其它事件）才用 `browser_eval` 自己派发，**只做需要的那几次，不要把它当常规手段**：

```js
(() => {
  const target = document.querySelector('<选择器>')
  const r = target.getBoundingClientRect()
  const o = { bubbles: true, cancelable: true, composed: true,
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
              view: window, detail: 1, button: 0, buttons: 1,
              pointerId: 1, pointerType: 'mouse', isPrimary: true }
  for (const [t, C] of [
    ['pointerdown', PointerEvent], ['mousedown', MouseEvent],
    ['pointerup', PointerEvent], ['mouseup', MouseEvent], ['click', MouseEvent],
  ]) target.dispatchEvent(new C(t, o))
  return JSON.stringify({ hash: location.hash })
})()
```

`browser_eval` 走"不可信任动作"审批；开启 `trustJsExecution` 且 origin 受信时可免审批——这也意味着免审批的 eval 更容易被页面内容诱导，仍然只做明确需要的事。

## 五、怎么确认"真的切页了"——不要猜，读这两处

**别用类名判断选中态。** 我踩过：`punch-filmstrip-selected-thumbnail-pagenumber` 这个类名在页面重渲染后就查不到了。

可靠判据是两个：

1. **URL hash**：切页后变成 `#slide=id.<slideId>`。**读之前先记录初值**，只有"前后不同"才是证据。
2. **画布元素 id**：当前页画布是 `g#editor-<slideId>`；缩略图 id 是 `filmstrip-slide-<N>`，其中 **`N` 是 0 基索引**——`filmstrip-slide-9` 就是**第 10 页**。1 基页码与 0 基 id 混用极易读错。

判"第 N 页"的稳妥写法：先取 hash 里的 slideId，再找 `[id^="filmstrip-slide-"]` 里含该 id 的那个，读它的索引 +1。

## 六、读某一页的正文

**胶片栏的 `text` 包含全部页面的文字**（所有缩略图都在 DOM 里），所以 `browser_get_text` 拿到的不是"当前页"。要拿单页正文，读画布节点：

```js
document.querySelector('g[id^="editor-"]').textContent
```

`browser_get_text` 会截断（本站遇到的是页脚/备案信息吃掉预算），必要时改用 `browser_dom_query` 取具体节点，或提高 `maxChars`。

## 七、边界与取舍

- **改动了用户文档的状态要还原。** 例如切过页之后，切回用户给你时的页码/hash。
- 这套手法对 Google **Docs / Sheets** 大概率同样适用（同源编辑器框架），但**我没有实测过**，不要当成已证事实。
- 用户提供的演示文稿如果不是你的，也不要留下编辑痕迹：只读、只切页。

## 八、动手前先看一眼现状

Slides 是"重状态"应用，先读现状能少走弯路：

1. `browser_snapshot`（`visual:false` 够用）确认当前页与是否已加载完
2. `browser_dom_query { selector: ".punch-filmstrip-thumbnail", fields: ["visible","text"], limit: 15 }` 拿到缩略图与页码
3. 再决定是否需要切页、切到哪一页

## 九、这份经验的维护位置

本文件随 dsh-browser 仓库分发：仓库内路径 `<repo>/.dsh/skills/google-slides-via-browser/SKILL.md` 是唯一事实源；`scripts/install-skills.mjs` 把它安装到 `~/.dsh/skills/`，因此**其它工作区**（cwd 不在本仓库时）也能触发。改内容改仓库里的这份，然后重跑安装脚本；不要只改 `~/.dsh/skills` 下的副本。
