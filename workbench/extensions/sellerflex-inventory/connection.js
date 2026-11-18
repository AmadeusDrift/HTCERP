const byId = id => document.getElementById(id);
let lastState;
let busy = false;
let erpSession;
const unresolvedLive = state => Boolean(state?.liveTrial && state.liveTrial.stage !== 'ACKNOWLEDGED');
async function message(type, input) {
  const response = await chrome.runtime.sendMessage({ type, input });
  if (!response?.ok) throw new Error(response?.error || '无法读取扩展状态，请重新加载扩展。');
  byId('test-warning').hidden = !response.localTest;
  return response.value;
}
function render(state) {
  lastState = state;
  const items = [
    ['状态', state.connected ? '已配对' : '尚未配对'],
    ['仓库', state.scope?.warehouseCode || '配对后由 ERP 绑定'],
    ['卖家账户', state.scope?.sellerAccountId || '—'],
    ['站点', state.scope?.marketplaceId || '—'],
    ['最近连接', state.lastContact ? new Date(state.lastContact).toLocaleString() : '尚未连接'],
    ['待确认回执', state.pending ? '已保留，正在等待重试' : '无'],
    ['已归档执行记录', String(state.archivedLiveCount || 0) + ' 份'],
    ['已保留异常', String(state.archivedReceiptCount || 0) + ' 份（未确认）'],
    ['最近模拟', state.lastResult ? state.lastResult.rowCount + ' 行 · ' + new Date(state.lastResult.at).toLocaleString() : '尚无'],
    ['执行模式', ({ SIMULATION: '模拟校验', REAL_TRIAL: '两行真实试跑', AUTO_REPLENISH: '自动补库（每批最多 10 行）' })[state.mode] || '等待任务'],
    ['库存任务', state.liveTrial ? state.liveTrial.stage + ' · ' + (state.liveTrial.filename || state.liveTrial.jobId) : '尚无任务'],
  ];
  byId('details').replaceChildren(...items.flatMap(([label, text]) => {
    const term = document.createElement('dt'); term.textContent = label;
    const value = document.createElement('dd'); value.textContent = text;
    return [term, value];
  }));
  byId('notice').textContent = state.error || '';
  byId('disconnect').disabled = busy || !state.connected || state.pending || unresolvedLive(state);
  byId('poll').disabled = busy || !state.connected;
  byId('recovery').hidden = !state.recoveryAvailable;
  byId('archive-full').hidden = state.archivedReceiptCount < 10;
  byId('archive-pending').disabled = busy || !state.recoveryAvailable || state.archivedReceiptCount >= 10;
}
async function act(task) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { render(await task()); } catch { byId('notice').textContent = '操作未完成。请检查配对码、网络和 ERP 设备状态；有待确认回执时需先重试。'; }
  finally {
    busy = false;
    byId('pair-form').querySelector('button').disabled = Boolean(lastState?.pending) || unresolvedLive(lastState);
    byId('disconnect').disabled = !lastState?.connected || Boolean(lastState?.pending) || unresolvedLive(lastState);
    byId('poll').disabled = !lastState?.connected;
    byId('archive-pending').disabled = !lastState?.recoveryAvailable || lastState.archivedReceiptCount >= 10;
    byId('detect-erp').disabled = false;
    byId('open-erp').disabled = false;
    byId('connect-erp').disabled = erpSession?.status !== 'ready' || Boolean(lastState?.connected || lastState?.pending || lastState?.liveTrial);
  }
}
byId('pair-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = { baseUrl: byId('base-url').value.trim(), code: byId('pair-code').value.trim(), name: byId('device-name').value.trim() };
  byId('pair-code').value = '';
  void act(async () => { await message('erp-pair', input); return message('erp-poll'); });
});
byId('poll').addEventListener('click', () => { void act(() => message('erp-poll')); });
byId('disconnect').addEventListener('click', () => { void act(() => message('erp-disconnect')); });
byId('archive-pending').addEventListener('click', () => { void act(() => message('erp-archive-pending')); });
async function detectErp() {
  erpSession = await message('erp-detect');
  const descriptions = {
    'no-tab': '未发现本浏览器的 ERP 标签页。请打开 ERP 并登录，然后重新检测。',
    login: 'ERP 尚未登录或登录已失效。请在 ERP 登录后重新检测。',
    forbidden: '当前 ERP 账户不能授权设备，请使用管理员账户登录。',
    relay: 'ERP 标签页尚未加载此版本连接脚本。请手动刷新已保存的页面，或打开新的 ERP 标签页。',
    scope: 'ERP 尚未配置店铺范围，请在 ERP 完成配置后重试。',
    'local-test': '本地隔离测试版本，请展开备用配对码连接。',
  };
  byId('erp-session').textContent = erpSession.status === 'ready'
    ? '已检测到 ' + erpSession.actor.displayName + ' · ' + erpSession.scope.sellerAccountId + ' · ' + erpSession.scope.warehouseCode
    : descriptions[erpSession.status] || '暂时无法读取 ERP 登录状态，请检查网络后重试。';
  if (erpSession.status === 'local-test') byId('pair-fallback').open = true;
}
byId('detect-erp').addEventListener('click', () => { void act(async () => { await detectErp(); return message('erp-status'); }); });
byId('open-erp').addEventListener('click', () => { void act(() => message('erp-open')); });
byId('connect-erp').addEventListener('click', () => { void act(async () => {
  await message('erp-connect', { name: byId('device-name').value.trim() });
  return message('erp-poll');
}); });
void act(async () => {
  const state = await message('erp-status');
  byId('base-url').value = state.baseUrl;
  byId('device-name').value = state.name || '仓库 Edge 电脑';
  await detectErp();
  return state;
});
