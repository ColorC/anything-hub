import html2canvas from 'html2canvas';

const LIMIT = 100;
const STYLE_ID = 'anything-hub-feedback-style';
const OWN = 'data-hub-feedback';

function clean(value, limit = 1800) {
  return String(value ?? '').replace(/(bearer\s+)[\w.\-]+/gi, '$1[已隐藏]')
    .replace(/((?:password|passwd|secret|token|authorization|api[_-]?key)\s*[=:]\s*)[^\s,;&]+/gi, '$1[已隐藏]')
    .slice(0, limit);
}

function safeUrl(value, base) {
  try {
    const url = new URL(value, base);
    url.username = '';
    url.password = '';
    // Diagnostics need the endpoint, not query values, fragments or credentials.
    url.search = '';
    url.hash = '';
    return url.href;
  } catch { return '[地址不可用]'; }
}

function serialize(value) {
  try {
    const tag = Object.prototype.toString.call(value);
    if (value instanceof Error || tag === '[object Error]') return clean(`${value.name}: ${value.message}\n${value.stack || ''}`);
    if (typeof value === 'string') return clean(value);
    if (value == null || ['number', 'boolean'].includes(typeof value)) return String(value);
    // Do not inspect arbitrary game objects: getters may have side effects or expose private data.
    return clean(tag, 150);
  } catch { return '[无法读取的对象]'; }
}

function installStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .hub-feedback,.hub-feedback *{box-sizing:border-box;user-select:text;-webkit-user-select:text}
    .hub-feedback{position:fixed;inset:0;z-index:2147483000;background:#08101dd9;display:grid;place-items:center;padding:20px;color:#eff4ff;font:14px/1.6 system-ui,sans-serif}
    .hub-feedback[hidden],.hub-feedback-toolbar[hidden]{display:none!important}
    .hub-feedback-panel{width:min(720px,100%);max-height:94dvh;overflow:auto;background:#142033;border:1px solid #50647c;border-radius:16px;padding:22px;box-shadow:0 16px 64px #0008}
    .hub-feedback h2{margin:0 0 8px;font-size:21px}.hub-feedback p{margin:8px 0;color:#bacadd}
    .hub-feedback label{display:block;margin:14px 0 5px}.hub-feedback input,.hub-feedback textarea{width:100%;padding:10px 12px;background:#0c1726;color:#eff4ff;border:1px solid #60728b;border-radius:8px;font:inherit}
    .hub-feedback textarea{min-height:108px;resize:vertical}.hub-feedback button,.hub-feedback-toolbar button{font:inherit;color:#eff4ff;background:#294365;border:1px solid #7185a0;border-radius:8px;padding:8px 13px;cursor:pointer}
    .hub-feedback button:disabled{opacity:.5;cursor:wait}.hub-feedback button:hover,.hub-feedback-toolbar button:hover{background:#355681}
    .hub-feedback-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.hub-feedback-output{white-space:pre-wrap;overflow-wrap:anywhere;padding:10px;background:#0c1726;border-radius:8px;margin-top:10px}
    .hub-feedback-preview{display:block;max-width:100%;max-height:220px;margin-top:12px;border:1px solid #50647c;border-radius:8px}.hub-feedback-preview[hidden]{display:none}
    .hub-feedback a{color:#8fcbff}.hub-feedback-result a{display:inline-block;margin:6px 12px 0 0}
    .hub-feedback-toolbar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483001;display:flex;align-items:center;flex-wrap:wrap;justify-content:center;gap:8px;width:max-content;max-width:95vw;background:#142033f5;color:#eff4ff;padding:10px 14px;border:1px solid #8da4be;border-radius:12px;font:14px/1.5 system-ui,sans-serif;user-select:text}
    .hub-feedback-toolbar span{max-width:400px}.hub-feedback [role=status]{min-height:24px;margin-top:10px;color:#c6d9ed}
    @media(max-width:500px){.hub-feedback{padding:8px}.hub-feedback-panel{padding:15px}.hub-feedback-toolbar{bottom:8px;font-size:12px}}
  `;
  document.head.append(style);
}

function elementSelector(element, doc) {
  const escape = doc.defaultView?.CSS?.escape || (text => String(text).replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`));
  if (!element || element.nodeType !== 1) return '';
  if (element.id) {
    const id = `#${escape(element.id)}`;
    if (doc.querySelectorAll(id).length === 1) return id;
  }
  const parts = [];
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    let part = node.localName;
    if (node.id) {
      parts.unshift(`#${escape(node.id)}`);
      break;
    }
    const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(child => child.localName === node.localName) : [];
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    parts.unshift(part);
    if (parts.length === 10 || node === doc.body) break;
  }
  return parts.join(' > ');
}

/** Local, explicit problem reporting for a same-origin game iframe. */
export function setupFeedback({ frame, game, getBase }) {
  if (!frame || typeof getBase !== 'function') throw new TypeError('setupFeedback requires frame and getBase');
  installStyle();
  const records = [];
  let stopped = false;
  let collecting = false;
  let binding = null;
  let picker = null;
  let screenshot = null;
  let selector = '';
  let selection = null;
  let canvasSelection = false;
  let busy = false;
  let previousFocus = null;
  let linkedOnce = false;
  const currentGame = () => typeof game === 'function' ? game() : game;
  const currentBase = () => new URL(getBase(), window.location.href);
  const record = (type, data) => {
    if (stopped) return;
    records.push({ time: new Date().toISOString(), type, ...data });
    if (records.length > LIMIT) records.shift();
  };
  const setStatus = text => { status.textContent = text; };
  const own = element => Boolean(element?.closest?.(`[${OWN}]`));

  const modal = document.createElement('div');
  modal.className = 'hub-feedback';
  modal.setAttribute(OWN, 'dialog');
  modal.hidden = true;
  modal.innerHTML = `<section class="hub-feedback-panel" role="dialog" aria-modal="true" aria-labelledby="hub-feedback-title">
    <h2 id="hub-feedback-title">反馈游戏问题</h2>
    <p>圈出有问题的地方，补充复现步骤。截图和记录先保留在当前浏览器，点击保存后存到运行游戏的电脑。</p>
    <label for="hub-feedback-summary">问题简述</label><input id="hub-feedback-summary" maxlength="300" placeholder="例如：点开始后没有反应">
    <label for="hub-feedback-details">复现步骤与预期结果</label><textarea id="hub-feedback-details" maxlength="10000" placeholder="做了什么、看到了什么、原本希望发生什么"></textarea>
    <div class="hub-feedback-actions"><button type="button" data-action="element">圈选元素</button><button type="button" data-action="region">圈选区域</button><button type="button" data-action="capture">截取游戏画面</button><button type="button" data-action="locate">复制定位链接</button></div>
    <div class="hub-feedback-output" data-selection>尚未圈选</div><img class="hub-feedback-preview" alt="本次问题截图" hidden>
    <p>只记录游戏中的点击、滚动、按键类别和错误，不记录输入内容。打开反馈后可关闭面板，在游戏中复现，再回来保存。</p>
    <div class="hub-feedback-actions"><button type="button" data-action="save">保存报告</button><button type="button" data-action="export">导出 JSON</button><button type="button" data-action="close">关闭</button></div>
    <div role="status" aria-live="polite"></div><div class="hub-feedback-result"></div>
  </section>`;
  const toolbar = document.createElement('div');
  toolbar.className = 'hub-feedback-toolbar';
  toolbar.setAttribute(OWN, 'toolbar');
  toolbar.hidden = true;
  toolbar.innerHTML = '<span></span><button type="button" data-pick="done">完成圈选</button><button type="button" data-pick="cancel">取消</button>';
  document.body.append(modal, toolbar);
  const summaryInput = modal.querySelector('input');
  const detailsInput = modal.querySelector('textarea');
  const preview = modal.querySelector('img');
  const status = modal.querySelector('[role=status]');
  const selectionOutput = modal.querySelector('[data-selection]');
  const resultOutput = modal.querySelector('.hub-feedback-result');
  const toolbarText = toolbar.querySelector('span');

  function getFrameContext() {
    try {
      const doc = frame.contentDocument;
      const view = frame.contentWindow;
      if (!view) throw new Error('当前游戏尚未运行，仍可填写描述并保存问题报告。');
      void view.location.href;
      if (!doc?.body || view.location.href === 'about:blank' || !frame.getAttribute('src')) throw new Error('当前游戏尚未运行，仍可填写描述并保存问题报告。');
      return { doc, view };
    } catch (error) {
      if (error?.name === 'SecurityError') throw new Error('这个游戏来自其它网站，无法读取页面。请描述问题；也可以反馈当前游戏的打开地址。');
      throw error;
    }
  }

  function updateSelection() {
    selectionOutput.textContent = selection
      ? `${canvasSelection ? '画布区域' : selector ? '页面元素' : '页面区域'}${selector ? `：${selector}` : ''}\n位置：${Math.round(selection.x)}, ${Math.round(selection.y)}；大小：${Math.round(selection.width)} × ${Math.round(selection.height)}`
      : '尚未圈选';
  }

  function attachFrame() {
    binding?.();
    binding = null;
    if (stopped) return;
    let context;
    try { context = getFrameContext(); } catch { return; }
    const { doc, view } = context;
    const removes = [];
    const listen = (target, name, handler, options) => {
      target.addEventListener(name, handler, options);
      removes.push(() => target.removeEventListener(name, handler, options));
    };
    listen(view, 'error', event => {
      record('error', { message: clean(event.message || `资源加载失败：${event.target?.tagName || ''}`), stack: clean(event.error?.stack), file: safeUrl(event.filename || event.target?.src || event.target?.href || '', view.location.href), line: event.lineno || null, column: event.colno || null });
    }, true);
    listen(view, 'unhandledrejection', event => record('rejection', { message: serialize(event.reason), stack: clean(event.reason?.stack) }));
    for (const level of ['error', 'warn']) {
      const original = view.console?.[level];
      if (typeof original !== 'function') continue;
      const wrapped = function (...args) {
        try { record('console', { level, message: args.map(serialize).join(' ').slice(0, 1800) }); } catch { /* Logging must not affect game output. */ }
        return Reflect.apply(original, this, args);
      };
      try {
        view.console[level] = wrapped;
        removes.push(() => { if (view.console[level] === wrapped) view.console[level] = original; });
      } catch { /* A read-only console should keep working unchanged. */ }
    }
    const originalFetch = view.fetch;
    if (typeof originalFetch === 'function') {
      const wrappedFetch = function (...args) {
        const input = args[0];
        // Return the original promise/response behavior, and never read request or response bodies.
        const promise = Reflect.apply(originalFetch, this, args);
        let url = '[地址不可用]';
        let method = 'GET';
        try {
          url = safeUrl(typeof input === 'string' || input instanceof view.URL ? input : input instanceof view.Request ? input.url : '', view.location.href);
          const descriptor = args[1] && Object.getOwnPropertyDescriptor(args[1], 'method');
          method = clean(descriptor && 'value' in descriptor ? descriptor.value : input instanceof view.Request ? input.method : 'GET', 20);
        } catch { /* Unusual fetch arguments must preserve original fetch behavior. */ }
        return promise.then(response => {
          if (!response.ok) record('network', { url, method, status: response.status, message: `HTTP ${response.status}` });
          return response;
        }, error => {
          record('network', { url, method, status: null, message: clean(error?.message || error) });
          throw error;
        });
      };
      try {
        view.fetch = wrappedFetch;
        removes.push(() => { if (view.fetch === wrappedFetch) view.fetch = originalFetch; });
      } catch { /* Frozen fetch environments remain functional. */ }
    }
    listen(doc, 'click', event => {
      if (!collecting || picker || own(event.target)) return;
      record('interaction', { action: 'click', selector: elementSelector(event.target, doc), x: Math.round(event.clientX), y: Math.round(event.clientY) });
    }, true);
    let lastScroll = 0;
    listen(view, 'scroll', () => {
      if (!collecting || picker || Date.now() - lastScroll < 500) return;
      lastScroll = Date.now();
      record('interaction', { action: 'scroll', x: Math.round(view.scrollX), y: Math.round(view.scrollY) });
    }, { passive: true });
    listen(doc, 'keydown', event => {
      if (!collecting || picker || own(event.target)) return;
      const allowed = ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
      record('interaction', { action: 'key', key: allowed.includes(event.key) ? event.key : '输入按键', selector: elementSelector(event.target, doc) });
    }, true);
    binding = () => removes.reverse().forEach(remove => { try { remove(); } catch { /* detached frame */ } });
    if (!linkedOnce) {
      const linked = new URL(window.location.href).searchParams.get('pick');
      if (linked) {
        linkedOnce = true;
        try {
          const target = doc.querySelector(linked);
          if (target) {
            target.scrollIntoView({ block: 'center' });
            const old = target.style.outline;
            target.style.outline = '3px solid #ffcd58';
            const applied = target.style.outline;
            const timer = view.setTimeout(() => { if (target.style.outline === applied) target.style.outline = old; }, 2500);
            removes.push(() => { view.clearTimeout(timer); if (target.style.outline === applied) target.style.outline = old; });
          }
        } catch { /* Stale selectors do not prevent playing. */ }
      }
    }
  }

  function endPicker() {
    if (!picker) return;
    picker.cleanup();
    picker = null;
    toolbar.hidden = true;
    modal.hidden = false;
    updateSelection();
  }

  function startPicker(mode) {
    if (busy) return;
    try {
      const { doc, view } = getFrameContext();
      endPicker();
      modal.hidden = true;
      toolbar.hidden = false;
      toolbarText.textContent = mode === 'region' ? '在游戏中拖动框选区域，然后完成圈选。' : '点击选中元素，同一位置再次点击可选下面一层，然后完成圈选。';
      const outline = doc.createElement('div');
      outline.setAttribute(OWN, 'outline');
      outline.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483000;border:3px solid #ffcd58;background:#ffcd5818;display:none;box-sizing:border-box;';
      doc.documentElement.append(outline);
      const listeners = [];
      let dragStart = null;
      let lastPoint = null;
      let cycle = 0;
      const previous = { selector, selection, canvasSelection };
      const draw = rect => {
        Object.assign(outline.style, { display: 'block', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      };
      const useRect = rect => {
        selection = { x: rect.left + view.scrollX, y: rect.top + view.scrollY, width: rect.width, height: rect.height };
        draw(rect);
      };
      const listen = (name, handler) => {
        doc.addEventListener(name, handler, true);
        listeners.push(() => doc.removeEventListener(name, handler, true));
      };
      const block = event => { event.preventDefault(); event.stopImmediatePropagation(); };
      listen('pointerdown', event => {
        if (event.button !== 0) return;
        block(event);
        if (mode === 'region') dragStart = { x: event.clientX, y: event.clientY };
      });
      listen('pointermove', event => {
        if (!dragStart) return;
        block(event);
        selector = '';
        canvasSelection = false;
        useRect({ left: Math.min(dragStart.x, event.clientX), top: Math.min(dragStart.y, event.clientY), width: Math.abs(event.clientX - dragStart.x), height: Math.abs(event.clientY - dragStart.y) });
      });
      listen('pointerup', event => {
        block(event);
        if (mode === 'region') { dragStart = null; return; }
        const point = { x: event.clientX, y: event.clientY };
        if (lastPoint && Math.abs(lastPoint.x - point.x) < 5 && Math.abs(lastPoint.y - point.y) < 5) cycle += 1;
        else cycle = 0;
        lastPoint = point;
        const elements = doc.elementsFromPoint(point.x, point.y).filter(element => !own(element) && !['html', 'body'].includes(element.localName));
        const target = elements[cycle % Math.max(1, elements.length)];
        if (!target) return;
        selector = elementSelector(target, doc);
        canvasSelection = target.localName === 'canvas';
        useRect(target.getBoundingClientRect());
        toolbarText.textContent = canvasSelection ? '这个位置是画布，只能定位画布区域；需要更小范围时使用圈选区域。' : `已选：${selector}；继续点击相同位置可选下面一层。`;
      });
      // Prevent the picker click from activating the selected game's UI.
      listen('click', block);
      listen('dblclick', block);
      listen('keydown', event => { if (event.key === 'Escape') { block(event); selector = previous.selector; selection = previous.selection; canvasSelection = previous.canvasSelection; endPicker(); } });
      picker = { previous, cleanup: () => { listeners.forEach(remove => remove()); outline.remove(); } };
    } catch (error) { modal.hidden = false; toolbar.hidden = true; setStatus(clean(error.message)); }
  }

  async function capture() {
    if (busy) return;
    endPicker();
    busy = true;
    setStatus('正在生成游戏截图…');
    try {
      const { doc, view } = getFrameContext();
      const scroll = { x: view.scrollX, y: view.scrollY };
      // Remove the picker before capturing; capture only the visible game viewport.
      await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
      const canvas = await html2canvas(frame.contentDocument.body, {
        useCORS: true, allowTaint: false, logging: false, imageTimeout: 8000,
        scale: Math.min(1, 1600 / Math.max(1, view.innerWidth)),
        x: scroll.x, y: scroll.y, scrollX: scroll.x, scrollY: scroll.y, width: view.innerWidth, height: view.innerHeight,
        windowWidth: view.innerWidth, windowHeight: view.innerHeight,
        ignoreElements: element => own(element) || element.matches?.('noscript, input[type="password"], [data-feedback-private]'),
        onclone: async clonedDoc => {
          // html2canvas's about:blank clone can inherit the host page's URL, not
          // this iframe's URL. Keep assets relative to the original game document.
          let base = clonedDoc.querySelector('base');
          if (!base) { base = clonedDoc.createElement('base'); clonedDoc.head.prepend(base); }
          base.href = doc.baseURI;
          const originalStylesheets = Array.from(doc.querySelectorAll('link[rel~="stylesheet"]'));
          await Promise.all(Array.from(clonedDoc.querySelectorAll('link[rel~="stylesheet"]')).map((link, index) => {
            const source = originalStylesheets[index];
            const href = source?.href || new URL(link.getAttribute('href'), doc.baseURI).href;
            return new Promise((resolve, reject) => {
              // A failed original relative request may still leave link.sheet set.
              // Create a fresh link and wait for its actual load event.
              const loadedLink = link.cloneNode(false);
              const done = error => {
                clearTimeout(timer);
                loadedLink.removeEventListener('load', loaded);
                loadedLink.removeEventListener('error', failed);
                error ? reject(error) : resolve();
              };
              const loaded = () => done();
              const failed = () => done(new Error('游戏样式加载失败，未生成失真的截图。'));
              const timer = setTimeout(() => done(new Error('游戏截图的样式加载超时。')), 5000);
              loadedLink.addEventListener('load', loaded, { once: true });
              loadedLink.addEventListener('error', failed, { once: true });
              loadedLink.href = href;
              link.replaceWith(loadedLink);
            });
          }));
          if (clonedDoc.fonts?.ready) {
            let timer;
            await Promise.race([clonedDoc.fonts.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('游戏截图的字体加载超时。')), 5000); })]).finally(() => clearTimeout(timer));
          }
          clonedDoc.querySelectorAll('input, textarea, [contenteditable="true"], [data-feedback-private]').forEach(element => {
            if ('value' in element && !element.matches?.('input[type="range"]')) element.value = '';
            if (element.isContentEditable || element.hasAttribute('data-feedback-private')) element.textContent = '';
          });
          // Its first scroll restoration runs before the corrected CSS loads and
          // can be clamped to zero. Restore it again after the final game layout.
          clonedDoc.defaultView.scrollTo(scroll.x, scroll.y);
        }
      });
      if (stopped) return;
      screenshot = canvas.toDataURL('image/png');
      preview.src = screenshot;
      preview.hidden = false;
      const canvases = Array.from(doc.querySelectorAll('canvas'));
      setStatus(canvases.length ? '截图已生成。画布游戏可能不保留绘制缓冲；请检查预览是否包含需要反馈的画面。' : '截图已生成，请检查预览。');
    } catch (error) { setStatus(`截图失败：${clean(error.message)}。仍可保存描述和诊断记录。`); }
    finally { busy = false; }
  }

  function payload() {
    const active = currentGame() || {};
    let environment;
    try {
      const { doc, view } = getFrameContext();
      environment = { userAgent: navigator.userAgent, language: navigator.language, platform: navigator.platform, viewport: { width: view.innerWidth, height: view.innerHeight }, devicePixelRatio: view.devicePixelRatio, gameUrl: safeUrl(view.location.href), visibility: doc.visibilityState, canvasCount: doc.querySelectorAll('canvas').length, canvasSelection };
    } catch {
      environment = { userAgent: navigator.userAgent, language: navigator.language, frameUrl: safeUrl(frame.src, window.location.href), unavailable: '无法读取游戏页面' };
    }
    return { gameId: active.id, summary: clean(summaryInput.value, 300), details: clean(detailsInput.value, 10000), selector, selection, screenshot, commit: active.commit || null,
      diagnostics: { events: records.filter(entry => entry.type === 'interaction'), console: records.filter(entry => entry.type === 'console'), errors: records.filter(entry => ['error', 'rejection'].includes(entry.type)), network: records.filter(entry => entry.type === 'network'), environment, capturedAt: new Date().toISOString(), eventLimit: LIMIT } };
  }

  function exportReport() {
    const active = currentGame() || {};
    const file = new Blob([JSON.stringify(payload(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `problem-${String(active.id || 'game').replace(/[^a-z0-9_-]/gi, '-')}-${Date.now()}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('已导出本次问题报告。');
  }

  async function save() {
    if (busy) return;
    if (!summaryInput.value.trim()) { setStatus('请先写一句问题简述。'); summaryInput.focus(); return; }
    busy = true;
    const button = modal.querySelector('[data-action=save]');
    button.disabled = true;
    setStatus('正在保存报告…');
    try {
      const response = await fetch(new URL('api/reports', currentBase()), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()), signal: AbortSignal.timeout(15000) });
      const body = await response.json();
      if (!response.ok || !body.report) throw new Error(body.error || `HTTP ${response.status}`);
      if (stopped) return;
      resultOutput.replaceChildren();
      for (const [label, path, download] of [['打开报告', body.report.url, false], ['下载报告 JSON', body.report.downloadUrl, true]]) {
        if (!path) continue;
        const url = new URL(path, currentBase());
        if (url.origin !== currentBase().origin || !['http:', 'https:'].includes(url.protocol)) continue;
        const anchor = document.createElement('a');
        anchor.href = url.href;
        anchor.textContent = label;
        anchor.target = '_blank';
        anchor.rel = 'noopener';
        if (download) anchor.download = `${body.report.id || 'problem'}.json`;
        resultOutput.append(anchor);
      }
      setStatus('报告已保存到运行电脑，可打开查看或下载给开发者。');
    } catch (error) { setStatus(`保存失败：${clean(error.message)}。可以先导出 JSON 保留本次记录。`); }
    finally { busy = false; button.disabled = false; }
  }

  async function copyLocation() {
    const url = new URL(window.location.href);
    const active = currentGame() || {};
    if (active.id) url.searchParams.set('game', active.id);
    if (selector) url.searchParams.set('pick', selector);
    else url.searchParams.delete('pick');
    try { await navigator.clipboard.writeText(url.href); setStatus('定位链接已复制。'); }
    catch { setStatus(url.href); }
  }

  function close() {
    endPicker();
    modal.hidden = true;
    toolbar.hidden = true;
    previousFocus?.focus?.();
  }

  const actionHandler = event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'element' || action === 'region') startPicker(action);
    else if (action === 'capture') void capture();
    else if (action === 'locate') void copyLocation();
    else if (action === 'export') exportReport();
    else if (action === 'save') void save();
    else if (action === 'close') close();
  };
  const toolbarHandler = event => {
    const action = event.target.closest('[data-pick]')?.dataset.pick;
    if (action === 'done') { endPicker(); void capture(); }
    if (action === 'cancel') {
      if (picker) { selector = picker.previous.selector; selection = picker.previous.selection; canvasSelection = picker.previous.canvasSelection; }
      endPicker();
    }
  };
  const escapeHandler = event => { if (event.key === 'Escape' && !modal.hidden) close(); };
  modal.addEventListener('click', actionHandler);
  toolbar.addEventListener('click', toolbarHandler);
  document.addEventListener('keydown', escapeHandler);
  frame.addEventListener('load', attachFrame);
  attachFrame();

  return {
    open() {
      if (stopped) return;
      collecting = true;
      previousFocus = document.activeElement;
      modal.hidden = false;
      summaryInput.focus();
      updateSelection();
      let available = true;
      try { getFrameContext(); } catch (error) { available = false; setStatus(clean(error.message)); }
      for (const action of ['element', 'region', 'capture']) modal.querySelector(`[data-action=${action}]`).disabled = !available;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      collecting = false;
      endPicker();
      binding?.();
      frame.removeEventListener('load', attachFrame);
      document.removeEventListener('keydown', escapeHandler);
      modal.removeEventListener('click', actionHandler);
      toolbar.removeEventListener('click', toolbarHandler);
      modal.remove();
      toolbar.remove();
      records.length = 0;
      screenshot = null;
    }
  };
}
