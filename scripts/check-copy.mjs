import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const forbidden = /[\u00b7\u2013\u2014\u2022\u2026\u2018\u2019\u201c\u201d]/u
const files = ['README.md', 'AGENTS.md']
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collect(path)
    else if (/\.(md|tsx?|json)$/.test(path)) files.push(path)
  }
}
for (const directory of ['frontend/src', 'backend/src', 'docs']) collect(directory)
const failures = []
for (const file of files) {
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
    if (forbidden.test(line)) failures.push(`${file}:${index + 1}`)
  })
}
if (failures.length) {
  console.error('Replace decorative punctuation in project copy:\n' + failures.join('\n'))
  process.exitCode = 1
} else console.log(`Copy style passed (${files.length} files).`)
