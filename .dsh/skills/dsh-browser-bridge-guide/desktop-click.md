# 桥接够不到的地方：工具栏图标与扩展自己的页面

只在要操作浏览器 UI（不是网页）时读。

扩展的工具栏图标、以及它自己开的 `chrome-extension://…` 页面，都不在 `browser_*` 的射程
内：content script 只匹配 `http/https`，对着这类页面取快照会得到
`The content script could not be loaded on this page…`。用户说「用那个扩展做 X」时，先分清
哪一步是网页、哪一步只能在浏览器 UI 里点。

要按工具栏图标、要在扩展弹窗里按按钮，换个 `browser_*` 工具不会绕过去。按下面的顺序走。

## 一、先请用户绑快捷键，绑不上再谈点击

1. **请用户在 `chrome://extensions/shortcuts` 给这个扩展绑一个组合键。** 多数扩展会有一行
   「激活扩展程序」；绑好之后问清楚组合键是什么——每个人绑的都不一样，按他说的算。
2. **用组合键触发。** 不需要坐标：

   ```bash
   osascript -e 'tell application "Google Chrome" to activate' -e 'delay 0.3' \
     -e 'tell application "System Events" to keystroke "." using {command down}'
   ```

   上面是 `command+句号`；换键时只改 `keystroke` 的字符与修饰键（`command down` /
   `option down` / `shift down`）。
3. **快捷键走不通，再用第二节的系统层点击兜底。**

快捷键不依赖坐标、不受 Retina 缩放影响、不会误点，重复一百次也一样；坐标方案每次都要重新
定位，还会把用户当前焦点抢走。

**做完了，能指出这一条：**这次用的组合键，以及按下后弹窗有没有出来（截图或后续快照为证）。

## 二、快捷键走不通时：系统层点击

- **别把扩展页当普通页面驱动。** `browser_navigate` 只收 http(s)；Chrome 的「允许 Apple
  事件中的 JavaScript」对 `chrome-extension://` 同样被拒，报 `此网址不允许使用开发者工具`。
  **那个开关对扩展页无效**，别当成出口去开它。
- **AX 也读不到扩展页里的网页内容。** 遍历那个窗口的 AX 树只有工具栏 / 信息栏 / 窗口按钮，
  没有 `AXWebArea`，所以 `System Events` 的 `click at`、`AXPress` 对页面里的按钮无效，只
  能点原生 UI。
- **系统层点击分两种，按目标切。** `osascript -e 'tell application "System Events" to click
  at {x,y}'` 点工具栏、标题栏通常成功，点到网页内容上会报 `-25211 … 不允许辅助访问`，**权限
  正常时也照报**，不要反复重试同一条。合成事件更稳：JXA 里 `ObjC.import('CoreGraphics')`，
  `CGEventCreateMouseEvent(…, CGPointMake(x, y), …)` 配 `CGEventPost(kCGHIDEventTap, …)`。
  坐标必须走 `CGPointMake`，传普通对象会落到别处。
- **按下之前把指针读回来。** `CGEventGetLocation(CGEventCreate())` 循环「post move → 读回 →
  比差」，进到 3px 内再 down/up。鼠标平滑类工具和用户自己的鼠标都会让「固定 sleep 后按」
  落在移动途中；按下前后各读一次，位置跳了就是这次点击被抢走了，别把它当成「按钮没反应」。
- **非活动窗口吃掉第一次点击。** 截图看红绿灯：灰色的第一次点击只负责激活窗口，先点一下
  窗口，再点目标控件。
- **坐标换算与复验。** `screencapture -x -R<x>,<y>,<w>,<h>` 在 Retina 上出的是 CSS 点的 2
  倍图，除 2 再加 `-R` 原点；窗口位置另用 AX 的 `position`/`size` 交叉核对。每个动作后截
  一张图确认，**别用窗口顺序判断谁在前台**（多显示器下它会和截图矛盾）。
- **空挂载点不代表扩展坏了。** 这类扩展常在页面里留一个空容器，抓取时才渲染遮罩或错误框；
  真正的面板是它自己开的独立窗口。看到「容器在、里面是空的」先去找那个窗口。
- **卡片式按钮的可点击区可能只是卡片里的一张图。** 用户说「点了没反应」时，去读那个组件的
  源码找 `onClick` 挂在哪一层，比按直觉点标题条可靠。
- **接回业务表单用 URL，不要点。** 扩展最终会新开一个普通的 `http(s)` 表单页；直接
  `browser_navigate` 到同一个 URL 最省事（命中跟随站点会带那行 `This session was moved to
  tab N`，没命中就 `browser_bind_interactive` 让用户选）。

**做完了，能指出这一条（走系统层点击时）：**这次点击的坐标、读回的指针位置与目标的偏差（进到 3px 内），以及动作后截图里目标是否变化。
