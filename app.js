import {loadNotes,saveNote,removeNote,getSetting,setSetting} from './db.js';
import {escapeHTML,renderInline,renderMarkdown,safeUrl} from './markdown.js';
import {GistSync,VAULT_FILE,encryptVault,decryptVault,mergeNotes} from './sync.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const COLORS = ['graphite','moss','lavender','sand','rose','ocean'];
const ICON = {
  note:'<svg viewBox="0 0 24 24"><path d="M7 4h10a2 2 0 0 1 2 2v14H5V6a2 2 0 0 1 2-2Z"/><path d="M9 9h6M9 13h6M9 17h4"/></svg>',
  bookmark:'<svg viewBox="0 0 24 24"><path d="M6 4h12v17l-6-4-6 4z"/></svg>',
  pin:'<svg viewBox="0 0 24 24"><path d="m16 3 5 5-3 1-4 4-1 5-2 2-2-7-5-2 2-2 5-1 4-4zM4 20l6-6"/></svg>',
  dots:'<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>',
  arrow:'<svg viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>',
  link:'<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.1 0l2.1-2.1a5 5 0 0 0-7.1-7.1l-1.2 1.2M14 11a5 5 0 0 0-7.1 0l-2.1 2.1a5 5 0 0 0 7.1 7.1l1.2-1.2"/></svg>'
};
const MAX_BODY_LENGTH = 240000; // Разумный предел на одну локальную заметку.
let notes = new Map();
const account = 'local';
let filter = 'all';
let query = '';
let editorId = null;
let editorDirty = false;
let saveTimer = 0;
let toastTimer = 0;
let gistToken = '';
let gistId = null;
let gistPassphrase = '';
let gistBusy = false;
let lastSynced = 0;
let activeMode = 'edit';
let syncMode = 'local';
let drag = null;
let writeChain = Promise.resolve();


function announce(message) {
  const t=$('#toast');t.textContent=message;t.classList.add('show');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),3100);
}
function setSyncMode(mode){
  syncMode=mode;
  let label='Синхронизировать',dot='offline';
  if(mode==='syncing'){label='Синхронизация…';dot='loading';}
  else if(!navigator.onLine){label='Офлайн';}
  else if(mode==='synced'&&gistId){label='Синхронизировано';dot='online';}
  else if(mode==='error'){label='Ошибка синхронизации';dot='error';}
  else if(gistToken){label='Синхронизировать';dot='online';}
  $('#syncText').textContent=label;
  $('#syncDot').className=`status-dot ${dot}`;
  $('#syncButton').disabled=mode==='syncing';
}

function formatDate(timestamp){
  const d=new Date(timestamp||Date.now());
  return new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short'}).format(d);
}
function allLive(){return [...notes.values()].filter(n=>!n.deleted);}
function sorted(arr){return [...arr].sort((a,b)=>(Number(b.order)||0)-(Number(a.order)||0)||b.updatedAt-a.updatedAt);}
function makeNote(type='note',title=''){
  const ts=Date.now();
  return {id:crypto.randomUUID?.()||`mori-${ts}-${Math.random().toString(36).slice(2)}`,
    type:type==='bookmark'?'bookmark':'note',title,content:'',url:'',image:'',color:'graphite',
    pinned:false,order:ts,createdAt:ts,updatedAt:ts,deleted:false};
}
function normalizedNote(input){
  const base=makeNote(input.type);
  const id=String(input.id||base.id).replace(/[^\w-]/g,'').slice(0,110)||base.id;
  const now=Date.now();
  return {
    ...base,id,
    title:String(input.title||'').slice(0,180),
    content:String(input.content||'').slice(0,MAX_BODY_LENGTH),
    url:String(input.url||'').slice(0,2000),image:String(input.image||'').slice(0,2000),
    color:COLORS.includes(input.color)?input.color:'graphite',
    pinned:Boolean(input.pinned),order:Number.isFinite(Number(input.order))?Number(input.order):now,
    createdAt:Number.isFinite(Number(input.createdAt))?Number(input.createdAt):now,
    updatedAt:Number.isFinite(Number(input.updatedAt))?Number(input.updatedAt):now,
    deleted:Boolean(input.deleted)
  };
}
function enqueueSave(note){
  const snapshot={...note};
  writeChain=writeChain.catch(()=>{}).then(()=>saveNote('local',snapshot));
  writeChain.catch(error=>{console.error(error);announce('Не удалось сохранить локально. Проверь свободную память.');});
  return writeChain;
}

