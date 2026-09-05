# review

独立、只读、可收敛的代码评审扩展。用户入口只有一个：`/review`。

## 功能

- **交互范围选择**：`/review` 启动时选择默认分支 PR 范围、working tree、staged、指定 base/commit/file 或自定义关注点
- **独立 reviewer**：使用新的 Pi SDK session，隔离当前作者对话；只开放 `read` / `grep` / `find` / `ls` 与只读 diff 工具
- **自适应复核**：普通变更只启动一个 reviewer；安全、数据、并发、跨仓或大 diff 自动并行增加一个专项 reviewer，最多两个，再由主 reviewer 裁决
- **实时过程可见**：运行时持续显示耗时、阶段、lead/专项 reviewer、实际模型、thinking level、Fast mode 与只读工具活动；可打开安全 transcript 查看可见回复和工具轨迹，最终报告保留 reviewer 元数据
- **证据门槛**：finding 必须说明触发条件、实际影响、置信度，并落在本次 patch 的变更行；最终结论与摘要只根据门禁后的规范 finding 生成
- **可收敛 re-review**：同一会话分支会记录 finding 身份与开放状态；未被明确关闭的旧 P0/P1 会持续阻塞，重复 ID 保留最高优先级，相同 diff 直接复用结果
- **真实噪声过滤**：lock、构建产物、vendor、generated、媒体和二进制文件不会进入 reviewer 上下文
- **跨仓联动**：`/review "repo-a" "repo-b"` 自动检查共享接口、协议与兼容性
- **自动化入口**：LLM 可调用 `review` 工具；默认是 `auto`，高级范围通过工具参数表达，不打开交互菜单

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

命令启动后会先选择评审范围：

- `All current work vs default branch (PR-style)`：当前分支相对默认分支的已提交、暂存、未暂存和未跟踪工作
- `Uncommitted changes (working tree vs HEAD)`：`HEAD` 到当前工作区
- `Staged changes only`：仅暂存区
- `Changes vs a base branch or commit…`：输入自定义比较基线
- `Specific commit…` / `Specific file…`：单仓库的指定提交或文件
- `All current work with custom review focus…`：默认 PR 范围并附加评审关注点

默认分支范围依次解析 `origin/HEAD`、`init.defaultBranch`、`main` / `master` / `trunk`，在本地计算 merge-base；不会隐式 `fetch`。找不到可靠默认分支时，退化为评审 `HEAD` 到当前工作区。取消范围选择或参数输入会直接退出，不会启动 reviewer。

指定仓库路径（单仓库）：

- `/review piex`：评审 `piex` 子目录仓库
- `/review @piex/`、`/review @"piex"`：支持 Pi 路径引用与 autocomplete 引号
- `/review ./path/to/repo`：评审任意相对或绝对路径仓库
- 未指定路径时评审 cwd 所在仓库

多仓库联动评审（同时改了多个仓库时一次审完）：

