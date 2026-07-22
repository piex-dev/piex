# goal

自主目标完成扩展 — 设定目标后从空闲边界自动续跑，直到用证据证明完成、遇到真实阻塞、或 token 预算耗尽。

## 功能

- **`/goal` 命令**：启动 / 查看 / 编辑 / 暂停 / 恢复 / 清除目标，支持 `--tokens` 预算
- **`agent_settled` 续跑**：只在 agent 真正空闲（retry/compaction/steering/follow-up 排干）时派发续跑，不重复入队
- **`goal_complete` 工具**：完成调用须带当前 `goal_id`（stale 守卫）+ 完成证据摘要（拒绝矛盾摘要）
- **`goal_blocked` 工具**：真实阻塞通道，要求 reason/evidence + 同一阻塞连续复发 ≥ 3 轮
- **owned-prompt marker + stale tool-call block**：防陈旧续跑盖过新 goal
- **token 预算 wrap-up**：预算耗尽转 `budget_limited`，排一条 bounded 总结指令，禁 substantive 工具防死循环
- **状态机**：`active / paused / blocked / usage_limited / budget_limited / complete`，区分用户暂停、真实阻塞、provider 限额、用户预算耗尽
- **session-entry 持久化**：`pi.appendEntry`（customType `goal-state`），reload 可恢复
- **`toolVisibility` 策略**：`always`（默认）或 `after-first-goal`（首次激活后才显露工具，保持非 goal 会话 prompt-cache 稳定）

## 使用说明

```bash
pi install npm:@piex-dev/goal
```

命令：

```text
/goal                          # 查看当前目标、状态、轮数、用时、token
/goal implement snake game     # 启动 goal 模式
/goal --tokens 100k fix tests  # 带 token 预算启动
/goal edit ship smaller fix    # 改目标，保留计数
/goal pause                    # 暂停续跑
/goal resume                   # 恢复
/goal clear                    # 清除目标
```

`--tokens` 支持 `k`/`m` 后缀（`100k`、`1.5m`）。目标文本上限 4000 字符，超长请放文件里再在 `/goal` 引用路径。

配置（可选，`~/.pi/piex-dev/goal/goal.json`）：

```json
{
  "toolVisibility": "always"
}
```

`toolVisibility`：`"always"`（默认，工具恒在 schema）或 `"after-first-goal"`（首次激活或恢复未完成 goal 后才显露）。非法配置回退默认并告警，扩展不自动建文件。

冒烟测试：

```bash
pi -e ./extensions/goal/src/goal.ts -p "what is 1+1" --no-session
```

## 依赖

- `@earendil-works/pi-coding-agent`（peer）
- `@earendil-works/pi-ai`（peer，Usage 类型）
- `typebox`（peer，工具参数 schema）

## 延伸阅读

- https://piex.dev/zh/packages/goal/
