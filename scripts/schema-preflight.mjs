import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { checkSchemaReadiness } from '../backend/src/readiness.ts'

export function readPreflightEnv(file, inherited = process.env) {
  const env = { ...inherited }
  if (!file) return env
  // Explicit file only: never silently choose development credentials for a deployment.
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    let value = match[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    env[match[1]] = value
  }
  return env
}

export async function schemaPreflight({ envFile, env = process.env } = {}) {
  try { return await checkSchemaReadiness(readPreflightEnv(envFile, env)) }
  catch { return { ok: false, ready: false, error: 'database_not_configured' } }
}

export async function main(args = process.argv.slice(2)) {
  let envFile
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--env-file') {
      console.error('Usage: node scripts/schema-preflight.mjs [--env-file <target environment file>]')
      return 2
    }
    envFile = args[1]
  }
  const result = await schemaPreflight({ envFile })
  console.log(JSON.stringify(result))
  if (!result.ok) console.error('Deployment blocked: verify migrations 0009–0011 and refresh the target PostgREST schema cache. No database changes were made.')
  return result.ok ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main()