- `/review "piex" "oh-my-pi"`、`/review piex oh-my-pi`、`/review @piex @oh-my-pi` 均可
- 每个仓库独立冻结 base/head/diff，任一路径非法则列出全部错误并中止
- 选定范围统一应用到所有仓库；`commit` / `file` 只适用于单仓，因此多仓菜单会自动隐藏
- 跨仓变更会自动触发 contracts 专项 reviewer

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
● lead · openai-codex/gpt-5.6-sol · thinking xhigh · fast · reading src/reviewer.ts · 3 tools
● specialist/security · openai-codex/gpt-5.6-sol · thinking max · fast · reasoning about changes · 2 tools
```

面板会随 `preparing`、`reviewing`、`adjudicating`、`validating`、`changes detected; restarting` 等阶段，以及读取源码、搜索、检查冻结 diff 和提交报告等活动更新。并行运行时，先完成的 reviewer 会立即显示 `✓ … done`，不会等待另一个 reviewer，也不会被尾随事件改回 running。`review` 工具会通过 `onUpdate` 返回同一份结构化进度，最终报告也会列出实际 reviewer 模型、thinking level 和 Fast mode 状态。启用时，进度、transcript 与最终报告都会标记 `fast`。

reviewer 结束后会重新采集 diff，防止输出已经过期的 finding。若评审期间代码发生变化，扩展会保留安全校验、自动切换到最新 diff 并重跑一次，不再直接让 `/review` 失败；进度面板和 `/review-log` 会明确记录刷新，并只展示最新一轮的 reviewer。若第二轮期间代码仍持续变化，扩展才会停止并提示先等待编辑完成，避免无限重复调用模型。

在交互式 TUI 中，`/review` 会在后台执行并立即交还输入框。review 运行期间可直接输入 `/review-log`，也可按 `Ctrl+Alt+R`，两种方式都会打开铺满终端窗口、实时且可滚动的 reviewer transcript；完成后再次运行 `/review-log` 可回看最近一次记录。浮层复用主 Agent 当前 Pi 主题的语义配色：header、阶段、工具标题和 prompt 元数据分别使用 accent、muted、success/error、toolTitle 等 token，prompt 内嵌 diff 与 `review_diff` 使用增删/上下文色；工具参数和结果元数据只轻量区分 JSON 键、数字和标点，大段字符串使用主 Agent 的 `toolOutput` 正文色，不会整片显示为错误红色；`read` 按文件扩展名识别 TypeScript、Python、Rust 等源码语言，无法识别时保持普通代码色，不做不可靠的自动猜测。`Tab` 在 lead 与 specialist 间切换，方向键或 `j` / `k` 滚动，`G` 回到末尾并恢复自动跟随，`q` / `Esc` 关闭。

transcript 只记录发给 reviewer 的任务、assistant 可见文本、工具调用与结果摘要、重试/阶段状态和 `submit_review` 最终提交。原始 thinking/reasoning 不会被记录；secret/token/password 等敏感字段和常见凭据格式会脱敏，长内容、集合及总条目数均有限制。记录只保存在扩展内存中，不写入作者主 session，也不落盘；`/reload` 或进程退出后清除。

长工具结果会在 JSON 值内部截断并标记 `[TRUNCATED]`，保留合法 JSON，因此保留下来的源码和 diff 仍能按原始换行高亮。浮层按条目缓存高亮和自动换行结果，流式更新只处理变化部分；另一位 reviewer 的活动不会使当前页面缓存失效。窗口宽度变化只重新换行，主题刷新会清空缓存，淘汰的日志条目也会同步释放。

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
  "model": "openai-codex/gpt-5.6-sol",
  "thinkingLevel": "xhigh",
  "fastMode": true,
  "specialistModel": "openai-codex/gpt-5.6-sol",
  "specialistThinkingLevel": "max",
  "specialistFastMode": true,
  "maxReviewers": 2
}
```

`thinkingLevel` 控制主 reviewer，`specialistThinkingLevel` 只控制风险路由启动的专项 reviewer；两者接受 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，专项等级未配置时继承主 reviewer。`maxReviewers` 只接受 `1` 或 `2`；默认 `2` 表示允许按风险自动增加专项 reviewer，而不是每次都并发两个。显式配置的 `model` / `specialistModel` 始终优先；只有未配置对应模型时，同一 scope 的 re-review 才沿用首次记录的 reviewer 模型。

`fastMode` 控制 lead，`specialistFastMode` 控制专项 reviewer；专项值缺省时继承 `fastMode`。设为 `true` 时，扩展会向该独立 reviewer 的请求注入 `service_tier: "priority"`。该能力仅支持 `openai-codex` provider、`openai-codex-responses` API、ChatGPT OAuth，以及 `gpt-5.4`、`gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-6-astra` 模型；其他组合会在 reviewer 启动前报配置错误，而不是静默降级。reviewer 是独立 session，不会继承外层 `/gpt-fast` 状态，需要通过这两个字段显式配置。`fast` 标记表示扩展已启用请求注入，并非服务端确认；Pi 的本地成本遥测仍可能按标准 tier 估算，后端额度记录才是最终依据。

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
