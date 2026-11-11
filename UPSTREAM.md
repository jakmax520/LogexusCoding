# 上游基线与白标清单

本仓库的 `coding-harness/` 是 [deepseek-ai/coding-harness](https://github.com/deepseek-ai/coding-harness)
（dsh）的源码基座，并在其上叠加 Logexus 白标定制。

## 基线

| 项 | 值 |
|----|----|
| 上游仓库 | `https://github.com/deepseek-ai/coding-harness` |
| 基线版本 | `dsh-v0.1.2-alpha.1` |
| 根包名 / 版本 | `@deepseek-ai/dsh-root` / `0.1.2-alpha.1` |
| License | MIT（见 `coding-harness/LICENSE`） |
| 导入日期 | 2026-11-11 |
| 导入来源 | `Logexus/products/tauri-app/vendor/coding-harness`（Logexus 主仓库的 vendored 副本） |

导入时排除的内容：`node_modules`、`.git`、`packages/*/lib`、`apps/*/lib`、
`apps/web/dist`、`*.tsbuildinfo`，以及本地工具状态目录 `.omc`。
`coding-harness/` 内的上游 `.gitignore`、`.github/`、`.gitlab-ci.yml` 保持原样。

## 白标文件清单（11 处）

以下为相对 `coding-harness/` 的路径，是 Logexus 相对上游的全部定制面。
每次同步上游后，必须逐项复核并回归：

1. `packages/extensions/logexus-config/src/index.ts`
2. `packages/extensions/logexus-config/package.json`
3. `packages/llm/llm-deepseek/src/index.ts`
4. `packages/bundle/web-app/cordis.patch.yml`
5. `packages/client/ui-theme/src/client/index.ts`
6. `packages/client/locale/src/client/index.ts`
7. `packages/client/ui-layout/src/client/AppFrame.tsx`
8. `packages/client/ui-conversation/src/client/locales.ts`
9. `packages/client/ui-settings-models/src/client/DeepSeekOnboardingDialog.tsx`
10. `packages/client/ui-settings-models/src/client/WelcomeNotice.tsx`
11. `packages/client/ui-sidebar/src/client/SidebarRoot.tsx`

## 上游同步方式

上游为开发者预览版，存在破坏性变更，**不做盲目 rebase**。沿用 Logexus 既有的
**git 三方合并**方式同步，以保留白标改动：

1. 将上游仓库添加为 remote，并拉取目标 tag，例如：
   `git remote add upstream https://github.com/deepseek-ai/coding-harness`
   然后 `git fetch upstream --tags`。
2. 以「上次同步的基线」为 base、「本仓库当前 `coding-harness/` 定制」为 ours、
   「新上游 tag」为 theirs 做三方合并。
3. 合并后按上方 11 项白标清单逐项复核并回归；上游重构可能导致白标无法自动
   套用（如 `dsh-v0.1.2-alpha.1` 的 `LocaleKeysOf` / `ClientRemote` 类型变更），
   此时需在新基线上重新套用白标。
4. 更新本文件的「基线版本」，并在提交信息中注明目标 tag。

### 历史同步记录

| 从 | 到 | 方式 | 备注 |
|----|----|------|------|
| `dsh-v0.1.1-rc.2` | `dsh-v0.1.2-alpha.1` | git 三方合并（base / ours / theirs） | alpha.1 重构后白标在新基线上重套 |
