import { setupFeedback } from './feedback.js';

const $ = (selector) => document.querySelector(selector);
const base = new URL('.', location.href);
const views = ['browse', 'library', 'detail', 'play', 'downloads', 'reports'];
const labels = { available: '尚未安装', installing: '正在安装', ready: '已安装', failed: '安装未完成' };
const state = { games: [], reports: [], logs: new Map(), loaded: false, route: null, selected: null, query: '', genre: '', license: '', source: '', sort: 'catalog', playUrl: null };
let feedback = null;
let eventSource = null;
let backupTimer;
let toastTimer;
let catalogRequest;
let detailSignature;
let reportsRequest;

updateMachine();

function updateMachine(hostname) {
  const name = typeof hostname === 'string' ? hostname.trim() : '';
  $('#runtime-label').textContent = name ? '运行主机：' + name : '运行主机待确认';
  $('#machine-note').textContent = name ? '源码下载、构建和报告保存均在主机 ' + name + ' 上进行。网页游戏在当前浏览器中显示和操作。' : '运行主机尚未确认；连接后会显示源码下载、构建和报告保存所在的主机。';
  $('#reports-note').textContent = name ? '报告保存在主机 ' + name + ' 上，可查看或导出给创作者。' : '报告保存所在的主机待确认，可在连接后查看或导出给创作者。';
  $('#import-dialog .field-note').textContent = name ? '添加公开的网页游戏源码仓库，下载并安装到主机 ' + name + '。' : '下载和安装所在的主机待确认，连接后会显示主机名。';
}

