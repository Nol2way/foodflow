import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
// A single Worker serves /api and assets. Never embed a developer's localhost API URL.
const env = { ...process.env, VITE_API_URL: '' }
for (const args of [
  ['frontend/node_modules/typescript/bin/tsc', '--noEmit', '-p', 'frontend/tsconfig.json'],
  ['frontend/node_modules/vite/bin/vite.js', 'build', 'frontend'],
  ['backend/node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', 'wrangler.jsonc', ...process.argv.slice(2)],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
