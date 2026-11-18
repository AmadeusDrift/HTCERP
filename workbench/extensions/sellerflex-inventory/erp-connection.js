/* Background-only connection proof. The ERP tab receives only a SHA-256 challenge. */
(() => {
  'use strict';
  const ORIGIN = 'https://htcerp.app';
  const scopeKeys = ['sellerAccountId', 'marketplaceId', 'warehouseCode'];
  const text = (v, max = 512) => typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v && !/[\x00-\x1f]/.test(v);
  const scopeValid = v => v && scopeKeys.every(k => text(v[k]));
  const sameScope = (a, b) => scopeKeys.every(k => a?.[k] === b?.[k]);
  const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
  const fail = code => { const e = new Error('ERP 连接未完成，请检查登录状态后重试。'); e.safeCode = code; throw e; };
  const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  function create({ chrome, crypto, read, save, request }) {
    async function relay(tabId, operation, input) {
      let response;
      try { response = await chrome.tabs.sendMessage(tabId, { type: 'sf-erp-relay', operation, ...(input ? { input } : {}) }, { frameId: 0 }); }
      catch { fail('relay'); }
      if (!response?.ok) fail(response?.status === 401 ? 'login' : response?.status === 403 ? 'forbidden' : response?.status === 409 ? 'scope' : 'offline');
      return response.value;
    }
    async function discover() {
      const tabs = await chrome.tabs.query({ url: ORIGIN + '/*' });
      let status = 'no-tab';
      for (const tab of tabs) {
        if (!Number.isInteger(tab.id)) continue;
        try { if (new URL(tab.url).origin !== ORIGIN) continue; } catch { continue; }
        try {
          const value = await relay(tab.id, 'session');
          if (!text(value?.actor?.id) || !text(value.actor.displayName) || value.actor.role !== 'admin' || !scopeValid(value.scope)) fail('protocol');
          return { status: 'ready', tabId: tab.id, actor: { id: value.actor.id, displayName: value.actor.displayName, role: value.actor.role }, scope: Object.fromEntries(scopeKeys.map(k => [k, value.scope[k]])) };
        } catch (error) { status = error.safeCode || 'offline'; }
      }
      return { status };
    }
    async function detect() { const { tabId, ...visible } = await discover(); return visible; }
    async function connect(input) {
      const state = await read();
      if (state.token || state.pending || state.live) fail('pending');
      if (!text(input?.name, 80)) fail('input');
      const session = await discover();
      if (session.status !== 'ready') {
        if (['login', 'forbidden', 'scope'].includes(session.status)) { delete state.pendingConnection; await save(state); }
        fail(session.status);
      }
      let pending = state.pendingConnection;
      if (pending && (pending.expiresAt <= Date.now() || pending.actorId !== session.actor.id || !sameScope(pending.scope, session.scope) || pending.name !== input.name)) {
        delete state.pendingConnection; await save(state); fail('expired');
      }
      if (!pending) {
        const verifier = hex(crypto.getRandomValues(new Uint8Array(32)));
        pending = { requestId: crypto.randomUUID(), verifier, challenge: hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))), actorId: session.actor.id, scope: session.scope, name: input.name, expiresAt: Date.now() + 120000 };
        state.pendingConnection = pending;
        await save(state);
      }
      try {
        // Reauthorize even a saved grant: the server validates the exact cookie session.
        const grant = await relay(session.tabId, 'authorize', { requestId: pending.requestId, challenge: pending.challenge, name: pending.name });
        if (!uuid(grant?.grantId) || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now() || !sameScope(grant.scope, pending.scope) || pending.grantId && pending.grantId !== grant.grantId) fail('protocol');
        pending.grantId = grant.grantId;
        pending.expiresAt = Math.min(pending.expiresAt, grant.expiresAt);
        await save(state);
        const paired = await request({ baseUrl: ORIGIN }, 'connect', { grantId: pending.grantId, verifier: pending.verifier });
        if (!/^[a-f0-9]{64}$/.test(paired?.deviceId) || !/^[a-f0-9]{64}$/.test(paired?.token) || paired.mode !== 'SIMULATION' || paired.pollSeconds !== 60 || !sameScope(paired.scope, pending.scope)) fail('protocol');
        Object.assign(state, { baseUrl: ORIGIN, name: pending.name, deviceId: paired.deviceId, token: paired.token, scope: pending.scope, errorCode: null });
        delete state.pendingConnection;
        await save(state);
      } catch (error) {
        if (['auth', 'login', 'forbidden', 'scope', 'expired'].includes(error.safeCode)) { delete state.pendingConnection; await save(state); }
        throw error;
      }
    }
    return { detect, connect };
  }
  globalThis.SellerFlexErpConnection = Object.freeze({ create });
})();
