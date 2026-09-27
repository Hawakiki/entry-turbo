// Extension, isolated side (every playentry.org frame). Carries the settings from chrome.storage to the page script
// and its status back to the popup. Frames without Entry never answer, so the popup hears from the one that has it.
(() => {
  const PAGE = 'entry-turbo-page'
  const BRIDGE = 'entry-turbo-bridge'
  const DEFAULTS = { enabled: true, compile: true, deferViews: true, osd: true, smooth: false }
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
    else if (e.data.type === 'status' && waiting.has(e.data.id)) {
      waiting.get(e.data.id)(e.data.status)
      waiting.delete(e.data.id)
    }
  })

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type !== 'status' || !pageReady)
      return false
    const id = Math.random().toString(36).slice(2)
    waiting.set(id, respond)
    window.postMessage({ source: BRIDGE, type: 'status', id }, '*')
    return true
  })
})()
