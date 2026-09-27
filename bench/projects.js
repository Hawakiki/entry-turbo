// Bench projects, built with the block DSL from entry-test (omok/dsl.js). One text-box object, no assets.
// entry-test (the .ent / CDP / DSL tools) is found through ENTRY_TEST, or next to this repository.
import { createRequire } from 'node:module'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
export const ENTRY_TEST = (process.env.ENTRY_TEST || fileURLToPath(new URL('../../entry-test', import.meta.url))).replaceAll('\\', '/')
const D = require(`${ENTRY_TEST}/omok/dsl.js`)
const Blocks = require(`${ENTRY_TEST}/src/blocks.js`)

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

// UI blocks (motion, rotation, speech, text, wait, message, clone, stop) on a text box, for the generic path
export function uiProject() {
  const mk = (type, params, statements) => Blocks.block(type, params, statements)
  const main = [
    D.HAT_RUN(),
    D.SET('완료', 0),
    D.SET('카운트', 0),
    D.SET('신호수', 0),
    D.SET('클론수', 0),
    D.REPEAT(30, [
      mk('move_direction', [D.NUM(3), null]),
      mk('rotate_relative', [D.NUM(7), null]),
      D.ADD('카운트', 1),
      D.IF(D.EQ(D.MOD(D.V('카운트'), 5), 0), [D.BROADCAST('신호')]),
    ]),
    D.WAIT(0.1),
    D.REPEAT(3, [D.CLONE_SELF()]),
    D.WAIT_UNTIL(D.EQ(D.V('클론수'), 3)),
    D.LOCATE(D.V('카운트'), D.MINUS(0, D.V('카운트'))),
    mk('dialog', [D.JOIN('말 ', D.V('신호수')), 'speak', null]),
    D.TEXT_WRITE(D.JOIN('끝 ', D.V('카운트'))),
    mk('text_append', [D.TXT('!'), null]),
    D.SET('완료', 1),
  ]
  const onSignal = [D.HAT_MSG('신호'), D.ADD('신호수', 1), mk('move_y', [D.NUM(1), null])]
  const onClone = [D.HAT_CLONE(), D.ADD('클론수', 1), mk('move_x', [D.NUM(10), null]), D.STOP_THREAD(), D.ADD('클론수', 100)]
  const p = benchProject()
  p.objects = [textObject('주인공', [main, onSignal, onClone])]
  p.variables = ['완료', '카운트', '신호수', '클론수'].map(n => D.variable(n))
  p.messages = [D.message('신호')]
  p.name = 'turbo-ui'
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
