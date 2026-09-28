/* global Entry */
/* exported installEntryInspect */
// Project statistics and checks (experimental tools in the popup). Reads the loaded project from Entry's live objects;
// never Entry.exportProject(), which stops a running project. Blocks whose params Entry has not built yet (plain
// JSON, see loaded() in turbo.js) are walked as they are, without building them.
// The checks are what bit us building projects: an empty if branch yields a frame, a list grown in a loop stops the
// project at 5,000 items, a function of thousands of blocks freezes the editor when opened, recursion ends a few
// thousand calls deep, unused variables / lists / signals.
// Defines installEntryInspect(); the extension's main.js calls it.

/**
 * @typedef {object} InspectStats
 * @property {number} scenes Scenes.
 * @property {number} objects Objects.
 * @property {number} blocks Blocks in object scripts and functions.
 * @property {number} functions Functions.
 * @property {number} variables Variables (not lists).
 * @property {number} lists Lists.
 * @property {number} listItems Items in all lists now.
 * @property {number} messages Signals.
 * @property {number} pictures Shapes of all objects.
 * @property {number} sounds Sounds of all objects.
 * @property {{name: string, blocks: number}[]} topObjects The objects with the most blocks (at most 5).
 * @property {{name: string, blocks: number}[]} topFunctions The functions with the most blocks (at most 5).
 * @property {{compiled: number, fallback: number, functions: number, ms: number} | null} turbo What the compiler takes,
 *   compiled now without running (EntryTurbo.check); null when it cannot tell.
 */
/**
 * @typedef {object} InspectFinding
 * @property {'warn' | 'info'} level warn: can stop or freeze the project; info: worth knowing.
 * @property {string} title One line.
 * @property {string} detail What happens and what to do.
 * @property {string[]} where Up to 5 places (object or function names, variable names...).
 * @property {number} count How many in all.
 */
