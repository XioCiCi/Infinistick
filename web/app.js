import {sortedRecords, timeline, summaryPosition, fitBounds, zoomAt, localInput, isoFromInput, afterBlankClick} from './core.js';

const $ = selector => document.querySelector(selector);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors = ['yellow','blue','pink','green','lavender','white'];
const colorNames = {yellow:'奶油黄',blue:'天空蓝',pink:'樱花粉',green:'鼠尾草绿',lavender:'浅紫',white:'纸白'};
const mobile = () => matchMedia('(max-width:760px)').matches;
const state = {topics:[], records:[], topicId:null, csrf:'', trash:false, view:{x:0,y:0,scale:1}};
const expanded = new Set(), editing = new Set(), elements = new Map(), points = new Map(), committedTimes = new Map();
const dirty = new Map(), saving = new Map(), failures = new Map(), timers = new Map(), uploads = new Map();
const invalidTimes = new Set();
let localSequence=0;
let zIndex = 5, toastTimer, dialogResolve, editorRange, busy = false, pointerGesture = null, gestureMoved = false;
let photoState = {urls:[],index:0,scale:1,x:0,y:0}, imagePointer = null;

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').hidden = true, 4500);
}

async function api(path, {method='GET', body, raw=false}={}) {
  const headers = {};
  if(method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
  if(body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  let response;
  try { response = await fetch(path, {method, headers, body:body === undefined ? undefined : raw ? body : JSON.stringify(body)}); }
  catch { throw new Error('连接中断，内容尚未保存，请检查网络后重试'); }
  if(!response.ok) {
    const data = await response.json().catch(() => ({}));
    if(response.status === 401) toast('登录已过期。请先复制未保存的内容，再重新登录。');
    throw new Error(data.error || '操作失败，请重试');
  }
  return response.json();
}

const getRecord = id => state.records.find(r => r.id === id);
const noteText = record => {
  const el = document.createElement('div'); el.innerHTML = record.body;
  el.querySelectorAll('pre').forEach(p => p.append(document.createTextNode(' ')));
  return (el.textContent || '').replace(/\s+/g,' ').trim();
};
const titleOf = r => r.title.trim() || noteText(r).slice(0,28) || '空白便签';
const formatTime = value => new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));

function updateStatus() {
  const countUploads = [...uploads.values()].filter(u => !u.done).length;
  const errors = [...failures.values()];
  let label='已保存', kind='saved';
  if(!navigator.onLine) {label='连接中断 · 点击重试';kind='offline';}
  else if(errors.length) {label='保存失败 · 点击重试';kind='error';}
  else if([...uploads.values()].some(u => u.error)) {label='图片上传失败 · 请重试';kind='error';}
  else if(saving.size || dirty.size || countUploads) {label=countUploads ? '图片上传中…' : '保存中…';kind='saving';}
  $('#save-text').textContent=label; $('#save-status').dataset.state=kind;
  for(const [id,el] of elements) {
    const footer=el.querySelector('.note-save');
    if(footer) footer.textContent=failures.has(id) ? '保存失败 · 请重试' : [...uploads.values()].some(u=>u.recordId===id&&!u.done) ? '图片尚未保存' : dirty.has(id) || saving.has(id) ? '保存中…' : '已保存';
  }
}

function markDirty(record, delay=550) {
  dirty.set(record.id,(dirty.get(record.id)||0)+1);
  failures.delete(record.id);
  clearTimeout(timers.get(record.id));
  timers.set(record.id,setTimeout(()=>saveRecord(record.id),delay));
  updateStatus();
}

async function saveRecord(id) {
  clearTimeout(timers.get(id));
  if(saving.has(id)) return saving.get(id);
  if(invalidTimes.has(id)) {failures.set(id,'请先填写有效的记录时间，当前修改尚未保存');updateStatus();return false;}
  if(!dirty.has(id)) return !failures.has(id);
  const job = (async()=>{
    while(dirty.has(id)) {
      if(invalidTimes.has(id)){failures.set(id,'请先填写有效的记录时间，当前修改尚未保存');updateStatus();return false;}
      const record=getRecord(id);
      if(!record) return false;
      const generation=dirty.get(id), snapshot=structuredClone(record);
      try {
        const saved=await api(`/api/records/${id}`,{method:'PATCH',body:snapshot});
        record.version=saved.version; record.updatedAt=saved.updatedAt;
        if(dirty.get(id)===generation) { record.body=saved.body; dirty.delete(id); }
        failures.delete(id);
      } catch(error) { failures.set(id,error.message); updateStatus(); return false; }
    }
    return true;
  })();
  saving.set(id,job); updateStatus();
  try { return await job; }
  finally {saving.delete(id);updateStatus();}
}

async function flushAll() {
  let ok=true;
  for(const id of [...new Set([...dirty.keys(),...saving.keys()])]) if(!await saveRecord(id)) ok=false;
  if([...uploads.values()].some(u=>!u.done)) ok=false;
  if(!ok) toast('还有内容或图片未保存，请重试后继续。');
  return ok;
}

function readEditor(id) {
  const record=getRecord(id), el=elements.get(id);
  if(!record || !el || !editing.has(id)) return true;
  record.title=el.querySelector('.note-title-input').value;
  record.tags=el.querySelector('.tags-input').value;
  const clone=el.querySelector('.editor').cloneNode(true);
  clone.querySelectorAll('.upload-placeholder,.copy-code').forEach(node=>node.remove());
  record.body=clone.innerHTML;
  const timeInput=el.querySelector('.record-time-input');
  try {record.time=isoFromInput(timeInput.value);timeInput.setCustomValidity('');invalidTimes.delete(id);}
  catch(error) {invalidTimes.add(id);timeInput.setCustomValidity(error.message);return false;}
  return true;
}

