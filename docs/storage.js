// Single-record transactions keep each image and its metadata together.
const DB_NAME = 'nail-camera-v02';
let dbPromise;
function openDB() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('shots', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { dbPromise = null; reject(request.error); };
    request.onblocked = () => { dbPromise = null; reject(new Error('本机相册数据库被另一个页面占用')); };
  });
  return dbPromise;
}
export async function saveShot(shot) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('shots', 'readwrite');
    tx.objectStore('shots').put(shot);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('本机存储失败'));
  });
}
export async function listShots() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('shots').objectStore('shots').getAll();
    req.onsuccess = () => resolve(req.result.sort((a,b) => b.createdAt - a.createdAt));
    req.onerror = () => reject(req.error);
  });
}
export async function deleteShot(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('shots', 'readwrite');
    tx.objectStore('shots').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('删除失败'));
  });
}
// ZIP "store" format, without compression. No network or external dependencies.
const crcTable = Uint32Array.from({length:256},(_,n) => {
  for(let k=0;k<8;k++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export async function makeZip(files) {
  const chunks = [], central = []; let offset = 0, centralSize = 0;
  for(const file of files) {
    const name = new TextEncoder().encode(file.name);
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const crc = crc32(data);
    if (data.length > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP超过4GB上限');
    const local = new Uint8Array(30 + name.length), view = new DataView(local.buffer);
    view.setUint32(0,0x04034b50,true); view.setUint16(4,20,true); view.setUint16(6,0x0800,true);
    view.setUint16(12,0x21,true); view.setUint32(14,crc,true); view.setUint32(18,data.length,true); view.setUint32(22,data.length,true); view.setUint16(26,name.length,true); local.set(name,30);
    chunks.push(local,data);
    const c = new Uint8Array(46+name.length), cv = new DataView(c.buffer);
    cv.setUint32(0,0x02014b50,true); cv.setUint16(4,20,true); cv.setUint16(6,20,true); cv.setUint16(8,0x0800,true);
    cv.setUint16(14,0x21,true); cv.setUint32(16,crc,true); cv.setUint32(20,data.length,true); cv.setUint32(24,data.length,true); cv.setUint16(28,name.length,true); cv.setUint32(42,offset,true); c.set(name,46);
    central.push(c); centralSize += c.length; offset += local.length + data.length;
  }
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0,0x06054b50,true); e.setUint16(8,files.length,true); e.setUint16(10,files.length,true); e.setUint32(12,centralSize,true); e.setUint32(16,offset,true);
  return new Blob([...chunks,...central,end], {type:'application/zip'});
}
export async function shotZip(shot) {
  return makeZip([{name:shot.metadata.photo.filename,blob:shot.photo}, {name:shot.id+'.json',blob:new Blob([JSON.stringify(shot.metadata,null,2)],{type:'application/json'})}]);
}
export async function sha256(blob) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())), x => x.toString(16).padStart(2,'0')).join('');
}
