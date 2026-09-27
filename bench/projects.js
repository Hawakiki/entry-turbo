// Bench projects, built with the block DSL from entry-test (omok/dsl.js). One text-box object, no assets.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
export const ENTRY_TEST = 'C:/path/to/entry-test'
const D = require(`${ENTRY_TEST}/omok/dsl.js`)

const LIST_SIZE = 100

// one iteration: variables (change_variable keeps a string), arithmetic, mod, if/else, list write and read
function body() {
  return [
    D.ADD('i', 1),
    D.SET('t', D.MOD(D.PLUS(D.MUL(D.V('i'), 3), D.V('합')), 1000)),
    D.IFELSE(D.EQ(D.MOD(D.V('t'), 7), 0), [D.ADD('합', 1)], [D.SET('합', D.V('t'))]),
    D.SETAT('L', D.PLUS(D.MOD(D.V('i'), LIST_SIZE), 1), D.V('t')),
    D.SET('합', D.MOD(D.PLUS(D.V('합'), D.AT('L', D.PLUS(D.MOD(D.MUL(D.V('i'), 7), LIST_SIZE), 1))), 1000)),
  ]
}

function textObject(name, stacks) {
  return {
    id: D.reg.id('object', name),
    name,
    objectType: 'textBox',
    rotateMethod: 'free',
    scene: 'main',
    sprite: { pictures: [], sounds: [] },
    text: name,
    lock: false,
    entity: {
      x: 0,
      y: 0,
      regX: 0,
      regY: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      direction: 90,
      width: 200,
      height: 40,
      font: '20px Nanum Gothic',
      fontSize: 20,
      colour: '#000000',
      bgColor: 'transparent',
      underLine: false,
      strike: false,
      text: name,
      textAlign: 0,
      lineBreak: false,
      visible: true,
    },
    script: D.script(...stacks),
  }
}

// `unroll` copies of the body inside one repeat: with boost off each tick runs one repeat iteration
export function benchProject({ unroll = 1 } = {}) {
  const loopBody = Array.from({ length: unroll }, body).flat()
  const main = [
    D.HAT_RUN(),
    D.SET('완료', 0),
    D.SET('합', 0),
    D.SET('i', 0),
    D.SET('t', 0),
    D.REPEAT(D.V('N'), loopBody),
    D.SET('완료', 1),
  ]
  return {
    objects: [textObject('벤치', [main])],
    scenes: [{ id: 'main', name: '벤치' }],
    variables: [
      ...['완료', '합', 'i', 't', 'N'].map(n => D.variable(n)),
      D.list('L', Array.from({ length: LIST_SIZE }).fill(0)),
    ],
    messages: [],
    functions: [],
    tables: [],
    speed: 60,
    interface: {},
    expansionBlocks: [],
    aiUtilizeBlocks: [],
    hardwareLiteBlocks: [],
    externalModules: [],
    externalModulesLite: [],
    name: 'turbo-bench',
  }
}

// the bench project plus one function, so the editor has a function call block to fingerprint
export function functionProject() {
  const p = benchProject()
  const fn = D.FUNC('더하기', [D.ADD('합', 1)])
  p.functions = [fn]
  p.objects[0].script = D.script([D.HAT_RUN(), D.CALL('더하기')])
  return p
}

export const BLOCKS_PER_BODY = (() => {
  let n = 0
  const count = (b) => {
    if (!b || typeof b !== 'object')
      return
    n++
    for (const p of b.params || []) count(p)
    for (const s of b.statements || []) {
      for (const x of s) count(x)
    }
  }
  for (const b of body()) count(b)
  return n
})()