function drawTopics() {
  $('#topic-count').textContent=String(state.topics.length).padStart(2,'0');
  $('#topics').innerHTML=state.topics.map(t=>`<div class="topic-item ${t.id===state.topicId&&!state.trash?'active':''}"><button class="topic-select" data-topic="${t.id}"><span class="topic-dot" data-color="${t.color}"></span><span class="topic-name">${escape(t.name)}</span></button><button class="topic-edit" data-edit-topic="${t.id}" aria-label="修改主题 ${escape(t.name)}" title="修改主题">${icon('more')}</button></div>`).join('');
  $('#trash-count').textContent=state.records.filter(r=>r.deleted).length||'';
  $('#trash-button').classList.toggle('active',state.trash);
}

function closeSidebar() {$('#sidebar').classList.remove('open');$('#sidebar-shade').hidden=true;}

async function selectTopic(id) {
  if(!await endAllEditingAndCollapse() || !await flushAll()) return;
  state.topicId=id;state.trash=false; expanded.clear(); editing.clear();
  state.records.filter(r=>r.topicId===id&&r.pinned&&!r.deleted).forEach(r=>expanded.add(r.id));
  $('#viewport').hidden=false;$('#trash-view').hidden=true;
  $('#new-record').hidden=false;$('#fit-button').hidden=false;
  closeSidebar();drawTopics();drawCanvas();fitAll();
}

function updateTransform(animated=false) {
  const world=$('#world');
  world.classList.toggle('moving',animated);
  world.style.transform=`translate(${state.view.x}px,${state.view.y}px) scale(${state.view.scale})`;
  world.classList.toggle('compact',state.view.scale<.65);
  world.classList.toggle('overview',state.view.scale<.36);
  $('#zoom-level').textContent=Math.round(state.view.scale*100)+'%';
}

function noteRect(record, point=points.get(record.id)) {
  if(expanded.has(record.id)) return {x:point.x+record.layout.dx,y:point.y+record.layout.dy,width:record.layout.width,height:record.layout.height};
  return {...summaryPosition(point),width:260,height:175};
}

function fitAll() {
  const records=sortedRecords(state.records,state.topicId,committedTimes);
  const rects=records.flatMap(r=>{const p=points.get(r.id);return [noteRect(r,p),{x:p.x-10,y:p.y-10,width:20,height:20}];});
  const viewport=$('#viewport').getBoundingClientRect();
  state.view=fitBounds(rects,viewport.width,viewport.height-120,mobile()?35:70);
  state.view.y+=95;
  updateTransform(true);
}

function showNoteInView(id, forceReadable=false) {
  const record=getRecord(id), point=points.get(id);
  if(!record||!point) return;
  const rect=noteRect(record), vp=$('#viewport').getBoundingClientRect();
  if(forceReadable || state.view.scale<.65) {
    const scale=Math.min(1,(vp.width-80)/rect.width,(vp.height-200)/rect.height);
    state.view=zoomAt(state.view,Math.max(.4,scale),vp.width/2,vp.height/2);
    state.view.x=vp.width/2-(rect.x+rect.width/2)*state.view.scale;
    state.view.y=(vp.height+110)/2-(rect.y+rect.height/2)*state.view.scale;
  } else {
    const left=rect.x*state.view.scale+state.view.x, top=rect.y*state.view.scale+state.view.y;
    const right=left+rect.width*state.view.scale, bottom=top+rect.height*state.view.scale;
    if(left<25) state.view.x+=25-left;
    else if(right>vp.width-25) state.view.x-=right-vp.width+25;
    if(top<140) state.view.y+=140-top;
    else if(bottom>vp.height-70) state.view.y-=bottom-vp.height+70;
  }
  updateTransform(true);
}

function firstLayout(record) {
  if(record.layoutPlaced) return;
  const p=points.get(record.id);
  const other=[...expanded].filter(id=>id!==record.id).map(id=>noteRect(getRecord(id)));
  const candidates=[[-130,50],[-130,-record.layout.height-50],[45,45],[-record.layout.width-45,45]];
  let choice=candidates[0];
  for(const c of candidates) {
    const r={x:p.x+c[0],y:p.y+c[1],width:record.layout.width,height:record.layout.height};
    if(!other.some(o=>r.x<o.x+o.width&&r.x+r.width>o.x&&r.y<o.y+o.height&&r.y+r.height>o.y)){choice=c;break;}
  }
  record.layout={...record.layout,dx:choice[0],dy:choice[1]};
  // 服务端记录的布局始终优先；首次默认布局只在本次新建时选取。
  record.layoutPlaced=true;markDirty(record);
}

function summaryHTML(record) {
  const body=document.createElement('div');body.innerHTML=record.body;
  const image=body.querySelector('img');
  return `<div class="summary"><div class="note-time">${escape(formatTime(record.time))}</div><h3>${escape(titleOf(record))}</h3><div class="summary-text">${image?`<img class="summary-thumb" src="${escape(image.getAttribute('src'))}" alt="记录图片缩略图">`:''}${escape(noteText(record).slice(0,100)||'还没有内容，点击继续记录。')}</div>${record.tags?`<div class="summary-tag">${escape(record.tags)}</div>`:''}</div>`;
}

function toolsHTML() {
  return `<div class="toolbar" aria-label="正文编辑工具"><button data-command="bold" title="粗体"><b>B</b></button><button data-command="hiliteColor" class="highlight-tool" title="高亮">高亮</button><span class="divider"></span><button data-block="h1" title="一级标题">H1</button><button data-block="h2" title="二级标题">H2</button><button data-block="p" title="普通段落">正文</button><span class="divider"></span><button data-command="insertUnorderedList" title="无序列表">•≡</button><button data-command="insertOrderedList" title="有序列表">1≡</button><button data-action="link" title="插入链接">${icon('link')}</button><button data-action="code" title="插入代码块">${icon('code')}</button><button data-action="image" title="插入图片">${icon('image')}</button><button data-action="remove-image" title="移除所选图片">移除图</button></div>`;
}

