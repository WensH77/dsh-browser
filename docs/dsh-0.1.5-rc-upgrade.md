# 升级记录：运行时与依赖对齐到 dsh 0.1.5-rc.1

> 日期：2026-09-10 · 分支：`refactor/pure-tool-bridge`
> 前置：[升级记录：对齐到 0.1.5-alpha.1](dsh-0.1.5-alpha-upgrade.md)
> 结论：插件与 harness `0.1.5-rc.1` **兼容**；依赖从 `0.1.5-alpha.1` 全线上调，并顺手修掉了仓库根 `pnpm start` 长期存在的 peer 解析缺陷。

## 背景

npm 上 `@deepseek-ai/dsh` 的 `latest` 已从 `0.1.5-alpha.1` 切到 `0.1.5-rc.1`（本机全局
`/opt/homebrew/bin/dsh` 与运行中的 GUI harness 均已是 rc.1，`alpha` tag 停在
`0.1.5-alpha.2`）。仓库的 peerDeps / devDeps / 根 CLI 仍 pin 在 `0.1.5-alpha.1`，
需要核实兼容性并对齐。

## 兼容性检查结论

| 层面 | 结论 |
|---|---|
| 类型/API | ✅ 兼容：6 个 `src/*.ts` 对 0.1.5-rc.1 类型定义做 `tsc`，0 错误 |
| 运行时 | ✅ 兼容：隔离 `$DSH_HOME` + 全新 `web` profile，`/ext/bridge-config` 返回 200 |
| 测试 | ✅ 插件 63/63、扩展 116/116 |
| 构建 | ✅ 插件（tsc + tsdown）与扩展（vite ×4）全绿 |
| 版本声明 | ⚠️ 偏差：peerDeps/root CLI 仍写 `0.1.5-alpha.1`，语义上不含 `0.1.5-rc.1` |

## 改动清单

- `package.json`（根）：devDep `@deepseek-ai/dsh` `0.1.5-alpha.1` → `0.1.5-rc.1`
- `packages/browser/bridge-browser/package.json`：
  - peerDeps：dsh-* `^0.1.5-alpha.1` → `^0.1.5-rc.1`（cordis `^4.0.2` 已是最新，未动）
  - devDeps：dsh-* `0.1.5-alpha.1` → `0.1.5-rc.1`；cordis 系 `4.0.2 / 1.0.7 / 1.0.3` 已是最新，未动
  - 同线范围内的 patch 顺带上调：`@deepseek-ai/schemastery` `^3.18.1` → `^3.18.2`，
    `ws` `^8.21.0` → `^8.21.3`，`@types/node` `^22.20.0` → `^22.20.2`
  - 根 devDeps 补齐 21 个缺失 peer（见下节）
- `pnpm-lock.yaml`：重新解析（lockfile 中已无 0.1.2 及更早版本线的 `@deepseek-ai/*` 实例）
- `README.md` / `README.zh.md`、`extensions/dsh-browser/README*.md`、
  `packages/browser/bridge-browser/README*.md`、`cordis.patch.yml`、
  `scripts/install.sh` / `install.ps1`：版本提示统一到 `0.1.5-rc.1`
- `docs/pure-tool-bridge-decisions.md`：追加 2026-09-10 版本线决策

## 过程中发现并修复的问题：根 workspace 的 peer 解析缺陷

用隔离 `$DSH_HOME` 跑本仓库自带的 `pnpm start`（本地 dsh）时启动失败：

```
SyntaxError: The requested module '@deepseek-ai/dsh-llm' does not provide an
export named 'assertNever'
  ← @deepseek-ai/dsh-sandbox@0.1.0-rc.7
```

根因与 0.1.5-alpha.1 那次同源：仓库 `.npmrc` 设了 `auto-install-peers=false`，
根 devDep `@deepseek-ai/dsh` 的依赖闭包里有一批 peer（`dsh-fs`、`dsh-sandbox`、
`dsh-workflow`、`dsh-jobs` …）没有被显式声明，pnpm 便复用 lockfile 里
`0.1.0-rc.7 / 0.1.1-rc.1 / 0.1.2-rc.1` 的旧实例；这些旧实例从已升级的 `dsh-llm`
请求被移除的导出。`pnpm peers check` 报 21 个 unmet peer（22 处）。

**先用 `git worktree` 在升级前的 `HEAD` 上复现了同样的失败**，确认这是既有缺陷，
不是本次升级引入。

修复：把这 21 个缺失 peer 在根 `package.json` 显式声明为 devDependencies
（dsh-* 统一 `0.1.5-rc.1`，`cordis-plugin-group` 取 `1.0.2`）。修复后
`pnpm peers check` 显示 “No peer dependency issues found”，本地 `pnpm start`
冒烟返回 200。做法与 0.1.5-alpha.1 升级时为插件补 peer 一致——`link:` 安装会绕过
peer 解析，`auto-install-peers=false` 下必须显式声明。

## 回归结果（全绿）

| 项 | 结果 |
|---|---|
| 插件 typecheck（`tsc -b`） | ✅ |
| 扩展 typecheck | ✅ |
| 插件 build（tsc + tsdown） | ✅ |
| 扩展 build（vite ×4） | ✅ |
| 插件测试 | ✅ 63/63（7 files，含真实 Loader 组合 composition.spec） |
| 扩展测试 | ✅ 116/116（20 files） |
| `pnpm peers check` | ✅ No peer dependency issues found |
| 启动冒烟（本地 dsh） | ✅ 隔离 `$DSH_HOME` + 全新 `web` profile，`/ext/bridge-config` 返回 `{"wsUrl":"ws://127.0.0.1:3181/ext/bridge"}` |
| 启动冒烟（全局 dsh 0.1.5-rc.1） | ✅ 同上，返回 200 |

## 遗留与后续

- peer 范围 `^0.1.5-rc.1` 在 semver 上已覆盖 `0.1.5` 稳定版，正式 tag 发布后只需把
  pin 字面量从 `0.1.5-rc.1` 改为 `0.1.5`，无需再动范围语义。
- `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 被 pnpm 自动追加了一条
  `@types/node@22.20.2`（该版本发布未满供应链策略的静默期）；保留它以免后续
  `pnpm install` 被策略拦截。
- 若将来以 registry 分发插件，peer 全集仍需按目标 harness 复核；根 devDeps 这批
  peer 只是本地开发用的补齐，不属于插件对外声明。
