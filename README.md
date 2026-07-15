# Piex — Pi Extensions

基于 [Pi](https://pi.dev) Extension API 构建的功能拓展集合，从 oh-my-pi、Claude Code、OpenCode 等优秀 coding agent 中提取核心功能特性，以独立 piex package 形式分发。

## 安装

三种安装方式，按场景选用。

### 方式一：本地路径安装（推荐，开发阶段）

直接从本地 monorepo 安装，改动即时生效，无需发布。

```bash
cd /path/to/piex

# hashline 依赖 @oh-my-pi/hashline，需要先装 npm 依赖
cd packages/hashline && npm install && cd -

# 方式 A：安装到全局 settings，必须传绝对路径（否则 /reload 后路径失效）
pi install /abspath-to-piex/packages/hashline
pi install /abspath-to-piex/packages/dap
pi install /abspath-to-piex/packages/lsp
pi install /abspath-to-piex/packages/plan
pi install /abspath-to-piex/packages/theme-dark-terminal
pi install /abspath-to-piex/packages/review
pi install /abspath-to-piex/packages/xai-oauth

# 方式 B：安装到项目级 .pi/settings.json，可用相对路径，团队共享
pi install -l ./packages/hashline
pi install -l ./packages/dap
pi install -l ./packages/lsp
pi install -l ./packages/plan
pi install -l ./packages/theme-dark-terminal
pi install -l ./packages/review
pi install -l ./packages/xai-oauth
```

> **注意：** 默认 `pi install` 写入全局 `~/.pi/agent/settings.json`，但传入相对路径时 pi 会按 settings 文件位置解析。因此全局安装本地包必须用绝对路径；想写相对路径请用 `-l` 安装到项目级 `.pi/settings.json`。

### 方式二：npm 安装（发布后）

各 package publish 到 npm 后，通过包名安装。

```bash
pi install npm:@piex-dev/hashline   # hashline 编辑
pi install npm:@piex-dev/dap        # DAP 调试
pi install npm:@piex-dev/lsp        # LSP 语言服务器
pi install npm:@piex-dev/plan       # 计划模式
pi install npm:@piex-dev/review     # 代码评审
pi install npm:@piex-dev/xai-oauth  # xAI OAuth 订阅登录
pi install npm:@piex-dev/theme-dark-terminal   # 暗终端主题
```

### 方式三：单次测试（不持久化）

通过 `-e` 临时加载，不写入 settings.json，适合快速验证。

```bash
# 测试单个扩展
pi -e ./packages/plan/extensions/plan.ts

# 测试全部加载
for pkg in hashline dap lsp plan review xai-oauth; do
  pi -e ./packages/$pkg/extensions/*.ts -p "1+1" --no-session
done
```

## Package 总览

| Package | 工具 | 来源 | 行数 |
|---------|------|------|------|
| hashline | 覆盖 `edit`（hashline 语法） | oh-my-pi | 318 |
| dap | `debug`（14 个 adapter） | oh-my-pi | 2154 |
| lsp | `lsp`（11 个 server） | oh-my-pi | 1069 |
| plan | `/plan`, `/todos` | pi 示例 | 348 |
| review | `/review`, `review` 工具 | oh-my-pi | 330 |
| xai-oauth | `/login` xAI Grok OAuth 订阅登录 | oh-my-pi | 580 |
| theme-dark-terminal | 暗终端高对比度主题 | [opencode-themes](https://github.com/debugtalk/opencode-themes) | — |

各 package 详细文档见对应目录下的 `README.md`。

## 文档

| 文档 | 说明 |
|------|------|
| [设计理念](docs/design.md) | 核心原则与架构模式 |
| [架构概览](docs/architecture.md) | 项目结构、工具注册、API 映射 |
| [实施路线](docs/roadmap.md) | 已完成 & 待规划 |
| [评测方案](docs/evaluation.md) | 评测集选择、Docker 架构、指标设计、实施路径 |
| [测试指南](docs/testing.md) | package 快速测试与功能验证命令 |
| [参考资料](docs/references.md) | pi 文档、来源项目索引 |

## 开发

```bash
# 安装依赖（hashline 需要）
cd packages/hashline && npm install

# 查看已安装的 packages
pi list

# 移除 package（全局安装用绝对路径，项目级安装用 -l）
pi remove /abspath-to-piex/packages/hashline
pi remove -l ./packages/hashline
```

## License

MIT