function cardHTML(note){
  const isBookmark=note.type==='bookmark';
  const safeLink=safeUrl(note.url);
  let host='';
  if(safeLink){try{host=new URL(safeLink).hostname.replace(/^www\./,'');}catch{}}
  const image=safeUrl(note.image);
  const favicon=host?`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`:'';
  let cover='';
  if(isBookmark){
    cover=`<div class="bookmark-cover">${image?`<img src="${escapeHTML(image)}" loading="lazy" alt="Обложка">`:favicon?`<img class="favicon-cover" src="${escapeHTML(favicon)}" loading="lazy" alt="Иконка сайта">`:'<span class="bookmark-cover-fallback">↗</span>'}</div>`;
  }
  const excerpt=(note.content||'').slice(0,isBookmark?115:330);
  const title=note.title.trim()||(isBookmark?(host||'Без названия'):'Без названия');
  return `<article class="note-card tone-${note.color}" data-id="${escapeHTML(note.id)}" data-group="${note.pinned?'pinned':'normal'}" tabindex="0" role="button" aria-label="Открыть ${escapeHTML(title)}">
      ${cover}
      <div class="card-top"><span class="card-kind">${isBookmark?ICON.bookmark:ICON.note}${isBookmark?'ЗАКЛАДКА':'ЗАМЕТКА'}</span><span class="card-side">${note.pinned?`<span class="mini-pin" title="Закреплено">${ICON.pin}</span>`:''}<button type="button" class="drag-handle" title="Перетащить карточку" aria-label="Перетащить карточку">${ICON.dots}</button></span></div>
      <h3 class="card-title">${escapeHTML(title)}</h3>
      ${host?`<div class="bookmark-host">${ICON.link}${escapeHTML(host)}</div>`:''}
      <div class="card-text">${excerpt?renderInline(excerpt):'<span style="color:#6d7975">Пустая заметка</span>'}</div>
      <div class="card-date"><span>${formatDate(note.updatedAt)}</span><span class="card-arrow">${ICON.arrow}</span></div>
    </article>`;
}
function groupHTML(label,items,isPinned){
  if(!items.length)return '';
  return `<section class="cards-section"><div class="group-heading">${isPinned?ICON.pin:''}<span>${label.toUpperCase()}</span><span class="group-rule"></span></div><div class="cards-grid" data-group="${isPinned?'pinned':'normal'}">${items.map(cardHTML).join('')}</div></section>`;
}
function render(){
  const live=allLive();$('#noteCount').textContent=live.length;$('#allCount').textContent=live.length;
  let items=live;
  if(filter==='pinned')items=items.filter(n=>n.pinned);
  if(filter==='bookmark')items=items.filter(n=>n.type==='bookmark');
  if(query){const q=query.toLocaleLowerCase('ru');items=items.filter(n=>[n.title,n.content,n.url].some(s=>String(s||'').toLocaleLowerCase('ru').includes(q)));}
  const pinned=sorted(items.filter(n=>n.pinned));
  const others=sorted(items.filter(n=>!n.pinned));
  const area=$('#collectionArea');
  if(!items.length){
    area.innerHTML=`<div class="empty-state"><div class="empty-icon">${query?ICON.link:ICON.note}</div><h3>${query?'Ничего не нашлось':filter==='pinned'?'Пока нет закреплённых':filter==='bookmark'?'Пока нет закладок':'Начни с первой мысли'}</h3><p>${query?'Попробуй изменить запрос.':filter==='pinned'?'Закрепи важную карточку в редакторе.':filter==='bookmark'?'Сохраняй интересные сайты в виде карточек.':'Заметки и ссылки будут жить здесь. Всё сохраняется автоматически.'}</p>${query?'':`<button type="button" class="button-primary empty-create">${filter==='bookmark'?'Добавить закладку':'Создать заметку'}</button>`}</div>`;
    area.querySelector('.empty-create')?.addEventListener('click',()=>createNote(filter==='bookmark'?'bookmark':'note'));
    return;
  }
  if(filter==='pinned')area.innerHTML=groupHTML('Закреплённые',pinned,true);
  else area.innerHTML=groupHTML('Закреплённые',pinned,true)+groupHTML(filter==='bookmark'?'Остальные закладки':'Все заметки',others,false);
  bindCardEvents();
}
function bindCardEvents(){
  $$('.note-card').forEach(card=>{
    card.addEventListener('click',e=>{
      if(e.target.closest('a,.drag-handle'))return;
      openEditor(card.dataset.id);
    });
    card.addEventListener('keydown',e=>{
      if((e.key==='Enter'||e.key===' ')&&e.target===card){e.preventDefault();openEditor(card.dataset.id);}
    });
    card.querySelector('.drag-handle').addEventListener('pointerdown',beginDrag);
  });
}
function beginDrag(e){
  if(e.button!==0||query||filter!=='all'){
    if(query||filter!=='all')announce('Перетаскивание доступно на вкладке «Все» без поиска');
    return;
  }
  e.preventDefault();e.stopPropagation();
  const card=e.currentTarget.closest('.note-card');
  drag={id:card.dataset.id,group:card.dataset.group,source:card,target:null,
    x:e.clientX,y:e.clientY,moved:false,ghost:null};
  document.addEventListener('pointermove',moveDrag,{passive:false});
  document.addEventListener('pointerup',endDrag,{once:true});
  document.addEventListener('pointercancel',endDrag,{once:true});
}
function moveDrag(e){
  if(!drag)return;
  if(!drag.moved&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<6)return;
  e.preventDefault();
  if(!drag.moved){
    drag.moved=true;drag.source.classList.add('drag-source');
    const ghost=drag.source.cloneNode(true);
    ghost.classList.add('drag-ghost');ghost.style.height=`${drag.source.offsetHeight}px`;
    document.body.append(ghost);drag.ghost=ghost;
  }
  drag.ghost.style.left=`${e.clientX+13}px`;drag.ghost.style.top=`${e.clientY+10}px`;
  $$('.drop-target').forEach(node=>node.classList.remove('drop-target'));
  const el=document.elementFromPoint(e.clientX,e.clientY);
  const target=el?.closest('.note-card');
  drag.target=target&&target.dataset.group===drag.group&&target!==drag.source?target:null;
  drag.target?.classList.add('drop-target');
}
function endDrag(){
  document.removeEventListener('pointermove',moveDrag);
  document.removeEventListener('pointerup',endDrag);
  document.removeEventListener('pointercancel',endDrag);
  if(!drag)return;
  const current=drag;drag=null;
  current.ghost?.remove();current.source.classList.remove('drag-source');
  $$('.drop-target').forEach(node=>node.classList.remove('drop-target'));
  if(!current.moved||!current.target)return;
  const group=sorted(allLive().filter(n=>current.group==='pinned'?n.pinned:!n.pinned));
  const from=group.findIndex(n=>n.id===current.id),to=group.findIndex(n=>n.id===current.target.dataset.id);
  if(from<0||to<0||from===to)return;
  const [item]=group.splice(from,1);group.splice(to,0,item);
  const at=group.findIndex(n=>n.id===item.id);
  const upper=at>0?group[at-1].order:null,lower=at+1<group.length?group[at+1].order:null;
  if(upper!==null&&lower!==null)item.order=(upper+lower)/2;
  else if(upper===null&&lower!==null)item.order=lower+10000;
  else if(lower===null&&upper!==null)item.order=upper-10000;
  else item.order=Date.now();
  // Если дробные позиции стали слишком близки, нормализуем только эту группу.
  if(upper!==null&&lower!==null&&Math.abs(upper-lower)<.001){
    const baseline=Date.now()+group.length*100;
    group.forEach((n,i)=>{n.order=baseline-i*100;n.updatedAt=Date.now();enqueueSave(n);});
  } else {item.updatedAt=Date.now();enqueueSave(item);}
  render();
}

