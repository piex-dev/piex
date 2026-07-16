---
title: Hashline 方案的原理及借鉴
date: 2026-07-16
tags: [Hashline, Edit, Extension]
---

## 为什么需要锚定编辑

AI 编码助手的 edit 工具面临一个根本问题：**模型用行号描述编辑位置，但行号是脆弱的**。用户可能在模型思考期间修改文件，模型自己前一轮的编辑也会让后续行号全部偏移。如果直接信任行号，edit 会在错误位置修改代码，造成难以察觉的 bug。

锚定编辑（Hashline）解决这个问题的思路是：**用内容哈希代替行号作为编辑的坐标系统**。模型读取文件时看到每行旁边的哈希值，编辑时用这些哈希值告诉工具"替换从这个哈希到那个哈希之间的内容"，而不是"替换第 12 到 15 行"。

[piex/hashline](https://github.com/piex-dev/piex/tree/main/packages/hashline) 在设计上从三个优秀的 hashline 实现中汲取灵感。本文深入对比这三个实现，分析它们各自的设计决策、优势与取舍，说明 piex/hashline 的选择逻辑。

---

## 一、三个参考实现

| 实现 | 作者 | 哈希粒度 | 代码规模 | 测试 |
|------|------|---------|---------|------|
| **[oh-my-pi/hashline](https://github.com/can1357/oh-my-pi)** | can1357 | 全文件 → 4-hex tag | ~3500 行 | 12 个 |
| **[pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit)** | RimuruW | 逐行上下文感知 → 2/3/4 char | ~4000 行 | 30+ 个 |
| **[pi-hashline-edit-pro](https://github.com/YuGiMob/pi-hashline-edit-pro)** | YuGiMob | 逐行内容 → 3 char | ~3500 行 | 50+ 个 |

关键事实：后两者与 oh-my-pi **没有任何共享代码**。pi-hashline-edit 注释写的是 "Vendored & adapted from oh-my-pi"，但其核心算法（上下文感知哈希、textHint 交叉校验、3-way merge 恢复）全部是原创设计。

---

## 二、原理：整体哈希 vs 逐行哈希

这是最根本的设计分歧。

### 2.1 整体哈希（oh-my-pi）

```
读取时：
  全文件内容 → xxHash32 → 截取前 16 bit → 4-hex tag "A3F2"
  输出：[src/main.ts#A3F2]
          1:A3F2:import { foo } from "./foo";
          2:B7E1:const x = 1;

编辑时：
  [src/main.ts#A3F2]        ← 用 tag 证明"我看到的是这个版本"
  SWAP 2.=2:                ← 行号 + tag 双重定位
  +const x = 2;
```

**校验流程**：

1. 重读文件 → 计算哈希 → 得到 `actualTag`
2. 对比 header 中的 `expectedTag`
3. 匹配 → 行号索引的是 tag 所指版本，安全执行
4. 不匹配 → `MismatchError`，提示 re-read

**优点**：概念简单，一个 tag 覆盖整个文件。seenLines 机制可以跟踪模型实际看到的行号，阻止模型编辑从未读取的行。

**缺点**：文件任何一处改动 → 全局 tag 失效。并发修改极其敏感。模型必须先读完整文件才能编辑任意位置。

### 2.2 逐行哈希（pi-hashline-edit、pi-hashline-edit-pro）

```
读取时：
  对每一行独立计算哈希
  输出：1#MQ:import { foo } from "./foo";
        2#VR:const x = 1;

编辑时：
  { "op": "replace", "pos": "2#VR", "lines": ["const x = 2;"] }
  ← 锚定在行 2 的哈希 VR 上
```

**校验流程**：

1. 对锚点指定的行号，计算当前文件中该行的哈希
2. 对比锚点中的 expectedHash
3. 匹配 → 该行内容未变，安全编辑
4. 不匹配 → `E_STALE_ANCHOR`

**优点**：局部失效——只改第 5 行，第 50 行的锚点仍然有效。读完需要的范围就可以编辑，减少不必要的 re-read round-trip。

**缺点**：哈希碰撞更突出（每行独立哈希，同内容行碰撞需要额外策略）。

### 2.3 上下文感知哈希（pi-hashline-edit 独有）

pi-hashline-edit 的哈希函数不只是对行内容做摘要：

```
computeHashFromContext(prev, curr, next) =
  xxHash32(prev + "\0" + curr + "\0" + next)
```

**第 N 行的哈希值依赖 N-1、N、N+1 三行内容**。这意味着编辑的影响半径精确限定在 ±1 行：

```
编辑第 5 行 →
  第 4 行锚点失效（next 变了）
  第 5 行锚点失效（自身变了）
  第 6 行锚点失效（prev 变了）
  第 3、7、8... 行锚点保持有效 ← 远处不受影响
```

比整体哈希（全局失效）宽松，比纯内容哈希（只失效编辑行）更安全——紧邻编辑区的锚点确实应该被标记为不可信。

### 2.4 Stable Hash Mapping（pi-hashline-edit-pro 独有）

pi-hashline-edit-pro 采用纯内容哈希，但在编辑后执行 **stable hash mapping**：通过逐行内容匹配将旧哈希映射到新文件中相同内容的行，让未变化的行保留旧哈希。

```
编辑前：lines = ["import x", "const a = 1", "const b = 2", "export y"]
         hashes = ["F4T",       "MQX",         "ZPM",         "VRW"]
编辑后：lines = ["import x", "const b = 2", "export y"]
            ↓ 内容匹配        ↓ 匹配到旧行 3  ↓ 匹配到旧行 4
         hashes = ["F4T",       "ZPM",         "VRW"]
                                               ↑ 锚点存活！
```

这意味着模型在一次编辑后，**不需要 re-read 就能继续编辑同一文件**。

### 2.5 三种方案失效范围对比

```
整体哈希 (oh-my-pi):
  文件任意改动 → ████████████████████ 全部失效

上下文感知哈希 (pi-hashline-edit):
  编辑第5行       → ___███______________  ±1行失效

纯内容哈希 + stable mapping (pi-hashline-edit-pro):
  编辑第5行       → ____█_______________  仅编辑行本身，stable mapping 让其余存活
```

---

## 三、容错机制对比

### 3.1 Stale Anchor 恢复

**oh-my-pi — Recovery 模块（anchor remapping）**

```
1. diffArrays(旧文件, 新文件) → 构建行号映射 Map<oldLine, newLine>
2. 验证每个锚点上下文的非锚点邻行在映射后仍然连续
3. 所有锚点必须按同一 offset 移动
4. 通过 → 重映射锚点，在新文件上直接 apply
5. 失败 → MismatchError
```

严格但保守：所有锚点必须统一偏移。一个锚点对不上，全部拒绝。

**pi-hashline-edit — 3-way merge 恢复**

```
1. 取模型最后一次 read 的快照（多版本 LRU，最多 4 版本 × 8 路径）
2. 在快照上重放编辑 → baseEdited
3. 生成 unified patch：structuredPatch(snapshot, baseEdited)
4. 合并到 live 文件：applyPatch(liveContent, patch, {fuzzFactor: 0})
5. 成功 → 返回合并结果 + warning
6. 失败 → 尝试更早版本快照，全部失败则回退到 E_STALE_ANCHOR
```

**fuzzFactor=0 是关键约束**——如果外部修改和模型编辑有冲突（同一行被两边改了），合并必然失败，不会静默覆盖任何一方的修改。

**pi-hashline-edit-pro — 无恢复，依赖 stable hash mapping 降低失效概率。**

### 3.2 Noop Loop Guard（pi-hashline-edit 独有）

模型经常忽略 soft hint，在 noop 结果上反复重试同一 payload。极端案例：一次会话中模型连续发送了 205 次 byte-identical 的 noop edit。

pi-hashline-edit 的方案：

```
同一 (canonicalPath, payloadKey) → noopCount++
noopCount ≥ 3 → 抛 ToolError "[E_NOOP_LOOP]"
模型切换 payload → 计数器重置
```

简单但有效。oh-my-pi 和 pi-hashline-edit-pro 均无此保护。

### 3.3 Duplicate Edit 检测（pi-hashline-edit 独有）

与 noop loop guard 正交：模型在一次**成功**的 edit 后误以为失败，重发相同 payload（如 append 一行后不确定是否生效，又发一次，导致内容重复）。

```
lastAppliedPayload[path] = payloadKey

新请求到达：
  payloadKey 匹配 && read snapshot == live content → [E_DUPLICATE_EDIT]
  模型主动 re-read → 清除 lastAppliedPayload
```

### 3.4 Boundary Repair

**oh-my-pi 的修复引擎**（~1200 行）是三个实现中最完善的。它在 apply 阶段自动检测并修复：

| 错误类型 | 检测方式 | 处理 |
|---------|---------|------|
| Boundary echo | 替换内容首/尾行与范围外行完全相同 | 自动裁剪重复行 |
| Delimiter imbalance | 括号/花括号/方括号在替换前后不匹配 | 保留/移除范围边界外的结构闭合行 |
| JSX closer mismatch | JSX 闭合标签丢失或重复 | 识别组件名匹配，自动修复 |
| After-insert landing | body 缩进深度与锚点位置不匹配 | 根据缩进深度自动调整插入位置 |

两个逐行哈希实现只有简化版：
- pi-hashline-edit：比较首尾行与范围外邻行（trim 后），发 warning
- pi-hashline-edit-pro：同样检测，但**自动修复**（autoFix 裁剪重复行）

### 3.5 方言归一化（pi-hashline-edit 独有）

模型可能用不符合 schema 的格式调用 edit tool——例如用 pi 原生的 `oldText/newText`、把 edits 序列化成 JSON 字符串、用 `file_path` 代替 `path`。

pi-hashline-edit 的 `prepareArguments` hook 在验证前自动吸收这些变异：

```
prepareArguments → normalizeEditRequest:
  file_path → path
  "edits": "[...]" → JSON.parse → array
  { oldText, newText } → { op: "replace_text", oldText, newText }
  缺少 op 的 edit item → backfillEditOp 推断
```

一个非标准格式被归一化后继续执行，不消耗模型额外的 turn。这是 oh-my-pi 和 pi-hashline-edit-pro 都没有的。

### 3.6 textHint 交叉校验（pi-hashline-edit 独有）

pi-hashline-edit 的锚点格式 `LINE#HASH:content` 中 `:content` 后缀是可选的 textHint：

- **哈希匹配但 textHint 不匹配** → 锚点过期（防 1/256 哈希碰撞）
- **哈希不匹配但 textHint 匹配且模糊等价** → 接受锚点（容错空白符变化）

textHint 的来源是 read 输出中本就存在的内容，对模型零额外 token 开销。oh-my-pi 和 pi-hashline-edit-pro 都没有这个保护。

---

## 四、编辑操作模型

### 4.1 三种语法风格

**oh-my-pi — 自定义 DSL**

```
[src/main.ts#A3F2]      ← 文件级 header + tag
SWAP 12.=12:             ← 替换行 12
+const x = 1;

DEL 5                    ← 删除行 5

INS.PRE 8:               ← 在第 8 行之前插入
+import { foo } from "./foo";

SWAP.BLK 20:             ← 替换第 20 行开始的整个语法块（tree-sitter）
+function greet(name) {
+  return `Hello, ${name}`;
+}

REM                      ← 删除整个文件
MV lib/greet.ts          ← 移动/重命名文件
```

**pi-hashline-edit — JSON + 多样化操作**

```json
{
  "path": "src/main.ts",
  "edits": [
    { "op": "replace", "pos": "12#MQ", "lines": ["const x = 1;"] },
    { "op": "replace", "pos": "5#VR", "end": "8#QV", "lines": ["..."] },
    { "op": "append", "pos": "8#VR", "lines": ["import { foo }..."] },
    { "op": "prepend", "lines": ["// Header comment"] },
    { "op": "replace_text", "oldText": "var x = 1", "newText": "const x = 1" }
  ]
}
```

**pi-hashline-edit-pro — JSON + 单一操作**

```json
{
  "path": "src/main.ts",
  "changes": [
    { "content_lines": ["const x = 1;"], "hash_range_inclusive": ["MQX", "MQX"] },
    { "content_lines": [], "hash_range_inclusive": ["F4T", "ZPM"] }
  ]
}
```

### 4.2 Block 操作——oh-my-pi 的独特优势

oh-my-pi 的 `SWAP.BLK N:` 通过 tree-sitter 将第 N 行所在的**完整语法块**解析出来，模型不需要计算精确的起止行号。无论目标函数是 3 行还是 30 行，tree-sitter 精确解析从 `function` 到 `}` 的完整范围。

**这是三个实现中唯一具备语法感知能力的设计**。两个逐行哈希实现全是纯行级编辑，无语法感知。

### 4.3 操作多样性——pi-hashline-edit 的优势

pi-hashline-edit 提供五种操作类型：

| 操作 | 说明 |
|------|------|
| `replace` + pos | 替换单行 |
| `replace` + pos + end | 替换范围 |
| `append` + (pos?) | 在某行后（或 EOF）插入 |
| `prepend` + (pos?) | 在某行前（或 BOF）插入 |
| `replace_text` | 精确字符串匹配替换 |

相比之下，oh-my-pi 的 DSL 语法虽然表达能力更强（含 block 和文件操作），但模型学习成本更高。pi-hashline-edit-pro 只有一种 replace 操作，append/prepend 需要通过变通方式实现。

---

## 五、功能全景对比

### 5.1 核心机制

| 维度 | oh-my-pi | pi-hashline-edit | pi-hashline-edit-pro |
|---|---|---|---|
| 哈希粒度 | 全文件 → 4-hex | 逐行上下文感知 → 2/3/4 char | 逐行内容 → 3 char |
| 碰撞空间 | 16-bit | 上下文 + textHint 双重防护 | 18-bit + 退避 |
| 锚点格式 | `[path#TAG]` header | `LINE#HASH[:textHint]` | `HASH`（无行号） |
| 失效范围 | 全局 | ±1 行 | 编辑行 |
| 恢复策略 | Recovery（anchor remapping） | 3-way merge（多版本快照） | stable hash mapping |

### 5.2 编辑操作

| 维度 | oh-my-pi | pi-hashline-edit | pi-hashline-edit-pro |
|---|---|---|---|
| 行级操作 | SWAP/DEL/INS | replace/append/prepend/replace_text | replace |
| 块级操作（tree-sitter） | ✅ | ❌ | ❌ |
| 文件操作 | REM / MV | ❌ | ❌ |

### 5.3 容错机制

| 维度 | oh-my-pi | pi-hashline-edit | pi-hashline-edit-pro |
|---|---|---|---|
| Stale Anchor 恢复 | ✅ anchor remapping | ✅ 3-way merge | ❌（stable hash 补偿） |
| Noop Loop Guard | ❌ | ✅ ≥3 次抛错 | ❌ |
| Duplicate Edit 检测 | ❌ | ✅ | ❌ |
| Boundary Repair | ✅ ~1200 行引擎 | ⚠️ 简化版 | ⚠️ 简化版 + autoFix |
| 方言归一化 | ❌ | ✅ | ❌ |
| textHint 校验 | ❌ | ✅ | ❌ |

### 5.4 用户体验

| 维度 | oh-my-pi | pi-hashline-edit | pi-hashline-edit-pro |
|---|---|---|---|
| Undo | ❌ | ❌ | ✅ |
| Grep（带锚点） | ❌ | ✅ | ❌ |
| Auto-Read | ❌ | ❌ | ✅ |
| Raw Read（省 token） | ❌ | ✅ | ❌ |
| Flat Mode | ❌ | ❌ | ✅ |
| Diff 预览 | ✅ | ✅ | ✅ |
---

## 六、piex/hashline 的选择

### 6.1 当前架构：以 oh-my-pi 为引擎

[piex/hashline](https://github.com/piex-dev/piex/tree/main/packages/hashline) 选择 **oh-my-pi 作为核心引擎**，在此基础上做 Node.js 适配。这个选择保留了 oh-my-pi 最独特的两个能力：

- **tree-sitter block 操作**（`SWAP.BLK`/`DEL.BLK`/`INS.BLK.POST`）：四个实现中唯一具备语法感知的编辑方式
- **boundary repair 引擎**（~1200 行）：自动修复模型编辑时的边界错误（boundary echo、delimiter imbalance、JSX closer 等）

### 6.2 四库功能对比

将 [piex/hashline](https://github.com/piex-dev/piex/tree/main/packages/hashline) 放入对比，可以直观看到它从 oh-my-pi 继承了什么，又从另两个实现中可以借鉴什么：

| 维度 | oh-my-pi | **piex/hashline** | pi-hashline-edit | pi-hashline-edit-pro |
|---|---|---|---|---|
| **引擎来源** | 自身 | **封装 oh-my-pi** | 独立重写 | 从零实现 |
| **代码规模** | ~3500 行 | **~200 行（封装层）** | ~4000 行 | ~3500 行 |
| **哈希粒度** | 全文件 → 4-hex | **同 oh-my-pi** | 逐行上下文感知 | 逐行内容 |
| **锚点格式** | `[path#TAG]` | **同 oh-my-pi** | `LINE#HASH:textHint` | `HASH`（无行号） |
| **Block 操作（tree-sitter）** | ✅ | **✅ 继承** | ❌ | ❌ |
| **文件操作（REM/MV）** | ✅ | **✅ 继承** | ❌ | ❌ |
| **Boundary Repair** | ✅ ~1200行引擎 | **✅ 继承** | ⚠️ 简化版 | ⚠️ + autoFix |
| **Stale Anchor 恢复** | ✅ Recovery | **❌** | ✅ 3-way merge | ❌ |
| **Noop Loop Guard** | ❌ | **❌** | ✅ ≥3次抛错 | ❌ |
| **Duplicate Edit 检测** | ❌ | **❌** | ✅ | ❌ |
| **方言归一化** | ❌ | **❌** | ✅ | ❌ |
| **textHint 校验** | ❌ | **❌** | ✅ | ❌ |
| **多版本快照** | ❌ | **❌** | ✅ LRU | ❌ |
| **append/prepend ops** | ✅（INS语法） | **✅ 继承** | ✅ 原生 JSON | ❌ |
| **replace_text** | ❌ | **❌** | ✅ 可配置 | ❌ |
| **Undo** | ❌ | **❌** | ❌ | ✅ |
| **Auto-Read** | ❌ | **❌** | ❌ | ✅ |
| **Grep（带锚点）** | ❌ | **❌** | ✅ | ❌ |
| **Raw Read** | ❌ | **❌** | ✅ | ❌ |
| **Flat Mode** | ❌ | **❌** | ❌ | ✅ |
| **Diff 预览** | ✅ | **✅ 继承** | ✅ | ✅ |

结论很清晰：**继承层全 ✅，容错层全 ❌**。piex/hashline 完美继承了 oh-my-pi 最独特的编辑能力（block 操作 + boundary repair），但在模型行为容错方面完全空白——每一次 ❌ 都是一次可借鉴的改进机会。

### 6.3 当前缺口：容错层空白

[piex/hashline](https://github.com/piex-dev/piex/tree/main/packages/hashline) 直接暴露了 oh-my-pi 的 Patcher 接口，但没有在外层构建任何容错机制：

| 缺失的容错能力 | 最佳参考来源 |
|--------------|------------|
| Noop Loop Guard | pi-hashline-edit |
| Duplicate Edit 检测 | pi-hashline-edit |
| Stale Anchor 恢复 | pi-hashline-edit（3-way merge）或 oh-my-pi（Recovery） |
| 方言归一化 | pi-hashline-edit |
| 多版本快照 | pi-hashline-edit |

这些特性都可以在 patcher 外层实现，不需要修改 oh-my-pi 内部。

### 6.4 路线图

按投入产出比排序：

```
Phase 1 — 低投入高产出（总计约 180 行）：
  ├── Noop Loop Guard         (~50行)  pi-hashline-edit 方案：计数器抛错
  ├── Duplicate Edit 检测      (~30行)  pi-hashline-edit 方案：payloadKey 记录
  └── 方言归一化              (~100行) pi-hashline-edit 方案：prepareArguments

Phase 2 — 中等投入，显著提升可靠性（总计约 550 行）：
  ├── Stale Anchor 恢复        (~150行) pi-hashline-edit 方案：3-way merge
  ├── 多版本快照存储           (~100行) pi-hashline-edit 方案：LRU 替代单版本
  └── Grep 工具（带锚点）      (~300行) pi-hashline-edit 方案

Phase 3 — 锦上添花：
  ├── Undo 工具               pi-hashline-edit-pro 方案
  ├── Auto-Read               pi-hashline-edit-pro 方案
  ├── Raw Read 模式            pi-hashline-edit 方案
  └── Stable Hash Mapping     pi-hashline-edit-pro 方案
```

---

## 七、参考资料

- [oh-my-pi hashline](https://github.com/can1357/oh-my-pi/tree/main/packages/hashline)
- [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) — 含 7 个 ADR 文档
- [pi-hashline-edit-pro](https://github.com/YuGiMob/pi-hashline-edit-pro)
- pi-hashline-edit 关键 ADR：
  - [0001: Keep Two-Character Hashlines](https://github.com/RimuruW/pi-hashline-edit/blob/main/docs/adr/0001-keep-two-character-hashlines.md)
  - [0003: Context-Based Line Hashing](https://github.com/RimuruW/pi-hashline-edit/blob/main/docs/adr/0003-context-based-line-hashing.md)
  - [0004: Snapshot-Merge Recovery](https://github.com/RimuruW/pi-hashline-edit/blob/main/docs/adr/0004-snapshot-merge-recovery.md)
  - [0005: Multi-Version Snapshot History](https://github.com/RimuruW/pi-hashline-edit/blob/main/docs/adr/0005-multi-version-snapshot-history.md)