function expandedHTML(record) {
  const edit=editing.has(record.id);
  return `<div class="note-header"><span class="note-time">${escape(formatTime(record.time))}</span><button class="pin-button" data-action="pin" aria-label="${record.pinned?'取消钉住':'钉住贴纸'}" aria-pressed="${record.pinned}" title="${record.pinned?'已钉住，点击取消':'点击钉住'}">${icon('pin')}</button><div class="note-actions">${!edit?'<button data-action="edit">编辑</button>':''}<button data-action="close" aria-label="收起贴纸" title="收起贴纸">${icon('close')}</button></div></div>${edit?toolsHTML():''}<div class="note-body">${edit?`<label class="note-time">记录时间 <input class="record-time-input" type="datetime-local" value="${localInput(record.time)}" aria-label="记录时间"></label><input class="note-title-input" aria-label="便签标题" maxlength="200" placeholder="无标题记录" value="${escape(record.title)}"><div class="rich-content editor" contenteditable="true" role="textbox" aria-label="便签正文" aria-multiline="true" spellcheck="false">${record.body}</div>`:`<h2>${escape(titleOf(record))}</h2><div class="rich-content">${record.body||'<p class="muted">这张便签还是空白的，点击编辑留下内容。</p>'}</div>`}</div><div class="note-footer">${edit?`<input class="tags-input" aria-label="可选标签" maxlength="200" placeholder="可选标签，例如：灵感、复盘" value="${escape(record.tags)}">`:`<span>${escape(record.tags)}</span>`}<span class="note-save">已保存</span><button data-action="delete" title="移到回收站">${icon('trash')}</button></div><div class="resize-handle" title="拖动调整尺寸"></div><div class="roll-curl"></div>`;
}

function enhanceContent(container) {
  container.querySelectorAll('pre').forEach(pre=>{
    if(pre.nextElementSibling?.classList.contains('copy-code')) return;
    const button=document.createElement('button');button.className='copy-code';button.textContent='复制代码';button.type='button';
    button.addEventListener('click',()=>copyText(pre.textContent));pre.after(button);
  });
}

function paintNote(id, animate=false) {
  const record=getRecord(id), point=points.get(id);
  if(!record||!point)return;
  let el=elements.get(id);
  if(!el) {el=document.createElement('article');el.className='note';el.dataset.id=id;$('#notes').append(el);elements.set(id,el);}
  const isExpanded=expanded.has(id), rect=noteRect(record,point);
  el.classList.toggle('expanded',isExpanded);el.classList.toggle('editing',editing.has(id));
  el.classList.remove('rolling');el.classList.toggle('unrolling',animate);
  el.dataset.color=record.color;el.dataset.title=titleOf(record);
  el.style.left=rect.x+'px';el.style.top=rect.y+'px';el.style.width=rect.width+'px';el.style.height=rect.height+'px';
  el.style.zIndex=isExpanded?String(++zIndex):'2';
  el.innerHTML=isExpanded?expandedHTML(record):summaryHTML(record);
  if(!isExpanded) {el.tabIndex=0;el.setAttribute('role','button');el.setAttribute('aria-label',`打开便签：${titleOf(record)}`);}
  else {el.removeAttribute('role');el.removeAttribute('tabindex');el.setAttribute('aria-label',titleOf(record));if(!editing.has(id))enhanceContent(el.querySelector('.rich-content'));}
  for(const upload of uploads.values()) if(upload.recordId===id&&!upload.done&&editing.has(id)) attachUploadPlaceholder(upload);
  updateStatus();
}

function updateLines() {
  const rects=[...elements.keys()].map(id=>noteRect(getRecord(id))).filter(Boolean);
  const minX=Math.min(-500,...rects.map(r=>r.x-100)), minY=Math.min(-500,...rects.map(r=>r.y-100));
  const maxX=Math.max(4000,...rects.map(r=>r.x+r.width+100)), maxY=Math.max(1500,...rects.map(r=>r.y+r.height+100));
  const lines=$('#lines');lines.style.left=minX+'px';lines.style.top=minY+'px';lines.style.width=(maxX-minX)+'px';lines.style.height=(maxY-minY)+'px';
  lines.setAttribute('viewBox',`${minX} ${minY} ${maxX-minX} ${maxY-minY}`);
  $('#connectors').innerHTML=[...expanded].filter(id=>points.has(id)).map(id=>{
    const record=getRecord(id), p=points.get(id), r=noteRect(record,p);
    const x=Math.max(r.x,Math.min(p.x,r.x+r.width)), y=Math.max(r.y,Math.min(p.y,r.y+r.height));
    return `<path d="M ${p.x} ${p.y} L ${x} ${y}"/>`;
  }).join('');
}

function drawCanvas() {
  const records=sortedRecords(state.records,state.topicId,committedTimes), curve=timeline(records.length);
  points.clear();records.forEach((r,i)=>points.set(r.id,curve.points[i]));
  const allowed=new Set(records.map(r=>r.id));
  for(const [id,el] of elements) if(!allowed.has(id)){el.remove();elements.delete(id);expanded.delete(id);editing.delete(id);}
  records.forEach(record=>{
    if(editing.has(record.id)&&elements.has(record.id)) {
      const rect=noteRect(record);Object.assign(elements.get(record.id).style,{left:rect.x+'px',top:rect.y+'px'});
    } else paintNote(record.id);
  });
  $('#timeline-base').setAttribute('d',records.length?curve.path:'');$('#timeline-dash').setAttribute('d',records.length?curve.path:'');
  $('#nodes').innerHTML=records.map(r=>{const p=points.get(r.id);return `<circle cx="${p.x}" cy="${p.y}" r="9"/>`;}).join('');
  $('#empty-state').hidden=records.length>0;
  const topic=state.topics.find(t=>t.id===state.topicId);
  $('#topic-title').textContent=topic?.name||'我的画布';
  $('#topic-subtitle').textContent=records.length?`${records.length} 条记录 · 让零散的片刻，慢慢连成一条线。`:'让零散的片刻，慢慢连成一条线。';
  $('#new-record').disabled=!topic;
  updateLines();
}

