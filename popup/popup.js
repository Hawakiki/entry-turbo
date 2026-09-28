// Popup: the switches (chrome.storage, read by bridge.js in each playentry.org frame) and what the active tab's
// Entry is doing, refreshed every second.
/** @type {TurboSettings} (src/bridge.js) */
const DEFAULTS = { enabled: true, compile: true, deferViews: true, deepRecursion: false, osd: true, smooth: false, seedOn: false, seed: 1 }
// the checkboxes; seed is a number box of its own
const SWITCHES = Object.keys(DEFAULTS).filter(k => typeof DEFAULTS[k] === 'boolean')
const $ = id => document.getElementById(id)
const SEED_MAX = 4294967295
let savedSeed = DEFAULTS.seed

chrome.storage.local.get(DEFAULTS, (settings) => {
  for (const k of SWITCHES)
    $(k).checked = settings[k]
  savedSeed = settings.seed
  $('seed').value = settings.seed
  syncSubs()
})
for (const k of SWITCHES) {
  $(k).addEventListener('change', () => {
    chrome.storage.local.set({ [k]: $(k).checked })
    syncSubs()
  })
}
// a whole number 0 .. 2^32 - 1; anything else puts the last good seed back
function saveSeed(value) {
  const n = Number(value)
  if (value === '' || !Number.isInteger(n) || n < 0 || n > SEED_MAX) {
    $('seed').value = savedSeed
    return
  }
  savedSeed = n
  $('seed').value = n
  chrome.storage.local.set({ seed: n })
}
$('seed').addEventListener('change', () => saveSeed($('seed').value))
$('newSeed').addEventListener('click', () => saveSeed(crypto.getRandomValues(new Uint32Array(1))[0]))
function syncSubs() {
  for (const k of ['compile', 'deferViews'])
    $(k).disabled = !$('enabled').checked
  $('deepRecursion').disabled = !$('enabled').checked || !$('compile').checked
  $('seed').disabled = !$('seedOn').checked
  $('newSeed').disabled = !$('seedOn').checked
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
  if (st.seed && st.wanted && st.wanted.seedOn && st.seed.seed !== null) {
    const s = st.seed
    const seedText = s.shared
      ? '<span class="warn">공유 변수를 쓰는 작품이라 꺼짐</span>'
      : st.state === 'stop' || !s.active ? `시작하면 ${s.seed}` : `<span class="ok">${s.seed} 적용 중</span>`
    html += row('시드', seedText)
  }
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
// newest release (at most every 6 hours; nothing about the user is sent) and offers the download. A release is X.Y.Z,
// a release candidate X.Y.Z-rc.N (a GitHub pre-release, version_name in the manifest, scripts/version.js). A release
// hears only about releases (/releases/latest leaves pre-releases out); a candidate also about newer candidates.
const REPO = 'Hawakiki/entry-turbo'
const API = { headers: { Accept: 'application/vnd.github+json' } }
const manifest = chrome.runtime.getManifest()
const current = manifest.version_name || manifest.version
const testing = current.includes('-')
$('version').textContent = `v${current}`
// [X, Y, Z, candidate number, Infinity for the release itself]: a candidate comes before its release
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(v || '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])] : null
}
function newer(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y)
    return false
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i])
      return x[i] > y[i]
  }
  return false
}
async function fetchNewest() {
  if (!testing) {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, API)
    const body = r.ok ? await r.json() : null
    return body ? { tag: body.tag_name, url: body.html_url } : { tag: null, url: null }
  }
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, API)
  const list = r.ok ? await r.json() : []
  let best = { tag: null, url: null }
  for (const x of Array.isArray(list) ? list : []) {
    if (!x.draft && parseVersion(x.tag_name) && (!best.tag || newer(x.tag_name, best.tag)))
      best = { tag: x.tag_name, url: x.html_url }
  }
  return best
}
async function latestRelease() {
  const { release } = await chrome.storage.local.get({ release: null })
  // the cache answers the same question only: a candidate and a release ask for different lists
  if (release && release.testing === testing && Date.now() - release.at < 6 * 3600 * 1000)
    return release
  const next = { at: Date.now(), testing, ...await fetchNewest() }
  await chrome.storage.local.set({ release: next })
  return next
}
latestRelease().then((release) => {
  if (!release.tag || !newer(release.tag, current))
    return
  const tag = release.tag.replace(/^v/, '')
  const el = $('update')
  el.innerHTML = `새 ${tag.includes('-') ? '시험판이' : '버전이'} 나왔습니다: <b>v${escape(tag)}</b> <a id="get">받으러 가기</a>`
  el.hidden = false
  $('get').addEventListener('click', () => chrome.tabs.create({ url: release.url }))
}, () => {})

// ── tools: project statistics and checks (src/inspect.js in the page) ──
function showTool(html) {
  const el = $('toolResult')
  el.innerHTML = html
  el.hidden = false
}
function renderStats(s) {
  let html = '<table>'
  html += row('장면 · 오브젝트', `${s.scenes} · ${s.objects}`)
  html += row('블록', s.blocks.toLocaleString())
  html += row('함수', `${s.functions}`)
  html += row('변수 · 리스트', `${s.variables} · ${s.lists} (${s.listItems.toLocaleString()}칸)`)
  html += row('신호', `${s.messages}`)
  html += row('모양 · 소리', `${s.pictures} · ${s.sounds}`)
  if (s.turbo)
    html += row('터보', `스크립트 ${s.turbo.compiled}개 컴파일 · 원래 방식 ${s.turbo.fallback} · 함수 ${s.turbo.functions} (${s.turbo.ms}ms)`)
  html += '</table>'
  const list = (title, items) => (items.length ? `<p class="muted">${title}</p><ul>${items.map(x => `<li>${escape(x.name)} <span class="where">${x.blocks.toLocaleString()}블록</span></li>`).join('')}</ul>` : '')
  html += list('블록이 많은 오브젝트', s.topObjects)
  html += list('블록이 많은 함수', s.topFunctions)
  return html
}
function renderFindings(findings) {
  if (!findings.length)
    return '<span class="ok">찾은 문제가 없습니다.</span>'
  const order = { warn: 0, info: 1 }
  return `<ul>${[...findings].sort((a, b) => order[a.level] - order[b.level]).map(f => `<li><span class="${f.level === 'warn' ? 'warn' : 'muted'}">${f.level === 'warn' ? '⚠' : 'ℹ'} <b>${escape(f.title)}</b> ${f.count}곳</span><br />${escape(f.detail)}<br /><span class="where">${f.where.map(escape).join(', ')}${f.count > f.where.length ? ' …' : ''}</span></li>`).join('')}</ul>`
}
async function runTool(kind) {
  showTool('<span class="muted">읽는 중…</span>')
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) {
    showTool('<span class="warn">탭을 찾지 못했습니다.</span>')
    return
  }
  chrome.tabs.sendMessage(tab.id, { type: 'report', kind }, (report) => {
    if (chrome.runtime.lastError || !report) {
      showTool('<span class="warn">이 탭에서 엔트리를 찾지 못했습니다.</span>')
      return
    }
    if (report.error)
      showTool(`<span class="warn">${escape(report.error)}</span>`)
    else if (kind === 'stats')
      showTool(renderStats(report.stats))
    else
      showTool(renderFindings(report.findings))
  })
}
$('runStats').addEventListener('click', () => runTool('stats'))
$('runCheck').addEventListener('click', () => runTool('check'))
