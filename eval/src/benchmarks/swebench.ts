import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Task } from '../types.ts'

const REPO_CACHE = '/tmp/swebench-repos'
const DATASET_URL = 'https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite/resolve/main/data'

interface ParquetRow {
  repo: string
  instance_id: string
  base_commit: string
  patch: string
  test_patch: string
  problem_statement: string
  hints_text: string
  created_at: string
  version: string
  FAIL_TO_PASS: string
  PASS_TO_PASS: string
  environment_setup_commit: string
}

export async function loadSWEBenchLite(split: 'dev' | 'test' = 'dev'): Promise<Task[]> {
  const parquetFile = await downloadParquet(split)
  const rows = await readParquet(parquetFile)
  return rows.map(toTask)
}

async function downloadParquet(split: string): Promise<string> {
  mkdirSync(REPO_CACHE, { recursive: true })
  const filename = `${split}-00000-of-00001.parquet`
  const localPath = resolve(REPO_CACHE, filename)
  if (existsSync(localPath)) return localPath

  console.log(`Downloading SWE-bench Lite ${split}...`)
  const url = `${DATASET_URL}/${filename}`
  const resp = await fetch(url)
  const buf = Buffer.from(await resp.arrayBuffer())
  writeFileSync(localPath, buf)
  return localPath
}

async function readParquet(filepath: string): Promise<ParquetRow[]> {
  const tmpScript = `/tmp/swebench-read-${Date.now()}.py`
  const script = [
    'import pyarrow.parquet as pq, json',
    `table = pq.read_table('${filepath}')`,
    'rows = []',
    'for i in range(table.num_rows):',
    '    row = {}',
    '    for col in table.column_names:',
    '        val = table.column(col)[i].as_py()',
    '        row[col] = val',
    '    rows.append(row)',
    'print(json.dumps(rows))',
  ].join('\n')
  writeFileSync(tmpScript, script)
  try {
    const result = execSync(`python3.12 ${tmpScript}`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30_000,
    })
    return JSON.parse(result)
  } finally {
    try { unlinkSync(tmpScript) } catch { /* ignore */ }
  }
}

function toTask(row: ParquetRow): Task {
  const passTests = JSON.parse(row.FAIL_TO_PASS) as string[]

  const prompt = `${row.problem_statement}

Fix the issue described above. Make minimal changes to resolve the problem.
Modify only the necessary files. Do not add new features or change unrelated code.`

  const testExprs = passTests
    .map((t: string) => t.split('::').slice(1).join('::'))
    .filter(Boolean)

  const testCmd = testExprs.length > 0
    ? `python3.12 -m pytest ${testExprs.map((t: string) => `-k "${t}"`).join(' ')} -x -q 2>&1`
    : `python3.12 -m pytest -x -q 2>&1`

  return {
    id: row.instance_id,
    prompt,
    files: {},
    test_cmd: testCmd,
    language: 'python',
    prebuild: `python3.12 -m pip install -e . 2>&1 || true`,
    swebench: {
      repo: row.repo,
      base_commit: row.base_commit,
      test_patch: row.test_patch,
    },
  }
}

export function prepareSWERepo(task: Task): string {
  const sb = task.swebench!
  const cacheDir = resolve(REPO_CACHE, sb.repo.replace('/', '__'))
  mkdirSync(cacheDir, { recursive: true })

  if (!existsSync(resolve(cacheDir, '.git'))) {
    console.log(`  Cloning ${sb.repo}...`)
    execSync(`git clone https://github.com/${sb.repo}.git ${cacheDir}`, {
      stdio: 'pipe',
      timeout: 300_000,
    })
  }

  const workDir = `/tmp/piex-eval-swe-${Date.now()}`
  execSync(`cd ${cacheDir} && git fetch origin ${sb.base_commit} --depth 1 2>/dev/null || true`, { stdio: 'pipe' })
  execSync(`cd ${cacheDir} && git checkout -f ${sb.base_commit} 2>/dev/null || true`, { stdio: 'pipe' })
  execSync(`cp -r ${cacheDir} ${workDir}`)

  return workDir
}

export function applyTestPatch(workDir: string, testPatch: string): void {
  try {
    execSync(`cd ${workDir} && git apply --verbose 2>&1 || true`, {
      input: testPatch,
      stdio: 'pipe',
      timeout: 30_000,
    })
  } catch {
    // patch may fail if already applied or conflicts
  }
}

export function getGitDiff(workDir: string): string {
  try {
    return execSync(`cd ${workDir} && git diff`, {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim()
  } catch {
    return ''
  }
}

export function cleanupWorktree(workDir: string): void {
  // keep workspace for debugging
}
