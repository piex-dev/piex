# review

代码评审扩展 — `/review` 交互命令 + LLM 可调用的 `review` 工具。

## 功能

- **/review 命令**：交互式菜单选择评审源，支持 `/review [path]` 指定仓库
- **review 工具**：LLM 可直接调用，返回结构化 diff + prompt，可选 `repo` 参数指定仓库路径
- **Diff 解析**：解析 unified diff，统计 +/− 行数
- **噪声过滤**：自动排除 lock/min/build/vendor/image/binary 文件
- **多模式**：uncommitted / staged / branch / commit / file / custom
- **跨仓库**：当 cwd 不是 git 仓库或想评审子目录仓库时，可指定任意 git 仓库路径
- **多仓库联动评审**：`/review "repo-a" "repo-b"` 一次评审多个仓库，生成合并 prompt 并要求模型检查跨仓库一致性（共享接口/契约/import 路径/重复逻辑）

## 使用说明

```bash
pi install npm:@piex-dev/review
```

项目须为 git 仓库（或通过参数指定一个 git 仓库），系统已安装 git。在 pi 中执行 `/review` 选择评审源，或由 agent 调用 `review` 工具。

指定仓库路径（单仓库）：

- `/review piex` — 评审 `piex` 子目录仓库的变更
- `/review @piex/` — 也支持 pi 的 `@` 路径引用语法（`@` 前缀自动去除）
- `/review @"piex"` — autocomplete 产生的引号形式也会自动剥离
- `/review ./path/to/repo` — 评审任意相对路径仓库
- 菜单中选「Switch repository path…」可运行时切换仓库
- `review` 工具传 `repo` 参数（相对 cwd 解析），如 `{ action: "diff", repo: "piex" }`

未指定路径时默认评审 cwd 所在仓库。

多仓库联动评审（同时改了多个仓库时一次审完）：

- `/review "piex" "oh-my-pi"` — 同时评审两个仓库，生成一条合并 prompt
- `/review piex oh-my-pi` — bare 形式同样支持（空格分隔）
- `/review @piex @oh-my-pi` — `@` 路径引用、引号、弯引号可混用
- 菜单选一个模式（Uncommitted / Staged / vs 默认分支 / Custom），**统一应用到所有仓库**；每个仓库用各自默认分支
- `review` 工具传 `repos` 数组：`{ action: "diff", repos: ["piex", "oh-my-pi"] }`，返回合并 prompt 并要求模型检查跨仓库一致性（`repos` 优先于 `repo`；多仓库仅支持 `diff`/`staged`/`branch`，`base` 应用到每个仓库）
- 任一仓库路径非法时列出全部错误并中止，不做半截评审
- vs 默认分支时区分「比较失败」与「确实无变更」：仓库无 remote / 分支没 fetch 到 / 默认分支名对不上时，该仓库在 prompt 里标注 ⚠️「比较失败」，不静默当成无变更

冒烟测试：

```bash
pi -e ./extensions/review/src/review.ts -p "what is 1+1" --no-session
```

## 依赖

- `@earendil-works/pi-coding-agent`（peer）
- `typebox`（peer）

## 延伸阅读

- https://piex.dev/zh/packages/review/
