import { existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const local = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const python = process.env.PYTHON ?? (existsSync(local) ? local : process.platform === 'win32' ? 'python' : 'python3')
const probe = spawnSync(python, ['-c', 'import pixeltable_pgserver, psycopg'], { encoding: 'utf8' })
if (probe.status !== 0) {
  console.error('Database tests require Python 3.13 and the pinned dependencies. Run: npm run setup:database')
  process.exit(1)
}
for (const test of readdirSync(join(root, 'database/tests')).filter(name => /^test_.*\.py$/.test(name)).sort()) {
  const result = spawnSync(python, ['-X', 'utf8', join(root, 'database/tests', test)], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
