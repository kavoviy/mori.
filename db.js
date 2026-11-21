// Минимальная локальная база. Аккаунты разделены префиксами: local / user:<uid>.
const DB_NAME = 'mori_notes_v1';
const DB_VERSION = 1;
let connection;

function openDatabase() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('Браузер не поддерживает IndexedDB'));
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('notes')) {
        const store = db.createObjectStore('notes', {keyPath:'key'});
        store.createIndex('account', 'account', {unique:false});
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', {keyPath:'key'});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Не удалось открыть хранилище'));
  });
  return connection;
}

async function requestResult(storeName, mode, makeRequest) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = makeRequest(tx.objectStore(storeName));
    let data;
    request.onsuccess = () => { data = request.result; };
    tx.oncomplete = () => resolve(data);
    tx.onerror = () => reject(tx.error || request.error || new Error('Ошибка IndexedDB'));
    tx.onabort = () => reject(tx.error || new Error('Запись отменена'));
  });
}

export async function loadNotes(account) {
  const rows = await requestResult('notes', 'readonly', s => s.index('account').getAll(account));
  return rows.map(({key,account,...note}) => note);
}
export async function saveNote(account, note) {
  await requestResult('notes', 'readwrite', s => s.put({...note, account, key:`${account}:${note.id}`}));
}
export async function removeNote(account, id) {
  await requestResult('notes', 'readwrite', s => s.delete(`${account}:${id}`));
}
export async function getSetting(key) {
  const row = await requestResult('settings', 'readonly', s => s.get(key));
  return row?.value;
}
export async function setSetting(key, value) {
  await requestResult('settings', 'readwrite', s => s.put({key,value}));
}