async function finishNote(id,{forceClose=false}={}) {
  const record=getRecord(id);if(!record)return true;
  if(editing.has(id)) {
    if(!readEditor(id)){markDirty(record,10000);elements.get(id).querySelector('.record-time-input').reportValidity();return false;}
    markDirty(record,10000);
  }
  const pending=[...uploads.values()].filter(u=>u.recordId===id&&!u.done);
  if(pending.length) {toast(pending.some(u=>u.error)?'图片上传失败，请在便签内重试或取消。':'图片还在上传，请稍候。');return false;}
  if(!await saveRecord(id)) {toast(failures.get(id));return false;}
  const reordered=committedTimes.has(id)&&Date.parse(committedTimes.get(id))!==Date.parse(record.time);
  if(forceClose&&record.pinned) {
    record.pinned=false;markDirty(record,10000);
    if(!await saveRecord(id)) {
      const message=failures.get(id);record.pinned=true;markDirty(record,10000);failures.set(id,message);updateStatus();toast(message);return false;
    }
  }
  committedTimes.delete(id);editing.delete(id);
  const result=afterBlankClick({editing:false,pinned:record.pinned,saved:true});
  if(!result.expanded||forceClose) {
    const el=elements.get(id);
    if(el&&expanded.has(id)) {
      el.classList.add('rolling');
      await new Promise(resolve=>setTimeout(resolve,matchMedia('(prefers-reduced-motion:reduce)').matches?0:320));
    }
    expanded.delete(id);
  }
  if(reordered) {drawCanvas();showNoteInView(id,true);}
  else {paintNote(id);updateLines();}
  return true;
}

async function endAllEditingAndCollapse(except=null) {
  if(busy)return false;
  busy=true;
  try {
    for(const id of [...expanded]) if(id!==except&&(!getRecord(id)?.pinned||editing.has(id))) {
      if(!await finishNote(id))return false;
    }
    return true;
  } finally {busy=false;}
}

async function openNote(id) {
  const record=getRecord(id);if(!record)return;
  if(mobile())return mobileRead(record);
  if(expanded.has(id)) {elements.get(id).style.zIndex=++zIndex;if(state.view.scale<.65)showNoteInView(id,true);return;}
  if(!await endAllEditingAndCollapse(id))return;
  expanded.add(id);paintNote(id,true);updateLines();showNoteInView(id);
}

async function startEdit(id) {
  if(mobile())return;
  if(!await endAllEditingAndCollapse(id))return;
  editing.add(id);committedTimes.set(id,getRecord(id).time);paintNote(id);
  elements.get(id).querySelector('.editor').focus();
}

function formDialog({title,description='',fields=[],submit='确认'}) {
  if($('#form-dialog').open)return Promise.resolve(null);
  $('#dialog-title').textContent=title;$('#dialog-description').textContent=description;$('#dialog-submit').textContent=submit;$('#dialog-error').textContent='';
  $('#dialog-fields').innerHTML=fields.map(f=>{
    if(f.type==='color')return `<label>${escape(f.label)}</label><input type="hidden" name="${escape(f.name)}" value="${escape(f.value||'yellow')}"><div class="color-picker">${colors.map(c=>`<button type="button" class="color-choice ${c===(f.value||'yellow')?'selected':''}" data-color="${c}" aria-label="${colorNames[c]}" title="${colorNames[c]}"></button>`).join('')}</div>`;
    return `<label for="field-${escape(f.name)}">${escape(f.label)}</label>${f.type==='textarea'?`<textarea id="field-${escape(f.name)}" name="${escape(f.name)}" ${f.required?'required':''}>${escape(f.value||'')}</textarea>`:`<input id="field-${escape(f.name)}" name="${escape(f.name)}" type="${f.type||'text'}" value="${escape(f.value||'')}" ${f.required?'required':''} ${f.max?`maxlength="${f.max}"`:''}>`}`;
  }).join('');
  $('#form-dialog').showModal();
  return new Promise(resolve=>dialogResolve=resolve);
}

function resolveDialog(value) {$('#form-dialog').close();const resolve=dialogResolve;dialogResolve=null;resolve?.(value);}
$('#dialog-form').addEventListener('submit',event=>{event.preventDefault();resolveDialog(Object.fromEntries(new FormData(event.currentTarget)));});
$('#dialog-cancel').onclick=()=>resolveDialog(null);$('#dialog-close').onclick=()=>resolveDialog(null);
$('#form-dialog').addEventListener('cancel',event=>{event.preventDefault();resolveDialog(null);});
$('#dialog-fields').addEventListener('click',event=>{const button=event.target.closest('.color-choice');if(!button)return;const parent=button.closest('.color-picker');parent.querySelectorAll('button').forEach(b=>b.classList.toggle('selected',b===button));parent.previousElementSibling.value=button.dataset.color;});

async function changeTopic(id=null) {
  if(mobile())return;
  const topic=id?state.topics.find(t=>t.id===id):null;
  const data=await formDialog({title:topic?'整理这个主题':'新建主题',description:'每个主题都有一条独立的时间线。',fields:[{name:'name',label:'主题名称',value:topic?.name,required:true,max:80},{name:'color',label:'主题颜色',type:'color',value:topic?.color||'blue'}]});
  if(!data)return;
  try {
    const saved=await api(topic?`/api/topics/${id}`:'/api/topics',{method:topic?'PATCH':'POST',body:data});
    if(topic)Object.assign(topic,saved);else state.topics.push(saved);
    drawTopics();if(!topic)await selectTopic(saved.id);else drawCanvas();
  } catch(error){toast(error.message);}
}

