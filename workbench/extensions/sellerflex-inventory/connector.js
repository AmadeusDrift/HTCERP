/* ERP connector: no Seller Flex DOM, upload, scripting, tab, or download capability. */
(() => {
  'use strict';
  const KEY = 'sf-erp-v2';
  const ALARM = 'sf-erp-poll-v2';
  const HEADER = 'BIN,Merchant SKU,Quantity,Disposition (GOOD/BAD),Expiration Date (DD/MM/YYYY),Manufacturing Date (DD/MM/YYYY)';
  const errors = {
    endpoint: '仅允许 https://htcerp.app；本地地址只用于独立测试版本。',
    input: '配对码或设备名称无效。',
    protocol: 'ERP 返回的数据格式或模式不受支持，已停止本轮处理。',
    offline: '无法连接 ERP，未确认回执已保留，将自动重试。',
    auth: '设备凭据已失效，请在 ERP 核对设备状态。',
    pending: '仍有未确认回执或未完成库存任务，请先恢复连接并核对后再更换配对或断开。',
    recovery: '只有凭据已被 ERP 拒绝且仍有未确认回执时，才能归档并解除配对。',
    archiveFull: '本机已保留 10 份异常回执，请联系管理员备份核对；现有回执不会覆盖或丢弃。',
  };
  const fail = code => { const error = new Error(errors[code]); error.safeCode = code; throw error; };
  const cleanText = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !Array.from(value).some(c => c.charCodeAt(0) < 32);
  const date = value => {
    if (value == null) return '';
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('protocol');
    return value.split('-').reverse().join('/');
  };
  const cell = value => /[",]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
  async function manifest(job, crypto) {
    if (!job || job.mode !== 'SIMULATION' || !cleanText(job.id) || !cleanText(job.nonce) || !Array.isArray(job.rows) || !job.rows.length || job.rows.length > 3000) fail('protocol');
    const ids = new Set();
    const lines = job.rows.map(row => {
      if (!row || Object.keys(row).some(key => !['rowId','sku','binCode','quantity','disposition','expiryDate','manufacturingDate'].includes(key)) || !cleanText(row.rowId) || ids.has(row.rowId) || !cleanText(row.sku) || !cleanText(row.binCode) || !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 5 || row.disposition !== 'GOOD') fail('protocol');
      ids.add(row.rowId);
      return [row.binCode, row.sku, String(row.quantity), row.disposition, date(row.expiryDate), date(row.manufacturingDate)].map(cell).join(',');
    });
    const bytes = new TextEncoder().encode([HEADER, ...lines, ''].join('\r\n'));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return { jobId: job.id, nonce: job.nonce, sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''), rowCount: job.rows.length, mode: 'SIMULATION' };
  }
  function create({ chrome, fetch, crypto, allowLocalTest = false, liveFactory, erpFactory, packFactory }) {
    let tail = Promise.resolve();
    let polling;
    const initialized = (async () => {
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
    })();
    const serial = task => { const result = tail.then(() => initialized).then(task); tail = result.catch(() => {}); return result; };
    const read = async () => (await chrome.storage.local.get(KEY))[KEY] || {};
    const save = value => chrome.storage.local.set({ [KEY]: value });
    function endpoint(value) {
      let url;
      try { url = new URL(value); } catch { fail('endpoint'); }
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('endpoint');
      if (url.origin !== 'https://htcerp.app' && !(allowLocalTest && url.protocol === 'http:' && url.hostname === '127.0.0.1')) fail('endpoint');
      return url.origin;
    }
    async function request(state, path, body) {
      const base = endpoint(state.baseUrl);
      let response;
      try {
        response = await fetch(base + '/api/inventory-device/' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(/^pack-orders\/(?:import|[\w-]+)$/.test(path) ? 180000 : path === 'automatic/prepare' ? 60000 : 12000), credentials: 'omit', redirect: 'error', cache: 'no-store',
        });
      } catch { fail('offline'); }
      if (response.status === 401 || response.status === 403) fail('auth');
      if (!response.ok) { const error = new Error(errors.offline); error.safeCode = 'offline'; error.status = response.status; throw error; }
      try { return await response.json(); } catch { fail('protocol'); }
    }
    const live = liveFactory?.({ serial, read, save, request, crypto, manifest: job => manifest(job, crypto) });
    const erp = erpFactory?.({ chrome, crypto, read, save, request });
    const pack = packFactory?.({ serial, read, request, crypto });
    function publicStatus(state) {
      return {
        connected: Boolean(state.token), baseUrl: state.baseUrl || 'https://htcerp.app',
        name: state.name || '', deviceId: state.deviceId || '', scope: state.scope || null,
        mode: state.live?.job.mode || 'SIMULATION', pending: Boolean(state.pending), lastContact: state.lastContact || null,
        lastResult: state.lastResult || null, error: errors[state.errorCode] || '',
        recoveryAvailable: Boolean((state.pending || state.live) && state.token && state.errorCode === 'auth'),
        archivedReceiptCount: (state.archivedReceipts || []).length,
        archivedLiveCount: (state.archivedLive || []).length,
        liveTrial: state.live ? { mode: state.live.job.mode, jobId: state.live.job.id, stage: state.live.stage, filename: state.live.job.filename, pending: Boolean(state.live.pending) } : null,
      };
    }
    const status = async () => { await initialized; return publicStatus(await read()); };
    async function sendPending(state) {
      if (!state.pending) return;
      // Persisted envelope is replayed verbatim. Only an acknowledged HTTP success clears it.
      if (state.pending.mode !== 'SIMULATION') fail('protocol');
      const acknowledgement = await request(state, 'results', state.pending);
      if (acknowledgement?.state !== 'PASSED' || acknowledgement?.mode !== 'SIMULATION') fail('protocol');
      state.lastResult = { jobId: state.pending.jobId, sha256: state.pending.sha256, rowCount: state.pending.rowCount, at: new Date().toISOString() };
      state.pending = null;
      await save(state);
    }
    function poll() {
      if (polling) return polling;
      polling = serial(async () => {
        const state = await read();
        // Pack outbox is independent of inventory mode and never changes inventory work.
        // Purge obsolete PDFs even while disconnected; uploads require the original identity.
        try { await pack?.synchronize(); } catch { /* Durable outbox will retry next alarm. */ }
        if (!state.token) return publicStatus(state);
        try {
          if (state.live) await live?.synchronize(state);
          const heartbeat = await request(state, 'heartbeat', {});
          if (heartbeat.mode !== 'SIMULATION' || heartbeat.status !== 'ACTIVE') fail('protocol');
          state.lastContact = new Date().toISOString();
          state.errorCode = null;
          await save(state);
          await sendPending(state);
          const work = await request(state, 'work');
          if (!work || !Object.hasOwn(work, 'job')) fail('protocol');
          if (work.job !== null) {
            state.pending = await manifest(work.job, crypto);
            await save(state);
            await sendPending(state);
          }
        } catch (error) {
          state.errorCode = Object.hasOwn(errors, error.safeCode) ? error.safeCode : 'protocol';
          await save(state);
        }
        return publicStatus(state);
      }).finally(() => { polling = null; });
      return polling;
    }
    return {
      ready: () => initialized, status, poll, live, pack,
      detectErp: () => serial(() => erp.detect()),
      connectErp: input => serial(async () => { await erp.connect(input); return publicStatus(await read()); }),
      pair: input => serial(async () => {
        const baseUrl = endpoint(input.baseUrl || 'https://htcerp.app');
        if (!cleanText(input.code, 128) || !cleanText(input.name, 80)) fail('input');
        const previous = await read();
        if (previous.pending || previous.live && previous.live.stage !== 'ACKNOWLEDGED') fail('pending');
        if (previous.live && (previous.archivedLive || []).length >= 10) fail('archiveFull');
        const paired = await request({ baseUrl }, 'pair', { code: input.code, name: input.name });
        if (paired.mode !== 'SIMULATION' || !cleanText(paired.deviceId) || !cleanText(paired.token, 4096) || !paired.scope || !['sellerAccountId','marketplaceId','warehouseCode'].every(key => cleanText(paired.scope[key]))) fail('protocol');
        const state = { baseUrl, name: input.name, deviceId: paired.deviceId, token: paired.token, scope: { sellerAccountId: paired.scope.sellerAccountId, marketplaceId: paired.scope.marketplaceId, warehouseCode: paired.scope.warehouseCode }, pending: null, errorCode: null };
        state.archivedReceipts = previous.archivedReceipts || [];
        state.archivedLive = previous.archivedLive || [];
        if (previous.live) {
          state.archivedLive = [...state.archivedLive, { live: previous.live, deviceId: previous.deviceId, baseUrl: previous.baseUrl, scope: previous.scope, archivedAt: new Date().toISOString(), reason: 'REPAIRED' }];
        }
        await save(state);
        return publicStatus(state);
      }),
      disconnect: () => serial(async () => {
        const state = await read();
        if (state.pending || state.live && state.live.stage !== 'ACKNOWLEDGED') fail('pending');
        const archivedLive = state.archivedLive || [];
        if (state.live && archivedLive.length >= 10) fail('archiveFull');
        const disconnected = { archivedReceipts: state.archivedReceipts || [], archivedLive: state.live ? [...archivedLive, { live: state.live, deviceId: state.deviceId, baseUrl: state.baseUrl, scope: state.scope, archivedAt: new Date().toISOString(), reason: 'DISCONNECTED' }] : archivedLive };
        await save(disconnected);
        return publicStatus(disconnected);
      }),
      archivePending: () => serial(async () => {
        const state = await read();
        if (!(state.pending || state.live) || !state.token || state.errorCode !== 'auth') fail('recovery');
        const archivedReceipts = state.archivedReceipts || [];
        if (archivedReceipts.length >= 10) fail('archiveFull');
        // One atomic storage write preserves the envelope and its original identity,
        // while deleting that identity's credential. Archives are never replayed.
        const recovered = { archivedLive: state.archivedLive || [], archivedReceipts: [...archivedReceipts, {
          receipt: state.pending, live: state.live || null, deviceId: state.deviceId, baseUrl: state.baseUrl,
          scope: state.scope, archivedAt: new Date().toISOString(), reason: 'AUTH_REVOKED',
        }] };
        await save(recovered);
        return publicStatus(recovered);
      }),
    };
  }
  globalThis.SellerFlexConnector = Object.freeze({ create });
})();
