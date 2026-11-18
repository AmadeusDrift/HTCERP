/* Extension-origin IndexedDB. Never exposed to the Seller Flex document. */
(() => {
  'use strict';
  function create(indexedDB = globalThis.indexedDB) {
    let opening;
    function open() {
      if (!opening) opening = new Promise((resolve, reject) => {
        const request = indexedDB.open('sf-pack-outbox-v1', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('exports', { keyPath: 'requestId' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => { opening = null; reject(new Error('Pack outbox unavailable')); };
      });
      return opening;
    }
    async function operation(mode, action) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('exports', mode);
        const request = action(transaction.objectStore('exports'));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = transaction.onabort = () => reject(new Error('Pack outbox write failed'));
      });
    }
    return { all: () => operation('readonly', store => store.getAll()), get: id => operation('readonly', store => store.get(id)), put: record => operation('readwrite', store => store.put(record)) };
  }
  globalThis.SellerFlexPackOutbox = Object.freeze({ create });
})();
