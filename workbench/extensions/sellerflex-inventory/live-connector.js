/* Runs only in the trusted service worker. No credential reaches a page. */
(() => {
  'use strict';
  const invalid = () => { throw new Error('库存执行协议或上下文不匹配，已停止。'); };
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
  const expires = value => typeof value === 'number' ? value : Date.parse(value);
  function create({ serial, read, save, request, crypto, manifest }) {
    const identity = (live, input) => {
      if (!live || live.job.id !== input.jobId || live.job.leaseId !== input.leaseId) invalid();
    };
    const tabOwner = owner => typeof owner === 'string' ? owner.match(/^tab:\d+(?=:document:)/)?.[0] : null;
    const automatic = live => live?.job.mode === 'AUTO_REPLENISH';
    const protocol = live => automatic(live) ? 'automatic' : 'live';
    const publicJob = live => ({ job: live ? { ...live.job } : null, needsReconciliation: Boolean(live && live.stage !== 'CLAIMED') });
    const metadata = job => ({ id: job.id, leaseId: job.leaseId, mode: job.mode, state: job.state, ...(job.bulk === true ? { bulk: true } : { rows: job.rows }), filename: job.filename, sha256: job.sha256, warehouseCode: job.warehouseCode, expiresAt: job.expiresAt });
    function validate(job, state) {
      if (!job || !['REAL_TRIAL', 'AUTO_REPLENISH'].includes(job.mode) || !text(job.id) || !text(job.leaseId) || job.warehouseCode !== 'A1C5' || state.scope?.warehouseCode !== job.warehouseCode || !Array.isArray(job.rows) || job.rows.length < 1 || job.rows.length > (job.mode === 'AUTO_REPLENISH' ? (job.bulk === true ? 2900 : 10) : 2)) invalid();
    }
    const recorded = (live, proof) => Boolean(automatic(live) && proof?.state === 'RECORDED'
      && proof.submitted === true && proof.id === live.job.id && proof.leaseId === live.job.leaseId
      && text(proof.eventId) && proof.eventId === (live.pending || live.lastReceipt)?.eventId);
    async function acknowledge(state, proof) {
      const live = state.live;
      if (!recorded(live, proof)) invalid();
      const alreadyRecorded = recorded(live, live.receiptProof) && live.receiptProof.eventId === proof.eventId;
      live.lastReceipt = live.pending || live.lastReceipt;
      live.pending = null;
      live.stage = 'ACKNOWLEDGED';
      // One compact durable receipt replaces normal batch history. Full archives remain for transfers.
      state.lastAutomaticReceipt = { receipt: { id: proof.id, leaseId: proof.leaseId,
        eventId: proof.eventId, state: 'RECORDED', submitted: true }, ownedFile: live.ownedFile || null };
      live.receiptProof = state.lastAutomaticReceipt.receipt;
      const tab = tabOwner(live.ownedFile?.owner);
      if (tab && !alreadyRecorded) state.automaticCleanup = { ...state.automaticCleanup, [tab]: state.lastAutomaticReceipt };
      await save(state);
    }
    const cleanup = (state, value) => Object.keys(state.automaticCleanup || {}).length
      ? { ...value, cleanupProof: state.lastAutomaticReceipt, cleanupProofs: Object.values(state.automaticCleanup) } : value;
    async function replay(state) {
      if (!state.live?.pending) return;
      const ack = await request(state, protocol(state.live) + '/results', state.live.pending);
      if (ack?.accepted !== true || ack.job?.id !== state.live.job.id) invalid();
      if (automatic(state.live)) { await acknowledge(state, ack.receipt); return; }
      state.live.lastReceipt = state.live.pending;
      state.live.pending = null;
      state.live.stage = state.live.lastReceipt.status === 'UNKNOWN' ? 'UNKNOWN' : 'ACKNOWLEDGED';
      await save(state);
    }
    async function synchronizeMode(state, mode) {
        let replayError;
        try { await replay(state); } catch (error) {
          if (!automatic(state.live) && error.status !== 409) throw error;
          replayError = error;
        }
        const previous = state.live && protocol(state.live) === mode ? state.live : null;
        const result = await request(state, mode + '/claim', previous
          ? { previousJobId: previous.job.id, previousLeaseId: previous.job.leaseId, ...(mode === 'automatic' ? { bulk: true } : {}) }
          : mode === 'automatic' ? { bulk: true } : {});
        if (!result || !Object.hasOwn(result, 'job')) invalid();
        if (result.job) {
          validate(result.job, state);
          if (protocol({ job: result.job }) !== mode) invalid();
        }
        const proof = result.previousJob;
        const durable = recorded(previous, proof);
        if (proof?.state === 'RECORDED' && !durable) invalid();
        if (durable) await acknowledge(state, proof);
        const transferred = previous && proof?.state === 'TRANSFERRED'
          && proof.id === previous.job.id && proof.leaseId === previous.job.leaseId
          && typeof proof.submitted === 'boolean' && /^[a-f0-9]{64}$/.test(proof.newDeviceId)
          && /^[a-f0-9]{64}$/.test(state.deviceId) && proof.newDeviceId !== state.deviceId;
        if (proof?.state === 'TRANSFERRED' && !transferred) invalid();
        if (replayError && !transferred && !durable) throw replayError;
        if (transferred) {
          const archived = state.archivedLive || [];
          if (archived.length >= 10 || result.job && result.job.leaseId === previous.job.leaseId) invalid();
          // Atomic, append-only evidence preservation before releasing this lease's latch.
          state.archivedLive = [...archived, { live: previous, proof: { ...proof }, deviceId: state.deviceId,
            baseUrl: state.baseUrl, scope: state.scope, archivedAt: new Date().toISOString(), reason: 'TRANSFERRED' }];
          state.live = null;
          await save(state);
        }
        const retireUnsubmitted = !transferred && previous && ['CLAIMED', 'PREPARING'].includes(previous.stage)
          && !previous.pending && !previous.lastReceipt
          && proof?.id === previous.job.id && proof.leaseId === previous.job.leaseId
          && ['EXPIRED', 'SKIPPED'].includes(proof.state) && proof.submitted === false;
        if (retireUnsubmitted) {
          // Only an authenticated server proof can release a pre-dispatch latch. Local time
          // or a different claimed ID is never evidence that a prior upload did not happen.
          if (result.job?.id === previous.job.id) invalid();
          previous.stage = 'ACKNOWLEDGED';
          previous.job.state = proof.state;
          previous.retirementProof = { id: proof.id, leaseId: proof.leaseId, state: proof.state, submitted: false };
        }
        if (!result.job) {
          if (retireUnsubmitted) await save(state);
          return state.live && state.live.stage !== 'ACKNOWLEDGED' ? publicJob(state.live) : { job: null };
        }
        if (state.live?.job.id === result.job.id) {
          if (state.live.job.leaseId !== result.job.leaseId) invalid();
          if (result.job.bulk === true && result.job.state === 'CLAIMED' && state.live.stage === 'PREPARING')
            state.live.stage = 'CLAIMED';
          // Server may renew lease metadata, but can never reset the local dispatch latch.
          state.live.job = { ...state.live.job, ...metadata(result.job) };
        } else {
          if (state.live && state.live.stage !== 'ACKNOWLEDGED') invalid();
          const prior = state.live;
          state.live = { job: metadata(result.job), stage: (state.archivedLive || []).some(entry => entry.live?.job.id === result.job.id && (entry.proof?.submitted || !['CLAIMED', 'PREPARING', 'ACKNOWLEDGED'].includes(entry.live.stage))) || result.needsReconciliation || result.job.needsReconciliation || !['LEASED', 'QUEUED', 'CLAIMED'].includes(result.job.state) ? 'UNKNOWN' : 'CLAIMED', pending: null, priorReceipt: prior?.lastReceipt || null, priorRetirementProof: prior?.retirementProof || prior?.priorRetirementProof || null };
        }
        await save(state);
        return state.live.stage === 'ACKNOWLEDGED' ? { job: null } : publicJob(state.live);
    }
    async function synchronize(state) {
      if (!state.token) return { job: null };
      // Continue unresolved work on its own protocol. Never turn an old trial UNKNOWN into auto work.
      if (state.live && state.live.stage !== 'ACKNOWLEDGED')
        return cleanup(state, await synchronizeMode(state, protocol(state.live)));
      const manual = await synchronizeMode(state, 'live');
      if (manual.job || state.live && state.live.stage !== 'ACKNOWLEDGED') return cleanup(state, manual);
      return cleanup(state, await synchronizeMode(state, 'automatic'));
    }
    return {
      replay, synchronize,
      poll: () => serial(async () => synchronize(await read())),
      cleared: (input, owner) => serial(async () => {
        const state = await read(), tab = tabOwner(owner), proof = state.automaticCleanup?.[tab];
        if (!tab || !proof || ['id', 'leaseId', 'eventId', 'state', 'submitted'].some(key => input[key] !== proof.receipt[key])) invalid();
        delete state.automaticCleanup[tab];
        await save(state);
        return { cleared: true };
      }),
      prepare: (input, owner) => serial(async () => {
        const state = await read();
        identity(state.live, input);
        if (state.live.stage !== 'CLAIMED') return publicJob(state.live);
        if (automatic(state.live) && (!tabOwner(owner) || !state.automaticCleanup?.[tabOwner(owner)]
            && Object.keys(state.automaticCleanup || {}).length >= 32)) invalid();
        // An uncertain prepare response cannot be retried: the server may have registered SUBMITTING.
        state.live.stage = 'PREPARING';
        await save(state);
        const response = await request(state, protocol(state.live) + '/prepare', input);
        if (response.pending === true) {
          const job = response.job;
          identity({ job }, input);
          if (state.live.job.bulk !== true || job.bulk !== true || job.mode !== 'AUTO_REPLENISH'
            || job.state !== 'CLAIMED' || job.csv || job.filename || job.needsReconciliation) invalid();
          state.live.job = metadata(job);
          state.live.stage = 'CLAIMED';
          await save(state);
          return { ...publicJob(state.live), pending: true };
        }
        if (response.job?.state === 'SKIPPED' && !response.job.csv) {
          identity({ job: response.job }, input);
          if (response.job.mode !== state.live.job.mode || response.job.warehouseCode !== 'A1C5') invalid();
          state.live.job = metadata(response.job);
          state.live.stage = 'ACKNOWLEDGED';
          await save(state);
          return publicJob(state.live);
        }
        if (response.needsReconciliation || response.job?.needsReconciliation || !response.job?.csv) {
          if (response.job) {
            validate(response.job, state);
            identity({ job: response.job }, input);
            if (response.job.mode !== state.live.job.mode) invalid();
            state.live.job = metadata(response.job);
          }
          state.live.stage = 'UNKNOWN';
          await save(state);
          return publicJob(state.live);
        }
        const job = response.job;
        validate(job, state);
        if (job.mode !== state.live.job.mode) invalid();
        identity({ job }, input);
        if (job.bulk !== state.live.job.bulk || !/^receive-[A-Za-z0-9-]+\.csv$/.test(job.filename) || !/^[a-f0-9]{64}$/.test(job.sha256) || !(expires(job.expiresAt) > Date.now()) || typeof job.csv !== 'string' || job.csv.length > (job.bulk === true ? 6500000 : 16384)) invalid();
        const canonical = await manifest({ ...job, mode: 'SIMULATION', nonce: job.leaseId });
        const bytes = new TextEncoder().encode(job.csv);
        if (bytes.length > (job.bulk === true ? 6500000 : 16384)) invalid();
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        if (canonical.sha256 !== job.sha256 || hash !== job.sha256) invalid();
        const ownedFile = { owner, filename: job.filename, sha256: job.sha256, size: bytes.length, lastModified: Date.now() };
        state.live = { ...state.live, job: metadata(job), owner, ownedFile, stage: 'DISPATCHING' };
        await save(state);
        return { job: { ...state.live.job, csv: job.csv }, ownedFile, needsReconciliation: false };
      }),
      heartbeat: input => serial(async () => {
        const state = await read(); identity(state.live, input);
        await replay(state);
        await request(state, protocol(state.live) + '/heartbeat', input);
        return { ok: true };
      }),
      dispatched: (input, owner) => serial(async () => {
        const state = await read(); identity(state.live, input);
        if (state.live.owner !== owner || state.live.stage !== 'DISPATCHING') invalid();
        state.live.stage = 'DISPATCHED';
        await save(state);
        await request(state, protocol(state.live) + '/dispatched', input);
        return { ok: true };
      }),
      results: input => serial(async () => {
        const state = await read(); identity(state.live, input);
        if (state.live.stage === 'CLAIMED') invalid();
        for (const key of ['filename', 'sha256', 'warehouseCode']) if (input[key] !== state.live.job[key]) invalid();
        if (!['COMPLETED', 'FAILED', 'UNKNOWN'].includes(input.status) || !(input.errorCount === null || Number.isInteger(input.errorCount) && input.errorCount >= 0) || !input.evidence || typeof input.evidence.rowText !== 'string' || input.evidence.rowText.length > 16000 || !Number.isFinite(input.evidence.observedAt)) invalid();
        // Content parser deliberately reports partial results UNKNOWN until exact SKU errors are available.
        if (input.status === 'COMPLETED' && input.errorCount !== 0) invalid();
        if (state.live.pending) { await replay(state); return cleanup(state, { accepted: true }); }
        const receipt = { jobId: input.jobId, leaseId: input.leaseId, filename: input.filename, sha256: input.sha256, warehouseCode: input.warehouseCode, status: input.status, errorCount: input.errorCount, evidence: { rowText: input.evidence.rowText, observedAt: input.evidence.observedAt } };
        if (state.live.lastReceipt?.status === input.status && state.live.lastReceipt?.evidence.rowText === receipt.evidence.rowText) return cleanup(state, { accepted: true });
        state.live.pending = { ...receipt, eventId: crypto.randomUUID() };
        await save(state);
        await replay(state);
        return cleanup(state, { accepted: true });
      }),
    };
  }
  globalThis.SellerFlexLiveConnector = Object.freeze({ create });
})();
