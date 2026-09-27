// Screenshot a playentry.org project page with the extension's page scripts injected (turbo + OSD, settings at their
// defaults), after pressing ▶ and waiting. For checking the OSD and the stage by eye.
//   node bench/web-shot.js [project id] [--wait 12] [--boost] [--off] [-o shot.png]      (debug Chrome on port 9333)
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import process from 'node:process'
import { ENTRY_TEST } from './projects.js'

const require = createRequire(import.meta.url)
const cdp = require(`${ENTRY_TEST}/src/cdp`)
const args = process.argv.slice(2)
const flag = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const id = args.find(a => /^[0-9a-f]{24}$/.test(a)) || '6ab8a912e74f73da0867850c'
const WAIT = Number(flag('--wait', 12))
const OUT = flag('-o', 'shot.png')
const INJECT = ['../src/turbo.js', '../src/osd.js', '../src/main.js'].map(f => fs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n;\n')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const FRAME = `[...document.querySelectorAll('iframe')].map((f) => f.contentWindow).find((w) => { try { return w.Entry && w.Entry.engine } catch (e) { return false } })`

async function main() {
  const ts = await cdp.targets(9333)
  const c = await cdp.attach(ts.find(t => t.type === 'page').webSocketDebuggerUrl)
  await c.send('Page.enable')
  const scripts = []
  if (!args.includes('--off'))
    scripts.push((await c.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT })).identifier)
  await c.send('Page.navigate', { url: `https://playentry.org/project/${id}` })
  for (let i = 0; i < 120 && !(await c.evaluate(`Boolean(${FRAME})`)); i++) await sleep(500)
  await sleep(3000)
  await c.send('Page.bringToFront')
  await c.evaluate(`(() => { const w = ${FRAME}; w.Entry.isTurbo = ${args.includes('--boost')}; w.Entry.engine.toggleRun(); return true })()`)
  await sleep(WAIT * 1000)
  // the player frame, or with --zoom only its top-left corner (where the OSD sits) at 3x
  const zoom = args.includes('--zoom')
  const clip = await c.evaluate(`(() => { const f = [...document.querySelectorAll('iframe')].find((x) => { try { return x.contentWindow.Entry } catch (e) { return false } }); const r = f.getBoundingClientRect(); return ${zoom} ? { x: r.left, y: r.top, width: 200, height: 140, scale: 3 } : { x: r.left, y: r.top, width: r.width, height: r.height, scale: 1 } })()`)
  const { data } = await c.send('Page.captureScreenshot', { format: 'png', clip })
  fs.writeFileSync(OUT, Buffer.from(data, 'base64'))
  const info = await c.evaluate(`(() => { const w = ${FRAME}; const o = w.document.getElementById('entry-turbo-osd'); return { osd: o ? o.innerText : null, state: w.Entry.engine.state } })()`)
  console.log(JSON.stringify(info))
  await c.evaluate(`(() => { const w = ${FRAME}; if (w.Entry.engine.state !== 'stop') w.Entry.engine.toggleStop(); return true })()`)
  for (const s of scripts) await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: s })
  c.close()
  console.log(`→ ${OUT}`)
}

main().then(() => process.exit(0), (e) => {
  console.error(e)
  process.exit(1)
})
