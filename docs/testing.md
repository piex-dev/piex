# 测试指南

## 快速测试

每个 package 可通过 `pi -e` 单独测试：

```bash
cd piex

# 加载测试（验证扩展不报错）
pi -e ./extensions/hashline/src/hashline.ts -p "what is 1+1" --no-session
pi -e ./extensions/dap/src/dap.ts       -p "what is 1+1" --no-session
pi -e ./extensions/lsp/src/lsp.ts       -p "what is 1+1" --no-session
pi -e ./extensions/plan/src/plan.ts     -p "what is 1+1" --no-session
pi -e ./extensions/review/src/review.ts  -p "what is 1+1" --no-session
pi -e ./extensions/xai-oauth/src/xai-oauth.ts -p "what is 1+1" --no-session

# init 为 prompt 包（无 extensions），用 --prompt-template 或 install 后测
pi --prompt-template ./prompts/init/init.md -p "/init" --no-session

# 单元测试（不依赖真实外部服务）
bun test extensions/xai-oauth/test/xai-oauth.test.ts extensions/xai-oauth/test/models.test.ts
cd extensions/lsp && npm install && bun test   # mock LSP server
```

## 功能测试

### hashline

```bash
# 创建测试文件
echo -e 'hello world\nline 2\nline 3' > /tmp/test.txt

# 测试 read → edit 工作流
pi -e ./extensions/hashline/src/hashline.ts \
  -p "1. Read /tmp/test.txt 2. Use edit tool to replace 'hello world' with 'hi piex' using hashline SWAP syntax with [PATH#TAG]" \
  --no-session -nc

# 验证结果
cat /tmp/test.txt
```

### dap

```bash
# 列出 debug sessions
pi -e ./extensions/dap/src/dap.ts \
  -p "Use the debug tool with action=sessions" --no-session

# 启动调试（需要安装 debug adapter）
pi -e ./extensions/dap/src/dap.ts \
  -p "Use the debug tool: action=launch, program=script.py, adapter=debugpy, timeout=5" --no-session
```

### lsp

```bash
# 单元测试（推荐，无需安装 language server）
cd extensions/lsp && npm install && bun test

# 查看 LSP 状态（按项目 rootMarkers 列出默认 server）
pi -e ./extensions/lsp/src/lsp.ts \
  -p "Call the lsp tool with action=status and show the output" --no-session

# 诊断 / 导航 / 重构（需要本机已装对应 server，如 typescript-language-server、pyright）
pi -e ./extensions/lsp/src/lsp.ts \
  -p "Use lsp action=diagnostics file=src/index.ts" --no-session

pi -e ./extensions/lsp/src/lsp.ts \
  -p "Use lsp action=rename file=src/a.ts line=1 column=1 new_name=foo apply=false" --no-session

# 写后诊断：edit/write 成功后 tool 结果应附带 [lsp diagnostics] ERROR 块
# 关闭：PI_LSP_DIAGNOSTICS_ON_EDIT=0
```

### plan

```bash
# 交互式测试（需要 TUI 模式）
pi -e ./extensions/plan/src/plan.ts

# 进入后输入 /plan 切换计划模式
```

### review

```bash
# 测试 review 工具（无变更）
pi -e ./extensions/review/src/review.ts \
  -p "Use the review tool with action=diff" --no-session

# 交互式测试
pi -e ./extensions/review/src/review.ts
# 输入 /review 查看评审菜单
# 输入 /review 查看评审菜单
```

### init

```bash
# 本地加载 prompt（不写 settings）
pi --prompt-template ./prompts/init/init.md
# 交互输入 /init，或：
pi install -l prompts/init
pi -p "/init" --no-session   # 在目标项目目录执行，会创建/更新 AGENTS.md
```
## 环境要求

| Package | 运行时 | 额外工具 |
|---------|--------|---------|
| hashline | Node.js ≥ 18 或 Bun ≥ 1.3.14 | 无 |
| dap | Node.js ≥ 18 | debug adapter（如 debugpy, gdb） |
| lsp | Node.js ≥ 18；单测需 Bun | 可选：真实 LSP server（ts-ls、pyright…）；单测用 mock |
| plan | Node.js ≥ 18 | 无 |
| review | Node.js ≥ 18 | git |
| init | 任意（仅 prompt 资源） | 无 |
| xai-oauth | Node.js ≥ 18；单测需 Bun | 无（单测不联网） |

## Bun 测试

hashline 在 Bun 下使用原生 Bun API，无需 polyfill：

```bash
bun run pi -e ./extensions/hashline/src/hashline.ts -p "hi" --no-session
````
