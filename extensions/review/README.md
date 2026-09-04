# review

独立、只读、可收敛的代码评审扩展。用户入口只有一个：`/review`。

## 功能

- **零选择默认流程**：`/review` 自动评审当前分支相对默认分支的全部工作，包括已提交、暂存、未暂存和未跟踪文件
- **独立 reviewer**：使用新的 Pi SDK session，隔离当前作者对话；只开放 `read` / `grep` / `find` / `ls` 与只读 diff 工具
- **自适应复核**：普通变更只启动一个 reviewer；安全、数据、并发、跨仓或大 diff 自动并行增加一个专项 reviewer，最多两个，再由主 reviewer 裁决
- **实时过程可见**：运行时持续显示耗时、阶段、lead/专项 reviewer、实际模型、thinking level 与只读工具活动；可打开安全 transcript 查看可见回复和工具轨迹，最终报告保留 reviewer 元数据
- **证据门槛**：finding 必须说明触发条件、实际影响、置信度，并落在本次 patch 的变更行；最终结论与摘要只根据门禁后的规范 finding 生成
- **可收敛 re-review**：同一会话分支会记录 finding 身份与开放状态；未被明确关闭的旧 P0/P1 会持续阻塞，重复 ID 保留最高优先级，相同 diff 直接复用结果
- **真实噪声过滤**：lock、构建产物、vendor、generated、媒体和二进制文件不会进入 reviewer 上下文
- **跨仓联动**：`/review "repo-a" "repo-b"` 自动检查共享接口、协议与兼容性
- **自动化入口**：LLM 可调用 `review` 工具；默认同样是 `auto`，高级范围通过工具参数表达，不增加命令菜单

## 使用说明

```bash
pi install npm:@piex-dev/review
```

项目须为 git 仓库（或通过参数指定仓库），系统已安装 git。

```text
/review
/review ../repo-a
/review "../repo-a" "../repo-b"
```

不带参数时，扩展依次解析 `origin/HEAD`、`init.defaultBranch`、`main` / `master` / `trunk`，在本地计算 merge-base；不会隐式 `fetch`。找不到可靠默认分支时，退化为评审 `HEAD` 到当前工作区。

指定仓库路径（单仓库）：

- `/review piex`：评审 `piex` 子目录仓库
- `/review @piex/`、`/review @"piex"`：支持 Pi 路径引用与 autocomplete 引号
- `/review ./path/to/repo`：评审任意相对或绝对路径仓库
- 未指定路径时评审 cwd 所在仓库

多仓库联动评审（同时改了多个仓库时一次审完）：

- `/review "piex" "oh-my-pi"`、`/review piex oh-my-pi`、`/review @piex @oh-my-pi` 均可
- 每个仓库独立冻结 base/head/diff，任一路径非法则列出全部错误并中止
- 跨仓变更会自动触发 contracts 专项 reviewer，无需用户选择模式

## Review 结果

- `NEEDS FIX`：存在 P0/P1，建议继续修复后再次运行 `/review`
- `PASS`：没有阻塞问题；P2 作为 advisory 展示，不要求无限循环修复
- re-review 会把旧 finding 标记为 `resolved` / `still_open` / `invalid` / `superseded`
- reviewer 未提供非空关闭理由时，旧 finding 继续留在开放集合；旧 P0/P1 也不能通过降级为 P2 绕过阻塞门槛
- 相同 scope 且 diff 未变化时返回 cached 结果，不再次消耗模型调用

## 实时进度与 reviewer transcript

交互式 TUI 的 `/review` 只在编辑器上方显示实时面板，避免与状态栏重复；非 TUI UI 会回退为状态栏紧凑摘要：

```text
Review · 00:31 · reviewing
● lead · openai-codex/gpt-5.6-sol · thinking xhigh · reading src/reviewer.ts · 3 tools
● specialist/security · openai-codex/gpt-5.6-sol · thinking max · reasoning about changes · 2 tools
```

