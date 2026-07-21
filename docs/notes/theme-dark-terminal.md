---
title: Dark Terminal 主题：把 pi 涂成一台真正的终端
date: 2026-07-19
tags: [Theme, TUI, UX]
---

> 想把 pi 看成一台认真的黑客终端，而不是通用灰蓝面板：装上 Dark Terminal，`/settings` 切一下即可，行为逻辑零改变。

## 问题背景

Coding agent 的 TUI 是你每天盯最久的界面之一。默认主题追求「通用好读」，但不一定符合所有人的审美与环境：

- 有人要在暗光下长时间看 diff，需要更高对比
- 有人习惯经典终端：黑底、荧光绿、警告纯红、链接亮蓝
- 主题若只能改编辑器、改不了 agent TUI，割裂感很强

`@piex-dev/theme-dark-terminal` 不做任何 TypeScript 逻辑，只提供一份 **pi 官方主题 schema** 下的 JSON：把整套 UI token 映射成高对比「暗终端」调色板。

来源：[opencode-themes/dark-terminal](https://github.com/debugtalk/opencode-themes) 的色彩角色，适配到 pi 的 token 名。

```bash
pi install npm:@piex-dev/theme-dark-terminal
# 然后 /settings → theme: dark-terminal
```

---

## 技术原理

### 1. pi 的主题是数据，不是插件代码

扩展包可以挂 `extensions/*.ts`；主题包挂的是：

```json
{
  "pi": {
    "themes": ["./themes"]
  }
}
```

pi 启动时扫描 `themes/*.json`，校验 name + colors，在 `/settings` 里可选。  
**零运行时、零 hook**：换主题不会改变 agent 行为，只改变「怎么画」。

### 2. Token 分层：vars → colors

典型结构：

```json
{
  "name": "dark-terminal",
  "vars": {
    "green": "#00ff00",
    "bg": "#050505",
    ...
  },
  "colors": {
    "accent": "green",
    "error": "red",
    "toolDiffAdded": "green",
    ...
  }
}
```

- `vars`：调色板原子色（可复用）
- `colors`：语义 token → 指向 var 名或颜色

好处：改一个 `green`，accent、success、diff added、部分 markdown 标题可以一起变，保持风格一致。

### 3. 语义映射比「好看」更重要

主题的工作不是随机上色，而是回答：

- 什么是主强调？（accent）
- 什么是成功/失败/警告？
- diff 加行/删行怎么分色？
- markdown 标题、链接、代码语法如何分层？
- thinking 强度从低到高如何递进？

Dark Terminal 的选择非常「终端原教旨」：

| 角色   | 颜色                 | 用在                                  |
| ------ | -------------------- | ------------------------------------- |
| 主强调 | `#00ff00` 绿         | accent、success、部分语法与 diff 加行 |
| 结构   | `#00aaff` 蓝         | border、链接、keyword                 |
| 信息   | `#00ffcc` 青         | 次强调边框、变量、中等 thinking       |
| 错误   | `#ff0000` 红         | error、string、高 thinking            |
| 警告   | `#ffff00` 黄         | warning、function                     |
| 背景   | `#050505` / 略抬面板 | 页面与 panel                          |

没有渐变、没有莫兰迪：要的就是 CRT 式可读冲击力。

---

## 实现方案

包路径：[`themes/theme-dark-terminal`](https://github.com/piex-dev/piex/tree/main/themes/theme-dark-terminal)。

```
package.json
README.md
themes/dark-terminal.json
```

### 安装路径的坑（重要）

AGENTS.md 里特别强调：

- **全局安装请用绝对路径**，否则 `/reload` 后相对路径按 settings 文件位置解析，主题可能「丢了」
- 项目级：`pi install -l ./themes/theme-dark-terminal` 更稳

npm 包安装（`pi install npm:@piex-dev/theme-dark-terminal`）走包管理路径，一般比手写相对路径省心。

### 覆盖范围

JSON 按 pi theme schema 填齐必需 color token（数十个），包括：

- 通用：accent / border* / success / error / warning / muted / text
- 消息：user/custom message 背景与文字
- 工具：pending/success/error 背景、diff 加减行
- Markdown：标题、列表、链接、引用线、hr
- Syntax：keyword/string/function/type/number/…
- Thinking：从 off → max 的一串强度色（最高档用了亮粉 `#ff0088`，原 dark-terminal 无直接对应，属于 pi 侧增量）

### 与「功能扩展」的边界

主题包**刻意**不做：

- 不注册 tool/command
- 不读文件、不碰网络
- 不依赖 Node API

因此它是 piex 七包里风险面最小、也最适合当「扩展分发机制」示例的一员：证明 piex 不只是工具插件，也是 pi 包生态的一部分。
---

## 设计参考

| 项目                              | 机制                                                                      | piex 取舍                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **opencode-themes dark-terminal** | 51 color token 的高对比暗终端配色；`bg: #050505`、green/blue/red 强调色系 | **采纳**：色彩角色与语义映射（accent → 绿、error → 红、diff 加行 → 绿）。**适配**pi 的额外 token（thinking gradient 强度色 `#ff0088` 为 pi 侧增量） |
| **pi theme schema**               | `vars` → `colors` 两层映射；`pi.themes` JSON 分发；零代码热加载           | **完全遵循**：只提供静态 JSON，不写 TS、不走 hook                                                                                                   |

核心取舍：不做代码、不改行为、不绑宿主终端；只把 opencode-themes 的色板翻译到 pi 的 token 名上。

## 优化计划

主题包风险面小，迭代也该小步、可验证：

1. **只有强对比暗色一款**  
   亮环境刺眼，色弱友好也未覆盖。  
   → 同系列变体：`dark-terminal-soft`（降饱和）、色弱安全分支。

2. **改色靠肉眼**  
   JSON → reload → 扫一眼，缺少 token 对照与截图基线。  
   → token 说明表（每个语义色对应哪块 UI）+ 本地/可选 CI 视觉回归。

3. **与终端模拟器主题叠层**  
   pi 内着色与 iTerm/Warp 外层可能「套娃」。  
   → 文档给出推荐外层配置，而不是试图控制宿主终端。

4. **跟 pi schema 演进**  
   上游新增 color token 时旧主题可能缺键。  
   → 版本说明里跟 schema；缺键时降级策略写清楚。

5. **主题资产仍偏手工**  
   从 opencode-themes 批量映射尚未产品化。  
   → 建角色映射表，一键生成多个 piex 主题包；settings 深链减少「装了找不到」。
