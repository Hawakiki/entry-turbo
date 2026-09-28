/* global Entry */
/* exported installEntrySeed */
// Fixed random seed (experimental). With a seed set, the project's randomness (the random number block, a random list
// item, anything a block draws from Math.random) repeats run after run: the generator is seeded again at every start
// from stop, and only draws made while the project runs follow it.
// Entry also draws from Math.random for its own ids: a hash per block its executor runs, an id per executor (one per
// function call). The compiled path makes neither, so those draws stay on the browser's generator; the project then
// sees the same sequence whether its scripts run compiled or not.
// Off on projects with shared (cloud / real-time) variables or lists: knowing the rolls there would rig shared rankings.
// Defines installEntrySeed(); the extension's main.js calls it.

/**
 * @typedef {object} EntrySeed
 * @property {(seed: number | null) => void} set The seed for the next start from stop; null turns it off.
 * @property {() => void} restart Seed the generator again (main.js calls it at every start from stop).
 * @property {number | null} seed The seed asked for.
 * @property {boolean} active The project's randomness follows the seed now.
 * @property {boolean} shared The project uses shared variables or lists, so the seed stays off.
 */
/** @returns {EntrySeed} the switch main.js drives */
function installEntrySeed() {
  const original = Math.random
  let wanted = null
  let state = 0
  let active = false
  let shared = false
  let bypass = 0 // > 0 while Entry makes one of its ids
  let installed = false

  // mulberry32: 32-bit state, uniform in [0, 1)
  function next() {
    state = (state + 0x6D2B79F5) | 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  function seeded() {
    return active && bypass === 0 && Entry.engine && Entry.engine.state !== 'stop' ? next() : original()
  }
  // Entry's id makers draw from the browser's generator even while the seed is on
  function ownGenerator(obj, name) {
    const f = obj && obj[name]
    if (typeof f !== 'function')
      return
    obj[name] = function (...args) {
      bypass++
      try {
        return f.apply(this, args)
      }
      finally {
        bypass--
      }
    }
  }
  // only once a seed is asked for: until then the page keeps its own Math.random untouched
  function install() {
    if (installed)
      return
    installed = true
    Math.random = seeded
    ownGenerator(Entry, 'generateHash')
    ownGenerator(Entry.Utils, 'generateId')
  }
  function usesShared() {
    const vc = Entry.variableContainer
    if (!vc)
      return false
    return [...(vc.variables_ || []), ...(vc.lists_ || [])].some(v => v && (v.isRealTime_ || v.isCloud_))
  }

  function set(seed) {
    const n = Number(seed)
    wanted = seed === null || seed === undefined || seed === '' || !Number.isFinite(n) ? null : Math.trunc(n) >>> 0
    if (wanted !== null)
      install()
    else
      active = false
  }
  function restart() {
    shared = wanted !== null && usesShared()
    active = wanted !== null && !shared
    state = wanted === null ? 0 : wanted | 0
  }
  return {
    set,
    restart,
    get seed() {
      return wanted
    },
    get active() {
      return active
    },
    get shared() {
      return shared
    },
  }
}
