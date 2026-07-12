# pie-hashline

基于 `@oh-my-pi/hashline` 的 hashline 编辑语言扩展，覆盖 pi 内置 `edit` 工具。

## 功能

- **覆盖 edit 工具**: 内置 `edit` 替换为 hashline 语法解析 + 应用
- **read hook**: 读取文件后自动注入 `[PATH#TAG]` header，为后续编辑提供锚点
- **快照验证**: 编辑时验证 `#TAG` 与文件内容一致，防止并发修改冲突

## 架构

```
hashline.ts                    # pi 扩展入口
├── bun-polyfill.ts            # Node.js Bun API polyfill
│   ├── Bun.file → fs.readFile
│   ├── Bun.write → fs.writeFile
│   └── Bun.hash.xxHash32 → 纯 JS xxHash32
├── @oh-my-pi/hashline (依赖)
│   ├── Patch.parse()          # 解析 hashline 输入
│   ├── Patcher.apply()        # 应用编辑
│   ├── InMemorySnapshotStore  # 快照管理
│   ├── formatHashlineHeader   # 格式化 [PATH#TAG]
│   └── normalizeToLF, stripBom
└── pi ExtensionAPI
    ├── pi.registerTool("edit") # 覆盖内置 edit
    └── pi.on("tool_result")   # Hook read 结果
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
5. Patcher 验证 #A1B2 匹配 → 应用编辑
6. 返回新 tag: #C3D4
```

## 运行时兼容

| 环境 | 方式 |
|------|------|
| Node.js | bun-polyfill.ts 注入全局 + 动态 `import("@oh-my-pi/hashline")` |
| Bun | 原生 Bun API，无需 polyfill |

## 安装

```bash
cd packages/pie-hashline && npm install
pi -e ./extensions/hashline.ts
```

或通过 npm：

```bash
pi install npm:@debugtalk/pie-hashline
```

## 依赖

- `@oh-my-pi/hashline` ^16.4.0
- `@earendil-works/pi-coding-agent` (peer)
- `typebox` (peer)

## 来源

功能特性来自 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的 `packages/hashline`。
