# Pie — Pi Extensions

基于 [Pi](https://pi.dev) Extension API 构建的功能拓展集合，从 oh-my-pi、Claude Code、OpenCode 等优秀 coding agent 中提取核心功能特性，以独立 pi package 形式分发。

## 安装

三种安装方式，按场景选用。

### 方式一：本地路径安装（推荐，开发阶段）

直接从本地 monorepo 安装，改动即时生效，无需发布。

```bash
cd /path/to/pie

# pie-hashline 依赖 @oh-my-pi/hashline，需要先装 npm 依赖
cd packages/pie-hashline && npm install && cd -

# 逐个安装（相对路径）
pi install ./packages/pie-hashline
pi install ./packages/pie-dap
pi install ./packages/pie-lsp
pi install ./packages/pie-plan
pi install ./packages/pie-review

# 或用绝对路径
pi install /absolute/path/to/pie/packages/pie-hashline
# ... 其余同理
```

安装后写入 `~/.pi/agent/settings.json`，每次启动 pi 自动加载。加 `-l` 参数可安装到项目级 `.pi/settings.json`（团队共享）。

> **注意：** 其余 4 个 package（pie-dap / pie-lsp / pie-plan / pie-review）只有 peerDependencies，pi 自带这些依赖，无需额外安装。

### 方式二：npm 安装（发布后）

各 package publish 到 npm 后，通过包名安装。

```bash
pi install npm:@debugtalk/pie-hashline   # hashline 编辑
pi install npm:@debugtalk/pie-dap        # DAP 调试
pi install npm:@debugtalk/pie-lsp        # LSP 语言服务器
pi install npm:@debugtalk/pie-plan       # 计划模式
pi install npm:@debugtalk/pie-review     # 代码评审
```

### 方式三：单次测试（不持久化）

通过 `-e` 临时加载，不写入 settings.json，适合快速验证。

```bash
# 测试单个扩展
pi -e ./packages/pie-plan/extensions/plan.ts

# 测试全部加载
for pkg in pie-hashline pie-dap pie-lsp pie-plan pie-review; do
  pi -e ./packages/$pkg/extensions/*.ts -p "1+1" --no-session
done
```

## Package 总览

| Package | 工具 | 来源 | 行数 |
|---------|------|------|------|
| pie-hashline | 覆盖 `edit`（hashline 语法） | oh-my-pi | 318 |
| pie-dap | `debug`（14 个 adapter） | oh-my-pi | 2154 |
| pie-lsp | `lsp`（11 个 server） | oh-my-pi | 1069 |
| pie-plan | `/plan`, `/todos` | pi 示例 | 348 |
| pie-review | `/review`, `review` 工具 | oh-my-pi | 330 |

各 package 详细文档见对应目录下的 `README.md`。

## 文档

| 文档 | 说明 |
|------|------|
| [设计理念](docs/design.md) | 核心原则与架构模式 |
| [架构概览](docs/architecture.md) | 项目结构、工具注册、API 映射 |
| [实施路线](docs/roadmap.md) | 已完成 & 待规划 |
| [测试指南](docs/testing.md) | 快速测试与功能测试 |
| [参考资料](docs/references.md) | pi 文档、来源项目索引 |

## 开发

```bash
# 安装依赖（pie-hashline 需要）
cd packages/pie-hashline && npm install

# 查看已安装的 packages
pi list

# 移除 package
pi remove ./packages/pie-hashline
```

## License

MIT
