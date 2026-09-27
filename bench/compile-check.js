// Load a project into the offline editor and compile every script without running it: how many compile,
// what stops the rest, how many functions became plain JS vs generators. Restarts Entry.exe.
//   node bench/compile-check.js <project.ent> [--source <object name>]
import fs from 'node:fs'
import { createRequire } from 'node:module'
import process from 'node:process'
import { ENTRY_TEST } from './projects.js'

const require = createRequire(import.meta.url)
const { EntryLive } = require(`${ENTRY_TEST}/src/live`)

const args = process.argv.slice(2)
const file = args.find(a => a.endsWith('.ent'))
const sourceOf = args.includes('--source') ? args[args.indexOf('--source') + 1] : null
const TURBO_SRC = fs.readFileSync(new URL('../src/turbo.js', import.meta.url), 'utf8')

async function main() {
  const live = await EntryLive.launch({ fresh: true })
  const t = Date.now()
  await live.loadEnt(file)
  console.log(`로드 ${((Date.now() - t) / 1000).toFixed(1)}초`)
  await live.eval(TURBO_SRC)
  await live.eval('EntryTurbo.enable()')
  console.log(JSON.stringify(await live.eval('EntryTurbo.check()'), null, 2))
  if (sourceOf) {
    const src = await live.eval(`(() => {
      const o = Entry.container.getAllObjects().find((x) => x.name === ${JSON.stringify(sourceOf)})
      return o.script.getThreads().map((t) => EntryTurbo.source(t.getFirstBlock())).join('\\n\\n')
    })()`)
    fs.writeFileSync(new URL('../bench/source.txt', import.meta.url), src)
    console.log(`생성 코드 → bench/source.txt (${src.length.toLocaleString()}자)`)
  }
  await live.eval('EntryTurbo.disable()')
  live.conn.close()
}

main().then(() => process.exit(0), (e) => {
  console.error(e)
  process.exit(1)
})
