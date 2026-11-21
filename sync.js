// mori. — ручная синхронизация через GitHub Gist. Все содержимое Gist зашифровано AES-GCM.
// Никаких секретов в исходниках приложения: токен пользователь вводит на своём устройстве.
const API = 'https://api.github.com';
export const VAULT_FILE = 'mori-vault.json';
const PART_PREFIX = 'mori-part-';
const PART_SIZE = 400000; // Меньше порога усечения GitHub Gist API (~1 MiB на файл).
const MAX_PARTS = 48;
const MAX_PLAINTEXT = 12_000_000;
const KDF_ITERATIONS = 250000;
const FORMAT = 'mori-encrypted-gist-v1';
const FIELDS = ['type','title','content','url','image','color','pinned','order','deleted'];
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal:true});

function encode64(bytes) {
  let out = '';
  for (let i=0;i<bytes.length;i+=8192) out+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(out);
}
function decode64(b64) {
  const raw=atob(b64);
  return Uint8Array.from(raw, ch=>ch.charCodeAt(0));
}
function equal(a,b) {
  if (!a || !b) return a === b;
  return FIELDS.every(k=>a[k]===b[k]);
}
function conflictCopy(note, now, idMaker) {
  const title=String(note.title||'Без названия').slice(0,135)+' (конфликт синхронизации)';
  return {...note,id:idMaker(),title,deleted:false,pinned:false,createdAt:now,updatedAt:now,order:now};
}
// Трёхстороннее слияние на базе последней успешной синхронизации.
// При конфликте двух изменений исходник не выбрасываем: создаётся конфликтная копия.
export function mergeNotes(localRows, remoteRows, baseRows=[], now=Date.now(), idMaker=()=>crypto.randomUUID()) {
  const local=new Map(localRows.map(n=>[n.id,n]));
  const remote=new Map(remoteRows.map(n=>[n.id,n]));
  const base=new Map(baseRows.map(n=>[n.id,n]));
  const merged=[]; let conflicts=0;
  for (const id of new Set([...local.keys(), ...remote.keys()])) {
    const l=local.get(id),r=remote.get(id),b=base.get(id);
    if (!l || !r) { merged.push(l||r); continue; }
    if (equal(l,r)) {merged.push(l.updatedAt>=r.updatedAt?l:r);continue;}
    const lc=b?!equal(l,b):true, rc=b?!equal(r,b):true;
    if (lc&&!rc) {merged.push(l);continue;}
    if (!lc&&rc) {merged.push(r);continue;}
    // Удаление оставляем удалением, а параллельное редактирование сохраняем копией.
    const winner=l.deleted!==r.deleted?(l.deleted?l:r):((l.updatedAt||0)>=(r.updatedAt||0)?l:r);
    const loser=winner===l?r:l;
    merged.push(winner);
    if (!loser.deleted) { merged.push(conflictCopy(loser,now+(++conflicts),idMaker)); }
  }
  // В отсутствие локальной записи привозим удалённые tombstone-записи тоже,
  // чтобы другой компьютер не восстановил их при следующей синхронизации.
  return {notes:merged,conflicts};
}

