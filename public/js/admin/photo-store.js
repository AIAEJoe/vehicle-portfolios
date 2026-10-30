// Photos kept on the phone until they're safely uploaded. If the page is closed, the phone locks for too long or
// the signal drops, the next visit to the Photos page picks them up and finishes the uploads. Each photo remembers
// which car it was taken for. Uses the browser's IndexedDB; if that isn't available (private browsing), uploads
// still work, just without the safety copy.
const DB = 'vp-photos';
const STORE = 'pending';

function open() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('no indexedDB')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function run(mode, fn) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(out && 'result' in out ? out.result : undefined); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch { return undefined; } // no safety copy available; uploads carry on regardless
}

/** rec: { id, dealership_id, vid, label, pos, name, type, blob, created } */
export const savePending = (rec) => run('readwrite', (s) => s.put(rec));
export const removePending = (id) => run('readwrite', (s) => s.delete(id));
export async function listPending(dealershipId) {
  const all = (await run('readonly', (s) => s.getAll())) || [];
  return all.filter((r) => r.dealership_id === dealershipId).sort((a, b) => a.created - b.created);
}

/** "Save to Photos": the phone's share sheet when it can take files (iPhone, Android), otherwise downloads. */
export async function saveToDevice(files) {
  if (!files.length) return 'none';
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name || 'photo.jpg';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  return 'downloaded';
}
