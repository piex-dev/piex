# hashline

基于 `@oh-my-pi/hashline` 的 hashline 编辑语言扩展，覆盖 pi 内置 `edit` 工具。

## 功能

- **覆盖 edit 工具**: 内置 `edit` 替换为 hashline 语法解析 + 应用
- **read hook**: 读取文件后自动注入 `[PATH#TAG]` header，为后续编辑提供锚点
- **快照验证**: 编辑时验证 `#TAG` 与文件内容一致，防止并发修改冲突
- **seen-lines 追踪**: 记录 agent 实际看到的行号，Patcher 拒绝编辑未显示的行
- **路径规范化**: `canonicalSnapshotKey` 解析符号链接（macOS `/tmp` → `/private/tmp`），确保快照 key 一致
- **Node.js 原生 FS**: `PiexNodeFilesystem` 使用 `node:fs` 直驱 I/O，不再通过 Bun polyfill 中转

## 架构

```
hashline.ts                      # pi 扩展入口
├── filesystem.ts            # Node.js 原生 FS 适配器（realpath + write guard）
├── bun-polyfill.ts              # Bun.hash.xxHash32 polyfill（computeFileHash 内部使用）
├── @oh-my-pi/hashline (依赖)
│   ├── Patch.parse()            # 解析 hashline 输入
│   ├── Patcher.apply()          # 应用编辑（含 seen-lines guard）
│   ├── InMemorySnapshotStore    # 快照管理
│   ├── formatHashlineHeader     # 格式化 [PATH#TAG]
│   └── normalizeToLF, stripBom
└── pi ExtensionAPI
    ├── pi.registerTool("edit")  # 覆盖内置 edit
    └── pi.on("tool_result")     # Hook read 结果 + seen-lines 提取
```

## 工作流

```
1. LLM 调用 read /tmp/file.js
2. hashline.ts hook → 注入 header: [/tmp/file.js#A1B2]
3. LLM 收到带 tag 的文件内容
4. LLM 生成 hashline patch:
   [/tmp/file.js#A1B2]
   SWAP 3.=5:
   +new content
5. Patcher 验证 #A1B2 匹配 + seen-lines 检查 → 应用编辑
6. 返回新 tag: #C3D4
```

## 运行时兼容

| 环境 | 方式 |
|------|------|
| Node.js | bun-polyfill.ts 注入 `Bun.hash` 全局 + `PiexNodeFilesystem`（`node:fs` 直驱） |
| Bun | 原生 Bun API（bun-polyfill 自动跳过） |

## 安装

```bash
pi install npm:@piex-dev/hashline
```

## 依赖

- `@oh-my-pi/hashline` ^16.4.0
- `@earendil-works/pi-coding-agent` (peer)
- `typebox` (peer)

## 与 omp 实现差异

| omp | hashline |
|-----|-------------|
| `HashlineFilesystem` (Bun + LSP writethrough) | `PiexNodeFilesystem` (node:fs + realpath canonicalPath) |
| `canonicalSnapshotKey` with `fs.realpathSync.native` | ✅ 同级实现 |
| seen-lines tracking via `recordSeenLinesFromBody` | ✅ `parseSeenLines` + `store.record(path, text, seenLines)` |
| noop-loop-guard (连续 noop 硬限制) | ❌ 未实现（单次 noop 有 actionable 提示） |
| block editing (tree-sitter `SWAP.BLK/DEL.BLK`) | ❌ 未实现（需 blockResolver） |

## 来源

功能特性来自 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的 `packages/hashline`。
