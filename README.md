# PieX — Pi Extensions

基于 [Pi](https://pi.dev) Extension API 构建的功能拓展集合，从 oh-my-pi、Claude Code、OpenCode 等优秀 coding agent 中提取核心功能特性，以独立 piex package 形式分发。

## Why PieX？

- **充分拓展，而非 fork**：omp 选择 fork + 全量内置；PieX 只做官方扩展，100% 基于 pi Extension API，不碰内核，随 pi 升级而升级。
- **按需拓展，自由切换**：扩展相互独立、即装即卸；克制可控，只为用到的能力付出 token。
- **知其所以然**：取百家之长，借鉴主流 agent 的优秀设计，搞懂底层原理再以扩展引入；每个功能自己选择、自己理解、自己掌控。
- **评测优先**：影响 agent 行为的扩展都有评测标准与数据支撑（见 [评测方案](docs/evaluation.md)）；无法度量效果，就不引入。

完整论述见 [设计理念](docs/design.md)。

## 安装

包名见下方 [Package 总览](#package-总览)（npm 包为 `@piex-dev/<name>`）。

### 一键安装全部

```bash
curl -fsSL https://piex.dev/scripts/install.sh | bash          # 全局安装
curl -fsSL https://piex.dev/scripts/install.sh | bash -s -- -l  # 项目级安装
```

仓库内开发可直接执行本地脚本：

```bash
bash docs/scripts/install.sh --dev        # 从本地 extensions/ prompts/ themes/ 安装
bash docs/scripts/install.sh --dev -l     # 项目级 + 本地路径
```

### 逐包安装

```bash
pi install npm:@piex-dev/hashline
```

### 本地路径（开发）

在 **piex 仓库根目录**执行；其它包将 `hashline` 换成对应目录即可。

```bash
cd /path/to/piex
cd extensions/hashline && npm install && cd ../..   # 仅 hashline 需先 npm install
pi install extensions/hashline                      # 全局 settings
pi install -l extensions/hashline                   # 项目 .pi/settings.json
```

### 临时加载（`-e`，不写 settings）

```bash
pi -e ./extensions/hashline/src/hashline.ts
```

主题包无 `extensions/*.ts`，请用 npm 或本地 `pi install`，见 [theme-dark-terminal](themes/dark-terminal/README.md)。

## Package 总览

| Package             | 工具                                                                        | 来源                                                            | 行数  |
| ------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- | ----- |
| hashline            | 覆盖 `edit`（hashline 语法）                                                | oh-my-pi                                                        | 318   |
| dap                 | `debug`（14 个 adapter）                                                    | oh-my-pi                                                        | 2154  |
| lsp                 | `lsp`（~50 server 默认；写后 ERROR；rename/code_actions；诊断 settle/pull） | oh-my-pi + OpenCode                                             | ~1750 |
| plan                | `/plan`, `/todos`, `plan_complete`/`plan_question` 工具，bash 词法白名单    | pi 示例 + pi-extensions                                         | ~1430 |
| review              | `/review`, `review` 工具                                                    | oh-my-pi                                                        | 330   |
| init                | `/init`（生成/改进 AGENTS.md）                                              | OpenCode                                                        | —     |
| xai-oauth           | `/login` xAI Grok OAuth 订阅登录（含实时模型发现）                          | oh-my-pi / pi-grok                                              | 949   |
| theme-dark-terminal | 暗终端高对比度主题                                                          | [opencode-themes](https://github.com/debugtalk/opencode-themes) | —     |
| btw                 | `/btw` 临时提问（旁路调用，不写入会话）                                     | oh-my-pi + pi-extensions                                        | ~720  |
| context             | `/context` 上下文用量报告                                                   | oh-my-pi                                                        | 160   |

各 package 详细文档见对应目录下的 `README.md`。

## 文档

| 文档                             | 说明                                        |
| -------------------------------- | ------------------------------------------- |
| [设计理念](docs/design.md)       | 背景动机、核心设计理念与架构模式            |
| [架构概览](docs/architecture.md) | 项目结构、工具注册、API 映射                |
| [实施路线](docs/roadmap.md)      | 已完成 &amp; 待规划                         |
| [评测方案](docs/evaluation.md)   | 评测集选择、Docker 架构、指标设计、实施路径 |
| [测试指南](docs/testing.md)      | package 快速测试与功能验证命令              |
| [参考资料](docs/references.md)   | pi 文档、来源项目索引                       |

## 开发

```bash
# 安装依赖（hashline 需要）
cd extensions/hashline && npm install

# 查看已安装的 packages
pi list

# 移除 package（全局安装用绝对路径，项目级安装用 -l）
pi remove /abspath-to-piex/extensions/hashline
pi remove -l ./extensions/hashline
```

## License

MIT