async function createNote(type){
  const note=makeNote(type);
  notes.set(note.id,note);
  try{await enqueueSave(note);}catch(error){console.warn(error);}
  render();openEditor(note.id);
}
function updateColorButtons(){
  $('#colorPopover').innerHTML=COLORS.map(c=>`<button type="button" class="color-swatch ${notes.get(editorId)?.color===c?'selected':''}" data-color="${c}" title="${c}" aria-label="Выбрать цвет ${c}"></button>`).join('');
  $$('#colorPopover .color-swatch').forEach(el=>el.addEventListener('click',()=>{
    const note=notes.get(editorId);if(!note)return;
    note.color=el.dataset.color;note.updatedAt=Date.now();enqueueSave(note);updateColorButtons();
    $('#colorPopover').classList.add('hidden');
  }));
}
function fillPreviewImage(){
  const image=safeUrl($('#bookmarkImageInput').value);
  $('#bookmarkImagePreview').classList.toggle('hidden',!image);
  $('#bookmarkImagePreview').innerHTML=image?`<img alt="Обложка закладки" src="${escapeHTML(image)}">`:'';
  const link=safeUrl($('#bookmarkUrlInput').value);
  $('#openBookmarkButton').href=link||'#';
  $('#openBookmarkButton').style.pointerEvents=link?'auto':'none';
  $('#openBookmarkButton').style.opacity=link?'1':'.35';
}
function openEditor(id){
  const note=notes.get(id);if(!note||note.deleted)return;
  editorId=id;editorDirty=false;activeMode='edit';
  $('#editorTypeLabel').textContent=note.type==='bookmark'?'Закладка':'Заметка';
  $('#noteTitleInput').value=note.title;
  $('#noteBodyInput').value=note.content;
  $('#bookmarkUrlInput').value=note.url;
  $('#bookmarkImageInput').value=note.image;
  $('#bookmarkControls').classList.toggle('hidden',note.type!=='bookmark');
  $('#saveIndicator').textContent='Сохранено';
  $('#editDate').textContent=formatDate(note.updatedAt);
  $('#editorPinButton').classList.toggle('active',note.pinned);
  $('#editorPinButton').title=note.pinned?'Открепить':'Закрепить';
  $('#colorPopover').classList.add('hidden');
  updateColorButtons();fillPreviewImage();updateCharCount();setMode('edit');
  showDialog($('#editorDialog'));
  if(window.innerWidth>680)setTimeout(()=>$('#noteTitleInput').focus(),180);
}
function showDialog(dialog){
  if(dialog.open)return;
  dialog.showModal();
  requestAnimationFrame(()=>requestAnimationFrame(()=>dialog.classList.add('is-visible')));
}
function hideDialog(dialog){
  if(!dialog.open)return;
  dialog.classList.add('is-closing');dialog.classList.remove('is-visible');
  setTimeout(()=>{if(dialog.open)dialog.close();dialog.classList.remove('is-closing');},190);
}
function updateCharCount(){
  const length=$('#noteBodyInput').value.length;
  $('#characterCount').textContent=`${length.toLocaleString('ru-RU')} символов`;
  $('#characterCount').style.color=length>MAX_BODY_LENGTH?'#f3aaa1':'';
}
function updateDraft(){
  if(!editorId)return;
  const note=notes.get(editorId);if(!note)return;
  const content=$('#noteBodyInput').value;
  if(content.length>MAX_BODY_LENGTH){
    announce(`Максимум ${MAX_BODY_LENGTH.toLocaleString('ru-RU')} символов на заметку`);
    $('#noteBodyInput').value=content.slice(0,MAX_BODY_LENGTH);
  }
  note.title=$('#noteTitleInput').value.slice(0,180);
  note.content=$('#noteBodyInput').value;
  note.url=$('#bookmarkUrlInput').value.slice(0,2000);
  note.image=$('#bookmarkImageInput').value.slice(0,2000);
  note.updatedAt=Date.now();
  editorDirty=true;$('#saveIndicator').textContent='Сохраняем…';
  updateCharCount();
  clearTimeout(saveTimer);saveTimer=setTimeout(()=>void saveDraft(),420);
}
async function saveDraft(){
  clearTimeout(saveTimer);
  if(!editorId||!editorDirty)return;
  const note=notes.get(editorId);if(!note)return;
  editorDirty=false;
  await enqueueSave(note);
  $('#saveIndicator').textContent='Сохранено';
  $('#editDate').textContent=formatDate(note.updatedAt);
}
async function closeEditor(){
  await saveDraft();
  editorId=null;
  hideDialog($('#editorDialog'));render();
}
function setMode(mode){
  activeMode=mode;
  $('#editModeButton').classList.toggle('active',mode==='edit');
  $('#previewModeButton').classList.toggle('active',mode==='preview');
  $('#noteBodyInput').classList.toggle('hidden',mode!=='edit');
  $('#markdownPreview').classList.toggle('hidden',mode!=='preview');
  if(mode==='preview')$('#markdownPreview').innerHTML=renderMarkdown($('#noteBodyInput').value);
}
async function deleteCurrent(){
  const n=notes.get(editorId);if(!n)return;
  if(!confirm(`Удалить «${n.title||'Без названия'}»? Заметка исчезнет со всех синхронизированных устройств.`))return;
  clearTimeout(saveTimer);editorDirty=false;
  n.deleted=true;n.updatedAt=Date.now();enqueueSave(n);
  editorId=null;hideDialog($('#editorDialog'));render();announce('Заметка удалена');
}
async function fetchCover(){
  const url=safeUrl($('#bookmarkUrlInput').value);
  if(!url){announce('Сначала вставь ссылку на сайт');return;}
  const button=$('#autoPreviewButton');button.disabled=true;button.firstChild.textContent='Ищем… ';
  try{
    // Сторонний сервис получает только URL сайта, не текст твоих заметок.
    const resp=await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}`,{signal:AbortSignal.timeout(11000)});
    const json=await resp.json();
    if(!resp.ok||json.status!=='success')throw new Error('Нет метаданных');
    const meta=json.data||{};
    if((!$('#noteTitleInput').value.trim()||$('#noteTitleInput').value==='Новая закладка')&&meta.title)$('#noteTitleInput').value=String(meta.title).slice(0,180);
    const picture=safeUrl(meta.image?.url||meta.logo?.url||'');
    if(picture)$('#bookmarkImageInput').value=picture;
    updateDraft();fillPreviewImage();
    announce(picture?'Обложка добавлена':'Название получено, картинка не найдена');
  }catch(error){console.warn(error);announce('Не удалось получить картинку. Можно вставить URL вручную.');}
  finally{button.disabled=false;button.firstChild.textContent='Найти обложку ';}
}
function downloadBlob(blob,name){
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function safeFilename(s){return (s||'заметка').replace(/[\\/:*?"<>|]/g,'-').slice(0,95);}
function exportCurrent(){
  if(!editorId)return;
  const note=notes.get(editorId);
  const content=note.type==='bookmark'?`# ${note.title||'Закладка'}\n\n[Открыть сайт](${safeUrl(note.url)||'#'})\n\n${note.content}`:`# ${note.title||'Без названия'}\n\n${note.content}`;
  downloadBlob(new Blob([content],{type:'text/markdown;charset=utf-8'}),`${safeFilename(note.title)}.md`);
  announce('Markdown скачан');
}
function exportBackup(){
  const data={app:'mori',version:1,exportedAt:new Date().toISOString(),notes:allLive()};
  const text=JSON.stringify(data,null,2);
  downloadBlob(new Blob([text],{type:'application/json;charset=utf-8'}),`mori-backup-${new Date().toISOString().slice(0,10)}.json`);
  hideDialog($('#menuDialog'));announce('Резервная копия скачана');
}
async function importMarkdown(files){
  let count=0;
  for(const file of files){
    if(file.size>850000){announce(`Файл ${file.name} слишком большой`);continue;}
    const txt=await file.text();
    if(txt.length>MAX_BODY_LENGTH){announce(`Файл ${file.name} длиннее лимита`);continue;}
    const note=makeNote('note',file.name.replace(/\.(md|markdown|txt)$/i,''));
    note.content=txt;
    notes.set(note.id,note);await enqueueSave(note);count++;
  }
  render();hideDialog($('#menuDialog'));announce(`Импортировано заметок: ${count}`);
}
async function importBackup(file){
  if(file.size>25000000){announce('Слишком большой файл резервной копии');return;}
  try{
    const input=JSON.parse(await file.text());
    if(input.app!=='mori'||!Array.isArray(input.notes)||input.notes.length>10000)throw new Error('Неверный формат');
    let count=0;
    for(const raw of input.notes){
      if(!raw||typeof raw!=='object')continue;
      const n=normalizedNote(raw);n.deleted=false;n.updatedAt=Date.now()+count;
      notes.set(n.id,n);await enqueueSave(n);count++;
    }
    render();hideDialog($('#menuDialog'));announce(`Восстановлено заметок: ${count}`);
  }catch(error){console.warn(error);announce('Не удалось прочитать копию. Нужен JSON из mori.');}
}