async function deriveKey(passphrase,salt) {
  const material=await crypto.subtle.importKey('raw',encoder.encode(passphrase),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:KDF_ITERATIONS,hash:'SHA-256'},
    material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function encryptVault(notes,passphrase) {
  if (!crypto.subtle) throw new Error('Шифрование требует HTTPS (GitHub Pages).');
  if (passphrase.length<12) throw new Error('Для защиты заметок придумай пароль хотя бы из 12 символов.');
  const plain=encoder.encode(JSON.stringify({app:'mori',version:1,notes}));
  if (plain.length>MAX_PLAINTEXT) throw new Error('Для Gist слишком много данных (больше 12 МБ). Скачай резервную копию и сократи архив.');
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await deriveKey(passphrase,salt);
  const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plain));
  const b64=encode64(ciphertext);
  const chunks=[];
  for(let i=0;i<b64.length;i+=PART_SIZE) chunks.push(b64.slice(i,i+PART_SIZE));
  if(chunks.length>MAX_PARTS) throw new Error('Слишком большой архив для синхронизации Gist.');
  const manifest={format:FORMAT,version:1,algorithm:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations:KDF_ITERATIONS,
    salt:encode64(salt),iv:encode64(iv),parts:chunks.length,updatedAt:new Date().toISOString()};
  const files={[VAULT_FILE]:{content:JSON.stringify(manifest)}};
  chunks.forEach((content,i)=>files[`${PART_PREFIX}${String(i).padStart(3,'0')}.txt`]={content});
  return {files,parts:chunks.length,plainBytes:plain.length};
}
export async function decryptVault(gist,passphrase) {
  let manifest;
  try {manifest=JSON.parse(gist.files?.[VAULT_FILE]?.content||'');}
  catch {throw new Error('Это не архив mori. или файл облака повреждён.');}
  if(manifest.format!==FORMAT||manifest.parts<1||manifest.parts>MAX_PARTS||!Number.isInteger(manifest.parts)||
      manifest.iterations!==KDF_ITERATIONS) throw new Error('Неизвестный формат облачного архива mori.');
  let blob='';
  for(let i=0;i<manifest.parts;i++){
    const file=gist.files?.[`${PART_PREFIX}${String(i).padStart(3,'0')}.txt`];
    if (!file || file.truncated || typeof file.content!=='string') throw new Error('Gist вернул неполный архив. Повтори позже.');
    blob+=file.content;
  }
  if (blob.length>MAX_PARTS*PART_SIZE) throw new Error('Облачный архив слишком большой.');
  try {
    const key=await deriveKey(passphrase,decode64(manifest.salt));
    const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(manifest.iv)},key,decode64(blob));
    const data=JSON.parse(decoder.decode(plaintext));
    if(data.app!=='mori'||data.version!==1||!Array.isArray(data.notes)||data.notes.length>10000)
      throw new Error('Некорректная структура архива.');
    return data.notes;
  }catch(e){
    if(e.name==='OperationError') throw new Error('Неверный пароль шифрования либо повреждённый архив.');
    throw e;
  }
}
export class GistSync {
  constructor(token) {this.token=token.trim();this.gistId=null;}
  async request(path, method='GET', data) {
    const headers={Authorization:`Bearer ${this.token}`,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28'};
    if(data!==undefined)headers['Content-Type']='application/json';
    let response;
    try{response=await fetch(`${API}${path}`,{method,headers,body:data===undefined?undefined:JSON.stringify(data),cache:'no-store'});}
    catch {throw new Error('Нет соединения с GitHub. Проверь интернет.');}
    if(!response.ok){
      if(response.status===401)throw new Error('GitHub отклонил токен. Проверь его и создай новый при необходимости.');
      if(response.status===403)throw new Error('Доступ запрещён или достигнут лимит GitHub. Токен должен иметь только разрешение gist.');
      if(response.status===404)throw new Error('Gist не найден. Возможно, он удалён или токен принадлежит другому аккаунту.');
      if(response.status===413)throw new Error('Архив слишком большой для GitHub Gist.');
      let message='';try{message=(await response.json()).message||'';}catch{}
      throw new Error(`GitHub вернул ошибку ${response.status}${message?': '+message:''}`);
    }
    return response.status===204?null:response.json();
  }
  async findExisting(){
    // Личный список включает Secret Gist, даже если он не отображается в публичном поиске.
    // У старых Gist других пользователей одноимённые файлы не трогаем.
    const found=[];
    for(let page=1;page<=5;page++){
      const batch=await this.request(`/gists?per_page=100&page=${page}`);
      for(const gist of batch){if(gist.files?.[VAULT_FILE]) found.push(gist);}
      if(batch.length<100)break;
    }
    if(found.length>1) throw new Error('Найдено несколько архивов mori. Удали лишние Gist или укажи нужный ID в настройках.');
    return found[0]?.id||null;
  }
  async getGist(id){return this.request(`/gists/${encodeURIComponent(id)}`);}
  async create(files){
    const gist=await this.request('/gists','POST',{description:'mori. encrypted notes vault — do not edit manually',public:false,files});
    this.gistId=gist.id;
    return gist;
  }
  async update(id,files,oldCount){
    // Удаляем лишние чанки, если новая зашифрованная копия стала короче.
    const newCount=Object.keys(files).filter(x=>x.startsWith(PART_PREFIX)).length;
    for(let i=newCount;i<oldCount;i++) files[`${PART_PREFIX}${String(i).padStart(3,'0')}.txt`]=null;
    return this.request(`/gists/${encodeURIComponent(id)}`,'PATCH',{files});
  }
}
