# 扩展 service worker 何时被回收，以及"调试横幅出现几秒就消失"意味着什么

> 起因：外部反馈「截图失败 / eval 调不通 / debug 横幅出现几秒就消失了」，最初的猜测是"MV3 的 service worker 被 Chrome 回收，连带丢掉了 `chrome.debugger` 附加"。查证 Chromium 源码与官方文档后，**这个因果链是反的**。本文记录查证结果与由此得到的排查清单。
>
> 行号截至 2026-09-29。

## 结论（三条）

1. service worker 因**空闲**被回收的条件是「30 秒内既没有事件、也没有扩展 API 调用」（Chrome 110+；旧的 5 分钟硬上限已移除），外加「单个请求处理超过 5 分钟」。
2. **只要 `chrome.debugger` 附加着，SW 就不会被空闲回收**：Chromium 在 attach 时给这个 worker 加了一个 `kDoesNotTimeout` 的保活。
3. **调试横幅消失说明会话真的断了**，不是显示问题：那条 infobar 在 detach 之后 5 秒自动关闭（`kAutoCloseDelay = 5s`），attach 期间只要没人点它就不会自己关。

因此要问的不是"SW 为什么被回收"，而是**"谁在几秒内断开了调试会话"**。

## 一、SW 被回收的完整条件

