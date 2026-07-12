# 测试指南

## 快速测试

每个 package 可通过 `pi -e` 单独测试：

```bash
cd pie

# 加载测试（验证扩展不报错）
pi -e ./packages/pie-hashline/extensions/hashline.ts -p "what is 1+1" --no-session
pi -e ./packages/pie-dap/extensions/dap.ts       -p "what is 1+1" --no-session
pi -e ./packages/pie-lsp/extensions/lsp.ts       -p "what is 1+1" --no-session
pi -e ./packages/pie-plan/extensions/plan.ts     -p "what is 1+1" --no-session
pi -e ./packages/pie-review/extensions/review.ts  -p "what is 1+1" --no-session
```

## 功能测试

### pie-hashline

```bash
# 创建测试文件
echo -e 'hello world\nline 2\nline 3' > /tmp/test.txt

# 测试 read → edit 工作流
pi -e ./packages/pie-hashline/extensions/hashline.ts \
  -p "1. Read /tmp/test.txt 2. Use edit tool to replace 'hello world' with 'hi pie' using hashline SWAP syntax with [PATH#TAG]" \
  --no-session -nc

# 验证结果
cat /tmp/test.txt
```

### pie-dap

```bash
# 列出 debug sessions
pi -e ./packages/pie-dap/extensions/dap.ts \
  -p "Use the debug tool with action=sessions" --no-session

# 启动调试（需要安装 debug adapter）
pi -e ./packages/pie-dap/extensions/dap.ts \
  -p "Use the debug tool: action=launch, program=script.py, adapter=debugpy, timeout=5" --no-session
```

### pie-lsp

```bash
# 查看 LSP 状态
pi -e ./packages/pie-lsp/extensions/lsp.ts \
  -p "Use the lsp tool with action=status" --no-session

# 获取诊断（需要对应的 LSP server）
pi -e ./packages/pie-lsp/extensions/lsp.ts \
  -p "Use the lsp tool with action=diagnostics, file=README.md" --no-session
```

### pie-plan

```bash
# 交互式测试（需要 TUI 模式）
pi -e ./packages/pie-plan/extensions/plan.ts

# 进入后输入 /plan 切换计划模式
```

### pie-review

```bash
# 测试 review 工具（无变更）
pi -e ./packages/pie-review/extensions/review.ts \
  -p "Use the review tool with action=diff" --no-session

# 交互式测试
pi -e ./packages/pie-review/extensions/review.ts
# 输入 /review 查看评审菜单
```

## 环境要求

| Package | 运行时 | 额外工具 |
|---------|--------|---------|
| pie-hashline | Node.js ≥ 18 或 Bun ≥ 1.3.14 | 无 |
| pie-dap | Node.js ≥ 18 | debug adapter（如 debugpy, gdb） |
| pie-lsp | Node.js ≥ 18 | LSP server（如 marksman, ts-ls） |
| pie-plan | Node.js ≥ 18 | 无 |
| pie-review | Node.js ≥ 18 | git |

## Bun 测试

pie-hashline 在 Bun 下使用原生 Bun API，无需 polyfill：

```bash
bun run pi -e ./packages/pie-hashline/extensions/hashline.ts -p "hi" --no-session
```
