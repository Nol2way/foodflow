import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { schemaPreflight } from './schema-preflight.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
// A single Worker serves /api and assets. Never embed a developer's localhost API URL.
const env = { ...process.env, VITE_API_URL: '' }
const deployArgs = process.argv.slice(2)
const schemaFlag = deployArgs.indexOf('--schema-env-file')
let envFile
if (schemaFlag >= 0) {
  envFile = deployArgs[schemaFlag + 1]
  if (!envFile || envFile.startsWith('--')) throw new Error('--schema-env-file requires a target environment file')
  deployArgs.splice(schemaFlag, 2)
}
// Artifact-only dry runs may run offline. Every actual deployment must prove the
// target database supports the application before publishing new assets/code.
if (!deployArgs.includes('--dry-run')) {
  const readiness = await schemaPreflight({ envFile })
  if (!readiness.ok) {
    console.error(JSON.stringify(readiness))
    console.error('Deployment blocked by schema preflight. Supply target credentials via environment or --schema-env-file. No database changes were made.')
    process.exit(1)
  }
}
for (const args of [
  ['frontend/node_modules/typescript/bin/tsc', '--noEmit', '-p', 'frontend/tsconfig.json'],
  ['frontend/node_modules/vite/bin/vite.js', 'build', 'frontend'],
  ['backend/node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', 'wrangler.jsonc', ...deployArgs],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
