(() => {
  const request = async (operation, key, value) => {
    const response = await chrome.runtime.sendMessage({ type: 'sf-manual-storage', operation, key, value });
    if (!response?.ok) throw new Error('无法访问本地提交记录，请重新加载扩展和页面。');
    return response.value;
  };
  globalThis.SellerFlexManualStorage = Object.freeze({
    get: key => request('get', key),
    set: async records => {
      for (const [key, value] of Object.entries(records)) await request('set', key, value);
    },
    remove: key => request('remove', key),
  });
})();
