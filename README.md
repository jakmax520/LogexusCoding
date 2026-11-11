# LogexusCoding

Logexus 的 AI Coding 引擎独立仓库。基座为 DeepSeek 开源的
[coding-harness](https://github.com/deepseek-ai/coding-harness)（dsh），
并在其上承载 Logexus 的白标定制。

## 目录

| 路径 | 说明 |
|------|------|
| `coding-harness/` | 引擎源码（上游基座 + Logexus 白标改动），后续任务在此目录工作 |
| `UPSTREAM.md` | 上游基线版本、11 处白标文件清单与同步方式 |

## 基线

`dsh-v0.1.2-alpha.1`（详见 [UPSTREAM.md](UPSTREAM.md)）。

## 开发

引擎自身的构建与开发说明见 `coding-harness/` 内的上游文档。
`coding-harness/.github/` 是上游自带的 CI 配置，仅在上游仓库中运行，不会从本仓库根目录执行。
本仓库自身的四平台构建与发布 CI 位于 `.github/workflows/release.yml`。
