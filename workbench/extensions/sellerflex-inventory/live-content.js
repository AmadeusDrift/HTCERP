/* Isolated content world. Receives one-use CSV permits, never bearer credentials. */
(() => {
  'use strict';
  const label = node => (node?.getAttribute('aria-label') || node?.textContent || '').trim().replace(/\s+/g, ' ');
  const visible = node => node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const enabled = node => node && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const route = () => location.origin === 'https://sellerflex.amazon.com' && location.pathname.replace(/\/$/, '') === '/receive';
  const warehouse = () => label([...document.querySelectorAll('nav [role="combobox"]')].map(node => node.closest('button') || node).find(node => visible(node) && label(node) && !/^Lang\s*:/i.test(label(node))));
  const dialog = () => [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]')].some(visible);
  const guard = () => {
    if (!route() || warehouse() !== 'A1C5' || dialog()) throw new Error('页面、仓库或弹窗状态已变化');
  };
  const send = async (operation, input = {}) => {
    const reply = await chrome.runtime.sendMessage({ type: 'sf-live', operation, input });
    if (!reply?.ok) throw new Error('ERP 未确认本次操作');
    return reply.value;
  };
  function tables() {
    return [...document.querySelectorAll('main table')].filter(table => {
      const headings = [...table.querySelectorAll('th')].map(label);
      return visible(table) && headings.includes('Uploaded file') && headings.includes('Status') && headings.some(value => value.startsWith('Errors'));
    });
  }
  function resultFor(filename) {
    const matches = [];
    for (const table of tables()) {
      const headings = [...table.querySelectorAll('th')].map(label);
      const fileIndex = headings.indexOf('Uploaded file');
      const statusIndex = headings.indexOf('Status');
      const errorsIndex = headings.findIndex(value => value.startsWith('Errors'));
      for (const body of table.tBodies) for (const row of body.rows) {
        const file = row.cells[fileIndex];
        if (visible(row) && (label(file) === filename || file?.title === filename || file?.querySelector('[title]')?.title === filename)) matches.push({ row, statusIndex, errorsIndex });
      }
    }
    if (!matches.length) return;
    const evidence = { rowText: matches.map(({ row }) => label(row)).join('\n').slice(0, 16000), observedAt: Date.now() };
    if (matches.length !== 1) return { status: 'UNKNOWN', errorCount: null, evidence };
    const { row, statusIndex, errorsIndex } = matches[0];
    const status = label(row.cells[statusIndex]);
    const errorCell = row.cells[errorsIndex]?.cloneNode(true);
    errorCell?.querySelectorAll('button,a,svg').forEach(node => node.remove());
    const countText = label(errorCell);
    const digits = countText.match(/^(\d[\d,]*)(?:\s|$)/)?.[1];
    const errorCount = /^(none|0)$/i.test(countText) ? 0 : digits ? Number(digits.replaceAll(',', '')) : null;
    if (/^failed$/i.test(status)) return { status: 'FAILED', errorCount, evidence };
    if (!/^completed$/i.test(status)) return;
    // Error download buttons have no verified export contract; do not infer failed SKUs.
    return { status: errorCount === 0 ? 'COMPLETED' : 'UNKNOWN', errorCount, evidence };
  }
  function controls() {
    const buttons = [...document.querySelectorAll('main button')].filter(node => visible(node) && label(node) === 'Upload inventory file');
    if (buttons.length !== 1) return {};
    const button = buttons[0];
    const inputs = [...button.parentElement.querySelectorAll('input[type="file"]')];
    return { button, input: inputs.length === 1 ? inputs[0] : null };
  }
  function readyInput() {
    guard();
    if (globalThis.SellerFlexManualGuard?.isBusy()) throw new Error('手动队列尚未处理完毕');
    const { button, input } = controls();
    if (!enabled(button) || !input?.isConnected || input.disabled || input.files.length || !tables().length) throw new Error('上传控件未就绪');
    return input;
  }
  async function openBulk() {
    guard();
    if (!controls().input) {
      const tabs = [...document.querySelectorAll('main [role="tab"],main label')].filter(node => visible(node) && label(node) === 'Bulk Upload');
      if (tabs.length !== 1) throw new Error('未找到唯一批量上传标签');
      tabs[0].click();
      for (let attempt = 0; attempt < 20 && !controls().input; attempt++) { await sleep(250); guard(); }
    }
  }
  const identity = job => ({ jobId: job.id, leaseId: job.leaseId });
  async function observe(job) {
    const deadline = Date.now() + (job.bulk ? 15 * 60 * 1000 : 240000);
    let lastHeartbeat = 0;
    while (Date.now() < deadline) {
      guard();
      const result = resultFor(job.filename);
      if (result) return result;
      if (Date.now() - lastHeartbeat >= 60000) {
        await send('heartbeat', identity(job));
        lastHeartbeat = Date.now();
      }
      const refresh = [...document.querySelectorAll('main table button')].find(node => visible(node) && enabled(node) && label(node) === 'Refresh');
      refresh?.click();
      await sleep(3500);
    }
    return { status: 'UNKNOWN', errorCount: null, evidence: { rowText: (job.bulk ? '15' : '4') + ' 分钟内未取得唯一文件的最终结果；禁止重新上传。', observedAt: Date.now() } };
  }
  // The worker returns this proof only to the tab that owned the issued permit.
  // Filename alone is never evidence: a user may have selected a different file.
  async function clearRecordedFile(proof) {
    if (proof?.receipt?.state !== 'RECORDED' || proof.receipt.submitted !== true || !proof.receipt.eventId) return;
    const owned = proof.ownedFile;
    if (!owned || !/^[a-f0-9]{64}$/.test(owned.sha256)) return;
    const { input } = controls();
    if (input?.files.length === 0) { await send('cleared', proof.receipt); return; }
    const file = input?.files.length === 1 ? input.files[0] : null;
    if (!file || file.name !== owned.filename || file.size !== owned.size || file.lastModified !== owned.lastModified) return;
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    guard();
    if (hash === owned.sha256 && input.isConnected && input.files.length === 1 && input.files[0] === file
        && !globalThis.SellerFlexManualGuard?.isBusy()) {
      input.value = '';
      await send('cleared', proof.receipt);
    }
  }
  let running = false;
  async function tick() {
    if (running || !route() || warehouse() !== 'A1C5' || dialog() || globalThis.SellerFlexManualGuard?.isBusy() || !navigator.locks) return false;
    running = true;
    let progressed = false;
    try {
      await navigator.locks.request('seller-flex-inventory-batch', { ifAvailable: true }, async lock => {
        if (!lock) return;
        guard();
        const work = await send('poll');
        await clearRecordedFile(work.cleanupProof);
        if (!work.job) return;
        let job = work.job;
        let ownedUpload;
        if (!['REAL_TRIAL', 'AUTO_REPLENISH'].includes(job.mode) || job.warehouseCode !== 'A1C5') return;
        globalThis.SellerFlexManualGuard?.setLiveBusy(true);
        try {
          await openBulk();
          if (!work.needsReconciliation) {
            let permit;
            do {
              readyInput();
              permit = await send('prepare', identity(job));
            } while (permit.pending === true);
            job = permit.job;
            if (job.csv && !permit.needsReconciliation) {
              // Recheck every guard after the network round trip, then consume once.
              const input = readyInput();
              const dispatch = new DataTransfer();
              const file = new File([job.csv], job.filename, { type: 'text/csv;charset=utf-8',
                ...(permit.ownedFile ? { lastModified: permit.ownedFile.lastModified } : {}) });
              dispatch.items.add(file);
              input.files = dispatch.files;
              ownedUpload = { input, file: input.files[0] };
              input.dispatchEvent(new Event('change', { bubbles: true }));
              // A lost dispatch acknowledgement must not prevent read-only reconciliation.
              await send('dispatched', identity(job)).catch(() => {});
            }
          }
          if (!job.filename || !job.sha256) { progressed = job.state === 'SKIPPED'; return; }
          let result;
          try { result = await observe(job); }
          catch (error) { result = { status: 'UNKNOWN', errorCount: null, evidence: { rowText: String(error.message).slice(0, 1000), observedAt: Date.now() } }; }
          const ack = await send('results', { ...identity(job), filename: job.filename, sha256: job.sha256, warehouseCode: job.warehouseCode, ...result });
          if (job.mode === 'AUTO_REPLENISH') {
            await clearRecordedFile(ack.cleanupProof);
            progressed = ack.accepted === true && ack.cleanupProof?.receipt?.state === 'RECORDED';
          } else if (result.status !== 'UNKNOWN' && ownedUpload?.input.files.length === 1 && ownedUpload.input.files[0] === ownedUpload.file) {
            // Older trial responses have no durable automatic proof; only clear this exact in-memory File.
            ownedUpload.input.value = '';
            progressed = true;
          }
        } finally { globalThis.SellerFlexManualGuard?.setLiveBusy(false); }
      });
    } catch { /* The durable worker latch remains authoritative; the next tick only reconciles. */ }
    finally { running = false; }
    return progressed;
  }
  globalThis.SellerFlexLiveDOM = Object.freeze({ resultFor });
  async function schedule() {
    const progressed = await tick();
    setTimeout(() => { void schedule(); }, progressed ? 5000 : 60000);
  }
  void schedule();
})();
