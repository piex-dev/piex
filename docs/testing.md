# 测试指南

## 快速测试

每个 package 可通过 `pi -e` 单独测试：

```bash
cd piex

# 加载测试（验证扩展不报错）
pi -e ./packages/hashline/extensions/hashline.ts -p "what is 1+1" --no-session
pi -e ./packages/dap/extensions/dap.ts       -p "what is 1+1" --no-session
pi -e ./packages/lsp/extensions/lsp.ts       -p "what is 1+1" --no-session
pi -e ./packages/plan/extensions/plan.ts     -p "what is 1+1" --no-session
pi -e ./packages/review/extensions/review.ts  -p "what is 1+1" --no-session
```

## 功能测试

### hashline

```bash
# 创建测试文件
echo -e 'hello world\nline 2\nline 3' > /tmp/test.txt

# 测试 read → edit 工作流
pi -e ./packages/hashline/extensions/hashline.ts \
  -p "1. Read /tmp/test.txt 2. Use edit tool to replace 'hello world' with 'hi piex' using hashline SWAP syntax with [PATH#TAG]" \
  --no-session -nc

# 验证结果
cat /tmp/test.txt
```

### dap

```bash
# 列出 debug sessions
pi -e ./packages/dap/extensions/dap.ts \
  -p "Use the debug tool with action=sessions" --no-session

# 启动调试（需要安装 debug adapter）
pi -e ./packages/dap/extensions/dap.ts \
  -p "Use the debug tool: action=launch, program=script.py, adapter=debugpy, timeout=5" --no-session
```

### lsp

```bash
# 查看 LSP 状态
pi -e ./packages/lsp/extensions/lsp.ts \
  -p "Use the lsp tool with action=status" --no-session

# 获取诊断（需要对应的 LSP server）
pi -e ./packages/lsp/extensions/lsp.ts \
  -p "Use the lsp tool with action=diagnostics, file=README.md" --no-session
```

### plan

```bash
# 交互式测试（需要 TUI 模式）
pi -e ./packages/plan/extensions/plan.ts

# 进入后输入 /plan 切换计划模式
```

### review

```bash
# 测试 review 工具（无变更）
pi -e ./packages/review/extensions/review.ts \
  -p "Use the review tool with action=diff" --no-session

# 交互式测试
pi -e ./packages/review/extensions/review.ts
# 输入 /review 查看评审菜单
```

## 环境要求

| Package | 运行时 | 额外工具 |
|---------|--------|---------|
| hashline | Node.js ≥ 18 或 Bun ≥ 1.3.14 | 无 |
| dap | Node.js ≥ 18 | debug adapter（如 debugpy, gdb） |
| lsp | Node.js ≥ 18 | LSP server（如 marksman, ts-ls） |
| plan | Node.js ≥ 18 | 无 |
| review | Node.js ≥ 18 | git |

## Bun 测试

hashline 在 Bun 下使用原生 Bun API，无需 polyfill：

```bash
bun run pi -e ./packages/hashline/extensions/hashline.ts -p "hi" --no-session
```
