---
name: google-slides-via-browser
description: 任何工作区（any workspace）用 dsh-browser 的 browser_* 工具驱动 Google Slides 编辑器时加载我：docs.google.com/presentation/… 页面、"第 N 页/这一页讲了什么"、切换胶片栏缩略图、导入某一页或替换/删除某一页、把本地 pptx 推到云上，或 browser_click 报成功但页面却没变时。
---

# 用 dsh-browser 驱动 Google Slides

适用场景：目标页是 Slides 编辑器（`docs.google.com/presentation/d/…/edit`）。

**总规则：Slides 的控件是 SVG 自绘、绑在完整指针序列上。** 普通点击对它们不生效却回报成功，所以「报成功但页面没变」先换 `browser_click_pointer`，再谈其它排查。

## 一、两种点击，各自管什么

`browser_click` 只发一个 `click` 事件（`extensions/dsh-browser/src/content/actions.ts` 的 `activateElement()`：HTML 元素用 `el.click()`，非 HTML 用一次 `dispatchEvent(MouseEvent('click'))`）。缩略图、工具栏、顶部菜单监听的是 `pointerdown`/`mousedown`/`mouseup`，所以只发 `click` 时工具照样回报 "Clicked selector …"，页面不动。

实测（2026-09-17，真实 Slides）：

| 序列 | 是否切页 |
|---|---|
| 只 `pointerdown` | ❌ |
| `pointerdown + pointerup + click` | ❌ |
| `pointerdown + mousedown + pointerup + mouseup + click` | ✅ |

`browser_click_pointer` 就是这个五件套。它派发前会等矩形稳定（至少一帧、两次测量一致）再做命中测试，隐藏/后台标签页里用定时器代替 rAF，一样生效。它单独成工具是因为给公共点击路径补鼠标事件会让普通按钮重复触发。

顺序：先 `browser_click`；无效再换 `browser_click_pointer`。参数与 `browser_click` 相同，也给 `index`：

```
browser_click_pointer { "selector": "g.punch-filmstrip-thumbnail:nth-of-type(7)" }
```

坐标由工具按元素矩形中心算，你只管给目标；它要求那个点落在元素内，否则命中测试不过。

**顶部菜单是必须用 pointer 的一类。** `#docs-file-menu` 用 `browser_click` 菜单打不开，换 pointer 才开。菜单 id：File 是 `#docs-file-menu`，Slide 是 `#punch-slide-menu`（没有 `#docs-slide-menu`）。打开后用 pointer 点条目。

**对话框里的复选框和按钮用 `browser_click` 就够**（选页复选框、Import slides 按钮都实测生效）。

## 二、切页

首选 `browser_slides_open_page { "page": N }`。

它按胶片栏的 DOM 下标推算页码，**导入或删除过页之后下标会和实际页序脱钩**（见第四节），这时它可能回 "Opened slide N" 却落在 N+1。落点以第五节核对为准。

工具不存在或落点可疑时手写网格流程：

1. `browser_click_pointer` 点 `#grid-view-toggle` 进网格视图（hash 变空，`#grid-view-toggle` 的 `aria-pressed="true"`）。
2. 用 `browser_dom_query { selector: "g.punch-filmstrip-thumbnail", fields: ["visible","text"] }` 按页码前缀认目标，拿它给出的 selector 去点。目标在屏外时先 `browser_eval` 做 `scrollIntoView({ block: 'center', behavior: 'instant' })`，等约 1.2s 再点——不等会点到邻页（第 30 页 → 落在第 6 页）。
3. 再点 `#grid-view-toggle` 退出，hash 变成所选页的 `#slide=id.<slideId>`。

**页码换算只有一个公式：`filmstrip-slide-<索引>-<slideId>` 的索引是 0 基，+1 才是页码。** `nth-of-type(N)` 只在没增删过页时才等于第 N 页。1 基页码与 0 基索引混用极易读错。

## 三、读某一页的正文

hash 给出 slideId，画布节点按它取：

