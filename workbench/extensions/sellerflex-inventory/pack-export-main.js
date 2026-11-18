/* MAIN-world observer. No network, extension APIs, credentials, or arbitrary URL reads. */
(() => {
  'use strict';
  if (window !== top || location.origin !== 'https://sellerflex.amazon.com') return;
  const CHANNEL = 'sf-pack-export-v1';
  const MAX = 12000000;
  const onPack = () => location.pathname.replace(/\/$/, '') === '/transshipments/pack';
  const nativeCreate = URL.createObjectURL.bind(URL);
  const nativeClick = HTMLAnchorElement.prototype.click;
  const nativeDispatch = HTMLAnchorElement.prototype.dispatchEvent;
  const blobs = new Map();
  let armed = null;
  let timer;
  let externalExportSeen = false;
  const diagnostic = (event, details) => console.info('[sf-pack]', event, JSON.stringify(details));
  const post = value => window.postMessage({ channel: CHANNEL, ...value }, location.origin);
  function clear(tainted = false) { if (tainted) externalExportSeen = true; clearTimeout(timer); armed = null; blobs.clear(); }
  addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== CHANNEL) return;
    const message = event.data;
    if (message.type === 'cancel' && armed?.nonce === message.nonce) { clear(Boolean(armed.clicked || message.dispatched)); return; }
    if (message.type !== 'arm' || !onPack() || !/^[a-f0-9]{32}$/.test(message.nonce) || message.kind !== 'xlsx' || armed) return;
    if (externalExportSeen) { post({ type: 'error', nonce: message.nonce, code: 'reload-required' }); return; }
    armed = { nonce: message.nonce, kind: 'xlsx', until: Date.now() + 30000 };
    diagnostic('arm', { kind: message.kind });
    timer = setTimeout(() => clear(Boolean(armed?.clicked)), 30000);
    post({ type: 'armed', nonce: message.nonce });
  });
  URL.createObjectURL = function (blob) {
    const url = nativeCreate(blob);
    if (armed && onPack()) diagnostic('blob', { kind: armed.kind, size: typeof blob?.size === 'number' ? blob.size : null, type: typeof blob?.type === 'string' ? blob.type.slice(0, 120) : null, instanceOfBlob: blob instanceof Blob });
    if (armed && onPack() && Date.now() < armed.until && blob instanceof Blob && ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/octet-stream'].includes(blob.type.toLowerCase().split(';')[0]) && blob.size > 0 && blobs.size < 20) blobs.set(url, blob.size <= MAX ? blob : { size: blob.size, type: blob.type });
    return url;
  };
  async function inspect(anchor) {
    const operation = armed;
    if (!operation || !onPack() || Date.now() >= operation.until || !(anchor instanceof HTMLAnchorElement)) return;
    const filename = anchor.download;
    const href = anchor.href;
    const blob = blobs.get(href);
    const protocol = /^[a-z][a-z0-9+.-]*:/i.exec(href)?.[0]?.toLowerCase() || '';
    diagnostic('inspect', { kind: operation.kind, filename: filename.slice(0, 180), protocol, tracked: Boolean(blob), type: typeof blob?.type === 'string' ? blob.type.slice(0, 120) : null, count: blobs.size });
    const matchesFilename = /^transshipment-order-list-\d{4}-\d{2}-\d{2}\.xlsx$/.test(filename);
    if (!matchesFilename) return;
    const types = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/octet-stream'];
    const tooLarge = () => { clear(Boolean(operation.clicked)); post({ type: 'error', nonce: operation.nonce, code: 'too-large' }); };
    let bytes, base64, magic;
    if (protocol === 'data:') {
      // Read only this clicked anchor's embedded bytes. Never fetch a URL.
      // Bound both the entire URL and its metadata before slicing or decoding.
      if (href.length > 16000256) { tooLarge(); return; }
      const comma = href.indexOf(',');
      if (comma < 6 || comma > 255) return;
      const metadata = /^([^;]+)(?:;charset=[A-Za-z0-9_-]+)?;base64$/i.exec(href.slice(5, comma));
      const type = metadata?.[1]?.toLowerCase() || '';
      const encodedLength = href.length - comma - 1;
      diagnostic('data', { kind: operation.kind, type: type.slice(0, 120), encodedLength });
      if (!metadata || !types.includes(type)) return;
      if (encodedLength > 16000000) { tooLarge(); return; }
      if (!encodedLength || encodedLength % 4 !== 0) return;
      base64 = href.slice(comma + 1);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return;
      let binary;
      try { binary = atob(base64); }
      catch (error) { diagnostic('read-error', { kind: operation.kind, name: typeof error?.name === 'string' ? error.name.slice(0, 80) : 'Error' }); return; }
      if (binary.length > MAX) { tooLarge(); return; }
      // Reject noncanonical padding bits and malformed encodings rather than repairing them.
      if (btoa(binary) !== base64) return;
      magic = binary.slice(0, 5);
    } else {
      if (protocol !== 'blob:' || !blob || !types.includes(blob.type.toLowerCase().split(';')[0])) return;
      if (blob.size > MAX) { tooLarge(); return; }
      // Keep the actual Blob reference across native immediate revokeObjectURL.
      try { bytes = new Uint8Array(await blob.arrayBuffer()); }
      catch (error) { diagnostic('read-error', { kind: operation.kind, name: typeof error?.name === 'string' ? error.name.slice(0, 80) : 'Error' }); return; }
      magic = String.fromCharCode(...bytes.slice(0, 5));
    }
    if (!magic.startsWith('PK\x03\x04')) return;
    // Inline decoding is synchronous; let the original native click dispatch before
    // completing, just as Blob.arrayBuffer() does, so it is not mistaken for a later export.
    await Promise.resolve();
    if (armed !== operation || !onPack() || Date.now() >= operation.until) return;
    if (base64 === undefined) {
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      base64 = btoa(binary);
    }
    clear();
    post({ type: 'file', nonce: operation.nonce, kind: operation.kind, filename, base64 });
  }
  // FileSaver may click an unattached anchor, so both prototype and event paths matter.
  HTMLAnchorElement.prototype.click = function () { void inspect(this); return nativeClick.call(this); };
  HTMLAnchorElement.prototype.dispatchEvent = function (event) { if (event?.type === 'click') void inspect(this); return nativeDispatch.call(this, event); };
  addEventListener('click', event => {
    const path = event.composedPath();
    if (onPack() && path.some(node => node instanceof Element && node.matches('button,[role="button"],a') && !node.id.startsWith('sf-') && ['Download order list','Download FNSKU labels','Print FNSKU labels','Download','Print'].includes((node.textContent || '').replace(/\s+/g, ' ').trim()))) {
      if (armed) armed.clicked = true; else externalExportSeen = true;
    }
    const anchor = path.find(node => node instanceof HTMLAnchorElement); if (anchor) void inspect(anchor);
  }, true);
  addEventListener('pagehide', () => clear(Boolean(armed?.clicked)));
})();
