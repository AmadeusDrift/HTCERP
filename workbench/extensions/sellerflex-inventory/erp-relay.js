/* Isolated-world, top-frame relay. No DOM events, cookies, storage or page messaging. */
(() => {
  'use strict';
  if (self !== top || location.origin !== 'https://htcerp.app') return;
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab || sender.url && sender.url !== chrome.runtime.getURL('background.js')) return false;
    if (message?.type !== 'sf-erp-relay' || Object.keys(message).some(k => !['type', 'operation', 'input'].includes(k))) return false;
    const authorize = message.operation === 'authorize';
    if (!authorize && (message.operation !== 'session' || message.input !== undefined)) return false;
    const input = message.input;
    if (authorize && (!input || Object.keys(input).sort().join(',') !== 'challenge,name,requestId' || !uuid(input.requestId) || typeof input.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(input.challenge) || typeof input.name !== 'string' || !input.name.trim() || input.name !== input.name.trim() || input.name.length > 80 || /[\x00-\x1f]/.test(input.name))) return false;
    (async () => {
      const response = await fetch('https://htcerp.app/api/inventory-sync/connection/' + (authorize ? 'authorize' : 'session'), {
        method: authorize ? 'POST' : 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12000),
        headers: { 'Content-Type': 'application/json' }, ...(authorize ? { body: JSON.stringify(input) } : {}),
      });
      if (!response.ok) return { ok: false, status: [401, 403, 409].includes(response.status) ? response.status : 0 };
      const value = await response.json();
      const scope = { sellerAccountId: value.scope?.sellerAccountId, marketplaceId: value.scope?.marketplaceId, warehouseCode: value.scope?.warehouseCode };
      return { ok: true, value: authorize ? { grantId: value.grantId, expiresAt: value.expiresAt, scope } : { actor: { id: value.actor?.id, displayName: value.actor?.displayName, role: value.actor?.role }, scope } };
    })().then(respond, () => respond({ ok: false, status: 0 }));
    return true;
  });
})();
