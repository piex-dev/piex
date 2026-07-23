# review

代码评审扩展 — `/review` 交互命令 + LLM 可调用的 `review` 工具。

## 功能

- **/review 命令**：交互式菜单选择评审源，支持 `/review [path]` 指定仓库
- **review 工具**：LLM 可直接调用，返回结构化 diff + prompt，可选 `repo` 参数指定仓库路径
- **Diff 解析**：解析 unified diff，统计 +/− 行数
- **噪声过滤**：自动排除 lock/min/build/vendor/image/binary 文件
- **多模式**：uncommitted / staged / branch / commit / file / custom
- **跨仓库**：当 cwd 不是 git 仓库或想评审子目录仓库时，可指定任意 git 仓库路径

## 使用说明

```bash
pi install npm:@piex-dev/review
```

项目须为 git 仓库（或通过参数指定一个 git 仓库），系统已安装 git。在 pi 中执行 `/review` 选择评审源，或由 agent 调用 `review` 工具。

指定仓库路径：

- `/review piex` — 评审 `piex` 子目录仓库的变更
- `/review ./path/to/repo` — 评审任意相对路径仓库
- 菜单中选「Switch repository path…」可运行时切换仓库
- `review` 工具传 `repo` 参数（相对 cwd 解析），如 `{ action: "diff", repo: "piex" }`

未指定路径时默认评审 cwd 所在仓库。

冒烟测试：

```bash
pi -e ./extensions/review/src/review.ts -p "what is 1+1" --no-session
```

## 依赖

- `@earendil-works/pi-coding-agent`（peer）
- `typebox`（peer）

## 延伸阅读

- https://piex.dev/zh/packages/review/
