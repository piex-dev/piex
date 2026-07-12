# pie-review

代码评审扩展 — `/review` 交互命令 + LLM 可调用的 `review` 工具。

## 功能

- **/review 命令**: 交互式菜单选择评审源
- **review 工具**: LLM 可直接调用，返回结构化 diff + prompt
- **Diff 解析**: 解析 unified diff，统计 +/− 行数
- **噪声过滤**: 自动排除 lock/min/build/vendor/image/binary 文件
- **多模式**: uncommitted / staged / branch / commit / custom

## 架构

```
review.ts                      # pi 扩展入口 (330 行)
├── /review 命令               #   交互式菜单
├── review 工具                #   LLM 可调用
├── Diff 引擎                  #   Git diff 解析 + 噪声过滤
├── 评审模式                    #   uncommitted/staged/branch/commit/custom
└── Prompt 生成                 #   结构化 markdown prompt
```

## 噪声过滤

自动排除：lock 文件、构建产物、vendor、minified、generated、source map、图片/字体、二进制

## 安装

```bash
pi install npm:@debugtalk/pie-review
pi -e ./extensions/review.ts
```

## 前提条件

- 项目必须是 git 仓库，系统已安装 git

## 与 omp review 的差异

| omp review | pie-review (轻量版) |
|-----------|-------------------|
| 多 agent 并行评审 | 当前 agent 直接评审 |
| TUI overlay 展示结果 | 文本输出 |
| Diff 解析 + 噪声过滤 | ✅ 完整移植 |
| 四种评审模式 | ✅ 完整移植 |
| 结构化 prompt 模板 | ✅ 精简移植 |

## 来源

功能特性来自 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的 `/review` 命令和 review 工具。
