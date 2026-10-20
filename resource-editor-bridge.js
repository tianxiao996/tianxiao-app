(function(root){
'use strict';
let host=null,sync=Promise.resolve();
const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el};
root.renderResourceEditEntries=function(){
 for(const card of document.querySelectorAll('#box>.card')){
  card.querySelectorAll('.resource-edit-entry').forEach(el=>el.remove());
  if(!root.adminToken||root.adminProfile?.role!=='owner'||!document.body.classList.contains('admin-mode')||adminAuditMode)continue;
  const slot=card.querySelector('.card-preview-bottom');if(!slot)continue;
  const edit=node('button','resource-edit-entry','编辑资源');edit.type='button';edit.onclick=event=>{event.stopPropagation();root.openResourceEditor(card.dataset.cardId)};slot.append(edit);
 }
};
function closeHost(){
 if(!host)return;const old=host;host=null;old.layer.remove();for(const [el,value]of old.inert)if(el.isConnected)el.inert=value;
 document.body.style.overflow=old.overflow;const scroll=document.getElementById('mainScroll');if(scroll)scroll.scrollTop=old.mainTop;root.scrollTo(0,old.windowTop);
 if(old.focus?.isConnected)old.focus.focus({preventScroll:true});
 if(history.state?.resourceEditorHost===old.channel)history.back();
}
function requestClose(){if(!host)return;if(!host.ready){closeHost();return}host.frame.contentWindow.postMessage({type:'resource-editor:request-close',channel:host.channel},location.origin)}
root.openResourceEditor=function(id){
 if(!root.adminToken){root.showToast?.('请先登录管理员');return}if(host){host.frame.focus();return}
 const channel=crypto.randomUUID(),url=new URL('admin-resource.html',location.href);url.searchParams.set('embedded','1');url.searchParams.set('editorChannel',channel);url.searchParams.set('siteRevision',String(root.resourceSiteRevision||0));if(id==='new')url.searchParams.set('new','1');else if(id)url.searchParams.set('id',id);
 const layer=node('section','resource-editor-host'),frame=node('iframe'),close=node('button','resource-editor-host-close','×');layer.id='resourceEditorHost';layer.setAttribute('role','dialog');layer.setAttribute('aria-modal','true');layer.setAttribute('aria-label','资源编辑');frame.title='资源编辑';frame.src=url.href;close.type='button';close.setAttribute('aria-label','关闭资源编辑');close.onclick=requestClose;layer.append(frame,close);
 const focus=document.activeElement,inert=new Map();for(const el of document.body.children)if(el instanceof HTMLElement&&!['SCRIPT','STYLE','LINK'].includes(el.tagName)){inert.set(el,el.inert);el.inert=true}
 const scroll=document.getElementById('mainScroll');host={channel,layer,frame,inert,focus,overflow:document.body.style.overflow,mainTop:scroll?.scrollTop||0,windowTop:root.scrollY,ready:false};
 document.body.style.overflow='hidden';document.body.append(layer);history.pushState({...history.state,resourceEditorHost:channel},'',location.href);frame.focus();
};
root.addCard=function(){root.openResourceEditor('new')};
const enter=root.enterAdmin;
root.enterAdmin=async function(...args){
 const result=await enter.apply(this,args);
 document.getElementById('openResourceManager')?.remove();const buttons=document.getElementById('adminBarBtns')||document.getElementById('adminBar');const add=buttons&&[...buttons.querySelectorAll('button')].find(button=>button.getAttribute('onclick')==='addCard()');if(add)buttons.prepend(add);
 root.renderResourceEditEntries();return result;
};
function displayCard(id,revision,m){
 const card=node('div','card'+(m.isPinned?' is-pinned':'')+(m.isFav?' is-fav':''));card.dataset.cardId=id;card.dataset.resourceRevision=String(revision);card.dataset.directDownload=m.directDl||'';
 if('size' in m)card.dataset.resourceSize=JSON.stringify(m.size);
 for(const [field,attr]of [['rjCode','resourceRj'],['company','resourceCompany'],['translationTeam','resourceTranslation'],['officialUrl','resourceOfficialUrl']])if(field in m)card.dataset[attr]=m[field];
 const slider=node('div','slider-box'),previous=node('button','slide-btn prev','‹'),next=node('button','slide-btn next','›');previous.onclick=()=>changeSlide(previous,-1);next.onclick=()=>changeSlide(next,1);previous.type=next.type='button';slider.append(previous);
 const images=m.images?.length?m.images:['images/image_404.jpg'];for(const [i,url]of images.entries()){const img=node('img',i===0?'active':'');img.src=url;img.loading='lazy';img.draggable=false;slider.append(img)}slider.append(next,node('div','img-index','1 / '+images.length));
 const favorite=node('div','fav-btn');favorite.innerHTML=heartSvg(favorites.has(id));favorite.onclick=()=>toggleFavorite(favorite);slider.append(favorite);
 const info=node('div','info-box'),description=node('div','desc-wrap'),text=node('div','desc-text');String(m.desc||'').split('\n').forEach((line,i)=>{if(i)text.append(document.createElement('br'));text.append(document.createTextNode(line))});const expand=node('div','desc-expand-btn','展开简介');expand.onclick=()=>toggleDescExpand(expand);description.append(text,expand);
 const links=node('div','link-wrap'),placeholder=node('div','link-text');placeholder.dataset.kvPlaceholder='1';links.append(placeholder);info.append(node('div','g-name',m.title),node('div','g-tags',m.tags),description,links);card.append(slider,info);return card;
}
function settingsOf(page){return {banner:page.banner||[],notice:page.notice||'',categories:page.categories||[],galleryContent:page.galleryContent||'',commentUrl:page.commentUrl||''}}
async function syncRevision(data){
 const current=root.resourceSiteRevision;
 if(data.siteRevision===current)return;
 if(data.changed&&data.beforeSiteRevision===current&&data.siteRevision===current+1){root.resourceSiteRevision=data.siteRevision;return}
 // Only uncommon concurrent changes require a full read. Keep all local site
 // settings untouched; advance their base only if the server settings agree
 // with the snapshot originally loaded by this main page.
 try{const token=sessionStorage.getItem('ADMIN_TOKEN'),response=await fetch(WORKER_BASE+'/api/data?t='+Date.now(),{cache:'no-store',headers:{Authorization:'Bearer '+token}});if(!response.ok)throw Error('读取失败');const latest=await response.json();const page=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(latest.content),c=>c.charCodeAt(0))));
  if(root.resourceLoadedSettings&&JSON.stringify(settingsOf(page))===JSON.stringify(root.resourceLoadedSettings))root.resourceSiteRevision=latest.siteRevision;
  else root.showToast?.('其他页面修改了站点设置。本页未保存内容已保留，保存设置前请先核对云端版本。',7000);
 }catch(error){root.showToast?.('资源已保存；主页版本同步未完成，本页未保存的设置仍保留。',6500)}
}
async function applySaved(data){
 const box=document.getElementById('box'),old=box.querySelector('[data-card-id="'+CSS.escape(data.resourceId)+'"]'),scroll=document.getElementById('mainScroll'),top=scroll?.scrollTop||0;
 if(data.published){if(!data.metadata||data.metadata.id!==data.resourceId||!Array.isArray(data.metadata.images))return;const card=displayCard(data.resourceId,data.revision,data.metadata);if(old)old.replaceWith(card);else box.prepend(card);initSliderTrack(card.querySelector('.slider-box'))}
 else old?.remove();
 initCardFavorites();refreshUI();root.ResourceSize?.render();root.ResourceWork?.render();initImagePreview();root.applyViewCounts?.();root.updateNavCounts?.();autoSave();if(scroll)scroll.scrollTop=top;
 await syncRevision(data);
}
root.addEventListener('message',event=>{
 if(!host||event.origin!==location.origin||event.source!==host.frame.contentWindow||event.data?.channel!==host.channel)return;
 const data=event.data;if(data.type==='resource-editor:ready')host.ready=true;
 else if(data.type==='resource-editor:closed')closeHost();
 else if(data.type==='resource-editor:saved'&&typeof data.resourceId==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(data.resourceId)&&Number.isSafeInteger(data.siteRevision)&&Number.isSafeInteger(data.revision))sync=sync.then(()=>applySaved(data)).catch(()=>root.showToast?.('资源已保存，卡片同步失败；主页未刷新，请保留本页设置。',6500));
});
root.addEventListener('keydown',event=>{if(host&&event.key==='Escape'){event.preventDefault();requestClose()}});
root.addEventListener('popstate',()=>{if(host&&history.state?.resourceEditorHost!==host.channel){history.pushState({...history.state,resourceEditorHost:host.channel},'',location.href);requestClose()}});
})(window);
