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
本仓库的构建脚本与 CI 将在后续任务中补充。
