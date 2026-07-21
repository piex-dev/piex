# review

代码评审扩展 — `/review` 交互命令 + LLM 可调用的 `review` 工具。

## 功能

- **/review 命令**：交互式菜单选择评审源
- **review 工具**：LLM 可直接调用，返回结构化 diff + prompt
- **Diff 解析**：解析 unified diff，统计 +/− 行数
- **噪声过滤**：自动排除 lock/min/build/vendor/image/binary 文件
- **多模式**：uncommitted / staged / branch / commit / file / custom

## 使用说明

```bash
pi install npm:@piex-dev/review
```

项目必须是 git 仓库，系统已安装 git。在 pi 中执行 `/review` 选择评审源，或由 agent 调用 `review` 工具。

冒烟测试：

```bash
pi -e ./extensions/review/src/review.ts -p "what is 1+1" --no-session
```

## 依赖

- `@earendil-works/pi-coding-agent`（peer）
- `typebox`（peer）

## 延伸阅读

- https://piex.dev/zh/packages/review/
