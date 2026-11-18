importScripts('connector.js');
importScripts('live-connector.js');
importScripts('erp-connection.js');
importScripts('pack-outbox.js');
importScripts('pack-connector.js');
// Test packaging changes this literal only in a separate local copy.
const LOCAL_TEST = false;
const connector = SellerFlexConnector.create({ chrome, fetch: fetch.bind(globalThis), crypto, allowLocalTest: LOCAL_TEST, liveFactory: SellerFlexLiveConnector.create, erpFactory: SellerFlexErpConnection.create, packFactory: SellerFlexPackConnector.create });
const ALARM = 'sf-erp-poll-v2';
const safeError = () => ({ ok: false, error: '操作未完成，请查看连接状态并重试。' });
function isOptions(sender) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('connection.html');
}
function isSellerFlex(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || typeof sender.url !== 'string') return false;
  try { return new URL(sender.url).origin === 'https://sellerflex.amazon.com'; } catch { return false; }
}
async function manualStorage(message) {
  // This broker cannot read/write the ERP key, and never returns a full storage dump.
  await connector.ready();
  if (typeof message.key !== 'string' || !message.key.startsWith('sf-inventory-v1:') || message.key.length > 4096) throw new Error('Invalid key');
  if (message.operation === 'get') return chrome.storage.local.get(message.key);
  if (message.operation === 'remove') { await chrome.storage.local.remove(message.key); return null; }
  if (message.operation === 'set') {
    if (!message.value || typeof message.value !== 'object' || JSON.stringify(message.value).length > 32768) throw new Error('Invalid record');
    await chrome.storage.local.set({ [message.key]: message.value });
    return null;
  }
  throw new Error('Invalid operation');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'sf-pack') {
    if (LOCAL_TEST || !isSellerFlex(sender) || new URL(sender.url).pathname.replace(/\/$/, '') !== '/transshipments/pack' || sender.frameId !== 0 || !sender.documentId) return false;
    const handlers = { enqueue: connector.pack.enqueue, resume: connector.pack.resume };
    if (!Object.hasOwn(handlers, message.operation)) return false;
    const owner = 'tab:' + sender.tab.id + ':document:' + sender.documentId;
    Promise.resolve().then(() => handlers[message.operation](message.input || {}, owner)).then(value => respond({ ok: true, value }), () => respond(safeError()));
    return true;
  }
  if (message?.type === 'sf-live') {
    if (LOCAL_TEST || !isSellerFlex(sender) || new URL(sender.url).pathname.replace(/\/$/, '') !== '/receive' || sender.frameId !== 0 || !sender.documentId) return false;
    const handlers = { poll: connector.live.poll, prepare: connector.live.prepare, heartbeat: connector.live.heartbeat, dispatched: connector.live.dispatched, results: connector.live.results, cleared: connector.live.cleared };
    if (!Object.hasOwn(handlers, message.operation)) return false;
    const owner = 'tab:' + sender.tab.id + ':document:' + sender.documentId;
    Promise.resolve().then(() => handlers[message.operation](message.input || {}, owner)).then(value => {
      if (value?.cleanupProof || value?.cleanupProofs) {
        const ownPrefix = 'tab:' + sender.tab.id + ':document:';
        const proofs = value.cleanupProofs || [value.cleanupProof];
        const proof = proofs.find(item => item?.ownedFile?.owner?.startsWith(ownPrefix));
        const { cleanupProof, cleanupProofs, ...safe } = value;
        value = proof ? { ...safe, cleanupProof: proof } : safe;
      }
      respond({ ok: true, value });
    }, () => respond(safeError()));
    return true;
  }
  if (message?.type === 'sf-manual-storage' && isSellerFlex(sender)) {
    manualStorage(message).then(value => respond({ ok: true, value }), () => respond(safeError()));
    return true;
  }
  if (!isOptions(sender)) return false;
  const handlers = {
    'erp-status': () => connector.status(),
    'erp-detect': () => LOCAL_TEST ? { status: 'local-test' } : connector.detectErp(),
    'erp-connect': () => { if (LOCAL_TEST) throw new Error('Local test uses pairing'); return connector.connectErp(message.input); },
    'erp-open': async () => { await chrome.tabs.create({ url: 'https://htcerp.app/settings?tab=inventory' }); return connector.status(); },
    'erp-pair': () => connector.pair(message.input),
    'erp-poll': () => connector.poll(),
    'erp-disconnect': () => connector.disconnect(),
    'erp-archive-pending': () => connector.archivePending(),
  };
  if (!Object.hasOwn(handlers, message?.type)) return false;
  Promise.resolve().then(handlers[message.type]).then(value => respond({ ok: true, value, localTest: LOCAL_TEST }), () => respond(safeError()));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void connector.poll().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void connector.poll().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { void connector.poll().catch(() => {}); });
// Initialization always locks storage before any credentials are loaded or saved.
void connector.ready().catch(() => {});