function el(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, className = 'button', action) {
  const node = el('button', className, text);
  node.type = 'button';
  if (action) node.addEventListener('click', action);
  return node;
}
function selectedGame() { return state.games.find((game) => game.id === state.selected); }
function safeUrl(value, sameOrigin = false) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (sameOrigin && url.origin !== base.origin)) throw new Error('链接不可用');
  return url;
}
function pageUrl(view = 'browse', game, section = '') {
  const url = new URL(base);
  url.searchParams.set('view', view);
  if (game) url.searchParams.set('game', typeof game === 'string' ? game : game.id);
  if (['browse', 'library'].includes(view)) {
    for (const key of ['query', 'genre', 'license', 'source']) if (state[key]) url.searchParams.set(key === 'query' ? 'q' : key, state[key]);
    if (state.sort !== 'catalog') url.searchParams.set('sort', state.sort);
  }
  if (section) url.hash = section;
  return url;
}
function mark(node, url) { node.dataset.deepLink = url.href || String(url); return node; }
function link(text, url, className = '', external = false) {
  const a = el('a', className, text);
  a.href = url.href || String(url);
  if (external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  else a.dataset.internal = 'true';
  return a;
}
function notify(text, sticky = false) {
  clearTimeout(toastTimer);
  $('#toast').replaceChildren(el('span', '', text));
  $('#toast').hidden = false;
  if (!sticky) toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
async function copyLink(url) {
  const value = url.href || String(url);
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else {
      const text = el('textarea'); text.value = value; text.style.cssText = 'position:fixed;opacity:0'; document.body.append(text);
      text.select(); const copied = document.execCommand('copy'); text.remove(); if (!copied) throw new Error('copy');
    }
    notify('链接已复制');
  } catch {
    notify('选中链接即可复制', true);
    const input = el('input', 'copy-fallback'); input.value = value; input.readOnly = true;
    input.setAttribute('aria-label', '可复制的链接'); $('#toast').append(input); input.focus(); input.select();
  }
}
function copyButton(url, name = '复制链接') {
  const node = button('复制链接', 'copy-button', () => copyLink(url));
  node.setAttribute('aria-label', name); node.title = name;
  return node;
}
async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(safeUrl(path, true), { ...options, signal: controller.signal, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    const text = await response.text();
    let result;
    try { result = text ? JSON.parse(text) : {}; } catch { throw new Error('服务返回了无法读取的内容'); }
    if (!response.ok) throw new Error(result.error?.message || result.error || result.message || '请求未完成');
    return result;
  } catch (error) { if (error.name === 'AbortError') throw new Error('连接超时，请重试'); throw error; }
  finally { clearTimeout(timeout); }
}
function updateConnection(connected) {
  $('#connection-dot').classList.toggle('connected', connected);
  $('#connection-label').textContent = connected ? '已连接' : '连接中断，正在重试';
  if (!connected) updateMachine();
}
function repository(game) {
  try {
    const url = safeUrl(game.source?.repository || game.repo);
    return { url, owner: url.pathname.split('/').filter(Boolean)[0] || '作者', name: url.pathname.split('/').filter(Boolean).at(-1)?.replace(/\.git$/, '') || game.title, provider: game.source?.provider || url.hostname, ownerUrl: new URL('/' + (url.pathname.split('/').filter(Boolean)[0] || ''), url) };
  } catch { return { owner: '作者信息待补充', provider: '来源待确认', name: game.title }; }
}
function licenseName(game) { return typeof game.license === 'string' ? game.license : game.license?.name || game.provenance?.license || '许可待确认'; }
function sourceName(game) {
  const source = repository(game).provider;
  return ({ github: 'GitHub', 'github.com': 'GitHub', gitee: 'Gitee', 'gitee.com': 'Gitee', gitlab: 'GitLab', 'gitlab.com': 'GitLab', codeberg: 'Codeberg', 'codeberg.org': 'Codeberg' })[source] || source;
}
function typeName(game) {
  return game.compatibility?.label || ({ static: '直接运行网页', build: '需要构建的网页' })[game.mode] || '等待检测';
}
function readRoute() {
  const url = new URL(location.href);
  let params = url.searchParams;
  let view = params.get('view');
  let section;
  try { section = decodeURIComponent(url.hash.slice(1)); } catch { section = ''; }
  if (url.hash.startsWith('#/')) {
    const [part, query = ''] = url.hash.slice(2).split('?');
    view = part; params = new URLSearchParams(query); section = '';
  } else if (!view && ['play', 'library', 'reports', 'downloads', 'browse'].includes(section)) { view = section; section = ''; }
  const game = params.get('game') || url.searchParams.get('game');
  return { view: views.includes(view) ? view : game ? 'detail' : 'browse', game, section, query: params.get('q') || '', genre: params.get('genre') || '', license: params.get('license') || '', source: params.get('source') || '', sort: ['catalog', 'title', 'installed'].includes(params.get('sort')) ? params.get('sort') : 'catalog' };
}
function navigate(url, replace = false) {
  const target = safeUrl(url, true);
  if (target.href === location.href) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', target);
  syncRoute();
}
function syncRoute() {
  const route = readRoute();
  const changedGame = state.selected !== route.game;
  const leavingPlay = state.route?.view === 'play' && route.view !== 'play';
  if (changedGame || leavingPlay) {
    feedback?.stop(); feedback = null; state.playUrl = null;
    // Clearing src navigates the existing child to about:blank and adds a joint-history entry.
    const frame = $('#game-frame');
    const freshFrame = frame.cloneNode(false);
    freshFrame.removeAttribute('src'); freshFrame.hidden = true;
    frame.replaceWith(freshFrame);
  }
  state.route = route; state.selected = route.game;
  mark($('#runtime-info'), pageUrl(route.view, route.game, 'runtime-info'));
  $('#copy-runtime-link').dataset.runtimeLink = pageUrl(route.view, route.game, 'runtime-info').href;
  for (const key of ['query', 'genre', 'license', 'source', 'sort']) state[key] = route[key];
  $('#game-search').value = state.query;
  $('#game-sort').value = state.sort;
  for (const name of ['catalog', 'detail', 'play', 'downloads', 'reports']) $('#' + name + '-view').hidden = name === 'catalog' ? !['browse', 'library'].includes(route.view) : name !== route.view;
  document.querySelectorAll('[data-route]').forEach((node) => {
    node.href = pageUrl(node.dataset.route).href;
    const active = node.dataset.route === route.view || node.dataset.route === 'browse' && ['detail', 'play'].includes(route.view);
    node.classList.toggle('active', active);
    if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
  });
  const titles = { browse: '浏览作品', library: '我的游戏', downloads: '下载任务', reports: '问题记录', detail: selectedGame()?.title || '作品详情', play: selectedGame()?.title || '游戏' };
  document.title = titles[route.view] + ' · 创意工坊';
  if (route.view === 'browse' || route.view === 'library') renderCatalog();
  if (route.view === 'detail') renderDetail(true);
  if (route.view === 'play') renderPlay();
  if (route.view === 'downloads') renderDownloads();
  if (route.view === 'reports') { renderReports(); loadReports(); }
  if (selectedGame() && ['detail', 'play'].includes(route.view) && !feedback) feedback = setupFeedback({ frame: $('#game-frame'), game: selectedGame, getBase: () => base });
  if (route.section === 'add-repository') $('#import-dialog').showModal();
  else scrollToSection();
}
function scrollToSection() {
  const section = state.route?.section;
  if (!section) return;
  requestAnimationFrame(() => {
    const target = document.getElementById(section);
    if (target) { if (target.tagName === 'DETAILS') target.open = true; target.scrollIntoView({ block: 'start' }); }
  });
}
function filtersChanged() {
  navigate(pageUrl(['browse', 'library'].includes(state.route.view) ? state.route.view : 'browse'), true);
  renderCatalog();
}
function renderFilters() {
  const groups = [
    ['genre', '类别', [...new Set(state.games.map((g) => g.genre || '其他'))]],
    ['license', '许可', [...new Set(state.games.map(licenseName))]],
    ['source', '来源', [...new Set(state.games.map(sourceName))]],
  ];
  groups.forEach(([key, title, values]) => {
    const group = $('#' + key + '-filters'); group.replaceChildren(); mark(group, pageUrl(state.route.view, null, key + '-filters'));
    group.append(el('h2', '', title));
    ['', ...values].forEach((value) => {
      const choice = button(value || '全部' + title, 'filter-option', () => { state[key] = value; filtersChanged(); });
      choice.classList.toggle('active', state[key] === value); choice.setAttribute('aria-pressed', String(state[key] === value));
      group.append(choice);
    });
  });
}
function cover(game) {
  const node = el('div', 'game-cover');
  const repo = repository(game);
  const kind = repo.name?.toLowerCase();
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 320 180'); svg.setAttribute('aria-hidden', 'true');
  if (kind === '2048') svg.innerHTML = '<rect width="320" height="180" fill="#e9e5df"/><rect x="80" y="10" width="160" height="160" rx="5" fill="#b5a99b"/><g fill="#cec5ba"><rect x="88" y="18" width="70" height="70" rx="3"/><rect x="162" y="18" width="70" height="70" rx="3"/><rect x="88" y="92" width="70" height="70" rx="3"/><rect x="162" y="92" width="70" height="70" rx="3"/></g><rect x="88" y="18" width="70" height="70" rx="3" fill="#eee4da"/><rect x="162" y="18" width="70" height="70" rx="3" fill="#ede0c8"/><rect x="88" y="92" width="70" height="70" rx="3" fill="#f2b179"/><rect x="162" y="92" width="70" height="70" rx="3" fill="#edc850"/><g font-family="Arial,sans-serif" font-weight="bold" font-size="29" text-anchor="middle" fill="#776e65"><text x="123" y="64">2</text><text x="197" y="64">4</text><text x="123" y="138" fill="#fff">8</text><text x="197" y="138" fill="#fff">16</text></g>';
  else if (kind === 'hello') svg.innerHTML = '<rect width="320" height="180" fill="#f1f2f2"/><g stroke="#c9cdce" fill="#fff"><rect x="39" y="37" width="46" height="46"/><rect x="88" y="37" width="46" height="46"/><rect x="137" y="37" width="46" height="46"/><rect x="186" y="37" width="46" height="46"/><rect x="235" y="37" width="46" height="46"/></g><rect x="39" y="37" width="46" height="46" fill="#6a9b84"/><rect x="137" y="37" width="46" height="46" fill="#c6ad62"/><g font-family="Arial,sans-serif" font-weight="bold" font-size="24" text-anchor="middle" fill="#373f42"><text x="62" y="68" fill="#fff">H</text><text x="111" y="68">E</text><text x="160" y="68" fill="#fff">L</text><text x="209" y="68">L</text><text x="258" y="68">O</text></g><g fill="#d8dcdd"><rect x="64" y="107" width="190" height="16" rx="2"/><rect x="78" y="127" width="163" height="16" rx="2"/></g>';
  else {
    svg.innerHTML = '<rect width="320" height="180" fill="#e9ecee"/><path d="M0 120 100 48l83 61 57-44 80 55v60H0Z" fill="#c9d0d3"/><circle cx="263" cy="36" r="15" fill="#e36a70"/>';
    const name = el('span', 'cover-name', game.title); node.append(name);
  }
  node.prepend(svg);
  return node;
}
function renderCatalog() {
  const library = state.route.view === 'library';
  $('#library-title').textContent = library ? '我的游戏' : '浏览作品';
  $('#catalog-context').textContent = state.query ? '搜索：“' + state.query + '”' : library ? '已安装和正在准备的作品' : '网页游戏';
  mark($('#catalog-view'), pageUrl(state.route.view));
  renderFilters();
  const grid = $('#game-grid'); grid.replaceChildren();
  const query = state.query.toLocaleLowerCase().trim();
  let games = state.games.filter((g) => (!library || g.status !== 'available') && (!state.genre || (g.genre || '其他') === state.genre) && (!state.license || licenseName(g) === state.license) && (!state.source || sourceName(g) === state.source) && (!query || [g.title, g.description, g.genre, g.repo, repository(g).owner].filter(Boolean).join(' ').toLocaleLowerCase().includes(query)));
  if (state.sort === 'title') games = [...games].sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  if (state.sort === 'installed') games = [...games].sort((a, b) => (Date.parse(b.installedAt) || 0) - (Date.parse(a.installedAt) || 0));
  if (!games.length) {
    const empty = el('div', 'empty-state');
    empty.append(el('h2', '', state.loaded ? '没有符合条件的作品' : '正在读取作品…'));
    if (state.loaded) empty.append(el('p', '', library ? '浏览作品并安装后，游戏会出现在这里。' : '调整筛选条件，或添加一个公开仓库。'));
    grid.append(empty); return;
  }
  games.forEach((game) => {
    const url = pageUrl('detail', game); const card = mark(el('article', 'game-card'), url); card.id = 'game-' + game.id;
    const image = link('', url, 'cover-link'); image.setAttribute('aria-label', '查看 ' + game.title); image.append(cover(game));
    const title = link(game.title, url, 'game-title');
    const repo = repository(game);
    const by = repo.ownerUrl ? link(repo.owner, repo.ownerUrl, 'creator-link', true) : el('span', 'creator-link', repo.owner);
    const heading = el('div', 'card-heading'); heading.append(title, copyButton(url, '复制' + game.title + '的链接'));
    const metadata = el('div', 'card-meta'); metadata.append(el('span', '', game.genre || '网页游戏'), el('span', 'license-tag', licenseName(game)));
    card.append(image, heading, el('p', 'card-description', game.description || '作者尚未提供作品说明。'), by, metadata, el('span', 'status-label ' + game.status, labels[game.status] || '等待检测'));
    grid.append(card);
  });
}
function detailsBlock(title, id, game) {
  const block = mark(el('details', 'info-details'), pageUrl('detail', game, id)); block.id = id;
  const summary = el('summary'); summary.append(el('span', '', title)); block.append(summary);
  const content = el('div', 'details-content'); content.append(copyButton(pageUrl('detail', game, id))); block.append(content);
  return { block, content };
}
function renderDetail(force = false) {
  const game = selectedGame();
  const signature = JSON.stringify(game);
  if (!force && signature === detailSignature) return;
  detailSignature = signature;
  const root = $('#detail-content');
  const open = new Set([...root.querySelectorAll('details[open]')].map((n) => n.id));
  root.replaceChildren();
  if (!game) { root.append(el('h1', '', state.loaded ? '没有找到这个作品' : '正在读取作品…'), link('返回作品目录', pageUrl('browse'), 'text-link')); return; }
  mark($('#detail-view'), pageUrl('detail', game));
  const breadcrumbs = el('div', 'breadcrumbs'); breadcrumbs.append(link('浏览作品', pageUrl('browse')), el('span', '', ' / '), el('span', '', game.title)); root.append(breadcrumbs);
  const columns = el('div', 'detail-columns'); const main = el('article', 'detail-main'); const aside = el('aside', 'detail-sidebar');
  main.append(el('h1', '', game.title));
  const repo = repository(game); const author = el('p', 'detail-author', '作者：');
  author.append(repo.ownerUrl ? link(repo.owner, repo.ownerUrl, '', true) : el('span', '', repo.owner)); main.append(author);
  main.append(el('p', 'detail-description', game.description || '作者尚未提供作品说明。'));
  const links = el('div', 'detail-links');
  if (repo.url) { links.append(link('源代码 ↗', repo.url, '', true)); if (repo.ownerUrl) links.append(link('原作者 ↗', repo.ownerUrl, '', true)); }
  links.append(copyButton(pageUrl('detail', game))); main.append(links);
  const action = button(game.status === 'ready' ? '开始游戏' : game.status === 'installing' ? '正在安装…' : game.status === 'failed' ? '重试安装' : '安装游戏', 'button primary', () => game.status === 'ready' ? navigate(pageUrl('play', game)) : installGame(game.id));
  action.id = 'detail-action'; action.disabled = game.status === 'installing';
  const actions = el('div', 'detail-actions'); actions.append(action, button('反馈问题', 'button', openFeedback));
  main.append(actions, el('p', 'status-line ' + game.status, labels[game.status] || '等待检测'));
  if (game.status === 'installing' || game.status === 'failed') main.append(link('查看下载任务与安装记录', pageUrl('downloads', null, 'task-' + game.id), 'text-link'));
  const facts = el('dl', 'game-facts');
  [[ '类别', game.genre || '网页游戏' ], [ '来源', sourceName(game) ], [ '许可', licenseName(game) ], [ '接入类型', typeName(game) ]].forEach(([k, v]) => facts.append(el('dt', '', k), el('dd', '', v)));
  aside.append(cover(game), facts); columns.append(main, aside); root.append(columns);
  const integration = detailsBlock('接入规范', 'compatibility', game);
  const kind = game.compatibility?.kind || (game.mode === 'build' ? 'npm' : game.mode);
  integration.content.append(el('p', '', kind === 'static' ? '网页文件下载到运行电脑后直接打开。' : kind === 'npm' ? '源码下载到运行电脑后，安装依赖并构建网页。' : game.compatibility?.reason || '安装时检测网页入口及构建方式。'));
  if (game.compatibility?.reason && kind !== 'unsupported') integration.content.append(el('p', '', game.compatibility.reason));
  root.append(integration.block);
  const license = detailsBlock('许可 · ' + licenseName(game), 'license', game);
  license.content.append(game.provenance?.licenseText ? el('pre', 'document-text', game.provenance.licenseText) : el('p', '', '尚未读取许可全文。安装后可在这里查看，也可以前往原仓库查看许可文件。'));
  if (repo.url) license.content.append(link('查看原仓库 ↗', repo.url, 'text-link', true)); root.append(license.block);
  const readme = detailsBlock('README', 'readme', game);
  readme.content.append(game.provenance?.readme ? el('pre', 'document-text', game.provenance.readme) : el('p', '', '尚未读取 README。安装后可查看本地源码中的说明。'));
  if (repo.url) readme.content.append(link('打开仓库说明 ↗', repo.url, 'text-link', true)); root.append(readme.block);
  const diagnostics = detailsBlock('安装日志与版本', 'diagnostics', game);
  const data = el('dl', 'diagnostic-facts');
  [['Git commit', game.commit || game.source?.commit || '尚未安装'], ['分支或版本', game.source?.ref || game.ref || '默认分支'], ['网页入口', game.compatibility?.entry || '待检测'], ['输出目录', game.compatibility?.output || game.output || '仓库根目录'], ['软件版本', game.provenance?.version || '未声明']].forEach(([k, v]) => data.append(el('dt', '', k), el('dd', '', v)));
  diagnostics.content.append(data);
  if (game.error) diagnostics.content.append(el('p', 'diagnostic-error', game.error));
  const log = el('pre', 'install-log', state.logs.get(game.id) || '展开后读取安装记录。'); log.id = 'install-log'; log.dataset.logGame = game.id; log.tabIndex = 0; diagnostics.content.append(log);
  diagnostics.block.addEventListener('toggle', () => { if (diagnostics.block.open) loadLog(game.id); }); root.append(diagnostics.block);
  root.querySelectorAll('details').forEach((n) => { n.open = open.has(n.id) || state.route.section === n.id; });
}
function openFeedback() {
  if (!selectedGame()) return;
  if (!feedback) feedback = setupFeedback({ frame: $('#game-frame'), game: selectedGame, getBase: () => base });
  feedback.open();
}
function renderPlay() {
  const game = selectedGame();
  mark($('#play-view'), game ? pageUrl('play', game) : pageUrl('browse'));
  $('#play-title').textContent = game?.title || '游戏';
  $('#back-to-detail').href = pageUrl(game ? 'detail' : 'browse', game).href; $('#back-to-detail').dataset.internal = 'true';
  $('#feedback-button').disabled = !game; $('#copy-current-link').disabled = !game;
  const playable = game?.status === 'ready' && game.playUrl;
  const fullscreen = $('#fullscreen-link'); fullscreen.setAttribute('aria-disabled', String(!playable));
  if (playable) fullscreen.href = safeUrl(game.playUrl, true).href; else fullscreen.removeAttribute('href');
  $('#stage-placeholder').hidden = !!playable; $('#game-frame').hidden = !playable;
  if (playable) {
    const url = safeUrl(game.playUrl, true).href;
    $('#game-frame').title = game.title;
    if (state.playUrl !== url) { $('#game-frame').src = url; state.playUrl = url; }
    return;
  }
  $('#stage-title').textContent = game?.title || (state.loaded ? '没有找到这个作品' : '正在读取作品…');
  $('#stage-description').textContent = game?.status === 'installing' ? '正在下载和准备游戏，完成后会在这里打开。' : game?.status === 'failed' ? '安装未完成，可以查看安装记录或反馈问题。' : '安装到运行电脑后即可开始。';
  $('#stage-action').hidden = !game; $('#stage-action').disabled = game?.status === 'installing'; $('#stage-action').textContent = game?.status === 'installing' ? '正在安装…' : game?.status === 'failed' ? '重试安装' : '安装游戏';
}
async function installGame(id) {
  const game = state.games.find((g) => g.id === id);
  if (!game || game.status === 'installing') return;
  game.status = 'installing'; state.logs.set(id, '正在准备安装…'); renderCurrent();
  try { await request('api/games/' + encodeURIComponent(id) + '/install', { method: 'POST', body: '{}' }); await loadCatalog(); }
  catch (error) { game.status = 'failed'; game.error = error.message; renderCurrent(); notify(error.message); }
}
function updateLogs(id) {
  document.querySelectorAll('[data-log-game]').forEach((log) => { if (log.dataset.logGame === id) { const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 45; log.textContent = state.logs.get(id) || '暂无安装记录。'; if (follow) log.scrollTop = log.scrollHeight; } });
}
async function loadLog(id) {
  try { const result = await request('api/games/' + encodeURIComponent(id) + '/log'); state.logs.set(id, result.text || '暂无安装记录。'); updateLogs(id); }
  catch (error) { state.logs.set(id, error.message); updateLogs(id); }
}
function renderDownloads() {
  const root = $('#downloads-list'); const open = new Set([...root.querySelectorAll('details[open]')].map((d) => d.id)); root.replaceChildren();
  mark($('#downloads-view'), pageUrl('downloads'));
  const games = state.games.filter((g) => g.task || ['installing', 'failed', 'ready'].includes(g.status));
  if (!games.length) { root.append(el('div', 'empty-state', '还没有下载任务。到作品详情安装游戏，或添加一个公开仓库。')); return; }
  games.forEach((game) => {
    const url = pageUrl('downloads', null, 'task-' + game.id);
    const item = mark(el('article', 'task-item'), url); item.id = 'task-' + game.id;
    const heading = el('div', 'list-item-heading'); heading.append(link(game.title, pageUrl('detail', game), 'list-title'), el('span', 'status-label ' + game.status, labels[game.status] || '等待检测'), copyButton(url)); item.append(heading);
    item.append(el('p', 'list-meta', sourceName(game) + ' · ' + (repository(game).owner || '')));
    const actions = el('div', 'list-actions'); actions.append(link('作品详情', pageUrl('detail', game), 'text-link'));
    if (game.status === 'ready') actions.append(link('开始游戏', pageUrl('play', game), 'button primary compact'));
    if (game.status === 'failed') actions.append(button('重试安装', 'button compact', () => installGame(game.id)));
    item.append(actions);
    const details = el('details', 'info-details task-log'); details.id = 'task-log-' + game.id;
    const summary = el('summary', '', '安装记录'); const log = el('pre', 'install-log', state.logs.get(game.id) || '展开后读取安装记录。'); log.dataset.logGame = game.id;
    details.append(summary, log); details.addEventListener('toggle', () => { if (details.open) loadLog(game.id); }); details.open = open.has(details.id) || state.route.section === item.id;
    item.append(details); root.append(item);
  });
}
function renderReports() {
  const root = $('#reports-list'); root.replaceChildren(); mark($('#reports-view'), pageUrl('reports'));
  if (!state.reports.length) { root.append(el('div', 'empty-state', '还没有问题记录。在作品详情或游戏中点击“反馈问题”。')); return; }
  [...state.reports].reverse().forEach((report) => {
    const item = mark(el('article', 'report-item'), pageUrl('reports', null, 'report-' + report.id)); item.id = 'report-' + report.id;
    const game = state.games.find((g) => g.id === report.gameId);
    const heading = el('div', 'list-item-heading'); heading.append(el('h2', 'list-title', report.summary || '游戏问题'), copyButton(pageUrl('reports', null, item.id))); item.append(heading);
    const date = new Date(report.createdAt);
    item.append(el('p', 'list-meta', [game?.title || report.title || '作品', Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN')].filter(Boolean).join(' · ')));
    const actions = el('div', 'list-actions');
    if (game) actions.append(link('作品详情', pageUrl('detail', game), 'text-link'));
    for (const [name, path] of [['查看报告', report.url], ['导出报告', report.downloadUrl || (report.url?.endsWith('.html') ? report.url.replace(/\.html$/, '.json') : null)]]) if (path) {
      try { const a = link(name, safeUrl(path, true), 'text-link', true); if (name === '导出报告') a.download = ''; actions.append(a); } catch { /* Text remains accessible when a report link is invalid. */ }
    }
    item.append(actions); root.append(item);
  });
}
async function loadReports() {
  if (reportsRequest) return reportsRequest;
  reportsRequest = request('api/reports').then((data) => { state.reports = data.reports || []; if (state.route.view === 'reports') renderReports(); }).catch((error) => notify(error.message));
  try { await reportsRequest; } finally { reportsRequest = null; }
}
function renderCurrent() {
  if (['browse', 'library'].includes(state.route.view)) renderCatalog();
  else if (state.route.view === 'detail') renderDetail();
  else if (state.route.view === 'play') renderPlay();
  else if (state.route.view === 'downloads') renderDownloads();
  else if (state.route.view === 'reports') renderReports();
  if (selectedGame() && ['detail', 'play'].includes(state.route.view) && !feedback) feedback = setupFeedback({ frame: $('#game-frame'), game: selectedGame, getBase: () => base });
}
function mergeGames(games) {
  if (!Array.isArray(games)) return;
  const firstLoad = !state.loaded;
  const previous = new Map(state.games.map((g) => [g.id, g]));
  state.games = games.map((g) => ({ ...previous.get(g.id), ...g })); state.loaded = true;
  renderCurrent();
  if (firstLoad) scrollToSection();
}
async function loadCatalog() {
  if (catalogRequest) return catalogRequest;
  catalogRequest = request('api/catalog').then((data) => { updateMachine(data.machine?.hostname); if (Array.isArray(data.reports)) state.reports = data.reports; mergeGames(data.games || []); updateConnection(true); }).catch((error) => { updateConnection(false); throw error; });
  try { await catalogRequest; } finally { catalogRequest = null; }
}
function connectEvents() {
  eventSource = new EventSource(safeUrl('api/events', true));
  eventSource.onopen = () => { updateConnection(true); clearTimeout(backupTimer); loadCatalog().catch(() => {}); };
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'state') mergeGames(data.games);
      if (data.type === 'log' && data.gameId) { const old = state.logs.get(data.gameId) || ''; state.logs.set(data.gameId, (old + (old ? '\n' : '') + (data.line || '')).slice(-200000)); updateLogs(data.gameId); }
      if (data.type === 'report') loadReports();
    } catch { /* One malformed event does not interrupt a running game. */ }
  };
  const backup = async () => { try { await loadCatalog(); } catch { updateConnection(false); } if (eventSource.readyState !== EventSource.OPEN) backupTimer = setTimeout(backup, 15000); };
  eventSource.onerror = () => { updateConnection(false); clearTimeout(backupTimer); backupTimer = setTimeout(backup, 8000); };
}
document.addEventListener('click', (event) => {
  const a = event.target.closest('a[data-route],a[data-internal]');
  if (!a || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); navigate(a.href);
});
document.addEventListener('contextmenu', (event) => {
  if (event.target.closest('input,textarea,pre,a[target="_blank"]')) return;
  const node = event.target.closest('[data-deep-link]');
  if (node) { event.preventDefault(); copyLink(node.dataset.deepLink); }
});
$('#game-search').addEventListener('input', (event) => {
  state.query = event.target.value;
  navigate(pageUrl(['browse', 'library'].includes(state.route.view) ? state.route.view : 'browse'), ['browse', 'library'].includes(state.route.view));
  renderCatalog();
});
$('#search-form').addEventListener('submit', (event) => { event.preventDefault(); navigate(pageUrl('browse')); });
$('#game-sort').addEventListener('change', (event) => { state.sort = event.target.value; filtersChanged(); });
$('#clear-filters').addEventListener('click', () => { state.query = ''; state.genre = ''; state.license = ''; state.source = ''; filtersChanged(); });
$('#toggle-filters').addEventListener('click', () => { const open = $('#filter-sidebar').classList.toggle('open'); $('#toggle-filters').setAttribute('aria-expanded', String(open)); });
$('#copy-catalog-link').addEventListener('click', () => copyLink(pageUrl(state.route.view)));
$('#copy-runtime-link').addEventListener('click', (event) => copyLink(event.currentTarget.dataset.runtimeLink));
document.querySelectorAll('[data-copy-view]').forEach((node) => node.addEventListener('click', () => copyLink(pageUrl(node.dataset.copyView))));
$('#stage-action').addEventListener('click', () => { if (selectedGame()) installGame(state.selected); });
$('#feedback-button').addEventListener('click', openFeedback);
$('#copy-current-link').addEventListener('click', () => { if (selectedGame()) copyLink(pageUrl('play', selectedGame())); });
$('#fullscreen-link').addEventListener('click', (event) => { if (event.currentTarget.getAttribute('aria-disabled') === 'true') event.preventDefault(); });
$('#add-repository').addEventListener('click', () => { $('#import-error').hidden = true; $('#import-dialog').showModal(); $('#repository-url').focus(); });
['#close-import', '#cancel-import'].forEach((selector) => $(selector).addEventListener('click', () => $('#import-dialog').close()));
$('#import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = { repo: $('#repository-url').value.trim() };
  for (const key of ['title', 'ref', 'output']) { const value = $('#repository-' + key).value.trim(); if (value) data[key] = value; }
  const submit = $('#submit-import'); submit.disabled = true; submit.textContent = '正在添加…'; $('#import-error').hidden = true;
  try {
    const result = await request('api/catalog/import', { method: 'POST', body: JSON.stringify(data) });
    if (!result.gameId) throw new Error('作品尚未登记，请重试');
    await loadCatalog();
    if (!state.games.some((g) => g.id === result.gameId)) state.games.push({ id: result.gameId, repo: data.repo, title: data.title || safeUrl(data.repo).pathname.split('/').filter(Boolean).at(-1)?.replace(/\.git$/, '') || '作品', status: 'installing', task: result.task });
    $('#import-dialog').close(); $('#import-form').reset(); navigate(pageUrl('detail', result.gameId)); notify('已添加，安装进度可在下载任务中查看');
  } catch (error) { $('#import-error').textContent = error.message; $('#import-error').hidden = false; }
  finally { submit.disabled = false; submit.textContent = '添加并安装'; }
});
window.addEventListener('popstate', syncRoute);
window.addEventListener('hashchange', syncRoute);
window.addEventListener('pagehide', () => { eventSource?.close(); clearTimeout(backupTimer); clearTimeout(toastTimer); feedback?.stop(); });
syncRoute();
loadCatalog().catch((error) => {
  updateConnection(false); state.loaded = true; renderCurrent(); notify(error.message, true);
  const retry = button('重新连接', 'button primary', () => loadCatalog().catch((failure) => notify(failure.message)));
  $('#toast').append(retry);
});
connectEvents();
