---
title: Pi Extension 机制及工作原理
date: 2026-07-14
tags: [Pi Extension]
---

## 设计哲学：为什么用 Extension 而不是内置特性？

Pi 的核心理念是**极致可扩展，最小化核心**。其他 AI 编码助手内置的特性（Plan Mode、Sub-agent、MCP 支持、权限弹窗、待办列表、后台 Shell），pi 全部不做。取而代之的是一套 Extension 机制，让用户按自己需要构建这些能力。

> Pi is aggressively extensible so it doesn't have to dictate your workflow.

Pi 内核只做最小的事：四种基础工具（read、write、edit、bash）加上基本 TUI。所有高级特性都是通过 Extension 实现的，不侵入核心代码。

---

## 三层架构

Extension 机制由三层核心模块组成：

```
  ExtensionFactory（用户写的 default export）
              │
              ▼
┌──────────────────────────────────────────┐
│  loader.ts  —  加载 & 发现 & API 工厂     │
│                                          │
│  1. 发现扩展路径（全局/项目/配置）          │
│  2. jiti 运行时加载 TypeScript            │
│  3. 执行工厂函数 → 填充 Extension 对象      │
│  4. 创建共享 ExtensionRuntime             │
└──────────────┬───────────────────────────┘
               │ Extensions[] + Runtime
               ▼
┌──────────────────────────────────────────┐
│  runner.ts —  编排 & 事件分发             │
│                                          │
│  1. bindCore() 将真实实现注入 Runtime      │
│  2. createContext() 构造 ExtensionContext │
│  3. 按扩展加载顺序逐一分发事件              │
│  4. 错误隔离                              │
└──────────────┬───────────────────────────┘
               │ AgentTools
               ▼
┌──────────────────────────────────────────┐
│  wrapper.ts — 工具包装                    │
│                                          │
│  注册的 ToolDefinition → AgentTool        │
└──────────────────────────────────────────┘
```

---

## 一、加载层（loader.ts）

### 1.1 运行时依赖解析

