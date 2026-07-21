---
title: Hashline：用内容锚点，而不是脆弱行号，改代码
date: 2026-07-14
tags: [Hashline, Edit, Extension]
---

> 装上 `@piex-dev/hashline` 后，默认编辑从「猜行号」变成「凭读过的版本改」：更少静默写错，代价是偶发 re-read。这是值得付的税。

## 问题背景

AI 编码助手的 `edit` 工具有一个根本矛盾：

> 模型用**行号**描述「改哪里」，但行号在真实世界里极不稳定。

典型翻车场景：

1. 用户在模型思考时随手改了文件
2. 模型上一轮 edit 已经插入/删除若干行，后面行号全漂
3. 模型没读全文件，却对「以为存在」的行号下手
4. 同一 payload 因不确定是否生效被重发，append 类操作直接内容重复

若工具盲目信任行号，错误会写进仓库，而且常常**静默成功**：exit code 是 0，代码已经错了。

**Hashline（锚定编辑）** 的回答是：把编辑坐标系从「第 N 行」升级为「我读到的那个版本 + 我见过的那些行」。  
`@piex-dev/hashline` 用它**覆盖** pi 内置 `edit`，让 agent 默认走更稳的补丁语言。

```bash
pi install npm:@piex-dev/hashline
```

包路径：[`extensions/hashline`](https://github.com/piex-dev/piex/tree/main/extensions/hashline)。

---

## 技术原理

### 1. 一句话原理

1. **读的时候**：给文件打一个内容指纹 tag，并记住模型实际看到了哪些行
2. **改的时候**：补丁必须带上同一个 tag；对不上就拒绝，要求 re-read
3. **写的时候**：用 DSL 描述替换/删除/插入/整块语法操作，而不是模糊的「把这段改成那样」

模型看到的读结果大致是：

```text
[src/main.ts#A3F2]
1:import { foo } from "./foo";
2:const x = 1;
```

它发出的编辑大致是：

```text
[src/main.ts#A3F2]
SWAP 2.=2:
+const x = 2;
```

工具会：重算当前文件哈希 → 与 `#A3F2` 比对 → 通过才 apply → 返回新 tag。

### 2. 整体哈希 vs 逐行哈希（行业分歧）

Hashline 不是只有一种做法。社区里至少三条路线：

| 路线                      | 代表                 | 失效范围                       | 直觉                       |
| ------------------------- | -------------------- | ------------------------------ | -------------------------- |
| 全文件 tag                | oh-my-pi / **piex**  | 文件任意改动 → 整文件 tag 失效 | 简单、严格，像乐观锁版本号 |
| 逐行 + 上下文哈希         | pi-hashline-edit     | 编辑点 ±1 行                   | 远处锚点仍可用，少 re-read |
| 逐行内容 + stable mapping | pi-hashline-edit-pro | 尽量只失效真正变了的行         | 编辑后尽量不 re-read       |

```text
整体哈希 (oh-my-pi / piex):
  任意改动 → ████████ 全部失效

上下文感知逐行:
  编辑第5行 → ___███__ ±1 行

纯内容 + stable mapping:
  编辑第5行 → ____█___ 尽量局部
```

piex 选择 **封装 `@oh-my-pi/hashline`（整体 tag）**，换取两样很难自研的能力：

- **tree-sitter 块操作**（`SWAP.BLK` / `DEL.BLK` …）：按语法块改，而不是人肉数行号
- **boundary repair 引擎**：自动收拾模型常犯的边界错误（多贴一行、括号不配平等）

封装层本身只有数百行，复杂算法留在上游引擎。

### 3. 只改「见过的行」

光有文件 tag 还不够：模型可能只 read 了文件前 80 行，却对第 200 行下手。  
oh-my-pi / piex 会从 read 输出的行号前缀解析 **seen-lines**，Patcher 拒绝编辑从未展示过的行（折叠摘要行 `12-40:` 只算边界，不算中间省略区）。

这是「防幻觉编辑」的硬闸，不是提示词劝导。

### 4. 模型行为容错（Phase 1）

即使坐标系对了，模型仍会：

- 对 noop 结果连打同一补丁（极端会话可上百次）
- 成功后又重发，导致重复插入
- 把 DSL 包进 markdown 代码块、混入 CRLF、乱加空行

piex 在引擎外包了一层 `EditGuard` + `normalizeInput`（详见下一节）。

更完整的三方实现对比、ADR 链接与路线图表，仍保留在文末「附录：与其它 hashline 实现的对比」。

---

## 实现方案

### 模块结构

```text
hashline.ts         # 扩展入口：覆盖 edit + hook read
filesystem.ts       # PiexNodeFilesystem：node:fs + realpath 规范路径
bun-polyfill.ts     # 为 @oh-my-pi/hashline 提供 Bun.hash.xxHash32
patches.ts          # EditGuard：noop loop + duplicate edit
@oh-my-pi/hashline  # Patch 解析、Patcher 应用、快照、prompt.md
```

这是 piex 里**唯一带运行时 npm 依赖**的包（`@oh-my-pi/hashline`），本地开发需先 `npm install`。

### 工作流（端到端）

```text
1. 模型 read src/a.ts
2. tool_result hook：
   - 规范化内容，canonicalSnapshotKey（解析符号链接）
   - store.record(path, text, seenLines)
   - 正文前插入 [src/a.ts#A3F2]
   - EditGuard.resetPath：主动 re-read 清空该路径 guard
3. 模型 edit，input 为 hashline DSL
4. normalizeInput → Patch.parse → EditGuard 查 duplicate
5. Patcher.apply（tag + seen-lines + boundary repair）
6. 成功：写回、record 新快照、recordApplied
7. 全 section noop：recordNoop，≥3 次同 payload → [E_NOOP_LOOP]
8. tag 不匹配 → MismatchError 文案，要求 re-read
```

### 覆盖内置 edit

```typescript
pi.registerTool({ name: "edit", ... })  // 同名覆盖
pi.on("tool_result", ...)               // 只处理 read
```

参数从「旧文本/新文本」类 schema 换成单一 `input` 字符串（DSL）。  
工具 description 直接读上游 `prompt.md`，保证语法说明与引擎一致。

### Phase 1 容错层（已落地）

实现文件：`extensions/patches.ts` + `hashline.ts` 内 `normalizeInput`。

| 机制            | 行为                                                      |
| --------------- | --------------------------------------------------------- |
| Noop Loop Guard | 同一 `(path, payloadKey)` 连续 noop ≥ 3 → `[E_NOOP_LOOP]` |
| Duplicate Edit  | 成功后同 payload 且文件哈希未变 → `[E_DUPLICATE_EDIT]`    |
| 方言归一化      | trim、CRLF→LF、剥 markdown 围栏、压缩多余空行             |
| re-read 重置    | 模型再次 read 该路径 → guard 状态清空（允许有意重做）     |

payloadKey / fileHash 均用 xxHash32 的紧凑 hex，避免存整份 DSL。

已知局限（代码里已注释）：payload 指纹针对**整次 input**；多文件大补丁若事后只重发其中一节，指纹不同，duplicate 可能覆盖不到。

### Node 适配要点

- **polyfill 必须先于依赖**：`import "./bun-polyfill.js"` 在前，再 `await import("@oh-my-pi/hashline")`，躲开 ESM 提升顺序问题
- **I/O 不走 Bun FS**：`PiexNodeFilesystem` 直连 `node:fs`
- **路径键一致**：macOS 上 `/tmp` → `/private/tmp` 等 symlink 用 realpath，避免 read/edit 快照 key 对不上

### 与 omp 原版的差异（务实表）

| 能力                  | omp                         | piex hashline             |
| --------------------- | --------------------------- | ------------------------- |
| 引擎                  | 内建                        | 依赖 `@oh-my-pi/hashline` |
| FS                    | Bun + 可选 LSP writethrough | node:fs + realpath        |
| seen-lines            | ✅                          | ✅                        |
| Phase 1 容错          | 部分在其它实现更强          | ✅ noop/dup/normalize     |
| Stale anchor 自动恢复 | Recovery 模块               | ❌ 目前要求 re-read       |
| 多版本快照 LRU        | 视版本                      | ❌ 单版本内存 store       |

---

## 设计参考

| 项目                     | 机制                                                   | piex 取舍                                                                                                                                          |
| ------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **oh-my-pi hashline**    | 全文件 tag + tree-sitter 块语法 + boundary repair 引擎 | **采纳**：封装 `@oh-my-pi/hashline`，继承 tag、SWAP.BLK、REM/MV 与引擎。**不采纳**：内建集成、Bun FS、LSP writethrough；改为 Node + 外层 EditGuard |
| **pi-hashline-edit**     | 逐行上下文哈希 + 3-way merge 恢复 + JSON DSL           | **不采纳**核心算法（路线分歧，整体 tag vs 逐行），**借鉴**容错意图（noop/dup guard，本包另做）。ADR 方案留作未来 Phase 2 Stale 恢复参考            |
| **pi-hashline-edit-pro** | 逐行内容哈希 + stable mapping                          | **不采纳**算法，**借鉴**「尽量少 re-read」的设计目标，作为远期优化方向                                                                             |

核心取舍：选择整体文件 tag（严格简单），放弃逐行 tag（局部可用），用封装层补容错。三个阶段明确：Phase 1 容错（done）→ Phase 2 恢复 → Phase 3 undo/LSP 联动。

## 优化计划

选择整体文件 tag，换来的是严格与简单，也带来固定税：

1. **冲突策略偏「拒绝」**  
   外部或并行改动一次，未完成编辑整批作废，强制 re-read；安全，但 token 与轮次贵。  
   → Phase 2 优先接 Stale Anchor 恢复（3-way merge 或 omp Recovery），在安全前提下少一轮往返。

2. **快照偏薄**  
   内存单版本，没有多版本 LRU，难在「读过的旧视图」上重放补丁。  
   → 多版本快照 + 带锚点的 Grep（搜索结果可直接 edit）。

3. **duplicate 粒度偏粗**  
   指纹打在整次 input 上，多文件补丁的 partial resend 可能漏检。  
   → 按 section/path 细化 payload 键。

4. **封装层测试与生态联动不足**  
   强依赖上游测试与手工冒烟；编辑成功后也不会自动刷新 LSP。  
   → 封装层单测与对抗性 payload fixture；与 `lsp` diagnostics 可选联动。

路线可以压成三期（Phase 1 已完成）：

```text
Phase 1 ✅  Noop Loop / Duplicate Edit / 方言归一化
Phase 2    Stale 恢复 · 多版本快照 · 锚点 Grep
Phase 3    Undo · Auto/Raw Read · LSP 联动 · 更密的封装层测试
```

---

## 附录：与其它 hashline 实现的对比

> 供实现者深入阅读；一般读者看「问题背景 / 技术原理 / 实现方案 / 优化计划」四节即可。

### 三个参考实现

| 实现                                                                    | 哈希粒度           | 代码规模 |
| ----------------------------------------------------------------------- | ------------------ | -------- |
| [oh-my-pi/hashline](https://github.com/can1357/oh-my-pi)                | 全文件 → 4-hex tag | ~3500 行 |
| [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit)         | 逐行上下文感知     | ~4000 行 |
| [pi-hashline-edit-pro](https://github.com/YuGiMob/pi-hashline-edit-pro) | 逐行内容 → 3 char  | ~3500 行 |

后两者与 oh-my-pi **无共享核心算法代码**（即便注释写 vendored，上下文哈希、textHint、3-way merge 等为各自设计）。

### 容错机制对照

| 维度                | oh-my-pi | piex        | pi-hashline-edit | pi-hashline-edit-pro |
| ------------------- | -------- | ----------- | ---------------- | -------------------- |
| Stale 恢复          | Recovery | ❌          | 3-way merge      | stable mapping 补偿  |
| Noop Loop           | ❌       | ✅ Phase1   | ✅               | ❌                   |
| Duplicate Edit      | ❌       | ✅ Phase1   | ✅               | ❌                   |
| Boundary Repair     | ✅ 重型  | ✅ 继承引擎 | 简化             | 简化+autoFix         |
| 方言归一化          | ❌       | ✅ Phase1   | ✅               | ❌                   |
| textHint            | ❌       | ❌          | ✅               | ❌                   |
| Block (tree-sitter) | ✅       | ✅ 继承     | ❌               | ❌                   |
| REM/MV 文件操作     | ✅       | ✅ 继承     | ❌               | ❌                   |

### 语法风格速览

**oh-my-pi / piex DSL**

```text
[src/main.ts#A3F2]
SWAP 12.=12:
+const x = 1;
DEL 5
INS.PRE 8:
+import { foo } from "./foo";
SWAP.BLK 20:
+function greet(name) {
+  return `Hello, ${name}`;
+}
```

**pi-hashline-edit JSON**：`replace` / `append` / `prepend` / `replace_text`，锚点 `LINE#HASH[:hint]`。  
**pi-hashline-edit-pro JSON**：单一 replace + `hash_range_inclusive`。

### 参考链接

- [oh-my-pi hashline](https://github.com/can1357/oh-my-pi/tree/main/packages/hashline)
- [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit)（含 ADR）
- [pi-hashline-edit-pro](https://github.com/YuGiMob/pi-hashline-edit-pro)
- 关键 ADR：
  - [0001 Two-Character Hashlines](https://github.com/RimuruW/pi-hashline-edit/blob/main/docs/adr/0001-keep-two-character-hashlines.md)
  - [0003 Context-Based Line Hashing](https://github.com/RimuruW/pi-hashline-edit/blob/main/docs/adr/0003-context-based-line-hashing.md)
  - [0004 Snapshot-Merge Recovery](https://github.com/RimuruW/pi-hashline-edit/blob/main/docs/adr/0004-snapshot-merge-recovery.md)
  - [0005 Multi-Version Snapshot History](https://github.com/RimuruW/pi-hashline-edit/blob/main/docs/adr/0005-multi-version-snapshot-history.md)