async function newRecord() {
  if(mobile())return;
  if(!state.topicId)return changeTopic();
  if(!await endAllEditingAndCollapse())return;
  const values=await formDialog({title:'留下一个新片刻',description:'选择记录发生的时间，也可以补记过去的事情。之后仍可修改。',submit:'创建便签',fields:[{name:'time',type:'datetime-local',label:'记录时间',value:localInput(),required:true},{name:'color',type:'color',label:'便签颜色',value:colors[state.records.filter(r=>r.topicId===state.topicId).length%5]}]});
  if(!values)return;
  try {
    const record=await api('/api/records',{method:'POST',body:{topicId:state.topicId,time:isoFromInput(values.time),color:values.color,body:'',title:''}});
    state.records.push(record);drawCanvas();expanded.add(record.id);firstLayout(record);editing.add(record.id);committedTimes.set(record.id,record.time);
    paintNote(record.id,true);updateLines();showNoteInView(record.id,true);elements.get(record.id).querySelector('.note-title-input').focus();
  }catch(error){toast(error.message);}
}

async function deleteRecord(id) {
  if(!readEditor(id))return;
  const confirm=await formDialog({title:'移到回收站？',description:'便签可以随时恢复，恢复后会回到原来的时间顺序。',submit:'移到回收站'});
  if(!confirm)return;
  if(!await finishNote(id))return;
  const r=getRecord(id);r.deleted=true;markDirty(r,10000);
  if(!await saveRecord(id)) {r.deleted=false;markDirty(r);toast(failures.get(id)||'删除未完成，请重试');return;}
  expanded.delete(id);editing.delete(id);committedTimes.delete(id);drawCanvas();drawTopics();toast('已移到回收站');
}

async function showTrash() {
  if(!await endAllEditingAndCollapse()||!await flushAll())return;
  state.trash=true;$('#viewport').hidden=true;$('#trash-view').hidden=false;$('#new-record').hidden=true;$('#fit-button').hidden=true;
  $('#topic-title').textContent='回收站';$('#topic-subtitle').textContent='给误删的片刻，一次回来的机会。';drawTopics();drawTrash();closeSidebar();
}

function drawTrash() {
  const records=state.records.filter(r=>r.deleted).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
  $('#trash-list').innerHTML=records.length?records.map(r=>`<article class="trash-row"><div><h3>${escape(titleOf(r))}</h3><p>${escape(state.topics.find(t=>t.id===r.topicId)?.name)} · ${escape(formatTime(r.time))}</p></div><button data-restore="${r.id}" class="secondary">恢复便签</button></article>`).join(''):'<p class="muted">回收站是空的。</p>';
}

async function restoreRecord(id) {
  const record=getRecord(id);record.deleted=false;markDirty(record,10000);
  if(await saveRecord(id)){drawTrash();drawTopics();toast('已恢复到原主题');}
  else {record.deleted=true;markDirty(record);toast('恢复失败，请重试');}
}

async function copyText(text) {
  try {await navigator.clipboard.writeText(text);toast('已复制');}
  catch {
    const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.left='-9999px';document.body.append(area);area.select();const ok=document.execCommand('copy');area.remove();toast(ok?'已复制':'无法自动复制，请选择代码后手动复制');
  }
}

function captureRange(editor) {
  const selection=window.getSelection();
  if(selection.rangeCount&&editor.contains(selection.getRangeAt(0).commonAncestorContainer)) editorRange=selection.getRangeAt(0).cloneRange();
}

function restoreRange(editor) {
  editor.focus();const selection=window.getSelection();
  const range=editorRange&&editor.contains(editorRange.commonAncestorContainer)?editorRange:document.createRange();
  if(range!==editorRange){range.selectNodeContents(editor);range.collapse(false);}
  selection.removeAllRanges();selection.addRange(range);
}