// Настройка Gist хранится в IndexedDB на каждом устройстве отдельно.
// Пароль шифрования НЕ сохраняем на диск: только в памяти открытой вкладки.
function openSyncDialog(){
  $('#gistToken').value=gistToken;
  $('#gistPassphrase').value=gistPassphrase;
  $('#gistError').classList.add('hidden');
  updateSyncInfo();
  showDialog($('#accountDialog'));
}
function updateSyncInfo(){
  $('#gistInfo').textContent=lastSynced
    ?`Последняя синхронизация ${new Date(lastSynced).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`
    :(gistId?'Облако настроено':'Ещё не подключено');
  $('#gistDisconnect').disabled=!gistToken;
}
function syncError(error){
  let message=String(error?.message||error||'Неизвестная ошибка');
  if(message.includes('Failed to fetch'))message='Нет связи с GitHub. Проверь интернет.';
  $('#gistError').textContent=message;
  $('#gistError').classList.remove('hidden');
  setSyncMode('error');
  announce(message);
}
async function runGistSync(token,passphrase){
  if(gistBusy)return;
  gistBusy=true;
  setSyncMode('syncing');
  $('#gistSyncNow').disabled=true;
  $('#gistError').classList.add('hidden');
  try{
    if(!navigator.onLine)throw new Error('Ты офлайн. Заметки сохраняются локально; для синхронизации нужен интернет.');
    if(!token || token.length<20)throw new Error('Вставь GitHub-токен (classic) с разрешением gist.');
    if(passphrase.length<12)throw new Error('Пароль шифрования должен быть не короче 12 символов.');
    if(editorId)await closeEditor();
    await writeChain;
    const client=new GistSync(token);
    // При смене токена другой аккаунт может хранить совершенно другой Gist.
    const previousToken=gistToken;
    let targetId=token===previousToken?gistId:null;
    if(!targetId)targetId=await client.findExisting();
    let remote=[];
    let oldPartCount=0;
    if(targetId){
      const cloudGist=await client.getGist(targetId);
      remote=await decryptVault(cloudGist,passphrase);
      oldPartCount=JSON.parse(cloudGist.files[VAULT_FILE].content).parts;
    }
    // При неправильном пароле НЕ создаём другой Gist и НЕ затираем существующий.
    const normalizedRemote=remote.map(normalizedNote);
    const base=targetId?(await getSetting(`gist-base:${targetId}`)||[]):[];
    const result=mergeNotes([...notes.values()],normalizedRemote,base.map(normalizedNote));
    const encrypted=await encryptVault(result.notes,passphrase);
    if(targetId)await client.update(targetId,encrypted.files,oldPartCount);
    else targetId=(await client.create(encrypted.files)).id;
    // Локальный набор обновляем ТОЛЬКО ПОСЛЕ подтверждённого ответа GitHub.
    const next=new Map();
    for(const raw of result.notes){
      const n=normalizedNote(raw);
      next.set(n.id,n);
      await saveNote('local',n);
    }
    notes=next;
    gistToken=token;
    gistId=targetId;
    gistPassphrase=passphrase;
    lastSynced=Date.now();
    await setSetting('gist-token',token);
    await setSetting('gist-id',targetId);
    await setSetting('gist-last-sync',lastSynced);
    await setSetting(`gist-base:${targetId}`,[...next.values()]);
    render();updateSyncInfo();setSyncMode('synced');hideDialog($('#accountDialog'));
    announce(result.conflicts
      ?`Синхронизировано! Спорные изменения сохранены в ${result.conflicts} отдельных карточках.`
      :'Синхронизировано — заметки объединены');
  }catch(e){console.warn('[mori gist sync]',e);syncError(e);}
  finally{gistBusy=false;$('#gistSyncNow').disabled=false;if(syncMode==='syncing')setSyncMode('ready');}
}
async function submitGistSync(){
  await runGistSync($('#gistToken').value.trim(),$('#gistPassphrase').value);
}
async function disconnectGist(){
  if(!confirm('Забыть GitHub-токен на этом устройстве? Локальные заметки и Gist сохранятся.'))return;
  gistToken='';gistId=null;gistPassphrase='';lastSynced=0;
  await setSetting('gist-token',null);
  await setSetting('gist-id',null);
  await setSetting('gist-last-sync',null);
  $('#gistToken').value='';$('#gistPassphrase').value='';
  updateSyncInfo();setSyncMode('local');announce('Токен забыт. Заметки остались на устройстве.');
}
function togglePassword(id,button){
  const field=$(id);
  field.type=field.type==='password'?'text':'password';
  button.textContent=field.type==='password'?'Показать':'Скрыть';
}
function bindUI(){
  $('#addNoteButton').addEventListener('click',()=>void createNote('note'));
  $('#addBookmarkButton').addEventListener('click',()=>void createNote('bookmark'));
  $('#mobileNew').addEventListener('click',()=>void createNote('note'));
  $('#mobileBookmark').addEventListener('click',()=>void createNote('bookmark'));
  $('#searchInput').addEventListener('input',e=>{query=e.target.value.trim();render();});
  $$('.filter-tab').forEach(button=>button.addEventListener('click',()=>{
    filter=button.dataset.filter;$$('.filter-tab').forEach(x=>x.classList.toggle('active',x===button));render();
  }));
  $('#syncButton').addEventListener('click',()=>{if(gistToken&&gistPassphrase)void runGistSync(gistToken,gistPassphrase);else openSyncDialog();});
  $('#menuButton').addEventListener('click',()=>showDialog($('#menuDialog')));
  $('#closeAccount').addEventListener('click',()=>hideDialog($('#accountDialog')));
  $('#closeMenu').addEventListener('click',()=>hideDialog($('#menuDialog')));
  $('#gistSyncNow').addEventListener('click',()=>void submitGistSync());
  $('#gistDisconnect').addEventListener('click',()=>void disconnectGist());
  $('#gistPassphrase').addEventListener('keydown',e=>{if(e.key==='Enter')void submitGistSync();});
  $('#revealToken').addEventListener('click',e=>togglePassword('#gistToken',e.currentTarget));
  $('#revealPassphrase').addEventListener('click',e=>togglePassword('#gistPassphrase',e.currentTarget));
  $('#closeEditorButton').addEventListener('click',()=>void closeEditor());
  ['noteTitleInput','noteBodyInput','bookmarkUrlInput','bookmarkImageInput'].forEach(id=>{
    $(`#${id}`).addEventListener('input',()=>{updateDraft();if(id.startsWith('bookmark'))fillPreviewImage();});
  });
  $('#noteBodyInput').addEventListener('keydown',e=>{
    if(e.key==='Tab'){
      e.preventDefault();const input=e.target,start=input.selectionStart,end=input.selectionEnd;
      input.setRangeText('  ',start,end,'end');updateDraft();
    }
  });
  $('#editorPinButton').addEventListener('click',()=>{
    const n=notes.get(editorId);if(!n)return;
    n.pinned=!n.pinned;n.order=Date.now();n.updatedAt=Date.now();enqueueSave(n);
    $('#editorPinButton').classList.toggle('active',n.pinned);
    $('#editorPinButton').title=n.pinned?'Открепить':'Закрепить';
    announce(n.pinned?'Закреплено':'Откреплено');
  });
  $('#colorButton').addEventListener('click',()=>$('#colorPopover').classList.toggle('hidden'));
  document.addEventListener('pointerdown',e=>{if(!e.target.closest('.color-menu-wrap'))$('#colorPopover').classList.add('hidden');});
  $('#editModeButton').addEventListener('click',()=>setMode('edit'));
  $('#previewModeButton').addEventListener('click',()=>setMode('preview'));
  $('#autoPreviewButton').addEventListener('click',()=>void fetchCover());
  $('#deleteNoteButton').addEventListener('click',()=>void deleteCurrent());
  $('#exportNoteButton').addEventListener('click',exportCurrent);
  $('#importMarkdownButton').addEventListener('click',()=>$('#markdownFileInput').click());
  $('#exportBackupButton').addEventListener('click',exportBackup);
  $('#importBackupButton').addEventListener('click',()=>$('#backupFileInput').click());
  $('#markdownFileInput').addEventListener('change',e=>{const fs=[...e.target.files];e.target.value='';void importMarkdown(fs);});
  $('#backupFileInput').addEventListener('change',e=>{const f=e.target.files?.[0];e.target.value='';if(f)void importBackup(f);});
  [$('#editorDialog'),$('#accountDialog'),$('#menuDialog')].forEach(d=>{
    d.addEventListener('cancel',e=>{e.preventDefault();d===$('#editorDialog')?void closeEditor():hideDialog(d);});
    d.addEventListener('click',e=>{if(e.target!==d)return;d===$('#editorDialog')?void closeEditor():hideDialog(d);});
  });
  document.addEventListener('keydown',e=>{
    const cmd=e.ctrlKey||e.metaKey;
    if(cmd&&e.key.toLowerCase()==='k'){e.preventDefault();if($('#editorDialog').open)return;$('#searchInput').focus();}
    if(cmd&&e.key.toLowerCase()==='s'){e.preventDefault();void saveDraft();announce('Сохранено');}
    if(cmd&&e.altKey&&e.key.toLowerCase()==='n'){e.preventDefault();void createNote('note');}
  });
  window.addEventListener('online',()=>setSyncMode('ready'));
  window.addEventListener('offline',()=>setSyncMode('offline'));
  window.addEventListener('pagehide',()=>{if(editorDirty)void saveDraft();});
}
async function initialize(){
  bindUI();
  try{
    // Сохраняем все старые заметки при переходе с версии Firebase.
    // До миграции local и user:<uid> были разными разделами IndexedDB.
    const oldAccount=await getSetting('lastAccount')||'local';
    const localRows=await loadNotes('local');
    notes=new Map(localRows.map(n=>[n.id,normalizedNote(n)]));
    if(oldAccount!=='local'&&oldAccount.startsWith('user:')){
      const oldRows=await loadNotes(oldAccount);
      for(const raw of oldRows){
        const n=normalizedNote(raw);
        if(!notes.has(n.id)||n.updatedAt>(notes.get(n.id).updatedAt||0)){
          notes.set(n.id,n);
          await saveNote('local',n);
        }
      }
      await setSetting('lastAccount','local');
    }
    gistToken=await getSetting('gist-token')||'';
    gistId=await getSetting('gist-id')||null;
    lastSynced=await getSetting('gist-last-sync')||0;
  }catch(error){console.error(error);announce('Локальное хранилище недоступно: заметки могут не сохраниться');}
  render();updateSyncInfo();setSyncMode('local');
  if('serviceWorker' in navigator&&location.protocol!=='file:'){
    navigator.serviceWorker.register('./sw.js').catch(e=>console.warn('PWA cache:',e));
  }
  if(!/Mac|iPhone|iPad/.test(navigator.platform))$('.search-hotkey').textContent='Ctrl K';
}
void initialize();
