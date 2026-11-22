import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const base = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run(base, ['-m', 'venv', '.venv'])
run(join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), ['-m', 'pip', 'install', '-r', 'database/requirements-test.txt'])