async function editorTool(id,button) {
  const editor=elements.get(id)?.querySelector('.editor');if(!editor)return;
  restoreRange(editor);
  if(button.dataset.command)document.execCommand(button.dataset.command,false,button.dataset.command==='hiliteColor'?'#ffe899':null);
  else if(button.dataset.block)document.execCommand('formatBlock',false,button.dataset.block);
  else if(button.dataset.action==='image') {$('#image-input').dataset.recordId=id;$('#image-input').click();return;}
  else if(button.dataset.action==='remove-image') {
    const selected=editor.querySelector('img.selected-image');if(selected)selected.remove();else toast('先点击正文中要移除的图片');
  } else if(button.dataset.action==='code') {
    captureRange(editor);
    const result=await formDialog({title:'插入代码块',description:'换行与缩进会原样保留。',fields:[{name:'code',type:'textarea',label:'代码或命令',required:true}],submit:'插入'});
    if(!result)return;restoreRange(editor);
    const pre=document.createElement('pre'),code=document.createElement('code'),paragraph=document.createElement('p');
    code.textContent=result.code;pre.append(code);paragraph.append(document.createElement('br'));
    const selection=window.getSelection(),range=selection.getRangeAt(0);
    range.deleteContents();range.insertNode(pre);pre.after(paragraph);
    range.setStart(paragraph,0);range.collapse(true);selection.removeAllRanges();selection.addRange(range);
  } else if(button.dataset.action==='link') {
    captureRange(editor);
    const anchor=(editorRange?.startContainer.nodeType===Node.ELEMENT_NODE?editorRange.startContainer:editorRange?.startContainer.parentElement)?.closest('a');
    const result=await formDialog({title:anchor?'编辑链接':'添加链接',fields:[{name:'url',type:'url',label:'链接地址',value:anchor?.getAttribute('href')||'https://',required:true}],submit:anchor?'更新':'插入'});
    if(!result)return;
    if(!/^https?:\/\//i.test(result.url)){toast('请使用 http 或 https 链接');return;}
    restoreRange(editor);
    const selection=window.getSelection();
    if(anchor&&editor.contains(anchor))anchor.setAttribute('href',result.url);
    else if(selection.isCollapsed)document.execCommand('insertHTML',false,`<a href="${escape(result.url)}" target="_blank" rel="noopener noreferrer">${escape(result.url)}</a>`);
    else document.execCommand('createLink',false,result.url);
  }
  captureRange(editor);readEditor(id);markDirty(getRecord(id));
}

function attachUploadPlaceholder(upload) {
  const editor=elements.get(upload.recordId)?.querySelector('.editor');if(!editor)return;
  let box=editor.querySelector(`[data-upload="${upload.key}"]`);
  if(!box) {box=document.createElement('div');box.className='upload-placeholder';box.contentEditable='false';box.dataset.upload=upload.key;editor.append(box);}
  box.innerHTML=upload.error?`图片“${escape(upload.file.name||'截图')}”上传失败 <button type="button" data-upload-retry="${upload.key}">重试</button><button type="button" data-upload-cancel="${upload.key}">取消</button>`:`正在上传 ${escape(upload.file.name||'截图')}…`;
}

async function uploadImage(upload) {
  upload.error='';attachUploadPlaceholder(upload);updateStatus();
  try {
    const result=await api('/api/images',{method:'POST',body:upload.file,raw:true});
    const editor=elements.get(upload.recordId)?.querySelector('.editor');
    if(!editor)throw new Error('请保持便签编辑状态后重试');
    const box=editor.querySelector(`[data-upload="${upload.key}"]`), img=document.createElement('img');img.src=result.url;img.alt=upload.file.name||'截图';
    if(box)box.replaceWith(img);else editor.append(img);
    upload.done=true;uploads.delete(upload.key);readEditor(upload.recordId);markDirty(getRecord(upload.recordId));
  } catch(error){upload.error=error.message;attachUploadPlaceholder(upload);toast(error.message);}
  updateStatus();
}

function insertFiles(id,files) {
  for(const file of files) {
    if(!['image/png','image/jpeg','image/gif','image/webp'].includes(file.type)){toast('仅支持 PNG、JPEG、GIF、WebP 图片');continue;}
    if(file.size>12*1024*1024){toast('每张图片最大 12 MB');continue;}
    const upload={key:`upload-${Date.now()}-${++localSequence}`,recordId:id,file,done:false,error:''};uploads.set(upload.key,upload);uploadImage(upload);
  }
}

function mobileRead(record) {
  $('#mobile-time').textContent=formatTime(record.time);$('#mobile-title').textContent=titleOf(record);
  $('#mobile-body').innerHTML=record.body||'<p class="muted">这张便签还是空白的。</p>';enhanceContent($('#mobile-body'));
  $('#mobile-reader').showModal();$('#mobile-reader').scrollTop=0;
}

function openImages(container,src) {
  photoState={urls:[...container.querySelectorAll('img')].map(img=>img.getAttribute('src')),index:0,scale:1,x:0,y:0};
  photoState.index=Math.max(0,photoState.urls.indexOf(src));$('#image-viewer').showModal();paintImage();
}
function paintImage(reset=true) {
  if(reset){photoState.scale=1;photoState.x=0;photoState.y=0;}
  $('#viewer-image').src=photoState.urls[photoState.index];$('#image-counter').textContent=`${photoState.index+1} / ${photoState.urls.length}`;
  $('#viewer-image').style.transform=`translate(${photoState.x}px,${photoState.y}px) scale(${photoState.scale})`;
  $('#image-prev').hidden=photoState.urls.length<2;$('#image-next').hidden=photoState.urls.length<2;
}
function photoZoom(multiplier) {photoState.scale=Math.max(.5,Math.min(8,photoState.scale*multiplier));paintImage(false);}

$('#notes').addEventListener('click',async event=>{
  if(gestureMoved){event.preventDefault();return;}
  const el=event.target.closest('.note');if(!el)return;
  const id=el.dataset.id, record=getRecord(id);el.style.zIndex=expanded.has(id)?++zIndex:2;
  const retry=event.target.closest('[data-upload-retry]'), cancel=event.target.closest('[data-upload-cancel]');
  if(retry){uploadImage(uploads.get(retry.dataset.uploadRetry));return;}
  if(cancel){uploads.delete(cancel.dataset.uploadCancel);cancel.closest('.upload-placeholder').remove();readEditor(id);markDirty(record);updateStatus();return;}
  const action=event.target.closest('[data-action]');
  if(action&&!action.closest('.toolbar')) {
    if(busy)return;
    switch(action.dataset.action) {
      case 'pin': record.pinned=!record.pinned;action.classList.toggle('pinned',record.pinned);action.setAttribute('aria-pressed',String(record.pinned));action.setAttribute('aria-label',record.pinned?'取消钉住':'钉住贴纸');markDirty(record);break;
      case 'edit': await startEdit(id);break;
      case 'close': busy=true;try{await finishNote(id,{forceClose:true});}finally{busy=false;}break;
      case 'delete': await deleteRecord(id);break;
    }
    return;
  }
  const tool=event.target.closest('.toolbar button');if(tool){await editorTool(id,tool);return;}
  const img=event.target.closest('.rich-content img');
  if(img) {
    if(editing.has(id)){el.querySelectorAll('img').forEach(i=>{i.classList.toggle('selected-image',i===img);i.style.outline=i===img?'2px solid #6862aa':'';});toast('已选中图片，可点工具栏“移除图”');}
    else openImages(el.querySelector('.rich-content'),img.getAttribute('src'));
    return;
  }
  if(!expanded.has(id)||state.view.scale<.65)await openNote(id);
});
$('#notes').addEventListener('keydown',event=>{const el=event.target.closest('.note');if(el&&!expanded.has(el.dataset.id)&&['Enter',' '].includes(event.key)){event.preventDefault();openNote(el.dataset.id);}});
$('#notes').addEventListener('input',event=>{const el=event.target.closest('.note');if(el&&editing.has(el.dataset.id)){readEditor(el.dataset.id);markDirty(getRecord(el.dataset.id));}});
$('#notes').addEventListener('mousedown',event=>{if(event.target.closest('.toolbar'))event.preventDefault();});
$('#notes').addEventListener('keyup',event=>{const editor=event.target.closest('.editor');if(editor)captureRange(editor);});
$('#notes').addEventListener('mouseup',event=>{const editor=event.target.closest('.editor');if(editor)captureRange(editor);});
$('#notes').addEventListener('paste',event=>{
  const editor=event.target.closest('.editor');if(!editor)return;
  const files=[...event.clipboardData.files];event.preventDefault();
  if(files.length)insertFiles(editor.closest('.note').dataset.id,files);
  else {document.execCommand('insertText',false,event.clipboardData.getData('text/plain'));readEditor(editor.closest('.note').dataset.id);markDirty(getRecord(editor.closest('.note').dataset.id));}
});
$('#notes').addEventListener('dragover',event=>{if(event.target.closest('.editor'))event.preventDefault();});
$('#notes').addEventListener('drop',event=>{const editor=event.target.closest('.editor');if(!editor)return;event.preventDefault();insertFiles(editor.closest('.note').dataset.id,[...event.dataTransfer.files]);});
$('#image-input').addEventListener('change',event=>{insertFiles(event.target.dataset.recordId,[...event.target.files]);event.target.value='';});

const touchPoints=new Map();let pinch=null;
$('#viewport').addEventListener('pointerdown',event=>{
  if(event.pointerType==='touch') {
    touchPoints.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(touchPoints.size===2) {
      const [a,b]=[...touchPoints.values()], vp=$('#viewport').getBoundingClientRect();
      pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),view:{...state.view},cx:(a.x+b.x)/2-vp.left,cy:(a.y+b.y)/2-vp.top};
      pointerGesture=null;gestureMoved=true;event.currentTarget.setPointerCapture(event.pointerId);return;
    }
  }
  if(event.button!==0&&event.button!==1)return;
  const note=event.target.closest('.note'), expandedNote=note&&expanded.has(note.dataset.id);
  let type='pan';
  if(event.button===0&&note&&!mobile()) {
    if(expandedNote&&event.target.closest('.resize-handle'))type='resize';
    else if(expandedNote&&event.target.closest('.note-header')&&!event.target.closest('button,input'))type='note';
    else return;
  }
  if(event.button===0&&event.target.closest('button,input,dialog'))return;
  event.preventDefault();gestureMoved=false;
  const record=note?getRecord(note.dataset.id):null;
  pointerGesture={type,id:record?.id,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,view:{...state.view},layout:record?{...record.layout}:null,moved:false,blank:!note};
  $('#world').classList.remove('moving');event.currentTarget.setPointerCapture(event.pointerId);
});
$('#viewport').addEventListener('pointermove',event=>{
  if(event.pointerType==='touch'&&touchPoints.has(event.pointerId))touchPoints.set(event.pointerId,{x:event.clientX,y:event.clientY});
  if(pinch&&touchPoints.size===2) {
    const [a,b]=[...touchPoints.values()], vp=$('#viewport').getBoundingClientRect();
    const dist=Math.hypot(a.x-b.x,a.y-b.y),cx=(a.x+b.x)/2-vp.left,cy=(a.y+b.y)/2-vp.top;
    state.view=zoomAt(pinch.view,pinch.view.scale*dist/Math.max(1,pinch.distance),pinch.cx,pinch.cy);
    state.view.x+=cx-pinch.cx;state.view.y+=cy-pinch.cy;updateTransform();return;
  }
  const g=pointerGesture;if(!g||g.pointerId!==event.pointerId)return;
  const dx=event.clientX-g.startX,dy=event.clientY-g.startY;
  if(Math.hypot(dx,dy)<5&&!g.moved)return;
  g.moved=true;gestureMoved=true;$('#viewport').classList.add('dragging');
  if(g.type==='pan') {state.view={...g.view,x:g.view.x+dx,y:g.view.y+dy};updateTransform();}
  else {
    const r=getRecord(g.id), el=elements.get(g.id);
    if(g.type==='note'){r.layout.dx=Math.max(-20000,Math.min(20000,g.layout.dx+dx/state.view.scale));r.layout.dy=Math.max(-20000,Math.min(20000,g.layout.dy+dy/state.view.scale));}
    else {r.layout.width=Math.max(320,Math.min(1000,g.layout.width+dx/state.view.scale));r.layout.height=Math.max(280,Math.min(1000,g.layout.height+dy/state.view.scale));}
    const rect=noteRect(r);Object.assign(el.style,{left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px',zIndex:++zIndex});updateLines();
  }
});
async function pointerEnd(event,cancelled=false) {
  touchPoints.delete(event.pointerId);
  if(pinch){if(touchPoints.size<2)pinch=null;pointerGesture=null;setTimeout(()=>gestureMoved=false,100);return;}
  const g=pointerGesture;if(!g||g.pointerId!==event.pointerId)return;
  pointerGesture=null;$('#viewport').classList.remove('dragging');
  if(g.moved&&g.type!=='pan'){markDirty(getRecord(g.id));}
  if(!g.moved&&!cancelled&&event.button===0) {
    if(mobile()&&g.id)await openNote(g.id);
    else if(g.blank)await endAllEditingAndCollapse();
  }
  setTimeout(()=>gestureMoved=false,100);
}
$('#viewport').addEventListener('pointerup',event=>pointerEnd(event));
$('#viewport').addEventListener('pointercancel',event=>pointerEnd(event,true));
$('#viewport').addEventListener('auxclick',event=>{if(event.button===1)event.preventDefault();});
$('#viewport').addEventListener('wheel',event=>{
  const body=event.target.closest('.note-body');
  if(body&&expanded.has(body.closest('.note').dataset.id)&&state.view.scale>=.36)return;
  event.preventDefault();const vp=$('#viewport').getBoundingClientRect();
  state.view=zoomAt(state.view,state.view.scale*Math.exp(-event.deltaY*.0016),event.clientX-vp.left,event.clientY-vp.top);updateTransform();
},{passive:false});

$('#topics').addEventListener('click',event=>{const select=event.target.closest('[data-topic]'),edit=event.target.closest('[data-edit-topic]');if(select)selectTopic(select.dataset.topic);if(edit)changeTopic(edit.dataset.editTopic);});
$('#new-topic').onclick=()=>changeTopic();$('#new-record').onclick=newRecord;$('#empty-add').onclick=newRecord;
$('#fit-button').onclick=fitAll;$('#zoom-fit').onclick=fitAll;
$('#zoom-in').onclick=()=>{const vp=$('#viewport').getBoundingClientRect();state.view=zoomAt(state.view,state.view.scale*1.25,vp.width/2,vp.height/2);updateTransform(true);};
$('#zoom-out').onclick=()=>{const vp=$('#viewport').getBoundingClientRect();state.view=zoomAt(state.view,state.view.scale/1.25,vp.width/2,vp.height/2);updateTransform(true);};
$('#trash-button').onclick=showTrash;$('#trash-list').onclick=event=>{const button=event.target.closest('[data-restore]');if(button)restoreRecord(button.dataset.restore);};
$('#menu-button').onclick=()=>{$('#sidebar').classList.add('open');$('#sidebar-shade').hidden=false;};$('#sidebar-shade').onclick=closeSidebar;
$('#save-status').onclick=async()=>{for(const upload of uploads.values())if(upload.error)uploadImage(upload);await flushAll();updateStatus();};
$('#mobile-close').onclick=()=>$('#mobile-reader').close();
$('#mobile-body').onclick=event=>{const img=event.target.closest('img');if(img)openImages($('#mobile-body'),img.getAttribute('src'));};
$('#image-close').onclick=()=>$('#image-viewer').close();$('#image-reset').onclick=()=>paintImage();
$('#image-larger').onclick=()=>photoZoom(1.25);$('#image-smaller').onclick=()=>photoZoom(.8);
$('#image-prev').onclick=()=>{photoState.index=(photoState.index-1+photoState.urls.length)%photoState.urls.length;paintImage();};
$('#image-next').onclick=()=>{photoState.index=(photoState.index+1)%photoState.urls.length;paintImage();};
$('#image-stage').addEventListener('wheel',event=>{event.preventDefault();photoZoom(Math.exp(-event.deltaY*.0015));},{passive:false});
$('#image-stage').addEventListener('pointerdown',event=>{imagePointer={x:event.clientX,y:event.clientY,startX:photoState.x,startY:photoState.y};event.currentTarget.setPointerCapture(event.pointerId);});
$('#image-stage').addEventListener('pointermove',event=>{if(!imagePointer)return;photoState.x=imagePointer.startX+event.clientX-imagePointer.x;photoState.y=imagePointer.startY+event.clientY-imagePointer.y;paintImage(false);});
$('#image-stage').addEventListener('pointerup',()=>imagePointer=null);$('#image-stage').addEventListener('pointercancel',()=>imagePointer=null);
$('#image-viewer').addEventListener('keydown',event=>{if(event.key==='ArrowRight')$('#image-next').click();if(event.key==='ArrowLeft')$('#image-prev').click();});

$('#export-button').onclick=async()=>{
  if(!await endAllEditingAndCollapse()||!await flushAll())return;
  try {
    const response=await fetch('/api/backup');if(!response.ok)throw new Error('备份导出失败，请重试');
    const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download=`无限贴纸备份-${localInput().slice(0,10)}.zip`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('完整备份已导出，包含正文、图片和回收站');
  }catch(error){toast(error.message);}
};
$('#import-button').onclick=async()=>{if(await endAllEditingAndCollapse()&&await flushAll())$('#backup-input').click();};
$('#backup-input').onchange=async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;
  if(file.size>128*1024*1024){toast('备份文件最大 128 MB');return;}
  const result=await formDialog({title:'整体恢复这份备份？',description:`文件：${file.name}。恢复将替换当前主题、便签和图片。服务器会先完整备份现有数据，校验失败不会修改现有内容。登录密码保持不变。`,submit:'确认恢复'});
  if(!result)return;
  try {
    const restored=await api('/api/restore',{method:'POST',body:file,raw:true});await loadState();toast(`已恢复 ${restored.records} 条记录；原数据备份：${restored.backup}`);
  }catch(error){toast(error.message);}
};
$('#logout-button').onclick=async()=>{
  if(!await endAllEditingAndCollapse()||!await flushAll())return;
  try {await api('/api/logout',{method:'POST',body:{}});state.csrf='';$('#app').hidden=true;$('#login-screen').hidden=false;$('#password').value='';}
  catch(error){toast(error.message);}
};

async function loadState() {
  const data=await api('/api/state');state.topics=data.topics;state.records=data.records;
  for(const r of state.records)r.layoutPlaced=true;
  expanded.clear();editing.clear();committedTimes.clear();dirty.clear();failures.clear();invalidTimes.clear();
  state.topicId=state.topics.some(t=>t.id===state.topicId)?state.topicId:state.topics[0]?.id||null;
  $('#login-screen').hidden=true;$('#app').hidden=false;drawTopics();
  await selectTopic(state.topicId);
}

$('#login-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;$('#login-error').textContent='';
  try {const result=await api('/api/login',{method:'POST',body:{password:$('#password').value}});state.csrf=result.csrf;$('#password').value='';await loadState();}
  catch(error){$('#login-error').textContent=error.message;}
  finally{button.disabled=false;}
});
window.addEventListener('online',async()=>{toast('连接已恢复，正在重试保存');for(const upload of uploads.values())if(upload.error)uploadImage(upload);await flushAll();updateStatus();});
window.addEventListener('offline',updateStatus);
window.addEventListener('beforeunload',event=>{if(dirty.size||saving.size||[...uploads.values()].some(u=>!u.done)){event.preventDefault();event.returnValue='';}});
window.addEventListener('resize',()=>{if(!state.trash&&!$('#app').hidden)fitAll();});

(async()=>{
  try {const session=await api('/api/session');state.csrf=session.csrf;if(session.authenticated)await loadState();else $('#password').focus();}
  catch(error){$('#login-error').textContent=error.message;}
})();
