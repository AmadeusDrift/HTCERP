/* ISOLATED-world, DOM-only pagination and selection. Never invokes Pack or Ship. */
(() => {
  'use strict';
  const text = node => (node?.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
  const enabled = node => node && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
  const checked = node => node.checked === true || node.getAttribute('aria-checked') === 'true';
  const key = row => JSON.stringify([row.transferId, row.sku, row.fnsku]);
  const signature = rows => JSON.stringify(rows.map(row => [key(row), row.units]).sort((a,b) => a[0].localeCompare(b[0])));
  const pause = () => new Promise(resolve => setTimeout(resolve, 150));
  function context() {
    if (location.pathname.replace(/\/$/, '') !== '/transshipments/pack') throw new Error('页面已变化，请回到 Pack 后重试。');
    const root = document.getElementById('awui-transshipment-pack-page');
    if (!root) throw new Error('未识别 Pack 订单区域，请刷新页面。');
    const tabs = [...root.querySelectorAll('[role="tab"]')].filter(node => visible(node.parentElement) && (node.checked || node.getAttribute('aria-selected') === 'true'));
    if (tabs.length !== 1) throw new Error('无法确认当前订单页签，请重新选择 Ready to pack 或 Packed。');
    const label = text(tabs[0].parentElement), match = /^(Ready to pack|Packed)\s*\(([\d,]+)\)$/i.exec(label);
    if (!match) throw new Error('无法确认当前页签订单总数，请刷新页面。');
    const fields = [...root.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]),select,[role="combobox"]')].filter(node => visible(node) && !node.closest('[role="dialog"]'));
    const search = fields.find(node => /search by transshipment/i.test(node.getAttribute('placeholder') || ''));
    if (search?.value?.trim()) throw new Error('请先清空订单搜索，再导出当前日期和时段的全部订单；指定订单可使用“导出当前所选”。');
    const fingerprint = JSON.stringify([location.pathname, label, text(document.getElementById('awui-masthead-warehouse-dropdown-value')), fields.map(node => node.matches('input,select') ? node.value : text(node))]);
    return { root, total: Number(match[2].replaceAll(',', '')), fingerprint };
  }
  function snapshot(root) {
    const tables = [...root.querySelectorAll('table')].filter(table => visible(table) && !table.closest('[role="dialog"]') && ['transshipment id','sku details','msku','content','units'].every(name => [...table.querySelectorAll('thead th')].filter(h => text(h).toLowerCase() === name).length === 1));
    if (tables.length !== 1) throw new Error('订单表格尚未完整显示，请稍后重试。');
    const table = tables[0], headers = [...table.querySelectorAll('thead th')].map(h => text(h).toLowerCase()), rows = [], carry = [];
    // Native multi-SKU transshipments can share a row-spanned ID/checkbox.
    for (const tr of table.querySelectorAll('tbody > tr')) {
      const grid = [], cells = [...tr.querySelectorAll(':scope > td')]; let column = 0;
      for (let i = 0; i < headers.length; i++) if (carry[i]?.left) { grid[i] = carry[i].cell; carry[i].left--; }
      for (const cell of cells) {
        while (grid[column]) column++;
        for (let n = 0; n < (cell.colSpan || 1); n++) { grid[column] = cell; if (cell.rowSpan > 1) carry[column] = { cell, left: cell.rowSpan - 1 }; column++; }
      }
      const value = name => text(grid[headers.indexOf(name)]);
      const units = value('units').replaceAll(',', '');
      const row = { transferId: value('transshipment id'), fnsku: value('sku details'), sku: value('msku'), title: value('content'), units: Number(units) };
      if (!row.transferId || !row.sku || !row.fnsku || !/^\d+$/.test(units) || !Number.isSafeInteger(row.units) || row.units < 1) throw new Error('订单行尚未完整或结构变化，未导出。');
      rows.push(row);
    }
    if (new Set(rows.map(key)).size !== rows.length) throw new Error('页面存在重复订单行，请刷新后重试，未导出。');
    const boxes = [...table.querySelectorAll('tbody input[type="checkbox"],tbody [role="checkbox"]')].filter((node,i,all) => !all.some((other,j) => j !== i && node.contains(other)));
    return { table, rows, boxes, count: new Set(rows.map(row => row.transferId)).size };
  }
  const moreButton = root => {
    const matches = [...root.querySelectorAll('button,[role="button"]')].filter(node => visible(node) && /^load more$/i.test(text(node)));
    if (matches.length > 1) throw new Error('发现多个 Load More，无法确认加载范围。');
    return matches[0];
  };
  async function loadAndSelect(status, signal) {
    const initial = context(), deadline = Date.now() + 10 * 60_000;
    if (!initial.total) throw new Error('当前页签没有订单可导出。');
    const guard = () => {
      if (signal.aborted) throw new Error('已取消，尚未导出订单。');
      if (Date.now() > deadline) throw new Error('加载全部订单超时，未导出不完整列表，请重试。');
      const now = context();
      if (now.fingerprint !== initial.fingerprint) throw new Error('日期、时段、店铺或订单页签/总数已变化，已停止导出，请重试。');
      return now;
    };
    let previous = new Map(), lastClick = 0, stableAt = Date.now(), lastSignature = '';
    for (;;) {
      const now = guard(), page = snapshot(now.root), sig = signature(page.rows), current = new Map(page.rows.map(row => [key(row), row.units]));
      for (const [id, units] of previous) if (current.get(id) !== units) throw new Error('加载期间订单内容或数量变化，已停止导出。');
      previous = current;
      if (page.rows.length > 10000) throw new Error('本次超过 10,000 条明细，请按时段分批导出。');
      if (page.count > initial.total) throw new Error('已加载订单数与页签总数不一致，未导出。');
      status.textContent = `正在展开订单：${page.count} / ${initial.total} 个订单，${page.rows.length} 条商品明细…`;
      if (sig !== lastSignature) { stableAt = Date.now(); lastSignature = sig; }
      const more = moreButton(now.root);
      // Reaching the tab count is not sufficient: keep loading until Load More disappears.
      if (!more && Date.now() - stableAt >= 1200) {
        if (page.count !== initial.total) throw new Error(`订单未展开完整：已加载 ${page.count} / ${initial.total}，数量不足，未导出。`);
        break;
      }
      if (Date.now() - stableAt > 120_000) throw new Error('Load More 长时间未完成或没有新增订单，未导出，请重试。');
      // Native loading disables this button. Once enabled again, another empty page
      // can still need a click; do not require a changed row signature to advance.
      if (more && enabled(more) && Date.now() - lastClick >= 1000 && Date.now() - stableAt >= 250) {
        lastClick = Date.now(); more.click();
      }
      await pause();
    }
    const all = snapshot(guard().root), frozen = signature(all.rows);
    if (!all.boxes.length) throw new Error('未找到订单选择框，未导出。');
    status.textContent = `已展开全部 ${all.count} 个订单，正在全选并核对…`;
    // Only click unchecked native controls. A partly-selected header must never toggle rows off.
    const header = all.table.querySelector('thead input[type="checkbox"],thead [role="checkbox"]');
    if (header && enabled(header) && !checked(header)) { header.click(); await pause(); }
    for (let i = 0; i < all.boxes.length; i++) {
      const page = snapshot(guard().root);
      if (signature(page.rows) !== frozen || page.boxes.length !== all.boxes.length) throw new Error('全选期间订单列表变化，未导出。');
      const box = page.boxes[i];
      if (!checked(box)) { if (!enabled(box)) throw new Error('部分订单不可选择，未导出。'); box.click(); await pause(); }
    }
    const verify = () => {
      const now = guard(), page = snapshot(now.root);
      if (moreButton(now.root)) throw new Error('Load More 重新出现，订单尚未加载完整，已停止导出。');
      if (signature(page.rows) !== frozen || page.boxes.length !== all.boxes.length || page.boxes.some(box => !checked(box))) throw new Error('订单内容或全选状态变化，已停止导出。');
    };
    verify();
    return { rows: all.rows, verify, matches: rows => signature(rows) === frozen };
  }
  globalThis.SellerFlexPackAll = Object.freeze({ loadAndSelect });
})();