```js
const slideId = location.hash.replace('#slide=id.', '')
document.querySelector(`g#editor-${slideId}`).textContent
```

两个坑：

- **胶片栏的 `text` 不止当前页。** 虚拟化窗口里十几到二十几张缩略图的文字都在，`browser_get_text` 不带 selector 拿到的是整片。
- **同时挂着多个画布。** 实测 20 个 `[id^="editor-"]`，`querySelector('g[id^="editor-"]')` 取的是 DOM 顺序第一个、常常不是当前页——我就因此把第 25 页读成了第 10 页。

`browser_get_text` 会截断（本站页脚吃掉过预算），必要时传 `g#editor-<slideId>` 或提高 `maxChars`。

判据：引用的那句话出自 `g#editor-<当前 hash 的 slideId>` 的 textContent。

## 四、改文档：导入一页、替换某一页

**先认桥接的边界：`browser_*` 没有给文件选择框塞文件的能力**（源码里没有 `setFileInputFiles`，也没有 file chooser 拦截）。Slides 的 "Upload" 标签会拉起原生选择框，这条路走不通。可用路径是先把本地文件送进 Drive：

1. 复制到 Drive 挂载目录 `~/Library/CloudStorage/GoogleDrive-<账号>/我的云端硬盘/`，等文件 xattr 出现 `com.google.drivefs.item-id#S`（本次约 15 秒）即同步完成。
2. 切到要被替换的那一页。**导入会插在当前停留页之后**：2026-11-11 实测停在第 21 页导入，新页落在 22 位。
3. `#docs-file-menu` → "Import slides" → 弹出 picker。picker 是 iframe（`docs.google.com/picker/v2/home`），`browser_eval` 进不去，只能用带 `frame` 参数的 dom_query / click。
4. picker 里点文件 → 底部 "Insert 1 item" → 选页对话框。
5. 只勾目标页。判据是底部那句 `1 out of 28 slides selected`；`#avWBGd-*` 这类 id 每次随机，用时现查。
6. 点 "Import slides"，标题栏从 "Saving…" 变成 "Saved to Drive" 才算写盘完成。
7. 删旧页：选中旧页 → `#punch-slide-menu` → "Delete slide"。

代价与核对：

- **新页是新的 slide id**，指向旧页的链接、评论会失联；页码由 Google 按位置重算，不用手动改。
- 删旧页前后各数一次 `.punch-filmstrip-thumbnail` 数量，并看一眼截图里的页码标签。
- 回滚：文件 → 版本记录，或 Cmd+Z。
- 用完把临时文件从 Drive 删掉，确认它没复活。

## 五、核对当前页：三个锚点

1. **URL hash** 的 slideId：切页前后都记，用来判"动没动"。
2. **`g#editor-<slideId>`**：当前页正文。
3. **截图里 app 自己画的页码标签**：第几页。增删页之后尤其靠它。

实测（2026-11-11）：导入后胶片栏的 DOM 顺序变成 `1…21, 23…29, 22`——新页节点留在列表末尾，`nth-of-type(N)` 与实际页序对不上，`browser_slides_open_page {page:22}` 打开了第 23 页。类名同样不可信：`punch-filmstrip-selected-thumbnail-pagenumber` 在重渲染后就查不到了。

标签页隐藏时工具回 `(No visible changes.)`，那只说明页面没重绘，不代表操作没落地——用上面三个锚点核对。

## 六、动手前先看一眼现状

1. `browser_snapshot { visual: false }` 确认加载完成。
2. `browser_dom_query { selector: ".punch-filmstrip-thumbnail", fields: ["visible","text"], limit: 15 }` 看页码与标题。
3. 要改内容时，先定位"本地哪一份是新版"。候选文件常常不止一份（本次仓库里一份、Drive 同步目录一份），mtime 和导出时间都不足以判断内容新旧，逐页比文本。

## 七、边界

- 只读访问之后，把视图切回用户给你时的 hash。
- 修改用户的演示文稿前先说明代价（slide id 变化、共享文档里别人可见），得到同意再动。
- 这套手法对 Google Docs / Sheets 大概率同样适用（同源编辑器框架），我没有实测过。
