export async function openStorage() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('spritecanvas-studio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onerror = () => reject(new Error(`Browser storage is unavailable: ${request.error?.message}`));
    request.onsuccess = () => resolve(request.result);
  });
}
export function readStorage(db) {
  return new Promise((resolve, reject) => {
    const request = db.transaction('workspace').objectStore('workspace').get('current');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(`Cannot read browser backup: ${request.error?.message}`));
  });
}
export function writeStorage(db, data) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('workspace', 'readwrite');
    transaction.objectStore('workspace').put(data, 'current');
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(new Error(`Browser autosave failed: ${transaction.error?.message}. Download a project file to keep your work.`));
    transaction.onabort = () => reject(new Error('Browser autosave was aborted. Download a project file to keep your work.'));
  });
}
export async function api(route, body) {
  const response = await fetch(new URL(`./api/${route}`, document.baseURI), body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpriteCanvas': '1' }, body: JSON.stringify(body),
  } : { cache: 'no-store' });
  if (!response.headers.get('content-type')?.includes('application/json')) {
    const error = new Error('Local bridge did not return JSON. Start it with npm start.');
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `Bridge returned ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}
