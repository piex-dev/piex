# hashline

基于 `@oh-my-pi/hashline` 的 hashline 编辑语言扩展，覆盖 pi 内置 `edit` 工具。

## 功能

- **覆盖 edit 工具**：内置 `edit` 替换为 hashline 语法解析 + 应用
- **read hook**：读取文件后自动注入 `[PATH#TAG]` header，为后续编辑提供锚点
- **快照验证**：编辑时验证 `#TAG` 与文件内容一致，防止并发修改冲突
- **seen-lines 追踪**：记录 agent 实际看到的行号，Patcher 拒绝编辑未显示的行
- **noop 循环守卫**：连续 3 次 byte-identical noop 抛 `[E_NOOP_LOOP]`（`patches.ts` EditGuard）
- **重复编辑检测**：成功编辑后重发相同 payload 且文件未变 → 抛 `[E_DUPLICATE_EDIT]`
- **方言归一化**：吸收 CRLF/代码块包裹/多余空行等模型输出偏差
- **diff 回显**：每次 update 附带 compact diff preview，实际增删行当场可见（含行号，可直接作下次编辑锚点）

## 优化记录（v0.1.3）

针对「模型基于旧快照行号连续编辑导致错位」的实战问题（2026-08-02 wings-edge 修复会话）：

- **auto-repair WARN 增强**：`boundary echo` / `duplicated leading/trailing payload` 自动修复时，
  WARN 现在**列出被丢弃行的实际内容**（`dropped trailing: const b = 2;`，截断 80 字符，
  最多 3 行 + 省略计数），模型一眼可判「丢弃是否合理」，而非只有 count 后盲目重发。
- **Next-edit hint**：每次 update 的 diff 回显后追加提示：后续编辑应锚定 **diff 中的新行号**
- **Tag mismatch 消息增强**：提示「若本会话刚编辑过该文件，用上次 diff 回显的新行号」。

配套补丁更新：`patches/@oh-my-pi+hashline+17.1.3.patch` 新增 `formatDroppedLines` 辅助
（WARN 内容预览）；补丁可逆验证通过（patch -p1 -R / -p1 往返一致）。

## 优化记录（v0.1.4）

针对「read 输出无行号 → 模型猜行号、seen-lines guard 静默失效」的根因修复
（2026-08-02 复盘发现：pi 内置 read 的 tool_result 是裸文本，行号只在终端渲染层；
prompt 却承诺 `LINE:TEXT` 格式，模型只能按内容位置猜行号）：

- **P0 read 输出行号化**：read hook 现在把文本块重写为 `N:TEXT` 行号格式
  （含 read offset 基准、跳过 pi 截断/limit 脚注及其前分隔空行——分隔空行
  若编号会顶掉下一个真实行号，截断读的边界行会被模型误当空行盲改；仅文件
  末尾真实哨兵空行编号计入 seen），模型看到真实行号，seen-lines guard 真正
  生效——「编辑未显示的行」会被拦截。
- **删除未 seen 行告警（Phase 2.6）**：diff 回显中 removed 行若不在最近 read
  的 seen 集合里，追加 `[WARN]` 提示行号可能偏移（覆盖「范围终点猜错」形态）。
- **fence 包裹剥离收紧**：`normalizeInput` 只在首行是 fence 且末行是**裸** ` ``` `
  时剥离代码块包裹；payload 以 `+``` ` 结尾（编辑 fence 块的 SWAP）不再误剥。
- **duplicate/noop 指纹 per-section**：payloadKey 改为按 `path + section.diff`
  分别计算，多文件 payload 重发其中一部分时也能命中检测。
- **HTML 属性值引号跳过**：`<div data-x="<section>">` 引号内的尖括号不再误计。
- **大文件 diff 降级**：LCS 超限时输出行数统计摘要，不再无回显。

## 使用说明

```bash
pi install npm:@piex-dev/hashline
```

安装后即生效：hashline 覆盖 pi 内置 `edit` 工具，并 hook `read` 结果。无需额外开关，无需配置文件。

冒烟测试（改动后必跑）：

```bash
pi -e ./extensions/hashline/src/hashline.ts -p "what is 1+1" --no-session
```

## 依赖

- `@oh-my-pi/hashline` ^17.1.3（运行时）
- `@earendil-works/pi-coding-agent`（peer）
- `typebox`（peer）
- `patch-package` ^8.0.1（运行时，安装时自动应用 patches/ 下的补丁）

## Patches

`patches/` 目录包含两个上游补丁，通过 `postinstall` 脚本 + `patch-package` 自动应用：

- `@oh-my-pi+hashline+17.1.3.patch` — 修复 `findDuplicateSuffix`/`findDuplicatePrefix` 在较大重写 payload 中误判边界回显的问题
- `@oh-my-pi+pi-natives+17.1.3.patch` — 用 `fileURLToPath` 替代 Node 21.2+ 才支持的 `import.meta.dir`

补丁针对 `@oh-my-pi/hashline@17.1.3` 的精确文件内容生成。升级 `@oh-my-pi/hashline` 版本时需重新生成补丁，`postinstall` 应用失败即为版本不兼容的明确信号。

## 延伸阅读

- https://piex.dev/zh/packages/hashline/
