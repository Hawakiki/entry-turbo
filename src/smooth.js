/* global Entry */
/* exported installEntrySmooth */
// Smooth motion ("interpolation", as TurboWarp calls it). The engine still ticks 60 times a second and the blocks run
// exactly as before; only the stage is drawn at the monitor's rate (requestAnimationFrame), with every sprite, clone
// and speech bubble placed between where it was at the last two ticks. Drawing sets the in-between transform, renders
// and puts the real one back at once, so nothing that reads positions (collisions, clicks, blocks) ever sees it. The
// picture trails the real state by at most one tick. Teleports, big turns and flips are not filled in.
// Entry normally redraws from a ~16 ms timer, only when something changed (Stage#update); while this is on, that
// timer's calls do nothing and the animation-frame loop does the drawing. Canvas 2D (createjs) stage only.
// Defines installEntrySmooth(); the extension's main.js calls it.

/**
 * @typedef {object} EntrySmooth
 * @property {(want: boolean) => void} set Turn smooth drawing on or off (stays off when not supported).
 * @property {boolean} supported False on a WebGL stage.
 * @property {boolean} on Whether it is drawing now (read-only).
 */
/** @returns {EntrySmooth} the switch main.js drives */
function installEntrySmooth() {
  const stage = Entry.stage
  const ownUpdate = Object.hasOwn(stage, 'update')
  const update = stage.update
  const supported = !(Entry.options && Entry.options.useWebGL)
  const TELEPORT = 120 // px in one tick
  const TURN = 45 // degrees in one tick
  const GROW = 1.5 // scale factor in one tick
  let on = false
  let raf = 0
  let prev = new Map() // display object -> [x, y, rotation, scaleX, scaleY] at the end of the tick before last
  let cur = new Map() // ... at the end of the last tick
  let tickAt = 0
  let tickOpen = false

  const snapshot = (o, into) => into.set(o, [o.x, o.y, o.rotation, o.scaleX, o.scaleY])
  // the objects' ticks run back to back inside the engine's timer callback: a microtask after the first one runs after
  // the whole engine tick, when every script of that tick has moved its sprites
  function closeTick() {
    tickOpen = false
    prev = cur
    cur = new Map()
    Entry.container.mapEntityIncludeCloneOnScene((e) => {
      if (e && e.object)
        snapshot(e.object, cur)
      if (e && e.dialog && e.dialog.object)
        snapshot(e.dialog.object, cur)
    })
    tickAt = performance.now()
  }
  const codeProto = Entry.Code.prototype
  const tick = codeProto.tick
  codeProto.tick = function (...args) {
    const r = tick.apply(this, args)
    if (on && !tickOpen) {
      tickOpen = true
      queueMicrotask(closeTick)
    }
    return r
  }

  const lerp = (a, b, t) => a + (b - a) * t
  function frame() {
    if (!on)
      return
    raf = requestAnimationFrame(frame)
    const moved = []
    if (Entry.engine.isState('run') && prev.size) {
      const t = Math.min(1, (performance.now() - tickAt) / (Entry.tickTime || 16))
      for (const [o, c] of cur) {
        const p = prev.get(o)
        // not there a tick ago, hidden, or changed since the tick (dragged in the editor): drawn as it is
        if (!p || !o.visible || o.x !== c[0] || o.y !== c[1] || o.rotation !== c[2] || o.scaleX !== c[3] || o.scaleY !== c[4])
          continue
        const dx = c[0] - p[0]
        const dy = c[1] - p[1]
        const turn = ((c[2] - p[2] + 540) % 360) - 180
        const grew = p[3] && p[4] ? Math.max(Math.abs(c[3] / p[3]), Math.abs(p[3] / c[3]), Math.abs(c[4] / p[4]), Math.abs(p[4] / c[4])) : Infinity
        const flipped = Math.sign(c[3]) !== Math.sign(p[3]) || Math.sign(c[4]) !== Math.sign(p[4])
        if ((!dx && !dy && !turn && c[3] === p[3] && c[4] === p[4]) || Math.abs(dx) > TELEPORT || Math.abs(dy) > TELEPORT)
          continue
        moved.push(o)
        o.x = lerp(p[0], c[0], t)
        o.y = lerp(p[1], c[1], t)
        if (Math.abs(turn) <= TURN)
          o.rotation = c[2] - turn * (1 - t)
        if (!flipped && grew <= GROW) {
          o.scaleX = lerp(p[3], c[3], t)
          o.scaleY = lerp(p[4], c[4], t)
        }
      }
    }
    if (moved.length)
      Entry.requestUpdate = true
    update.call(stage)
    for (const o of moved) {
      const c = cur.get(o)
      o.x = c[0]
      o.y = c[1]
      o.rotation = c[2]
      o.scaleX = c[3]
      o.scaleY = c[4]
    }
  }

  function set(want) {
    want = Boolean(want) && supported
    if (want === on)
      return
    on = want
    if (on) {
      prev = new Map()
      cur = new Map()
      stage.update = function () {} // the timer's redraws: the animation-frame loop draws now
      raf = requestAnimationFrame(frame)
    }
    else {
      cancelAnimationFrame(raf)
      if (ownUpdate)
        stage.update = update
      else
        delete stage.update
      Entry.requestUpdate = true
    }
  }
  return { set, supported, get on() {
    return on
  } }
}
