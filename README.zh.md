# PieX — Pi Extensions

[English](./README.md)

**充分扩展 Pi，而非 fork。**

基于 [Pi](https://pi.dev) Extension API 构建的功能扩展集合，从 oh-my-pi、Claude Code、OpenCode 等优秀 coding agent 中提取核心能力，以独立 `@piex-dev/*` npm 包形式按需安装。

## 为什么选 PieX？

- **充分扩展，而非 fork**：oh-my-pi（omp）fork 了 pi 内核并全量内置；PieX 只走官方 Extension API，不碰内核，随 pi 升级而升级。
- **按需扩展，自由切换**：包相互独立、即装即卸；克制可控，只为用到的能力付出 token。
- **知其所以然**：取百家之长，借鉴主流 agent 的优秀设计，搞懂底层原理再以扩展引入，每个功能自己选择、自己理解、自己掌控。
- **评测优先**：影响 agent 行为的扩展都有评测标准与数据支撑（见[评测方案](docs/evaluation.md)）；无法度量效果，就不引入。

完整论述见[设计理念](docs/design.md)。

## 安装

```bash
# 一键安装全部
curl -fsSL https://piex.dev/scripts/install.sh | bash          # 全局安装
curl -fsSL https://piex.dev/scripts/install.sh | bash -s -- -l  # 项目级安装

# 逐包安装
pi install npm:@piex-dev/hashline

# 本地开发（在 piex 仓库根目录执行）
cd extensions/hashline && npm install && cd ../..   # 仅 hashline 需先 npm install
pi install extensions/hashline                       # 全局
pi install -l extensions/hashline                    # 项目级

# 临时加载（不写 settings）
pi -e ./extensions/hashline/src/hashline.ts
```

## Package 总览

### 扩展

| Package     | npm                  | 说明                                                                                       |
| ----------- | -------------------- | ------------------------------------------------------------------------------------------ |
| hashline    | `@piex-dev/hashline` | Hashline 补丁语言 — 紧凑、行锚定、标签验证的文件编辑                                         |
| dap         | `@piex-dev/dap`      | 调试适配器协议 — 14 个 debug adapter，在 Pi 中直接调试程序                                   |
| lsp         | `@piex-dev/lsp`      | 语言服务器协议 — 诊断、导航、重命名、代码操作、格式化（50+ 服务器）                            |
| plan        | `@piex-dev/plan`     | Plan 模式 — 只读探索、方案创建和分步执行                                                     |
| review      | `@piex-dev/review`   | 代码审查 — 交互式 `/review` 命令和 LLM 可调用的 review 工具                                  |
| xai-oauth   | `@piex-dev/xai-oauth`| xAI Grok OAuth 登录 — 用 SuperGrok 或 X Premium+ 替代 API Key                               |
| btw         | `@piex-dev/btw`      | 旁路提问 — 携带会话上下文的临时提问，带外回答不污染对话                                       |
| context     | `@piex-dev/context`  | 上下文用量报告 — `/context` 命令展示 token 用量分布                                          |
| goal        | `@piex-dev/goal`     | 自主目标完成 — `/goal` 命令，支持 token 预算收尾和阻塞上报                                    |

### 提示词

| Package | npm              | 说明                                                    |
| ------- | ---------------- | ------------------------------------------------------- |
| init    | `@piex-dev/init` | 引导式 AGENTS.md 设置 — 扫描仓库并创建或改进项目 agent 规则 |

### 主题

| Package     | npm                          | 说明                                                     |
| ----------- | ---------------------------- | -------------------------------------------------------- |
| dark-terminal | `@piex-dev/theme-dark-terminal` | 高对比度终端风格暗色主题，绿色、蓝色、红色高亮            |

> **ai-code-report**（`@piex-dev/ai-code-report`）为 private 包 — AI 代码编辑埋点上报，依赖内部 registry，不公开发布。

## 文档

| 文档                             | 内容                                        |
| -------------------------------- | ------------------------------------------- |
| [设计理念](docs/design.md)       | 背景动机、核心设计理念与架构模式            |
| [架构概览](docs/architecture.md) | 项目结构、工具注册、API 映射                |
| [实施路线](docs/roadmap.md)      | 已完成 & 待规划                             |
| [评测方案](docs/evaluation.md)   | 评测集选择、Docker 架构、指标设计、实施路径 |
| [测试指南](docs/testing.md)      | 逐包冒烟测试与功能验证命令                  |
| [参考资料](docs/references.md)   | Pi 文档、上游项目索引                       |

## 开发

```bash
# 安装依赖（仅 hashline 需要）
cd extensions/hashline && npm install

# 查看已安装的 packages
pi list

# 移除 package
pi remove /path/to/piex/extensions/hashline      # 全局
pi remove -l ./extensions/hashline                # 项目级
```

## License

MIT
