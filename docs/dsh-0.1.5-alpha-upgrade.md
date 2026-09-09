# 升级记录：运行时与依赖对齐到 dsh 0.1.5-alpha.1

> 日期：2026-09-09 · 分支：`refactor/pure-tool-bridge`
> 结论：插件与当前 harness（0.1.5-alpha.1）**兼容**，仓库依赖已从 `0.1.2-rc.1` 全线升级并回归通过。

## 背景

本仓库桥插件（`@yuxianglin/dsh-bridge-browser`）的依赖长期 pin 在 dsh `0.1.2-rc.1`
（peerDeps / devDeps / 根 CLI 统一此线），而实际运行的 harness（本机 GUI 与
`/opt/homebrew` 全局安装）已是 `0.1.5-alpha.1`。需要核实插件与当前 harness
的兼容性，并决定依赖是否对齐。

## 兼容性检查结论

| 层面 | 结论 |
|---|---|
| 类型/API | ✅ 兼容：6 个 `src/*.ts` 全部对 0.1.5-alpha.1 类型定义做 `tsc` 编译，0 错误 |
| 运行时 | ✅ 兼容：插件经 `web` profile link 加载，0.1.5-alpha.1 上 `/ext/bridge-config` 返回 200，`browser_*` 工具与 systemPrompt 段落均已注册 |
| 构建 | ✅ lib 与最新 src 一致（重建 diff 为空） |
| 版本声明 | ⚠️ 偏差：peerDeps `^0.1.2-rc.1` 严格语义不含 `0.1.5-alpha.1`（prerelease 元组不同） |

## 决策

把仓库运行时与插件依赖统一升级到 dsh `0.1.5-alpha.1` 线，并同步相关文档/脚本中的版本引用。

## 改动清单

- `package.json`（根）：devDep `@deepseek-ai/dsh` `0.1.2-rc.1` → `0.1.5-alpha.1`
- `packages/browser/bridge-browser/package.json`：
  - peerDeps：cordis `^4.0.1` → `^4.0.2`；dsh-* `^0.1.2-rc.1` → `^0.1.5-alpha.1`
  - devDeps：cordis `4.0.1` → `4.0.2`；cordis-plugin-include/loader `1.0.6/1.0.2` → `1.0.7/1.0.3`；dsh-* `0.1.2-rc.1` → `0.1.5-alpha.1`
  - devDeps 新增 peer 补齐：`dsh-brand`、`dsh-scope`、`dsh-session-persistence`、`dsh-session-projection`、`dsh-util-values`、`dsh-typert-protocol`、`dsh-settings`（均为 0.1.5-alpha.1）
- `pnpm-lock.yaml`：全量重新解析
- `README.zh.md` / `README.md`、`scripts/install.sh` / `install.ps1`：同步精确版本提示

## 过程中发现并修复的问题

升级后插件测试曾失败：

```
tests/composition.spec.ts → '@deepseek-ai/dsh-session' does not provide an export named 'snapshotJsonValue'
```

根因：仓库 `.npmrc` 设了 `auto-install-peers=false`，而 `dsh-agent-loop@0.1.5-alpha.1`
等运行时 import 的 peer 包（`dsh-session-persistence` 等）未在桥插件 devDeps 显式声明，
pnpm 复用了旧 lockfile 里的 `0.1.1-rc.1` 实例；该旧版从已升级的
`dsh-session@0.1.5-alpha.1` 请求被移除的导出。

修复：把这些缺失 peer 显式补齐到 `0.1.5-alpha.1`（见改动清单）。这也是
「以 registry 方式分发前必须补全 peers」的实际教训——`link:` 安装会绕过 peer 解析。

## 回归结果（全绿）

| 项 | 结果 |
|---|---|
| 插件 typecheck（`tsc -b`） | ✅ |
| 扩展 typecheck | ✅ |
| 插件 build（tsc + tsdown） | ✅ |
| 扩展 build（vite ×4） | ✅ |
| 插件测试 | ✅ 63/63（7 files，含真实 Loader 组合 composition.spec） |
| 扩展测试 | ✅ 116/116（20 files） |
| 启动冒烟 | ✅ 隔离 `$DSH_HOME` + 全新 `web` profile（dsh-base / dsh-web-app / 桥插件），`/ext/bridge-config` 返回 `{"wsUrl":"ws://127.0.0.1:3180/ext/bridge"}` |

## 遗留与后续

- 运行中的 GUI harness 启动于升级前，仍使用旧依赖副本；**下次重启 dsh 后**应再点一次真实浏览器工具做端到端确认。
- 后续每次升级 harness（alpha 期间 API 可能漂移）后，重跑：根 `pnpm run typecheck` → 启动 → `/ext/bridge-config` 200 → 一次真实浏览器工具调用。
- 若将来以 registry 分发插件，peer 范围需覆盖目标 harness 的版本线（当前 `^0.1.5-alpha.1`）。
