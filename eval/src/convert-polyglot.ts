import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface PolyglotTask {
  id: string
  prompt: string
  files: Record<string, string>
  test_cmd: string
  language: string
  prebuild?: string
}

const REPO = '/tmp/polyglot-benchmark'

const LANG_TEST_CMD: Record<string, string> = {
  python:  'python3 -m pytest',
  javascript: 'jest',
  rust:    'cargo test -- --include-ignored',
  go:      'go test ./...',
  cpp:     'cmake -S . -B build && cmake --build build && ctest --test-dir build',
  java:    'chmod +x gradlew && ./gradlew test',
}

const LANG_PREBUILD: Record<string, string | undefined> = {
  javascript: 'npm install',
  cpp:        'mkdir -p build',
}
const LANG_SUFFIX_MAP: Record<string, string> = {
  python:     'py',
  javascript: 'js',
  rust:       'rs',
  go:         'go',
  cpp:        'cpp',
  java:       'java',
}

function walkExercises(): PolyglotTask[] {
  const tasks: PolyglotTask[] = []

  for (const lang of readdirSync(REPO)) {
    const langSuffix = LANG_SUFFIX_MAP[lang]
    if (!langSuffix) continue  // skip README.md, .git, etc.

    const exercisesDir = join(REPO, lang, 'exercises', 'practice')
    if (!existsSync(exercisesDir)) continue

    for (const exercise of readdirSync(exercisesDir)) {
      const dir = join(exercisesDir, exercise)
      if (!existsSync(join(dir, '.docs', 'instructions.md'))) {
        console.warn(`Skipping ${lang}/${exercise}: no instructions.md`)
        continue
      }

      const prompt = readFileSync(join(dir, '.docs', 'instructions.md'), 'utf-8')
      const files: Record<string, string> = {}
      const solutionFiles: string[] = []

      // read .meta/config.json for file list
      const configPath = join(dir, '.meta', 'config.json')
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
        const cfgFiles = config.files || {}
        const testFiles = cfgFiles.test || []
        const exampleFiles = cfgFiles.example || []
        const solnFiles = new Set<string>(cfgFiles.solution || [])

        // exclude files we don't want in workspace
        const ignoreFiles = new Set([
          'CMakeLists.txt', 'Cargo.toml',
          ...testFiles, ...exampleFiles,
        ])

        solnFiles.forEach((f: string) => {
          if (!ignoreFiles.has(f)) solutionFiles.push(f)
        })
      }

      // fallback: if no config, look for skeleton files
      if (solutionFiles.length === 0) {
        const skeletonFile = join(dir, `${exercise.replace(/-/g, '_')}.${langSuffix}`)
        if (existsSync(skeletonFile)) {
          solutionFiles.push(`${exercise.replace(/-/g, '_')}.${langSuffix}`)
        }
      }

      for (const f of solutionFiles) {
        const fullPath = join(dir, f)
        if (existsSync(fullPath)) {
          files[f] = readFileSync(fullPath, 'utf-8')
        }
      }

      const testCmd = LANG_TEST_CMD[lang]
      if (!testCmd) {
        console.warn(`Skipping ${lang}/${exercise}: no test command`)
        continue
      }

      const task: PolyglotTask = {
        id: `${lang}/${exercise}`,
        prompt,
        files,
        test_cmd: testCmd,
        language: lang,
      }

      const prebuild = LANG_PREBUILD[lang]
      if (prebuild) task.prebuild = prebuild

      tasks.push(task)
    }
  }

  return tasks
}

const tasks = walkExercises()
console.log(`Generated ${tasks.length} tasks`)

// Remove the 6 placeholder tasks already in fixtures
const outputPath = join(import.meta.dirname, '../fixtures/tasks/polyglot.jsonl')
const lines = tasks.map((t) => JSON.stringify(t))
writeFileSync(outputPath, lines.join('\n') + '\n')
console.log(`Written to ${outputPath}`)

// Print language breakdown
const counts: Record<string, number> = {}
for (const t of tasks) counts[t.language] = (counts[t.language] || 0) + 1
console.log('Breakdown:', counts)
