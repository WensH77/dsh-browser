# 升级记录：运行时与依赖对齐到 dsh 0.1.7-rc.1

> 日期：2026-09-24 · 分支：`refactor/pure-tool-bridge`
> 前置：[升级记录：对齐到 0.1.5-rc.1](dsh-0.1.5-rc-upgrade.md)
> 结论：插件与 harness `0.1.7-rc.1` **兼容**；依赖从 `0.1.5-rc.1` 全线上调，其中
> `@deepseek-ai/dsh-code-runtime` 随上游改名为 `dsh-ptc-runtime`。

## 背景

npm 上 `@deepseek-ai/dsh` 的 dist-tags 是：

| tag | 版本 |
|---|---|
| `latest` | `0.1.5-rc.3` |
| `next` | `0.1.7-rc.1` |
| `alpha` | `0.1.7-alpha.2` |

本机全局 `/opt/homebrew/bin/dsh` 与运行中的 GUI 都已经是 `0.1.7-rc.1`（即 `next` 线），而仓库的
peerDeps / devDeps / 根 CLI 仍 pin 在 `0.1.5-rc.1`——且 `^0.1.5-rc.1` 在 semver 上**不含**
`0.1.7-rc.1`（prerelease 元组不同，加 `includePrerelease` 也仍为 false，已用 `semver` 实测）。
于是 `pnpm start` 与仓库内测试跑的是另一条版本线，与实际运行的 harness 不是同一个。

## 兼容性检查（改动之前先核实）

| 层面 | 结论 |
|---|---|
| 类型/API | ✅ 6 个 `src/*.ts` 对 0.1.7-rc.1 的 `.d.ts` 做 `tsc`，0 错误（用 `paths` 映射到全局安装的声明文件，`--traceResolution` 确认解析到 `0.1.7-rc.1` + `cordis@4.0.4`） |
| 运行时组合 | ✅ 先把插件依赖整体换成 0.1.7-rc.1 的包跑一遍：插件测试 109/109（含真实 Loader 组合用例：真 WebSocket hello、`/ext/bridge-config` 200、系统提示注入、dispose 注销工具） |
| 线上实例 | ✅ 正在运行的 GUI 就是 0.1.7-rc.1：插件 `/ext/bridge-config` 返回 200、`browser_*` 已注册、单会话守卫按预期拒绝第二个会话绑定 |
| API 面差异 | ✅ 破坏点都落在插件没用到的地方（见下节）；插件实际使用的端口未变 |
| 版本声明 | ⚠️ 偏差（本次修掉）：peerDeps/root CLI 写 `0.1.5-rc.1`，语义上不含实际运行的 `0.1.7-rc.1` |

## 上游在这一段里改了什么

与本插件有关的部分，逐项核对过：

- `dsh-tools`：新增 `ToolDefinition.projectContent`、`ToolExecution.schema`、`ToolErrorInfo.reason`，
  `tools/pre-execute` 增加 `cancel` 语义——全部是加法，插件用到的 `defineTool` / `ToolRunContext` /
  `tools.register` 未变。
- `dsh-attachment`：`ImageRequestPolicy` 改名 `ImageRequestTarget`，`readImageRequest` 第二参数语义改变——
  插件只用 `AttachmentId` / `ImageAttachmentRef` / `ImageMediaType` / `saveImage` / `imageLimits`，未受影响。
- `dsh-agent`：`agent/session-start` 事件被移除，`createAgent` 的公告顺序调整——插件未监听该事件。
- `dsh-workspace`：`archivedSessionIds` 仍是 getter，插件的 gdrive 保留策略继续可用。
- `cordis` `4.0.2 → 4.0.4`：只多了一个 `Volatile` 类型导出。
- `dsh-host-webserver`：`host` 在 **0.1.5-rc.1 就已经是 `.required()`**（`npm pack` 下载旧版对比确认），
  所以“启动时 `$.host missing required value`”这类报错不是本次升级引入的，它只出现在没给 host 的启动方式上。
- `dsh-code-runtime` → `dsh-ptc-runtime`：npm 上 `dsh-code-runtime` 停在 `0.1.5-rc.3`，0.1.6 起改名为
  `dsh-ptc-runtime`；根 `devDependencies` 里那条补 peer 的声明随之替换。

## 改动清单

- `package.json`（根）：21 个 `@deepseek-ai/dsh-*` `0.1.5-rc.1` → `0.1.7-rc.1`；`dsh-code-runtime` →
  `dsh-ptc-runtime@0.1.7-rc.1`；`@deepseek-ai/cordis-plugin-group` `1.0.2` → `1.0.4`
- `packages/browser/bridge-browser/package.json`：
  - peerDeps：dsh-* `^0.1.5-rc.1` → `^0.1.7-rc.1`；cordis `^4.0.2` → `^4.0.4`
  - devDeps：dsh-* → `0.1.7-rc.1`；cordis `4.0.2` → `4.0.4`、include `1.0.7` → `1.0.9`、
    loader `1.0.3` → `1.0.5`（对齐 0.1.7 实际使用的版本）
  - dependencies：`@deepseek-ai/schemastery` `^3.18.2` → `^3.18.4`
- `pnpm-lock.yaml`：重新解析
- 版本提示统一到 `0.1.7-rc.1`：`README.md` / `README.zh.md`（pin 段落 + `npx` 命令行）、
  `extensions/dsh-browser/README{,.zh}.md`、`packages/browser/bridge-browser/README{,.zh}.md`、
  `packages/browser/bridge-browser/cordis.patch.yml` 注释、`scripts/install.sh` / `install.ps1`

## 回归结果（全绿）

| 项 | 结果 |
|---|---|
| 插件 typecheck（`tsc -b`） | ✅ |
| 插件测试 | ✅ 109/109（8 files，含真实 Loader 组合用例） |
| 扩展 typecheck | ✅ |
| 扩展测试 | ✅ 373/373（47 files，含本次新增的重叠 mock 与后台入口同意门用例） |
| 插件 build（tsc + tsdown） | ✅ |
| 扩展 build（vite ×4） | ✅ |
| `pnpm peers check` | ✅ No peer dependency issues found |
| `pnpm install --frozen-lockfile` | ✅ 与 lockfile 一致 |
| 启动冒烟（仓库内 0.1.7-rc.1 CLI） | ✅ 隔离 `DSH_HOME=/tmp/dsh-017-smoke` + 全新 `web` profile，`dsh web --no-open --port 3971` → `/ext/bridge-config` 返回 `{"wsUrl":"ws://127.0.0.1:3971/ext/bridge"}`，并按预期生成 `ext-bridge-token` |

## 遗留

- peer 范围 `^0.1.7-rc.1` 在 semver 上覆盖 `0.1.7` 正式版（同元组 prerelease 规则），但**不含**
  `0.1.5` 线：npm `latest` 仍指 `0.1.5-rc.3`，用 `latest` 装的 harness 会落在范围外。本包是 `private`
  且以 `link:` 安装，声明不参与解析，所以眼下不影响运行；若要一次覆盖两条线，需放宽成
  `>=0.1.5-rc.1 <0.2.0`。这里沿用与前两次升级一致的「跟当前运行线」策略。
- `dsh-code-runtime` 已停止发布：若将来还要在 0.1.5 线跑本仓库，需把根 devDeps 里那条换回旧包名。