/** @returns {{stats: () => InspectStats, check: () => InspectFinding[]}} the tools main.js answers the popup with */
function installEntryInspect() {
  // loops that do not end by themselves (a counted repeat ends: a list it fills stays that size)
  const ENDLESS = new Set(['repeat_inf', 'repeat_while_true'])
  const BIG_FUNCTION = 2000
  const LIST_LIMIT = 5000
  const isBlockLike = b => b && typeof b === 'object' && typeof b.type === 'string'

  // every block of a thread (Entry.Thread or a plain JSON array), with how many endless loops it is in
  function walkThread(thread, depth, visit) {
    const list = thread && typeof thread.getBlocks === 'function' ? thread.getBlocks() : Array.isArray(thread) ? thread : []
    for (const b of list)
      walkBlock(b, depth, visit)
  }
  function walkBlock(b, depth, visit) {
    if (!isBlockLike(b))
      return
    visit(b, depth)
    for (const p of b.params || []) {
      if (isBlockLike(p))
        walkBlock(p, depth, visit)
    }
    const inner = ENDLESS.has(b.type) ? depth + 1 : depth
    for (const s of b.statements || [])
      walkThread(s, inner, visit)
  }
  function walkCode(code, visit) {
    if (!code || typeof code.getThreads !== 'function')
      return
    for (const t of code.getThreads())
      walkThread(t, 0, visit)
  }

  // every script: [kind, name, code]
  function sources() {
    const out = []
    for (const obj of Entry.container.getAllObjects())
      out.push(['object', obj.name, obj.script])
    const funcs = Entry.variableContainer.functions_ || {}
    for (const id of Object.keys(funcs))
      out.push(['function', funcName(funcs[id]), funcs[id].content, id])
    return out
  }
  function funcName(f) {
    // the description holds the parameter slots as their type names: shown as ()
    return (f && (f.description || '').replace(/문자\/숫자값|판단값/g, '()').replace(/\s+/g, ' ').trim()) || (f && f.id) || '?'
  }
  const count = (code) => {
    let n = 0
    walkCode(code, () => {
      n++
    })
    return n
  }
  const top = (items, k = 5) => items.filter(x => x.blocks > 0).sort((a, b) => b.blocks - a.blocks).slice(0, k)

  function stats() {
    const vc = Entry.variableContainer
    const objects = Entry.container.getAllObjects()
    const perObject = objects.map(o => ({ name: o.name, blocks: count(o.script) }))
    const funcs = vc.functions_ || {}
    const perFunction = Object.keys(funcs).map(id => ({ name: funcName(funcs[id]), blocks: count(funcs[id].content) }))
    let turbo = null
    if (globalThis.EntryTurbo && typeof globalThis.EntryTurbo.check === 'function' && globalThis.EntryTurbo.engine().coreKnown) {
      try {
        const r = globalThis.EntryTurbo.check()
        turbo = { compiled: r.compiled, fallback: r.fallback, functions: r.functions, ms: r.ms }
      }
      catch {
        turbo = null
      }
    }
    return {
      scenes: Entry.scene && Entry.scene.getScenes ? Entry.scene.getScenes().length : 0,
      objects: objects.length,
      blocks: [...perObject, ...perFunction].reduce((s, x) => s + x.blocks, 0),
      functions: perFunction.length,
      variables: (vc.variables_ || []).filter(v => ['variable', 'slide'].includes(v.type || 'variable')).length,
      lists: (vc.lists_ || []).length,
      listItems: (vc.lists_ || []).reduce((s, l) => s + ((l.array_ && l.array_.length) || 0), 0),
      messages: (vc.messages_ || []).length,
      pictures: objects.reduce((s, o) => s + ((o.pictures && o.pictures.length) || 0), 0),
      sounds: objects.reduce((s, o) => s + ((o.sounds && o.sounds.length) || 0), 0),
      topObjects: top(perObject),
      topFunctions: top(perFunction),
      turbo,
    }
  }

  function check() {
    const vc = Entry.variableContainer
    const findings = []
    const add = (level, title, detail, where) => {
      if (where.length)
        findings.push({ level, title, detail, where: [...new Set(where)].slice(0, 5), count: where.length })
    }
    const emptyBranches = []
    const strings = new Set() // every string param: variable / list / signal ids are among them
    const appendedInLoop = new Map() // list id -> where, for adds inside an endless loop
    const removed = new Set()
    const appended = new Set() // lists items are added to anywhere
    const casts = new Set()
    const receives = new Set()
    const calls = new Map() // function id -> ids it calls
    const bigFunctions = []
    let total = 0

    for (const [kind, name, code, fid] of sources()) {
      let blocks = 0
      const callees = new Set()
      walkCode(code, (b, depth) => {
        blocks++
        for (const p of b.params || []) {
          if (typeof p === 'string')
            strings.add(p)
        }
        if ((b.type === '_if' || b.type === 'if_else') && Array.isArray(b.statements)) {
          const n = b.type === '_if' ? 1 : 2
          for (let i = 0; i < n; i++) {
            const s = b.statements[i]
            const list = s && typeof s.getBlocks === 'function' ? s.getBlocks() : Array.isArray(s) ? s : []
            if (!list.length)
              emptyBranches.push(name)
          }
        }
        if ((b.type === 'add_value_to_list' || b.type === 'insert_value_to_list') && typeof b.params[1] === 'string') {
          appended.add(b.params[1])
          if (depth > 0)
            appendedInLoop.set(b.params[1], name)
        }
        if (b.type === 'remove_value_from_list' && typeof b.params[1] === 'string')
          removed.add(b.params[1])
        if ((b.type === 'message_cast' || b.type === 'message_cast_wait') && typeof b.params[0] === 'string')
          casts.add(b.params[0])
        if (b.type === 'when_message_cast' && typeof b.params[1] === 'string')
          receives.add(b.params[1])
        if (b.type.startsWith('func_'))
          callees.add(b.type.slice(5))
      })
      total += blocks
      if (kind === 'function') {
        calls.set(fid, callees)
        if (blocks >= BIG_FUNCTION)
          bigFunctions.push(`${name} (${blocks.toLocaleString()}블록)`)
      }
    }

    add('warn', '빈 "만약" 가지', '비어 있는 "만약"이나 "아니면" 칸은 지날 때마다 한 프레임을 쉽니다. 반복 안에 있으면 멈춘 것처럼 느려집니다. 안 쓰는 칸은 지우세요.', emptyBranches)

    const lists = vc.lists_ || []
    const listName = id => (lists.find(l => l.id_ === id) || {}).name_ || id
    const growing = [...appendedInLoop.keys()].filter(id => !removed.has(id))
    add('warn', '끝없이 늘어나는 리스트', `계속 반복하기(또는 ~인 동안 반복) 안에서 항목을 추가하는데 지우는 곳이 없습니다. 리스트가 ${LIST_LIMIT.toLocaleString()}칸이 되면 작품이 멈춥니다. 미리 크게 만들고 칸 수를 따로 세는 방법이 있습니다.`, growing.map(id => `${listName(id)} (${appendedInLoop.get(id)})`))
    add('warn', `${LIST_LIMIT.toLocaleString()}칸에 가까운 리스트`, `리스트는 ${LIST_LIMIT.toLocaleString()}칸을 넘으면 작품이 멈추고, 미리 담아 올린 리스트도 불러올 때 잘립니다.`, lists.filter(l => appended.has(l.id_) && l.array_ && l.array_.length >= 4000).map(l => `${l.name_} (${l.array_.length.toLocaleString()}칸)`))

    add('warn', '아주 큰 함수', `한 함수에 블록이 ${BIG_FUNCTION.toLocaleString()}개를 넘으면 만들기 화면에서 그 함수를 열 때 오래 걸리거나 멈출 수 있습니다. 여러 함수로 나누세요.`, bigFunctions)

    // functions that reach themselves through calls (a cycle of the call graph)
    const recursive = []
    for (const [id] of calls) {
      const seen = new Set()
      const stack = [...(calls.get(id) || [])]
      while (stack.length) {
        const g = stack.pop()
        if (g === id) {
          recursive.push(funcName((vc.functions_ || {})[id]))
          break
        }
        if (seen.has(g))
          continue
        seen.add(g)
        for (const h of calls.get(g) || []) stack.push(h)
      }
    }
    add('info', '재귀 함수', '자기 자신을 (다른 함수를 거쳐서라도) 부르는 함수입니다. 엔트리는 보통 수천 단계 깊이에서 오류로 멈춥니다. 엔트리 터보는 1만 단계까지, "재귀 한계 풀기"를 켜면 더 깊이 갑니다.', recursive)

    const unusedVars = (vc.variables_ || []).filter(v => v.id_ && !strings.has(v.id_) && ['variable', 'slide'].includes(v.type || 'variable')).map(v => v.name_)
    add('info', '안 쓰는 변수', '어떤 블록에서도 쓰지 않는 변수입니다.', unusedVars)
    add('info', '안 쓰는 리스트', '어떤 블록에서도 쓰지 않는 리스트입니다.', lists.filter(l => l.id_ && !strings.has(l.id_)).map(l => l.name_))
    const messages = vc.messages_ || []
    add('info', '받는 곳이 없는 신호', '보내기만 하고 "신호를 받았을 때"가 없는 신호입니다.', messages.filter(m => casts.has(m.id) && !receives.has(m.id)).map(m => m.name))
    add('info', '보내는 곳이 없는 신호', '"신호를 받았을 때"는 있는데 보내는 블록이 없는 신호입니다.', messages.filter(m => receives.has(m.id) && !casts.has(m.id)).map(m => m.name))
    if (total >= 100000)
      add('info', '아주 큰 작품', `블록이 ${total.toLocaleString()}개입니다. 30만 개 근처부터 불러오기가 매우 느려지거나 멈출 수 있습니다.`, [`${total.toLocaleString()}블록`])
    return findings
  }

  return { stats, check }
}
