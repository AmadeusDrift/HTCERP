/* Pack XLSX broker: credentials stay in connector.js; labels exist only in ERP. */
(() => {
  'use strict';
  const MAX = 12000000;
  const fail = () => { throw new Error('Pack export does not match the current order list'); };
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
  function snapshot(rows) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 10000) fail();
    return rows.map(row => {
      if (!row || !['title','sku','fnsku','transferId'].every(key => text(row[key])) || !Number.isSafeInteger(row.units) || row.units < 1) fail();
      return { title: row.title, sku: row.sku, fnsku: row.fnsku, transferId: row.transferId, units: row.units };
    });
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function file(input) {
    const pattern = /^transshipment-order-list-\d{4}-\d{2}-\d{2}\.xlsx$/;
    if (!pattern.test(input.filename) || typeof input.base64 !== 'string' || !input.base64.length || input.base64.length > Math.ceil(MAX / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)) fail();
    let binary;
    try { binary = atob(input.base64); } catch { fail(); }
    if (binary.length > MAX || !binary.startsWith('PK\x03\x04')) fail();
  }
  function identity(state) {
    return { baseUrl: state.baseUrl, deviceId: state.deviceId, sellerAccountId: state.scope?.sellerAccountId, marketplaceId: state.scope?.marketplaceId, warehouseCode: state.scope?.warehouseCode };
  }
  const active = (state, record) => Boolean(state.token && state.scope?.warehouseCode === 'A1C5' && same(identity(state), record.identity));
  function validateBatch(batch, record) {
    if (batch?.labelSource !== 'AMAZON_API') throw new Error('ERP_UPGRADE_REQUIRED');
    if (!batch || !text(batch.id) || !/^[\w-]+$/.test(batch.id) || !['LABELS_PENDING','READY','NO_NEW'].includes(batch.state) || batch.totalRows !== record.rows.length || !Array.isArray(batch.labels) || !Number.isInteger(batch.newRows) || batch.labels.length !== batch.newRows) fail();
    if (record.batch && record.batch.id !== batch.id) fail();
    const seen = new Set();
    for (const slot of batch.labels) {
      const row = record.rows[slot.rowIndex];
      if (!Number.isInteger(slot.rowIndex) || seen.has(slot.rowIndex) || !row || !['sku','fnsku','transferId','units'].every(key => row[key] === slot[key]) || typeof slot.received !== 'boolean') fail();
      seen.add(slot.rowIndex);
    }
    if (!Array.isArray(batch.labelGroups)) fail();
    const groups = new Set(batch.labels.map(slot => slot.group));
    const reported = new Set();
    for (const group of batch.labelGroups) {
      if (!text(group.group) || !groups.has(group.group) || reported.has(group.group) || typeof group.ready !== 'boolean') fail();
      reported.add(group.group);
    }
    if (reported.size !== groups.size || (batch.state === 'READY' && (!batch.newRows || batch.labelGroups.some(group => !group.ready))) || (batch.state === 'NO_NEW' && batch.newRows !== 0)) fail();
    return batch;
  }
  function create({ serial, read, request, store = globalThis.SellerFlexPackOutbox.create() }) {
    const publicRecord = record => ({ requestId: record.requestId, pending: Boolean(record.error) || !record.batch || record.batch.labelSource !== 'AMAZON_API' || record.batch.state === 'LABELS_PENDING', batch: record.batch?.labelSource === 'AMAZON_API' ? record.batch : null, error: record.error || '' });
    async function purgeLegacyPdfs(record) {
      if (Object.hasOwn(record, 'pdfs')) { delete record.pdfs; await store.put(record); }
    }
    async function flush(record, state) {
      await purgeLegacyPdfs(record);
      if (!active(state, record)) return;
      try {
        const result = record.batch
          ? await request(state, 'pack-orders/' + record.batch.id)
          : await request(state, 'pack-orders/import', { requestId: record.requestId, filename: record.filename, base64: record.base64, warehouse: 'A1C5' });
        record.batch = validateBatch(result, record);
        record.error = '';
        await store.put(record);
      } catch (error) {
        record.error = error.message === 'ERP_UPGRADE_REQUIRED' ? '请先升级 ERP：当前接口尚未支持 Amazon API 标签；插件不会下载 Seller Flex 标签。' : '原始订单已保存在本机；ERP 回复尚未确认，标签处理可能仍在进行。请保持原店铺连接，后台会自动重试；可在 ERP 查看实际进度。';
        await store.put(record);
      }
    }
    return {
      // Called inside the parent connector's serial poll. Never acquire the serial lock twice.
      synchronize: async () => {
        const state = await read();
        for (const record of await store.all()) {
          await purgeLegacyPdfs(record);
          if (!record.batch || record.batch.labelSource !== 'AMAZON_API' || record.batch.state === 'LABELS_PENDING' || record.error) await flush(record, state);
        }
      },
      enqueue: (input, owner) => serial(async () => {
        file(input);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) fail();
        const rows = snapshot(input.rows), state = await read();
        if (!state.token || !state.deviceId || state.scope?.warehouseCode !== 'A1C5') fail();
        let record = await store.get(input.requestId);
        if (record) {
          if (!active(state, record) || record.base64 !== input.base64 || record.filename !== input.filename || !same(record.rows, rows)) fail();
        } else {
          record = { requestId: input.requestId, filename: input.filename, base64: input.base64, rows, owner, identity: identity(state), createdAt: new Date().toISOString(), batch: null };
          await store.put(record);
        }
        await flush(record, state);
        return publicRecord(record);
      }),
      resume: (input, owner) => serial(async () => {
        const rows = snapshot(input.rows), state = await read();
        const matches = (await store.all()).filter(record => active(state, record) && same(record.rows, rows)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const record = matches[0];
        if (!record) return null;
        record.owner = owner;
        await store.put(record);
        await flush(record, state);
        return publicRecord(record);
      }),
    };
  }
  globalThis.SellerFlexPackConnector = Object.freeze({ create });
})();
