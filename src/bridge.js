// Extension, isolated side (every playentry.org frame). Carries the settings from chrome.storage to the page script
// and its status back to the popup. Frames without Entry never answer, so the popup hears from the one that has it.

/**
 * The popup's switches as kept in chrome.storage.local; popup/popup.js and src/main.js hold the same defaults.
 * @typedef {object} TurboSettings
 * @property {boolean} enabled Master switch: off means Entry's own executor and setValue.
 * @property {boolean} compile Compile block scripts to JS (applied while stopped).
 * @property {boolean} deferViews Redraw variable views once per tick (applied while stopped).
 * @property {boolean} deepRecursion Experimental: recursive functions may go 1,000,000 calls deep, not 10,000 (applied
 *   while stopped).
 * @property {boolean} osd Show the on-screen display (applied at once).
 * @property {boolean} smooth Draw between ticks at the monitor's rate (applied at once).
 * @property {boolean} hires Experimental: draw the stage at the pixels it shows (applied at once).
 * @property {'fit' | 'fhd' | 'qhd'} hiresMax The widest canvas for hires: the screen (up to 4K), FHD or QHD.
 * @property {number} volume Master volume 0-100 (applied at once).
 * @property {boolean} volumeLimit Turn loud sounds down to a common level (applied at once).
 * @property {boolean} seedOn Experimental: the project's randomness follows seed (from the next start from stop).
 * @property {number} seed The fixed seed, 0 to 4294967295.
 */

(() => {
  const PAGE = 'entry-turbo-page'
  const BRIDGE = 'entry-turbo-bridge'
  /** @type {TurboSettings} */
  const DEFAULTS = { enabled: true, compile: true, deferViews: true, deepRecursion: false, osd: true, smooth: false, hires: false, hiresMax: 'fit', volume: 100, volumeLimit: false, seedOn: false, seed: 1 }
  const waiting = new Map()
  let pageReady = false

  const push = () => chrome.storage.local.get(DEFAULTS, (settings) => {
    window.postMessage({ source: BRIDGE, type: 'settings', settings }, '*')
  })
  push()
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local')
      push()
  })

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== PAGE)
      return
    if (e.data.type === 'ready') {
      pageReady = true
      push()
    }
    // an answer to the popup: the status, or a tool's report (statistics, checks)
    else if ((e.data.type === 'status' || e.data.type === 'report') && waiting.has(e.data.id)) {
      waiting.get(e.data.id)(e.data.type === 'status' ? e.data.status : e.data.report)
      waiting.delete(e.data.id)
    }
  })

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if ((message.type !== 'status' && message.type !== 'report') || !pageReady)
      return false
    const id = Math.random().toString(36).slice(2)
    waiting.set(id, respond)
    window.postMessage({ source: BRIDGE, type: message.type, kind: message.kind, id }, '*')
    return true
  })
})()
