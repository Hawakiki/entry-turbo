/* global Entry */
/* exported installEntryHires */
// Sharper stage (experimental). Entry draws the stage into a 640x360 canvas and the browser stretches it to the size
// on screen, so on a large or high-DPI display everything is blurry. With this on, the canvas gets as many pixels as it
// shows (its CSS width x devicePixelRatio, at most a cap: 4K, QHD or FHD) and the scene's root is scaled up to match.
// What the project sees stays the same:
// - Entry's mouse coordinates come from the canvas's size on screen, and createjs maps pointer events through the
//   canvas's pixel size, so clicks and the mouse blocks do not change;
// - pixel collisions (ndgmr.checkPixelCollision, used by the touching and bounce-off-edge blocks) sample the scene in
//   stage pixels: they are computed with the root set back to Entry's own scale, or answers at edges would change;
// - the ask box draws itself in canvas pixels at fixed places: while it is open the canvas goes back to 640x360.
// Canvas 2D (createjs) stage in a project page only: not WebGL, not the editor (whose thumbnails are canvas captures).
// Defines installEntryHires(); the extension's main.js calls it.

/**
 * @typedef {object} EntryHires
 * @property {(want: boolean, max?: 'fit' | 'fhd' | 'qhd') => void} set Turn it on or off, with a cap.
 * @property {boolean} supported A canvas 2D stage in a project page.
 * @property {boolean} on Asked for and supported.
 * @property {number} scale The canvas's pixel size over Entry's own, 1 when off.
 * @property {number[]} size The canvas's pixel size now.
 */
/** @returns {EntryHires} the switch main.js drives */
function installEntryHires() {
  const stage = Entry.stage
  const root = stage && stage.canvas // the createjs stage: every sprite, text and pen hangs from it
  const el = root && root.canvas
  const CAPS = { fit: 3840, qhd: 2560, fhd: 1920 } // widest canvas, device pixels
  let supported = Boolean(el && typeof el.getBoundingClientRect === 'function')
    && !(Entry.options && Entry.options.useWebGL) && Entry.type === 'minimize'
  // Entry's own size and root transform (stage.js initStage: 640x360, x 320, y 180, scale 4/3)
  const base = supported ? { width: el.width, height: el.height, x: root.x, y: root.y, scale: root.scaleX } : null
  if (supported && (!base.width || !base.height || root.scaleX !== root.scaleY))
    supported = false
  let on = false
  let cap = CAPS.fit
  let scale = 1
  let askOpen = false
  let installed = false

  function place(k) {
    el.width = Math.round(base.width * k)
    el.height = Math.round(base.height * k)
    root.x = base.x * k
    root.y = base.y * k
    root.scaleX = root.scaleY = base.scale * k
  }
  function setScale(k) {
    const width = Math.round(base.width * k)
    k = width / base.width
    // also when Entry put its own transform back behind our back
    if (k === scale && el.width === width && root.scaleX === base.scale * k)
      return
    const before = el.getBoundingClientRect().width
    place(k)
    // a canvas sized by its pixel count on the page would grow on screen: then leave it alone
    if (Math.abs(el.getBoundingClientRect().width - before) > 1) {
      place(1)
      scale = 1
      supported = false
      on = false
      return
    }
    scale = k
    Entry.requestUpdate = true
    stage.updateForce() // a resized canvas is blank until drawn
  }
  function wanted() {
    if (!on || askOpen)
      return 1
    const r = el.getBoundingClientRect()
    if (!r.width)
      return scale
    return Math.max(1, Math.min(r.width * (window.devicePixelRatio || 1), cap) / base.width)
  }
  const refresh = () => {
    if (supported)
      setScale(wanted())
  }

  function install() {
    installed = true
    const nd = window.ndgmr
    if (nd && typeof nd.checkPixelCollision === 'function') {
      const check = nd.checkPixelCollision
      nd.checkPixelCollision = function (...args) {
        if (scale === 1)
          return check.apply(this, args)
        const saved = [root.x, root.y, root.scaleX, root.scaleY]
        root.x = base.x
        root.y = base.y
        root.scaleX = root.scaleY = base.scale
        try {
          return check.apply(this, args)
        }
        finally {
          [root.x, root.y, root.scaleX, root.scaleY] = saved
        }
      }
    }
    for (const [name, open] of [['showInputField', true], ['hideInputField', false]]) {
      const f = stage[name]
      if (typeof f !== 'function')
        continue
      stage[name] = function (...args) {
        if (open) {
          askOpen = true
          refresh() // back to 640x360 before the box is made and drawn
          return f.apply(this, args)
        }
        const r = f.apply(this, args)
        askOpen = false
        refresh()
        return r
      }
    }
    // fullscreen, window size, moving to a screen with another pixel ratio
    if (typeof ResizeObserver === 'function')
      new ResizeObserver(refresh).observe(el)
    window.addEventListener('resize', refresh)
  }

  function set(want, max) {
    cap = CAPS[max] || CAPS.fit
    on = Boolean(want) && supported
    if (on && !installed)
      install()
    refresh()
  }
  return {
    set,
    get supported() {
      return supported
    },
    get on() {
      return on
    },
    get scale() {
      return scale
    },
    get size() {
      return el ? [el.width, el.height] : [0, 0]
    },
  }
}
