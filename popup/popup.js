// Popup: the switches (chrome.storage, read by bridge.js in each playentry.org frame) and what the active tab's
// Entry is doing, refreshed every second.
/** @type {TurboSettings} (src/bridge.js) */
const DEFAULTS = { enabled: true, compile: true, deferViews: true, deepRecursion: false, osd: true, smooth: false }
const KEYS = Object.keys(DEFAULTS)
const $ = id => document.getElementById(id)

chrome.storage.local.get(DEFAULTS, (settings) => {
  for (const k of KEYS)
    $(k).checked = settings[k]
  syncSubs()
})
for (const k of KEYS) {
  $(k).addEventListener('change', () => {
    chrome.storage.local.set({ [k]: $(k).checked })
    syncSubs()
  })
}
function syncSubs() {
  for (const k of ['compile', 'deferViews'])
    $(k).disabled = !$('enabled').checked
  $('deepRecursion').disabled = !$('enabled').checked || !$('compile').checked
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}
const row = (name, value) => `<tr><td>${name}</td><td>${value}</td></tr>`

/** @param {TurboStatus} st from src/main.js, always with `installed: true` here */
function render(st) {
  const s = st.stats
  const reasons = Object.entries(s.reasons).sort((a, b) => b[1] - a[1])
  const hats = reasons.filter(([r]) => r.startsWith('시작 블록')).reduce((n, [, c]) => n + c, 0)
  const blocks = reasons.filter(([r]) => !r.startsWith('시작 블록'))
  const on = [st.compiling && '컴파일', st.deferring && '표시 모으기', st.smooth && st.smooth.on && '보간'].filter(Boolean)
  const unknown = st.engine.unknown
  let html = '<table>'
  html += row('실행', `${st.state === 'run' ? '실행 중' : st.state === 'pause' ? '일시정지' : '멈춤'} · 부스트 ${st.boost ? '켬' : '꺼짐'}`)
  html += row('적용 중', on.length ? `<span class="ok">${on.join(' · ')}</span>` : '없음 (원래 방식)')
  if (st.smooth && !st.smooth.supported && st.wanted.smooth)
    html += row('', '<span class="warn">이 작품은 WebGL로 그려서 보간을 못 합니다</span>')
  if (st.pending)
    html += row('', '<span class="warn">바꾼 설정은 멈추면 적용됩니다</span>')
  html += row('엔진', st.engine.coreKnown ? '<span class="ok">확인된 버전</span>' : '<span class="warn">확인 안 된 버전: 컴파일 꺼짐</span>')
  if (unknown.length)
    html += row('', `<span class="warn">확인 안 된 블록 ${unknown.length}개는 원래 방식</span>`)
  if (st.compiling) {
    html += row('스크립트', `컴파일 ${s.compiled} · 원래 방식 ${s.fallback + hats}`)
    html += row('함수', `${s.functions}개${s.generators ? ` (양보하는 것 ${s.generators})` : ''}${s.recursive ? ` · 재귀 ${s.recursive}` : ''}${s.functionFallback ? ` · 원래 방식 호출 ${s.functionFallback}` : ''}`)
    // Entry's own recursion ends a few thousand calls deep (the browser's stack); from about here a project may stop
    // without the extension
    if (s.maxDepth >= 1000)
      html += row('재귀 깊이', `최대 ${s.maxDepth.toLocaleString()} <span class="warn">확장이 없으면 멈출 수 있는 깊이입니다</span>`)
  }
  html += '</table>'
  if (st.compiling && reasons.length) {
    html += '<p class="muted">원래 방식으로 도는 이유 (많은 순)</p><ul>'
    for (const [r, c] of [...blocks.slice(0, 6), ...reasons.filter(([x]) => x.startsWith('시작 블록')).slice(0, 3)])
      html += `<li><code>${escape(r)}</code> ${c}</li>`
    html += '</ul>'
  }
  if (st.compiling && !s.compiled && !s.fallback && !hats)
    html += '<p class="muted">아직 실행 전입니다. 시작하면 집계됩니다.</p>'
  $('status').innerHTML = html
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) {
    return
  }
  chrome.tabs.sendMessage(tab.id, { type: 'status' }, (st) => {
    if (chrome.runtime.lastError || !st) {
      $('status').innerHTML = '<p class="muted">이 탭에서 엔트리를 찾지 못했습니다. playentry.org 작품이나 만들기 화면을 열고, 불러올 때까지 기다려 주세요.</p>'
      return
    }
    render(st)
  })
}
refresh()
setInterval(refresh, 1000)

// ── new version notice ──
// Loaded unpacked, the extension never updates by itself. When the popup opens it asks GitHub's public API for the
// latest release number (at most every 6 hours; nothing about the user is sent) and offers the download.
const REPO = 'Hawakiki/entry-turbo'
const current = chrome.runtime.getManifest().version
$('version').textContent = `v${current}`
function newer(a, b) {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0))
      return (x[i] || 0) > (y[i] || 0)
  }
  return false
}
async function latestRelease() {
  const { release } = await chrome.storage.local.get({ release: null })
  if (release && Date.now() - release.at < 6 * 3600 * 1000)
    return release
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
  const body = r.ok ? await r.json() : null
  const next = { at: Date.now(), tag: body ? body.tag_name : null, url: body ? body.html_url : null }
  await chrome.storage.local.set({ release: next })
  return next
}
latestRelease().then((release) => {
  const tag = release.tag && release.tag.replace(/^v/, '')
  if (!tag || !newer(tag, current))
    return
  const el = $('update')
  el.innerHTML = `새 버전 <b>v${escape(tag)}</b>이 있습니다. <a id="get">받으러 가기</a>`
  el.hidden = false
  $('get').addEventListener('click', () => chrome.tabs.create({ url: release.url }))
}, () => {})
