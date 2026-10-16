(function(root){
'use strict';
function parseSize(text){
 const value=String(text||'').trim();if(!value)return null;
 const match=/^(\d+(?:\.\d+)?)\s*(B|Ki?B?|Mi?B?|Gi?B?|Ti?B?)$/i.exec(value);
 if(!match)throw Error('请填写如 3.4GB、500MB，留空表示待补充');
 const key=match[2].toUpperCase().replace('IB','B'),power={B:0,K:1,KB:1,M:2,MB:2,G:3,GB:3,T:4,TB:4}[key];
 const n=Number(match[1]),bytes=Math.round(n*1024**power);if(!Number.isSafeInteger(bytes)||bytes<=0)throw Error('大小必须大于0，且在有效范围内');
 return {bytes,label:String(n)+' '+['B','KB','MB','GB','TB'][power],source:'manual'};
}
function fromCard(card){if(!card||!card.hasAttribute('data-resource-size'))return undefined;try{return JSON.parse(card.dataset.resourceSize)}catch(e){return undefined}}
function badge(size){const el=document.createElement('span');el.className='resource-size-display';el.textContent=size?.label?'大小 '+size.label:'大小待补充';if(size)el.title={title:'来自原标题标注',quark:'夸克文件大小合计',manual:'管理员填写'}[size.source]||'';return el}
function renderCaption(card,size){const thumb=card.querySelector('.card-thumb');if(!thumb)return;let el=thumb.querySelector(':scope>.resource-size-caption');if(!size?.label){el?.remove();return}if(!el){el=badge(size);el.classList.add('resource-size-caption');thumb.append(el)}el.textContent=size.label}
function render(){
 for(const card of document.querySelectorAll('#box>.card')){
  const size=fromCard(card),tags=card.querySelector('.card-preview-tags');
  if(tags)tags.querySelectorAll('.resource-size-display').forEach(el=>el.remove());
  renderCaption(card,size);
  const info=card.querySelector('.info-box');if(!info)continue;
  info.querySelector(':scope>.resource-size-display')?.remove();const source=card.querySelector('.g-tags');if(source)source.insertAdjacentElement('afterend',badge(size));
  const allowed=root.isEditMode!==false&&document.body.classList.contains('admin-mode')&&(root.adminProfile?.role==='owner'||card.dataset.adminDraft==='1');
  let editor=info.querySelector('.resource-size-editor');if(!allowed){editor?.remove();continue}
  if(!editor){editor=document.createElement('label');editor.className='resource-size-editor';const text=document.createElement('span');text.textContent='资源大小（填写后保存云端）';const input=document.createElement('input');input.className='resource-size-input';input.type='text';input.maxLength=40;input.placeholder='例如 3.4GB、500MB；留空为待补充';input.value=size?.label||'';input.autocomplete='off';const status=document.createElement('span');status.className='resource-size-error';status.setAttribute('role','status');editor.append(text,input,status);info.querySelector(':scope>.resource-size-display')?.insertAdjacentElement('afterend',editor)}
  const input=editor.querySelector('input'),error=editor.querySelector('.resource-size-error');
  input.oninput=()=>{try{card.dataset.resourceSize=JSON.stringify(parseSize(input.value));delete input.dataset.invalid;error.textContent='';card.querySelectorAll('.resource-size-display:not(.resource-size-caption)').forEach(el=>{const updated=fromCard(card);el.textContent=updated?.label?'大小 '+updated.label:'大小待补充'});renderCaption(card,fromCard(card))}catch(e){input.dataset.invalid='1';error.textContent=e.message}};
 }
}
function detail(card){const body=document.getElementById('cardDetailBody');if(!body)return;body.querySelector('.detail-resource-size')?.remove();const anchor=body.querySelector('.detail-date')||body.querySelector('.detail-title-gradient');if(!anchor)return;const row=document.createElement('div');row.className='detail-resource-size';row.append(badge(fromCard(card)));anchor.insertAdjacentElement('afterend',row);requestAnimationFrame(()=>{const panel=body.querySelector('.quiet-detail-meta');if(panel&&row.isConnected)panel.append(row)})}
function dismissTutorial(){document.querySelectorAll('.tutorial-fab-shell').forEach(el=>el.classList.add('tutorial-fab-dismissed'))}
function installTutorialEntry(){
 if(document.getElementById('compactTutorialFab'))return;
 const source=document.querySelector('#cardDetailPage .detail-fab');if(!source)return;
 const shell=document.createElement('div');shell.className='detail-fab tutorial-fab-shell';source.before(shell);source.classList.remove('detail-fab');source.classList.add('tutorial-fab-open');shell.append(source);
 const close=document.createElement('button');close.type='button';close.className='tutorial-fab-close';close.setAttribute('aria-label','关闭解压教程入口');close.title='关闭解压教程入口，刷新页面后恢复';close.textContent='×';shell.append(close);
 const entry=shell.cloneNode(true);entry.id='compactTutorialFab';entry.classList.add('compact-tutorial-fab');document.body.append(entry);document.body.classList.add('has-compact-tutorial');
 document.querySelectorAll('.tutorial-fab-close').forEach(button=>button.onclick=event=>{event.stopPropagation();dismissTutorial()});
}
root.ResourceSize={parseSize,fromCard,render,detail,dismissTutorial};
if(typeof document!=='undefined'){
 installTutorialEntry();
 const refresh=root.refreshUI;if(typeof refresh==='function')root.refreshUI=function(...args){const result=refresh.apply(this,args);render();return result};
 const open=root.openCardDetail;if(typeof open==='function')root.openCardDetail=function(card,...args){const result=open.call(this,card,...args);detail(card);return result};
 const enter=root.enterAdmin;if(typeof enter==='function')root.enterAdmin=async function(...args){const result=await enter.apply(this,args);render();return result};
 const exit=root.exitAdmin;if(typeof exit==='function')root.exitAdmin=async function(...args){const result=await exit.apply(this,args);render();return result};
 render();const box=document.getElementById('box');if(box){let scheduled=false;new MutationObserver(()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;render()})}).observe(box,{childList:true})}
}
if(typeof module!=='undefined'&&module.exports)module.exports={parseSize};
})(typeof window!=='undefined'?window:globalThis);