来源：[扩展 service worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[Longer extension service worker lifetimes](https://developer.chrome.com/blog/longer-esw-lifetimes)（Chrome 110 的行为变更说明）。

| 条件 | 细节 |
|---|---|
| 30 秒无活动 | 收到事件、或调用任意扩展 API（如 `chrome.storage.local.get()`）都会把它重置 |
| 单个请求超过 5 分钟 | 长任务本身跑过 5 分钟、且这期间 30 秒没有新事件 |
| 强保活 | 会**取消**上面两个计时器。官方点名的例子是 native messaging；`chrome.debugger` 附加属于同一类（见第二节） |
| 非空闲终止 | 浏览器退出、扩展被更新/卸载/重载、worker 崩溃、profile 销毁。这些与空闲无关 |

要点：Chrome 110 之前存在"5 分钟硬上限"，所以网上大量"MV3 每 5 分钟必死"的说法对应的是旧版本行为。

我们扩展现有的保活手段（与本分析无关，但列出来免得误判）：
- 桥是 WebSocket 长连接，宿主有 ping/pong 心跳（连接活动同样重置空闲计时器）；
- `chrome.alarms` 每 0.5 分钟一次（`index.ts` 的 `BRIDGE_KEEPALIVE_ALARM`，用于重连循环），而 alarms 的最小周期就是 30 秒——正好等于空闲阈值，所以它**不能**单独当作可靠的保活；
- attach 期间的 debugger 保活（下面这条）。

## 二、附加调试器是强保活（源码证据）

`chrome/browser/extensions/api/debugger/debugger_api.cc`，`ExtensionDevToolsClientHost::Attach()`：

```cpp
  if (extension_service_worker_id_) {
    ProcessManager* process_manager = ProcessManager::Get(profile_);
    CHECK(process_manager);
    // The service worker should definitely be registered at this point.
    CHECK(process_manager->HasServiceWorker(*extension_service_worker_id_));
    service_worker_keepalive_ =
        process_manager->IncrementServiceWorkerKeepaliveCount(
            *extension_service_worker_id_,
            content::ServiceWorkerExternalRequestTimeoutType::kDoesNotTimeout,
            Activity::DEBUGGER, /*extra_data=*/std::string());
  }
```

配套的成员注释也写明了用途：

```cpp
  // A service worker keepalive used to keep the associated worker alive while
  // this client is attached.
  std::optional<base::Uuid> service_worker_keepalive_;
```

`Activity::DEBUGGER` 的类型定义在 [`extensions/browser/activity.h`](https://chromium.googlesource.com/chromium/src/+/main/extensions/browser/activity.h)：

```cpp
    // The activity is an attached debugger session (i.e., using the
    // chrome.debugger API). This is distinct from `DEV_TOOLS`, which indicates
    // the user is debugging the extension.
    DEBUGGER,
```

**推论**：attach 期间 SW 不会被空闲回收；只有 detach 之后保活才解除，SW 才回到 30 秒规则。所以"SW 被回收 → 附加丢失 → 横幅消失"这条链条不成立——反过来，附加在时 SW 是被保住的。

这也解释了为什么 `debugger_api.cc` 里 detach 时的清理要写成"如果 worker 还在才减计数"：

```cpp
    // The worker may have terminated for other reasons. Only decrement the
    // keepalive if it's still around.
```

## 三、横幅（infobar）的语义

[`extension_dev_tools_infobar_delegate.h`](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/extension_dev_tools_infobar_delegate.h)：

```cpp
  static constexpr base::TimeDelta kAutoCloseDelay = base::Seconds(5);
  ...
  // infobar_ is set after attaching an extension and is deleted 5 seconds after
  // detaching the extension.
```

据此：

- attach → 横幅出现；
- detach → **5 秒后**横幅自动关闭；
- 用户点横幅上的按钮 → 立即 detach，Chrome 给出的 reason 是 `canceled_by_user`（`WarningUiDestroyed()` 里先设 `detach_reason_` 再 `Close()`）。

所以"横幅出现几秒后消失"= 会话在几秒内断开了。若是用户自己点的，reason 会明确写 `canceled_by_user`。

## 四、谁会断开调试会话（排查清单）

Chrome 侧：

1. 用户点了横幅的按钮 → `canceled_by_user`。
2. 标签页关闭、renderer 崩溃 → `AgentHostClosed()` → 默认 reason `target_closed`。
3. 扩展被重载 / 更新 / 卸载 → `OnExtensionUnloaded()` → `Close()`。开发期手动 reload 扩展必然走到这里。
4. profile 销毁（浏览器退出）→ `OnProfileWillBeDestroyed()` → `Close()`。
5. 企业策略只在 **attach 时**拒绝（`kDebuggerDisabledByPolicyBlockedHosts`、`kDebuggerDisabledByScreenshotPolicy` 等），不会事后断开。

我们代码侧（`extensions/dsh-browser/src/background/`）：

1. `debugger-session.ts:254` `detachIfIdle`：引用计数归零即 detach。**截图路径每次都会走这里**（`capture.ts:134` 的 `lease.release()`），所以"截图时横幅闪一下"是设计行为，不是故障。
2. `index.ts:404`：`syncDevtoolsPriming` 会 detach**不在 wanted 集合里**的已预热标签页；wanted 只来自 `tabAffinity.sessionMap()`。绑定丢失、解绑、关掉调试开关时表现为整批 detach。而 `broadcastTabAffinity()` 有 12 个调用点（含 `tabs.onUpdated` / `onActivated` / 设置保存），每次都会触发这轮同步——这是"横幅反复闪"最可能的来源。
3. `index.ts:1755`：标签页关闭时清账。
4. `devtools.ts:374`：监听 Chrome 的 detach 事件并清账——这是**观察点**，不是断开原因。
5. 关掉「允许 dsh 使用浏览器调试能力」→ wanted 变空 → 全部 detach（预期行为）。

## 五、用日志区分（`browser_status` 输出的 debug log 段）

日志是这次新加的（`extensions/dsh-browser/src/background/debug-log.ts`），记 attach/detach 与 Chrome 给出的 reason：

| 日志形态 | 结论 |
|---|---|
| `attach` → `worker-start`（中间无 detach） | SW 真的被回收了。按第二节，这只该发生在 attach 之前/之后，或崩溃与扩展更新时 |
| `attach` → `detach … canceled_by_user` | 有人点了横幅按钮 |
| `attach` → `detach … target_closed` | 标签页关闭或 renderer 崩溃 |
| `attach` → `detach … released by the extension (no holder left)` | 我们自己的引用计数归零（截图完成、解绑、关掉调试开关） |
| 反复 `attach` / `detach` 交替 | `syncDevtoolsPriming` 与绑定状态在打架（第四节第 2 条），也就是"横幅反复闪"的形态 |

## 六、还没证实的假设（不要当结论用）

- **标签页内导航是否会让 Chrome 断开附加**：`DevToolsAgentHost` 是按 WebContents 建立的，跨文档导航通常保持；Chromium 的 detach 代码里也没有把导航列为独立原因。**2026-09-29 的实测日志部分回答了它**：多次出现 `attach` 之后 3–6 ms 就 `detach … detached by Chrome: target_closed`，即附加成功后的毫秒级内 target 被关闭。那段日志里同时有大量导航与标签页操作，**尚不能断定**是哪一种，但它证明"attach 成功"不等于会话稳定；而且 `target_closed` 是 Chrome 主动断开（我们自己的释放会记成 `released by the extension`），两者在日志里可以区分。
- **`tabAffinity.observeTab()` 在 `tabs.onUpdated` 中更新映射时，是否会短暂把标签页移出 `sessionMap()`**，从而让预热同步误 detach 一个刚建立的会话。这需要日志或针对性测试确认——如果成立，它正好解释"绑定后几秒横幅消失"。
- `MAX_PRIMED_TABS = 3` 只对同时绑定多个标签页的场景有影响，单会话（当前设计）不受影响。

## 参考

- [扩展 service worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Longer extension service worker lifetimes（Chrome 110 变更）](https://developer.chrome.com/blog/longer-esw-lifetimes)
- [`chrome/browser/extensions/api/debugger/debugger_api.cc`](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/debugger_api.cc)
- [`extension_dev_tools_infobar_delegate.h`](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/extension_dev_tools_infobar_delegate.h)
- [`extensions/browser/activity.h`](https://chromium.googlesource.com/chromium/src/+/main/extensions/browser/activity.h)
- [chrome.alarms（最小周期 30 秒）](https://developer.chrome.com/docs/extensions/reference/api/alarms)
