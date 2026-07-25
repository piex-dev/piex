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
