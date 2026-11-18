/* ISOLATED-world Pack UI. Only native export controls are activated. */
(() => {
  'use strict';
  if (window !== top || location.origin !== 'https://sellerflex.amazon.com') return;
  const CHANNEL = 'sf-pack-export-v1';
  const onPack = () => location.pathname.replace(/\/$/, '') === '/transshipments/pack';
  const normalize = value => value.replace(/\s+/g, ' ').trim();
  const exportNames = new Set(['Download order list','Download FNSKU labels','Print FNSKU labels','Download','Print']);
  const competingMessage = '检测到其他原生导出。请刷新 Pack 页面，重新打开相同订单列表后继续；已保存文件会保留。';
  const incompleteMessage = '本次原生导出未完成捕获。请刷新 Pack 页面，重新打开相同订单列表后继续；已保存文件会保留。';
  let automaticClick = false;
  let externalExportSeen = false;
  let refreshReason = competingMessage;
  function exportTarget(event) {
    return event.composedPath().find(node => node instanceof Element && node.matches('button,[role="button"],a') && !node.id.startsWith('sf-') && exportNames.has(normalize(node.textContent || '')));
  }
  // Require a fresh document after external exports to avoid mixing order snapshots.
  addEventListener('click', event => { if (onPack() && !automaticClick && exportTarget(event)) externalExportSeen = true; }, true);
  const visible = element => Boolean(element && element.isConnected && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  function button(root, label) {
    const matches = [...root.querySelectorAll('button,[role="button"],a')].filter(node => visible(node) && normalize(node.textContent || '') === label);
    return matches.length === 1 ? matches[0] : null;
  }
  function current() {
    if (!onPack()) return null;
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(dialog => visible(dialog) && (dialog.textContent || '').includes('Order List'));
    if (dialogs.length !== 1) return null;
    const dialog = dialogs[0], candidates = [];
    for (const table of dialog.querySelectorAll('table')) {
      const headers = [...table.querySelectorAll('thead th')].map(node => normalize(node.textContent || '').toLowerCase());
      const names = ['product title','sku','fnsku','transfer id','units'];
      if (!names.every(name => headers.filter(h => h === name).length === 1)) continue;
      const nodes = [...table.querySelectorAll('tbody tr')];
      if (!nodes.length) continue;
      const rows = [];
      for (const node of nodes) {
        const cells = [...node.querySelectorAll(':scope > td')];
        const values = names.map(name => normalize(cells[headers.indexOf(name)]?.textContent || ''));
        if (values.some(value => !value) || !/^\d+$/.test(values[4]) || Number(values[4]) < 1) return null;
        rows.push({ title: values[0], sku: values[1], fnsku: values[2], transferId: values[3], units: Number(values[4]) });
      }
      candidates.push({ dialog, rows, nodes });
    }
    return candidates.length === 1 ? candidates[0] : null;
  }
  function unchanged(original) {
    if (externalExportSeen) throw new Error(refreshReason);
    const now = current();
    if (!now || now.dialog !== original.dialog || JSON.stringify(now.rows) !== JSON.stringify(original.rows)) throw new Error('订单弹窗已变化，请重新打开原订单列表后继续。');
    return now;
  }
  async function send(operation, input) {
    let response;
    try {
      if (typeof globalThis.chrome?.runtime?.sendMessage !== 'function') throw new Error('Runtime unavailable');
      response = await chrome.runtime.sendMessage({ type: 'sf-pack', operation, input });
    } catch { throw new Error('扩展已重新加载或页面连接失效，请刷新 Seller Flex Pack 页面后继续；已保存文件会保留。'); }
    if (!response?.ok) throw new Error('同步未完成。已保存文件会自动重试，请核对 ERP 连接后继续。');
    return response.value;
  }
  function capture(original, nativeButton) {
    return new Promise((resolve, reject) => {
      const nonce = crypto.randomUUID().replaceAll('-', '');
      let clicked = false;
      const clean = (captured = false) => {
        if (clicked && !captured && !externalExportSeen) { externalExportSeen = true; refreshReason = incompleteMessage; }
        clearTimeout(timeout); removeEventListener('message', listener); removeEventListener('click', competing, true);
        window.postMessage({ channel: CHANNEL, type: 'cancel', nonce, dispatched: clicked && !captured }, location.origin);
      };
      const competing = event => {
        if (!automaticClick && exportTarget(event)) { externalExportSeen = true; clean(); reject(new Error(competingMessage)); }
      };
      const listener = event => {
        if (event.source !== window || event.origin !== location.origin || event.data?.channel !== CHANNEL || event.data.nonce !== nonce) return;
        try {
          unchanged(original);
          if (event.data.type === 'error' && event.data.code === 'reload-required') {
            externalExportSeen = true; throw new Error(competingMessage);
          } else if (event.data.type === 'error' && clicked && event.data.code === 'too-large') {
            throw new Error('原生文件超过 12 MB 上限，请减少本次所选订单后重新导出。');
          } else if (event.data.type === 'armed' && !clicked) {
            if (!visible(nativeButton) || nativeButton.disabled || nativeButton.getAttribute('aria-disabled') === 'true') throw new Error('原生导出按钮不可用，请稍后重试。');
            clicked = true;
            automaticClick = true;
            try { nativeButton.click(); } finally { automaticClick = false; }
          } else if (event.data.type === 'file' && clicked && event.data.kind === 'xlsx') {
            if (typeof event.data.base64 !== 'string' || event.data.base64.length > 16000000) throw new Error('原生文件超过 12 MB 上限，请减少本次所选订单后重新导出。');
            clean(true); resolve({ filename: event.data.filename, base64: event.data.base64 });
          }
        } catch (error) { clean(); reject(new Error(clicked ? error.message + ' ' + refreshReason : error.message)); }
      };
      const timeout = setTimeout(() => { console.info('[sf-pack]', 'capture-timeout', JSON.stringify({ kind: 'xlsx', clicked })); clean(); reject(new Error(clicked ? refreshReason : '未连接到原生导出捕获器，请刷新 Pack 页面后重试。')); }, 32000);
      addEventListener('message', listener);
      addEventListener('click', competing, true);
      window.postMessage({ channel: CHANNEL, type: 'arm', nonce, kind: 'xlsx' }, location.origin);
    });
  }
  let busy = false;
  let allOperation = null;
  async function synchronize(control, status, expected = null) {
    if (busy && !expected) return;
    busy = true; control.disabled = true;
    try {
      if (externalExportSeen) throw new Error(refreshReason);
      const original = current();
      if (!original) throw new Error('请打开完整的 Order List 订单弹窗。');
      const verify = () => { expected?.verify(); if (expected && !expected.matches(current()?.rows || [])) throw new Error('Order List 与全部已选订单不一致，未上传，请刷新后重试。'); };
      verify();
      status.textContent = '正在核对已保存订单…';
      let result = await send('resume', { rows: original.rows });
      unchanged(original);
      verify();
      if (!result) {
        const exportButton = button(original.dialog, 'Download order list');
        if (!exportButton) throw new Error('未找到原生订单导出按钮。');
        status.textContent = '正在导出完整订单并保存到 ERP…';
        const file = await capture(original, exportButton);
        unchanged(original);
        verify();
        result = await send('enqueue', { requestId: crypto.randomUUID(), ...file, rows: original.rows });
      }
      unchanged(original);
      if (result.error) throw new Error(result.error);
      if (!result.batch) throw new Error('原始订单已保存在本机，等待 ERP 确认后自动重试。');
      const batch = result.batch;
      if (batch.labelSource !== 'AMAZON_API' || !Array.isArray(batch.labelGroups)) throw new Error('请先升级 ERP：当前接口尚未支持 Amazon API 标签；插件不会下载 Seller Flex 标签。');
      const ready = batch.state === 'READY' && batch.labelGroups.length > 0 && batch.labelGroups.every(group => group.ready === true);
      const labelStatus = batch.state === 'NO_NEW' ? '没有新增订单，无需生成标签。' : ready ? '上欧代、下 SKU 标签及带图备货单已在 ERP 保存，可在订单分拣页下载。' : 'ERP 正在获取主图、生成带图备货单和 API 标签，后台会自动重试，可在 ERP 查看进度。';
      status.textContent = `订单 ${batch.totalRows} 行 · 新增 ${batch.newRows} · 跳过 ${batch.skippedRows} · 待核对 ${batch.conflicts.length}；${labelStatus}${batch.labelError ? ' ' + batch.labelError : ''}${batch.pickingError ? ' ' + batch.pickingError : ''}`;
      if (typeof batch.id === 'string' && /^[\w-]+$/.test(batch.id)) {
        const link = document.createElement('a'); link.href = 'https://htcerp.app/order-sorting?packBatch=' + encodeURIComponent(batch.id); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = ' 查看 ERP 批次'; status.appendChild(link);
      }
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; control.disabled = false; control.textContent = '同步到 ERP 并分拣 / 继续'; }
  }
  async function synchronizeAll(control, status, cancel) {
    if (busy) return;
    busy = true; control.disabled = true;
    const operation = new AbortController(); allOperation = operation;
    cancel.hidden = false; cancel.disabled = false;
    try {
      if (externalExportSeen) throw new Error(refreshReason);
      if (current()) throw new Error('请先关闭 Order List 弹窗，再展开全部订单。');
      const expected = await globalThis.SellerFlexPackAll.loadAndSelect(status, operation.signal);
      expected.verify();
      const native = button(document, 'Download & print all transshipments');
      if (!visible(native) || native.disabled || native.getAttribute('aria-disabled') === 'true') throw new Error('全选后原生导出按钮仍不可用，请重试。');
      status.textContent = '已全选，正在打开完整订单并核对商品明细…'; native.click();
      const until = Date.now() + 30_000;
      while (!current()) {
        expected.verify();
        if (Date.now() > until) throw new Error('打开 Order List 超时，未上传，请关闭弹窗后重试。');
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      expected.verify();
      if (!expected.matches(current().rows)) throw new Error('Order List 与全部已选订单不一致，未上传，请刷新后重试。');
      // After this point a durable upload may be in flight; do not label it cancelled.
      cancel.disabled = true;
      install();
      const sync = current().dialog.querySelector('#sf-pack-sync');
      if (!sync) throw new Error('同步控件尚未就绪，请在 Order List 内点击同步继续。');
      await synchronize(sync, status, expected);
      const dialogStatus = current()?.dialog.querySelector('#sf-pack-status');
      if (dialogStatus) dialogStatus.replaceChildren(...[...status.childNodes].map(node => node.cloneNode(true)));
    } catch (error) { status.textContent = error.message; }
    finally { allOperation = null; busy = false; control.disabled = false; cancel.hidden = true; }
  }
  function install() {
    if (!onPack()) return;
    const now = current();
    if (now && !now.dialog.querySelector('#sf-pack-sync')) {
      const native = button(now.dialog, 'Download order list');
      if (native) {
        const control = document.createElement('button'); control.id = 'sf-pack-sync'; control.type = 'button'; control.textContent = '同步到 ERP 并分拣';
        control.style.cssText = 'margin:8px;padding:8px 14px;background:#087f8c;color:white;border:0;border-radius:6px;cursor:pointer';
        const status = document.createElement('div'); status.id = 'sf-pack-status'; status.setAttribute('role', 'status'); status.style.cssText = 'padding:8px;font-size:13px';
        control.addEventListener('click', () => { void synchronize(control, status); });
        native.parentNode.insertBefore(control, native.nextSibling); control.after(status);
      }
    }
    const native = button(document, 'Download & print all transshipments');
    if (native && !document.querySelector('#sf-pack-open')) {
      const open = document.createElement('button'); open.id = 'sf-pack-open'; open.type = 'button'; open.textContent = '导出当前所选订单到 ERP'; open.style.cssText = 'margin:8px;padding:6px 10px';
      open.addEventListener('click', () => { if (!busy && onPack() && visible(native) && !native.disabled && native.getAttribute('aria-disabled') !== 'true') native.click(); });
      native.after(open);
    }
    if (native && globalThis.SellerFlexPackAll && !document.querySelector('#sf-pack-all')) {
      const all = document.createElement('button'); all.id = 'sf-pack-all'; all.type = 'button'; all.textContent = '展开全部并导出到 ERP'; all.style.cssText = 'margin:8px;padding:8px 12px;background:#087f8c;color:white;border:0;border-radius:6px;cursor:pointer';
      const cancel = document.createElement('button'); cancel.id = 'sf-pack-all-cancel'; cancel.type = 'button'; cancel.textContent = '取消展开'; cancel.hidden = true;
      const status = document.createElement('div'); status.id = 'sf-pack-all-status'; status.setAttribute('role','status'); status.style.cssText = 'padding:8px;font-size:13px';
      cancel.addEventListener('click', () => allOperation?.abort());
      all.addEventListener('click', () => { void synchronizeAll(all, status, cancel); });
      native.after(all); all.after(cancel); native.parentElement.after(status);
    }
  }
  new MutationObserver(install).observe(document.documentElement, { subtree: true, childList: true });
  install();
})();