Pi Extension 是 TypeScript 文件，通过 **[jiti](https://github.com/unjs/jiti)** 在运行时直接加载，不需要编译步骤。关键是模块别名系统：

```typescript
// Bun 二进制模式：virtualModules 直接注入模块缓存
const jiti = createJiti(import.meta.url, {
  ...(isBunBinary
    ? { virtualModules: VIRTUAL_MODULES, tryNative: false }
    : { alias: getAliases() }),
});
```

| 模式 | 解析方式 | 说明 |
|------|---------|------|
| Bun 二进制 | `virtualModules` | 将 pi 系列包（typebox、pi-agent-core、pi-tui、pi-coding-agent）直接注入 jiti 模块缓存，不依赖文件系统 |
| Node.js/开发 | `alias` | 映射到本地 workspace 路径 |

这意味着扩展中的 `import { ExtensionAPI } from "@earendil-works/pi-coding-agent"` 在运行时会被重定向到 pi 内部的打包实例，保证版本一致性。

### 1.2 扩展发现

`discoverAndLoadExtensions()` 按优先级从三个位置扫描：

| 优先级 | 位置 | 作用域 |
|--------|------|--------|
| 1 | `{cwd}/.pi/extensions/` | 项目级（需信任项目） |
| 2 | `~/.pi/agent/extensions/` | 全局（所有项目） |
| 3 | `settings.json` 中 `extensions` 字段 | 显式配置 |

每个目录的解析规则（不递归，只一层）：

```
extensions/
├── my-ext.ts          → 直接作为扩展加载（单文件）
├── my-ext.js          → 直接作为扩展加载
├── my-package/        → 子目录：
│   ├── package.json   → 优先读 pi.extensions 字段
│   ├── index.ts       → 无 package.json 时作为入口
│   └── index.js       → 无 index.ts 时作为入口
└── with-deps/         → 有 npm 依赖的子目录
    ├── package.json   → 支持 dependencies
    ├── node_modules/  → npm install 后可用
    └── src/
        └── index.ts
```

### 1.3 Extension 对象模型

每个扩展加载后生成一个 `Extension` 对象，所有 `pi.registerXxx()` 调用最终落盘到这些 Map：

```typescript
interface Extension {
  sourceInfo: SourceInfo;       // 来源信息（路径、scope、origin）
  handlers:        Map<string, Function[]>     // 事件处理器
  tools:           Map<string, RegisteredTool> // 注册的工具
  commands:        Map<string, RegisteredCommand> // 注册的命令
  flags:           Map<string, ExtensionFlag>  // CLI 标志
  shortcuts:       Map<string, ExtensionShortcut> // 键盘快捷键
  messageRenderers: Map<string, Function>      // 自定义消息渲染器
  entryRenderers:  Map<string, Function>       // 自定义条目渲染器
}
```

**数据所有权清晰**：每个扩展的数据存在自己的 Extension 对象里，不共享。

### 1.4 ExtensionAPI 的两层委托设计

`createExtensionAPI()` 构造 `pi` 对象时，将方法分为两类，走不同的委托路径：

```
pi.registerTool()    ──→  extension.tools.set()       （数据归 Extension）
pi.on("event", fn)   ──→  extension.handlers.get().push()
pi.registerCommand() ──→  extension.commands.set()

pi.sendMessage()     ──→  runtime.sendMessage()       （委托到共享 Runtime）
pi.sendUserMessage() ──→  runtime.sendUserMessage()
pi.setSessionName()  ──→  runtime.setSessionName()
pi.setActiveTools()  ──→  runtime.setActiveTools()
pi.exec()            ──→  runtime（直接调 execCommand）
```

**为什么这么设计？**

- **注册类方法**的操作对象是扩展本身的数据，天然应该归属 Extension。
- **行动类方法**需要与 pi 的会话系统交互（发送消息、修改工具集、创建 session 条目等），它们需要一个全局共享的后端。

### 1.5 ExtensionRuntime：共享的延迟绑定容器

`ExtensionRuntime` 是所有扩展共享的一个可变对象。初始化时所有 action 方法都是 **throwing stub**：

```typescript
const notInitialized = () => {
  throw new Error(
    "Extension runtime not initialized. " +
    "Action methods cannot be called during extension loading."
  );
};

const runtime: ExtensionRuntime = {
  sendMessage: notInitialized,
  sendUserMessage: notInitialized,
  appendEntry: notInitialized,
  setSessionName: notInitialized,
  getActiveTools: notInitialized,
  setActiveTools: notInitialized,
  // ...
};
```

这确保了**扩展加载期间是纯声明阶段**，不能执行副作用操作。stub 在 `bindCore()` 阶段被替换为真实的 AgentSession 实现。

**Provider 注册特别处理**：`pi.registerProvider()` 在加载期间调用不会立即执行，而是压入 `pendingProviderRegistrations` 队列，在 `bindCore()` 时批量冲刷。这样即使 ModelRegistry 尚未就绪，也能正常注册。

### 1.6 扩展工厂缓存

```typescript
const extensionCache = new Map<string, ExtensionFactory>();
```

缓存基于 `cwd + generation` 计数器。切换项目目录时自动清空。`/reload` 会增加 generation，使缓存失效但不会丢失所有缓存。同一项目下多次启动无需重复编译。

---

## 二、运行层（runner.ts）

### 2.1 ExtensionRunner：事件编排的中心节点

`ExtensionRunner` 持有整个扩展系统的运行时引用：

```
extensions[]          → 所有已加载的 Extension 对象
runtime               → 共享 ExtensionRuntime（action 方法在此）
uiContext             → 模式特定的 UI 实现（TUI/RPC/Print）
sessionManager        → 只读会话状态
modelRegistry         → 模型注册表
```

### 2.2 bindCore：连接真实世界

Runner 实例化后，需要 `bindCore()` 注入真实的会话后端实现：

```typescript
runner.bindCore(
  actions,         // { sendMessage, sendUserMessage, appendEntry, ... }
  contextActions,  // { getModel, isIdle, abort, shutdown, compact, getSystemPrompt, ... }
  providerActions, // { registerProvider, unregisterProvider }（可选）
);
```

调用 `bindCore()` 后：
1. **注入 actions** → runtime 的 throwing stub 被替换为真实函数
2. **保存 context 闭包** → `getModel`、`isIdle`、`abort` 等作为闭包保存在 Runner 内部
3. **冲刷 provider 队列** → `pendingProviderRegistrations` 批量注册
4. **替换 provider 方法** → 之后 `registerProvider()`/`unregisterProvider()` 立即生效

### 2.3 createContext：懒求值 ExtensionContext

`createContext()` 返回的 `ExtensionContext` 使用 **getter 设计**，每次属性访问时实时从 Runner 获取最新值：

```typescript
createContext(): ExtensionContext {
  return {
    get ui() { return runner.uiContext; },          // ← getter，不是闭包快照
    get cwd() { return runner.cwd; },
    get model() { return getModel(); },
    get sessionManager() { return runner.sessionManager; },
    get signal() { return runner.getSignalFn(); },  // 每次获取最新的 AbortSignal
    isIdle: () => runner.isIdleFn(),
    compact: (opts) => runner.compactFn(opts),
  };
}
```

**为什么用 getter？** 当 session 切换或 reload 后，Runner 的 `cwd`、`sessionManager`、`model` 等引用会更新。如果使用闭包快照，旧 ctx 会持有过时引用。getter 确保每次访问都是最新的。

对于 `ExtensionCommandContext`，额外用 `Object.defineProperties` 保留父类 getter，再追加 `waitForIdle`、`newSession`、`fork`、`switchSession` 等会话控制方法。

### 2.4 事件分发的三种模式

事件分发按**扩展加载顺序**串行迭代（全局 → 项目 → 配置路径）。同一扩展注册的多个同名 handler 也按注册顺序执行。

**错误隔离**：每个 handler 包裹在 try-catch 中，异常通过 `emitError()` 通知监听器（TUI 中显示 warning），**绝不向上传播**，一个扩展的 bug 不会让 pi 崩溃。

---

**模式 A：Fire-and-forget**

适用于 `session_start`、`model_select`、`agent_start`、`turn_start`、`turn_end`、`message_start`、`tool_execution_start`、`thinking_level_select` 等 30+ 种事件。逐个 handler 调用，返回值忽略。

```typescript
async emit(event) {
  for (const ext of this.extensions) {
    for (const handler of ext.handlers.get(event.type) ?? []) {
      try { await handler(event, ctx); }
      catch (err) { this.emitError(...); }
    }
  }
}
```

---

**模式 B：First-cancel-wins（可中断事件）**

适用于 `session_before_switch`、`session_before_fork`、`session_before_compact`、`session_before_tree`。任一 handler 返回 `{ cancel: true }` 即**停止后续分发**，整个操作被取消。

```typescript
async emit(event) {
  for (const ext of this.extensions) {
    for (const handler of handlers) {
      const result = await handler(event, ctx);
      if (result?.cancel) return result;  // ← 立即返回，不再继续
    }
  }
}
```

---

**模式 C：Chain（链式转换）**

适用于 `tool_result`、`message_end`、`context`、`before_agent_start`、`before_provider_request`。handler 的修改**累积传递**，下一个 handler 看到的是上一个修改后的版本。

以 `tool_result` 为例：

```typescript
async emitToolResult(event) {
  const currentEvent = { ...event };  // ← 可变副本

  for (const ext of this.extensions) {
    for (const handler of handlers) {
      const result = await handler(currentEvent, ctx);
      // 逐字段覆盖
      if (result?.content)  currentEvent.content  = result.content;
      if (result?.details)  currentEvent.details  = result.details;
      if (result?.isError)  currentEvent.isError  = result.isError;
    }
  }

  return { content, details, isError };  // ← 最终合并结果
}
```

`before_agent_start` 的实现更特殊：它重载了 `ctx.getSystemPrompt()`，让每个 handler 的 `event.systemPrompt` 反映前面 handler 修改过的版本，实现真正的链式 system prompt 编辑。

### 2.5 快捷键冲突检测

`getShortcuts()` 检查扩展注册的快捷键与内置保留快捷键的冲突：

| 级别 | 处理 |
|------|------|
| `restrictOverride: true` | 完全禁止覆盖（如 `Ctrl+C` 退出），输出 warning 并跳过 |
| `restrictOverride: false` | 允许覆盖但输出 info 警告 |
| 扩展间冲突 | 后注册覆盖先注册，输出 warning |

### 2.6 Stale Context 保护

Session 切换、fork、reload 后，旧的 `pi` 和 `ctx` 必须失效。Runner 的 `invalidate()` 会标记 stale，之后任何对 stale ctx 的操作都抛异常：

```typescript
invalidate(message) {
  this.runtime.invalidate(message);  // ← 所有 action 方法变 throwing
}
```

这防止了扩展在 Session 替换后误用旧引用，而这是最容易出 bug 的地方。

---

## 三、包装层（wrapper.ts）

### 3.1 工具注册到 Agent 工具

扩展注册的工具通过 `wrapRegisteredTool()` 包装成 `AgentTool`（符合 agent-core 协议）。关键细节：

```typescript
export function wrapRegisteredTool(registeredTool, runner) {
  const tool = wrapToolDefinition(registeredTool.definition,
    () => runner.createContext());  // ← 每次执行时创建新 context

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const activeBefore = runner.getActiveTools();
      const result = await execute(toolCallId, params, signal, onUpdate);
      const activeAfter = runner.getActiveTools();

      // 检查工具执行过程中是否动态注册了新工具
      const addedToolNames = activeAfter.filter(n => !activeBefore.has(n));
      if (addedToolNames.length > 0) {
        return { ...result, addedToolNames };  // ← 通知系统刷新工具集
      }
      return result;
    },
  };
}
```

这意味着：扩展工具可以在执行期间调用 `pi.registerTool()` 动态注册新工具，系统会自动感知并在下一轮 LLM 调用中包含新工具。

### 3.2 内置工具覆盖

扩展注册与内置工具同名的工具即可覆盖（如 `read`、`bash`、`edit`）。覆盖的渲染槽位如果省略，会自动继承内置实现（`renderCall`/`renderResult`），这让日志/权限包装类扩展只需写 execute 逻辑，不用重写 UI。

---

## 四、完整生命周期

```
1. 启动 → discoverAndLoadExtensions()
   │
   ├─ 扫描 .pi/extensions/、~/.pi/agent/extensions/
   ├─ jiti 加载 .ts 文件
   ├─ factory(pi) 执行 → 填充 handlers/tools/commands/... Map
   └─ 返回 { extensions[], runtime }

2. AgentSession 初始化
   │
   ├─ new ExtensionRunner(extensions, runtime, ...)
   ├─ runner.bindCore(actions, contextActions)     ← 注入真实实现
   ├─ runner.bindCommandContext(commandActions)    ← 注入会话控制
   └─ runner.setUIContext(tuiUIContext)            ← 注入 TUI 实现

3. project_trust（仅用户/全局扩展参与）
   └─ 返回 "yes"/"no"/"undecided"，控制项目信任

4. session_start
   └─ runner.emit({ type: "session_start" })

5. resources_discover
   └─ 扩展可提供额外的 skill/prompt/theme 路径

   ═══════════ 用户输入 → 以下循环 ═══════════

6. input pipeline:
   ├─ 扩展命令 (/cmd) 匹配检查 → 如果是命令，直接执行并跳过后续
   ├─ runner.emitInput(text) → 链式 transform / handled
   ├─ skill/template 展开
   └─ 如果未被 handled → 进入 agent loop

7. before_agent_start
   └─ 链式注入消息、修改 system prompt

8. Agent Loop（每轮 turn）:
   │
   ├─ runner.emitContext(messages)         → 链式过滤消息列表
   ├─ runner.emitBeforeProviderHeaders()   → 修改请求 HTTP 头
   ├─ runner.emitBeforeProviderRequest()   → 检查/替换 provider 请求
   ├─ runner.emitAfterProviderResponse()   → 检查 provider 响应
   ├─ LLM 调用
   │
   ├─ 对每个工具调用:
   │   ├─ runner.emitToolCall(event)       → 可 block（如拦截 rm -rf）
   │   ├─ 工具执行（内置 / 扩展）
   │   ├─ runner.emitToolResult(event)     → 链式修改结果
   │   └─ runner.emitMessageEnd(event)     → 链式修改最终消息
   │
   └─ runner.emit("turn_end")

9. agent_end → agent_settled
   └─ 所有自动重试/compaction/后续消息完成

10. 退出 / reload / session 切换:
    ├─ runner.emit("session_shutdown")
    ├─ runner.invalidate() → 标记所有旧 ctx 为 stale
    └─ 重建 ExtensionRunner → 新 session_start
```

---

## 五、设计要点总结

| 设计 | 实现 | 目的 |
|------|------|------|
| **数据归属清晰** | 注册类方法 → Extension 对象；行动类方法 → 共享 Runtime | 扩展独立，互不污染 |
| **延迟绑定** | Runtime 初建全是 throwing stub，bindCore() 后注入 | 加载阶段纯声明，无副作用 |
| **Context 懒求值** | getter 设计，每次访问实时取值 | 避免闭包快照过时 |
| **串行事件分发** | 按扩展加载顺序逐个 handler 执行 | 行为可预测 |
| **错误绝不传播** | try-catch + emitError 通知 | 单扩展 bug 不拖垮 pi |
| **三种分发模式** | Fire-and-forget / Cancel / Chain | 按事件语义选择合适策略 |
| **Stale 保护** | invalidate() 后抛异常 | 防止 session 切换后误用旧引用 |
| **Provider 注册队列** | 加载期入队，bindCore 时批量冲刷 | 解决注册时序问题 |

Pi 的 Extension 机制本质上是一个**插件化的事件驱动架构**：内核承担最少职责（四种工具 + TUI 渲染），把行为决策权全部交给 Extension 层。这种设计让 pi 能适配任意工作流，而不会强加一种特定的使用方式。
