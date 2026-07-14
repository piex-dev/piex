import { program } from 'commander'
import { evaluate } from './orchestrator.ts'
import { loadAiderPolyglot } from './benchmarks/aider-polyglot.ts'
import { loadSWEBenchLite } from './benchmarks/swebench.ts'
import { generateReport } from './report.ts'
import { resolve } from 'node:path'

program
  .name('piex-eval')
  .description('piex evaluation harness — compare pi bare vs pi+piex vs omp')

program
  .command('run')
  .description('Run evaluation')
  .option('-b, --benchmark <name>', 'benchmark name', 'aider-polyglot')
  .option('-a, --agents <list>', 'agents to run (comma-separated: pi-bare,pi-piex,omp)', 'pi-bare,pi-piex,omp')
  .option('-m, --model <model>', 'model (provider:model-id)', 'deepseek:deepseek-v4-flash')
  .option('-s, --source <path>', 'JSONL task file')
  .option('-c, --concurrency <n>', 'parallel task count', '3')
  .option('-l, --limit <n>', 'max number of tasks to run', Number)
  .option('-o, --output <dir>', 'output directory', 'results')
  .action(async (opts) => {
    const agents = opts.agents.split(',').map((s: string) => s.trim()) as ('pi-bare' | 'pi-piex' | 'omp')[]
    let tasks
    switch (opts.benchmark) {
      case 'aider-polyglot':
        tasks = loadAiderPolyglot(opts.source)
        break
      case 'swebench-lite':
        tasks = await loadSWEBenchLite('dev')
        break
      default:
        console.error(`Unknown benchmark: ${opts.benchmark}`)
        process.exit(1)
    }

    console.log(`\n> Running ${opts.benchmark} with agents: ${agents.join(', ')}`)

    if (opts.limit && opts.limit > 0) tasks = tasks.slice(0, opts.limit)
    console.log(`> Model: ${opts.model}`)
    console.log(`> Tasks: ${tasks.length}\n`)
    const report = await evaluate({ tasks, benchmark: opts.benchmark, agents, model: opts.model, concurrency: Number(opts.concurrency) })

    const outDir = resolve(import.meta.dirname, '..', opts.output, new Date().toISOString().slice(0, 10))
    const reportPath = generateReport(report, outDir)

    console.log(`\n> Report: ${reportPath}`)
    console.log(report.agents.map((a) => `  ${a.agent}: ${a.resolveRate}% (${a.passedTasks}/${a.passedTasks + a.failedTasks})`).join('\n'))
  })

program.parse()