面板会随 `preparing`、`reviewing`、`adjudicating`、`validating` 等阶段，以及读取源码、搜索、检查冻结 diff 和提交报告等活动更新。`review` 工具会通过 `onUpdate` 返回同一份结构化进度，最终报告也会列出实际 reviewer 模型和 thinking level。

在交互式 TUI 中，`/review` 会在后台执行并立即交还输入框。review 运行期间可直接输入 `/review-log`，也可按 `Ctrl+Alt+R`，两种方式都会打开铺满终端窗口、实时且可滚动的 reviewer transcript；完成后再次运行 `/review-log` 可回看最近一次记录。`Tab` 在 lead 与 specialist 间切换，方向键或 `j` / `k` 滚动，`G` 回到末尾并恢复自动跟随，`q` / `Esc` 关闭。

transcript 只记录发给 reviewer 的任务、assistant 可见文本、工具调用与结果摘要、重试/阶段状态和 `submit_review` 最终提交。原始 thinking/reasoning 不会被记录；secret/token/password 等敏感字段和常见凭据格式会脱敏，长内容、集合及总条目数均有限制。记录只保存在扩展内存中，不写入作者主 session，也不落盘；`/reload` 或进程退出后清除。

## review 工具

Agent 通常只需调用 `{ action: "auto" }`。为脚本或高级工作流保留：

- `diff`：`HEAD` 到工作区（含 staged / unstaged / untracked；unignored 的凭据类 untracked 文件如 `.env`、`.npmrc`、私钥等会自动排除，内容不会发往 reviewer）
- `staged`：仅暂存区
- `branch`：相对指定 `base` 的当前工作
- `commit`：指定 `commit`（单仓；merge commit 相对第一父提交评审）
- `file`：指定 `file`（单仓）
- `instructions`：附加评审关注点

`repo` 指定单仓，`repos` 指定多仓且优先于 `repo`。

finding 文件路径先按仓库相对路径精确匹配；只有精确匹配失败时，才把开头的 `a/` 或 `b/` 当作 Git diff 展示前缀剥离，因此仓库中真实的顶层 `a`、`b` 目录不会被误判。

## 可选配置

默认零配置，reviewer 使用当前模型和当前 thinking level。需要固定独立模型时可创建 `~/.pi/piex-dev/review/settings.json`：

```json
{
  "model": "provider/model-id",
  "specialistModel": "provider/other-model-id",
  "thinkingLevel": "high",
  "specialistThinkingLevel": "max",
  "maxReviewers": 2
}
```

`thinkingLevel` 控制主 reviewer，`specialistThinkingLevel` 只控制风险路由启动的专项 reviewer；两者接受 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，专项等级未配置时继承主 reviewer。`maxReviewers` 只接受 `1` 或 `2`；默认 `2` 表示允许按风险自动增加专项 reviewer，而不是每次都并发两个。显式配置的 `model` / `specialistModel` 始终优先；只有未配置对应模型时，同一 scope 的 re-review 才沿用首次记录的 reviewer 模型。

注意：`ultra` 不是 Pi thinking level。[GPT-5.6 Sol 模型说明](https://developers.openai.com/api/docs/models/gpt-5.6-sol)列出的最高 API `reasoning.effort` 是 `max`；Codex Ultra 使用 maximum reasoning，并可能额外运行 agent，见 [OpenAI Model guidance](https://developers.openai.com/api/docs/guides/latest-model)。因此，`max` 是本扩展可传给单个 reviewer 的最高档，不等于完整的 Codex Ultra 模式；配置中的 `ultra` 会被忽略。

冒烟测试：

```bash
pi -e ./extensions/review/src/review-v2.ts -p "what is 1+1" --no-session
```

## 依赖

- `@earendil-works/pi-coding-agent`（peer）
- `typebox`（peer）

## 延伸阅读

- https://piex.dev/zh/packages/review/
