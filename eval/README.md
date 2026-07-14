# 评测工具

piex eval 是 pi/piex/omp 三位一体评测框架，量化 piex 对 pi 的提升幅度。

## 快速开始

```bash
cd piex/eval && npm install
```

### 1. 构建 Docker 镜像

```bash
npm run build:pi      # pi 基础镜像
npm run build:omp     # omp 镜像
npm run build:swebench # SWE-bench 镜像
```

### 2. 运行评测

```bash
# 运行全部三个 Agent（pi bare + pi+piex + omp）
npm run run -- run -b aider-polyglot

# 仅运行 pi 系列对比
npm run run -- run -b aider-polyglot -a pi-bare,pi-piex

# 指定任务文件
npm run run -- run -b aider-polyglot -s fixtures/tasks/custom.jsonl

# 指定输出目录
npm run run -- run -b aider-polyglot -o results
```

### 3. 查看结果

报告生成在 `results/YYYY-MM-DD/report.md`。

## 目录结构

```
eval/
├── README.md
├── package.json
├── tsconfig.json
├── docker/
│   ├── pi.Dockerfile      # pi 基础镜像（共享）
│   ├── omp.Dockerfile     # omp 镜像
│   └── swebench.Dockerfile
├── src/
│   ├── runner.ts          # CLI 入口
│   ├── orchestrator.ts    # 任务调度
│   ├── sandbox.ts         # Docker 容器管理
│   ├── types.ts           # 共享类型
│   ├── metrics.ts         # 指标计算
│   ├── report.ts          # 报告生成
│   ├── agents/
│   │   ├── pi.ts          # pi bare + piex 运行器
│   │   └── omp.ts         # omp 运行器
│   └── benchmarks/
│       └── aider-polyglot.ts  # Aider Polyglot 数据集
├── results/               # .gitignored
└── fixtures/
    └── tasks/             # JSONL 任务文件
```

## 任务格式 (JSONL)

每行一个 JSON 对象：

```json
{"id": "task-id", "prompt": "自然语言指令", "files": {"main.py": "初始代码"}, "test_cmd": "验证命令", "language": "python"}
```
