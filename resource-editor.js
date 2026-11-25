(function(){
'use strict';
const API='https://api.tian-xiao.com',$=id=>document.getElementById(id),copy=value=>JSON.parse(JSON.stringify(value));
const state={admin:null,base:null,id:null,copySourceId:null,images:[],imageIndex:0,records:[],dirty:false,draftPending:false,busy:false,uploading:false,resources:[],presets:[],presetRevision:0,remarks:[],remarksLoaded:false,remarksError:false,remarkRevision:0,restoreRevision:null,lastSubmission:null,availableDraft:null};
const hostQuery=new URLSearchParams(location.search),embedded=window.parent!==window&&hostQuery.get('embedded')==='1',hostChannel=hostQuery.get('editorChannel');
const removedDraftIds=new Set(),resourceCache=new Map(),pendingResources=new Map(),listChanges=new Map();let navigation=0,listPending=null,listLoaded=false,loadingId=null;
let lastSiteRevision=Number(hostQuery.get('siteRevision'))||0;
function notifyHost(type,data={}){if(embedded)window.parent.postMessage({type:'resource-editor:'+type,channel:hostChannel,...data},location.origin)}
function leaveEditor(){if(!canLeave())return;state.dirty=false;if(embedded)notifyHost('closed');else location.assign('./')}
let pendingRemarkSettings=false;
if(embedded)document.documentElement.classList.add('embedded-editor');
window.addEventListener('message',event=>{if(!embedded||event.origin!==location.origin||event.source!==window.parent||event.data?.channel!==hostChannel)return;if(event.data.type==='resource-editor:request-close')leaveEditor();else if(event.data.type==='resource-editor:open-settings'&&event.data.settings==='remarks'){pendingRemarkSettings=true;openRemarkSettings()}});
window.addEventListener('keydown',event=>{if(embedded&&event.key==='Escape'){event.preventDefault();leaveEditor()}});
const names=['title','tags','gameVersion','rjCode','company','translationTeam','desc','officialUrl'];
const makeId=prefix=>prefix+crypto.randomUUID().replaceAll('-','');
function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node}
function button(text,action,cls){const node=el('button',cls,text);node.type='button';node.addEventListener('click',action);return node}
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error)}
function draftPrefix(){return 'tx-resource-editor:'+state.admin.id+':'}
function storageKey(id=state.id){return draftPrefix()+id}
function drafts(){
 const found=new Map(),prefix=draftPrefix();
 for(const store of [localStorage,sessionStorage])try{for(let i=0;i<store.length;i++){const key=store.key(i);if(!key?.startsWith(prefix))continue;try{const d=JSON.parse(store.getItem(key));if(d?.version!==1||key!==prefix+d.resourceId||!/^[a-zA-Z0-9_-]{1,160}$/.test(d.resourceId)||!Number.isSafeInteger(d.baseRevision)||d.baseRevision<0||!d.metadata||!Array.isArray(d.images)||!Array.isArray(d.records))continue;if(!found.has(d.resourceId)||(found.get(d.resourceId).savedAt||0)<(d.savedAt||0))found.set(d.resourceId,d)}catch(error){}}}catch(error){}
 return found;
}
function removeDraft(id){let removed=true;for(const store of [localStorage,sessionStorage])try{store.removeItem(storageKey(id));if(store.getItem(storageKey(id))!==null)removed=false}catch(error){removed=false}renderList();return removed}
function draftFor(id){return drafts().get(id)}
function syncControls(){const disabled=state.busy||!!loadingId;$('copyResource').disabled=disabled||state.uploading;$('deleteResource').disabled=disabled||state.uploading;$('editorFields').disabled=disabled;$('saveResource').disabled=disabled||state.uploading;$('saveDraft').disabled=disabled||state.uploading;$('reloadResource').disabled=disabled||state.uploading;$('newResource').disabled=state.busy||state.uploading;$('saveResource').textContent=state.busy?'正在发布…':'发布资源';$('deleteDraft').textContent=state.base?.cloudDraft?'删除云端草稿':state.base?.revision===0?'删除草稿':'删除本机草稿';$('deleteDraft').disabled=disabled||state.uploading||!state.id||(!state.base?.cloudDraft&&!draftFor(state.id)&&!state.dirty);$('discardDraft').disabled=disabled||state.uploading}
function setLoading(id){loadingId=id;syncControls();$('resourceLoading').hidden=!id;if(id){status('正在读取所选资源…');$('resourceLoadingText').textContent='正在读取所选资源…';$('retryResource').hidden=true}else $('retryResource').hidden=true;renderList()}
function loadedView(){if(matchMedia('(max-width:720px)').matches)$('resourceBrowser').open=false;window.scrollTo({top:0})}

function safeUrl(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&value===value.trim()}catch(error){return false}}
async function request(path,options={}){
 const verify=path==='/api/admin/session'&&(!options.method||options.method==='GET'),readOnly=!options.method||options.method==='GET';
 for(let attempt=0;attempt<(readOnly?2:1);attempt++){
  const token=sessionStorage.getItem('ADMIN_TOKEN');if(!token){const error=Error('管理员登录已失效，请返回网站登录');error.status=401;throw error}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),readOnly?15000:45000);
  try{const response=await fetch(API+path,{...options,signal:controller.signal,cache:'no-store',headers:{Authorization:'Bearer '+token,...(!(options.body instanceof FormData)?{'Content-Type':'application/json'}:{}),...options.headers}});let data;
   try{data=await response.json()}catch(cause){const error=Error('服务器未返回有效数据，编辑内容已保留');if(response.status>=400)error.status=response.status;throw error}
   if(!response.ok||data.success===false){const error=Error(data.error||'请求失败');error.status=response.status;throw error}return data;
  }catch(error){if(readOnly&&attempt===0&&(!error.status||error.status>=500)){await new Promise(resolve=>setTimeout(resolve,400));continue}if(error.name==='AbortError')throw Error(verify?'验证连接超时，请重试':readOnly?'资源读取超时，请重试；草稿和当前内容已保留':'请求超时，保存结果可能尚未确认。请保留草稿后重试或重新读取核对。');throw error}finally{clearTimeout(timer)}
 }
}
function rawDraft(){return {version:1,resourceId:state.id,baseRevision:state.base.revision,copySourceId:state.copySourceId,metadata:Object.fromEntries(names.map(name=>[name,$(name).value])),sizeText:$('size').value,isPinned:$('isPinned').checked,images:copy(state.images),records:copy(state.records),restoreRevision:state.restoreRevision,lastSubmission:state.lastSubmission,baseSnapshot:copy(state.base),createdAt:draftFor(state.id)?.createdAt||draftFor(state.id)?.savedAt||Date.now(),savedAt:Date.now()}}
let draftTimer;
function persistDraft(force=false){
 if(!state.id||!state.base)return false;
 // Viewing an existing draft is not an edit. Preserve its timestamp and list position.
 if(!force&&!state.draftPending&&draftFor(state.id))return true;
 try{localStorage.setItem(storageKey(),JSON.stringify(rawDraft()));sessionStorage.removeItem(storageKey());state.draftPending=false;$('draftState').textContent='草稿已保存到本机，尚未发布';$('saveState').textContent=state.base.published?'修改草稿已保存 · 尚未发布':'新资源草稿已保存 · 尚未发布';renderList();return true}
 catch(error){$('draftState').textContent='本机保存失败，请导出草稿';status('无法保存本机草稿，请点击“导出草稿”保存一份',true);return false}
}
function changed(){state.dirty=true;state.draftPending=true;syncControls();$('saveState').textContent='修改尚未暂存';clearTimeout(draftTimer);draftTimer=setTimeout(persistDraft,250);$('editorTitle').textContent=$('title').value||'未命名草稿'}
function busy(value){state.busy=value;syncControls()}
function canLeave(){if(state.busy||state.uploading)return false;if(!state.dirty)return true;clearTimeout(draftTimer);return persistDraft()}
function renderList(){
 if(!state.admin)return;
 syncControls();const saved=drafts(),entries=new Map(state.resources.filter(r=>!removedDraftIds.has(r.id)).map(r=>[r.id,{...r,published:r.published!==false}]));
 for(const [id,d]of saved){if(removedDraftIds.has(id))continue;if(state.admin.role==='contributor'&&d.baseRevision>0&&listLoaded&&!entries.has(id))continue;const cloud=entries.get(id);entries.set(id,{...(cloud||{id,revision:d.baseRevision,published:false}),copySourceId:d.copySourceId||d.baseSnapshot?.copySourceId||cloud?.copySourceId||null,title:d.metadata.title||cloud?.title||'未命名草稿',tags:d.metadata.tags||'',draft:d})}
 const query=$('resourceSearch').value.trim().toLowerCase(),filter=$('resourceFilter').value;
 const matched=[...entries.values()].filter(r=>(filter!=='mine'||(r.publisherAccountId||r.draft&&state.admin.id)===state.admin.id)&&(filter!=='drafts'||r.draft||r.cloudDraft)&&(filter!=='published'||r.published)&&(r.title+' '+r.tags+' '+r.id).toLowerCase().includes(query));
 const created=r=>r.published||r.cloudDraft?r.createdAt||0:r.draft?.createdAt||r.draft?.savedAt||0;matched.sort((a,b)=>created(b)-created(a));
 $('resourceCount').textContent='('+entries.size+')';$('draftCount').textContent='草稿 '+[...entries.values()].filter(r=>r.draft||r.cloudDraft).length;$('resourceList').replaceChildren();
 for(const resource of matched.slice(0,100)){const item=button('',()=>loadResource(resource.id),resource.id===state.id?'selected':'');item.dataset.resourceId=resource.id;item.title='资源 ID：'+resource.id;item.setAttribute('aria-current',String(resource.id===state.id));item.append(el('span','',resource.title||'未命名资源'),el('small','',(resource.published?'已发布 · 版本 '+resource.revision:'未发布草稿')+(resource.draft?' · 有本机草稿':'')));if(resource.id===loadingId)item.append(el('small','','正在读取…'));$('resourceList').append(item)}
 if(matched.length>100)$('resourceList').append(el('p','hint','仅显示前100项，请输入编号或标题查找。'));if(!matched.length)$('resourceList').append(el('p','hint',listLoaded||saved.size?'没有匹配资源':'资源列表尚未读取，可点击重试'));
}
async function loadList(force=false){
 if(listPending)return listPending;if(listLoaded&&!force){renderList();return}
 $('listStatus').textContent='正在读取资源列表…';$('refreshList').disabled=true;
 listPending=(async()=>{try{const result=await request('/api/admin/resources');if(!Array.isArray(result.resources))throw Error('资源列表格式无效');for(const id of Array.isArray(result.deletedDraftIds)?result.deletedDraftIds:[]){if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(id))continue;removedDraftIds.add(id);removeDraft(id);if(state.id===id){clearDraftView(id);status('这份云端草稿已删除，旧的本机编辑副本已移出列表。')}}const merged=new Map(result.resources.filter(r=>!removedDraftIds.has(r.id)).map(r=>[r.id,r])),recent=[];for(const [id,r]of listChanges){if(removedDraftIds.has(id))continue;if(!merged.has(id))recent.unshift(r);else if(merged.get(id).revision<r.revision)merged.set(id,r)}state.resources=[...recent,...merged.values()];listLoaded=true;
  for(const [id,r]of resourceCache){const current=state.resources.find(item=>item.id===id);if(!current||current.revision!==r.revision)resourceCache.delete(id)}
  $('listStatus').textContent='';$('refreshList').textContent='刷新列表';renderList()
 }catch(error){$('listStatus').textContent='资源列表读取失败：'+error.message;$('refreshList').textContent='重试列表';renderList()}finally{listPending=null;$('refreshList').disabled=false}})();return listPending;
}
function newMetadata(id){return {id,title:'',tags:'',desc:'',images:[],isPinned:false,isFav:false,directDl:''}}
function showResource(resource){
 clearTimeout(draftTimer);
 if(Number.isSafeInteger(resource.siteRevision))lastSiteRevision=resource.siteRevision;state.imageIndex=0;state.id=resource.id;state.copySourceId=resource.copySourceId||resource.copyOrigin?.sourceId||null;state.base=copy(resource);state.images=resource.metadata.images.map(url=>({id:makeId('img_'),url}));state.records=resource.records.map(r=>({...r,resourceId:resource.id}));state.restoreRevision=null;state.lastSubmission=null;state.dirty=false;state.draftPending=false;state.availableDraft=null;
 for(const name of names)$(name).value=resource.metadata[name]||'';$('size').value=resource.metadata.size?.label||'';$('isPinned').checked=!!resource.metadata.isPinned;
 $('editorTitle').textContent=resource.metadata.title||'新增资源';$('resourceId').textContent=resource.id;$('resourceState').textContent=resource.published?'编辑已发布资源':resource.cloudDraft?'云端未发布草稿':resource.revision?'已移出列表的资源':'新增资源';$('copyResource').hidden=!resource.published;$('deleteResource').hidden=!resource.published||state.admin.role!=='owner';$('revision').textContent=resource.revision?'版本 '+resource.revision:'草稿';$('linkState').textContent='链接资料：'+(resource.requiresRepair?'待核对或修复':resource.linkState==='active'?'已整理':'待核对');
 $('draftBanner').hidden=true;$('historyList').replaceChildren();$('historyDetails').open=false;delete $('historyDetails').dataset.loaded;
 $('editor').hidden=false;$('welcome').hidden=true;$('newResource').hidden=false;document.querySelector('[data-editor-tab=history]').hidden=resource.revision===0;setEditorTab(activeEditorTab);renderImages();renderLinks();renderList();$('saveState').textContent=resource.published?'已发布 · 版本 '+resource.revision:resource.cloudDraft?'云端草稿 · 尚未发布':resource.revision?'已移出列表':'新资源 · 尚未填写';$('draftState').textContent='编辑内容自动保存为本机草稿';
 const address=new URL(location.href);address.searchParams.set('id',resource.id);if(resource.revision===0)address.searchParams.set('new','1');else address.searchParams.delete('new');history.replaceState(null,'',address.href);
 if(resource.requiresRepair)status('此资源的链接资料需要核对。请检查每组网址、提取码、解压码和备注后保存。',true);
 else status(resource.revision?'已读取当前云端资源。':'填写内容后点击保存云端，才会发布新资源。');
 try{const saved=draftFor(resource.id);if(saved){state.availableDraft=saved;$('draftBanner').hidden=false;$('draftMessage').textContent='本机留有 '+new Date(saved.savedAt).toLocaleString('zh-CN')+' 的草稿，可恢复继续编辑。'}}catch(error){status('草稿读取失败，云端内容已正常加载',true)}

}

async function loadResource(id,skipGuard=false,force=false){
 if(removedDraftIds.has(id)){status('这份草稿已删除，请选择其他资源。');return}
 if(!force&&(id===loadingId||(id===state.id&&!loadingId)))return;
 if(!skipGuard&&!canLeave())return;const turn=++navigation;
 if(state.admin?.role==='contributor'){await loadList();if(!listLoaded){status('请先重试资源列表，再打开编辑资料。',true);return}if(!state.resources.some(r=>r.id===id)&&draftFor(id)?.baseRevision!==0){status('只能编辑自己发布的资源。',true);return}}
 const draft=!force&&draftFor(id);setLoading(null);$('resourceLoading').hidden=true;
 try{
  let resource=!force&&resourceCache.get(id);
  if(draft?.baseRevision===0)resource={id,revision:0,siteRevision:lastSiteRevision,published:false,copySourceId:draft.copySourceId||draft.baseSnapshot?.copySourceId||null,metadata:newMetadata(id),records:[]};
  const listed=state.resources.find(r=>r.id===id);if(!resource&&draft?.baseSnapshot?.id===id&&(!listed||listed.revision===draft.baseSnapshot.revision))resource=copy(draft.baseSnapshot);
  if(!resource){
   setLoading(id);$('welcome').hidden=true;if(!state.id)$('editor').hidden=true;
   let pending=pendingResources.get(id);
   if(!pending){pending=request('/api/admin/resource?id='+encodeURIComponent(id)).then(result=>{if(result.contractVersion!==1||result.resource?.id!==id)throw Error('资源数据格式或 ID 不匹配');resourceCache.set(id,copy(result.resource));return result.resource}).finally(()=>{if(pendingResources.get(id)===pending)pendingResources.delete(id)});pendingResources.set(id,pending)}
   resource=await pending;
  }
  if(turn!==navigation)return;setLoading(null);showResource(resource);if(draft){if(resource.published&&resource.records.length&&!draft.records.length)status('云端仍保留 '+resource.records.length+' 组下载链接；本机另有空链接草稿，未自动覆盖当前显示。需要时可手动恢复该草稿。当前资源 ID：'+resource.id,true);else applyDraft(draft,true)}loadedView();
 }catch(error){if(turn!==navigation)return;setLoading(null);$('resourceLoading').hidden=false;$('resourceLoadingText').textContent='所选资源读取失败：'+error.message+(state.id?'。当前仍保留上一份内容。':'。未载入编辑内容。');$('retryResource').hidden=false;$('retryResource').onclick=()=>loadResource(id,false,true);status('读取未完成，请重试；不会将读取失败的资源当作新增资源。',true);if([401,403].includes(error.status)){resourceCache.clear();$('editor').hidden=true}}
}
function createResource(id){
 if(!canLeave())return;++navigation;setLoading(null);id=id||'card_'+Date.now()+'_'+crypto.randomUUID().slice(0,9).replaceAll('-','');
 if(draftFor(id)){loadResource(id,true);return}
 showResource({id,revision:0,siteRevision:lastSiteRevision,published:false,metadata:newMetadata(id),records:[],legacyArchive:{text:'',urls:[]}});state.dirty=true;state.draftPending=true;persistDraft(true);status('已新增本机草稿，点击“发布资源”才会对外展示。');window.scrollTo({top:0});
}
function parseSize(value){const text=value.trim();if(!text)return null;const match=/^(\d+(?:\.\d+)?)\s*(B|Ki?B?|Mi?B?|Gi?B?|Ti?B?)$/i.exec(text);if(!match)throw Error('大小请填写如 3.4GB、500MB，或留空');const unit=match[2].toUpperCase().replace('IB','B'),power={B:0,K:1,KB:1,M:2,MB:2,G:3,GB:3,T:4,TB:4}[unit],bytes=Math.round(Number(match[1])*1024**power);if(!Number.isSafeInteger(bytes)||bytes<=0)throw Error('资源大小必须大于0且在有效范围内');return {bytes,label:String(Number(match[1]))+' '+['B','KB','MB','GB','TB'][power],source:'manual'}}
function payload(){
 const metadata={...state.base.metadata,id:state.id};for(const name of names)metadata[name]=$(name).value;
 metadata.images=state.images.map(image=>image.url.trim());metadata.isPinned=state.admin.role==='owner'?$('isPinned').checked:!!state.base.metadata.isPinned;
 metadata.directDl='';
 if(state.admin.role!=='owner'){metadata.isFav=!!state.base.metadata.isFav}
 if($('size').value!==(state.base.metadata.size?.label||''))metadata.size=parseSize($('size').value);
 if(!metadata.title.trim()){setEditorTab('basic');$('title').focus();throw Error('请填写资源标题')}
 metadata.officialUrl=metadata.officialUrl.trim();if(metadata.officialUrl&&!safeUrl(metadata.officialUrl)){setEditorTab('basic');$('officialUrl').focus();throw Error('正版链接请填写完整的 HTTP/HTTPS 网址，或留空')}
 if(metadata.images.length>100||metadata.images.some(url=>!safeUrl(url)))throw Error('图片链接无效，请填写完整的 HTTP/HTTPS 网址，或删除空图片组');
 const records=state.records.map(record=>({...record,resourceId:state.id,url:record.url.trim(),driveName:record.driveName.trim()||ResourceLinkEditor.detectDrive(record.url)}));
 const ids=new Set(),urls=new Set();for(let i=0;i<records.length;i++){const r=records[i];if(!safeUrl(r.url))throw Error('第 '+(i+1)+' 组下载链接无效');if(ids.has(r.id)||urls.has(r.url))throw Error('存在重复链接或 ID，请逐组核对');ids.add(r.id);urls.add(r.url)}
 return {contractVersion:1,cardId:state.id,baseRevision:state.base.revision,metadata,records,...(state.copySourceId&&state.base.revision===0?{copySourceId:state.copySourceId}:{}),...(state.restoreRevision?{restoreRevision:state.restoreRevision}:{})};
}
function move(list,index,step,render){const target=index+step;if(target<0||target>=list.length)return;[list[index],list[target]]=[list[target],list[index]];changed();render()}
function rowHeader(label,list,index,render){const head=el('div','row-head');head.append(el('h3','',label));const up=button('上移',()=>move(list,index,-1,render)),down=button('下移',()=>move(list,index,1,render));up.disabled=index===0;down.disabled=index===list.length-1;
 head.append(up,down,button('删除',()=>{if(!confirm('删除这一组？保存云端后才生效，历史版本仍会保留。'))return;list.splice(index,1);changed();render()},'danger'));return head;
}
async function copyText(text){try{await navigator.clipboard.writeText(text);status('已复制')}catch(error){const input=el('textarea');input.value=text;document.body.append(input);input.select();const copied=document.execCommand('copy');input.remove();status(copied?'已复制':'复制失败，请手动选择复制',!copied)}}
function galleryArrow(direction,action){
 const node=button('',action,'gallery-arrow '+direction);node.setAttribute('aria-label',direction==='previous'?'上一张图片':'下一张图片');
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
 const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',direction==='previous'?'M15 4 L7 12 L15 20':'M9 4 L17 12 L9 20');svg.append(path);node.append(svg);return node;
}
function switchImage(step){if(state.images.length<2)return;state.imageIndex=(state.imageIndex+step+state.images.length)%state.images.length;renderImages()}
function renderImages(){
 const gallery=$('images');gallery.replaceChildren();$('imageCount').textContent=state.images.length+' 张';
 if(!state.images.length){state.imageIndex=0;gallery.append(el('p','hint','尚未添加图片，可点击加图填写链接或上传。'));return}
 state.imageIndex=Math.max(0,Math.min(state.imageIndex,state.images.length-1));
 const index=state.imageIndex,image=state.images[index],card=el('article','image-card'),preview=el('div','image-preview');
 preview.tabIndex=0;preview.setAttribute('role','region');preview.setAttribute('aria-label','图片预览，左右方向键切换');
 const img=el('img');img.alt='图片 '+(index+1)+' 预览';img.referrerPolicy='strict-origin-when-cross-origin';
 const error=el('span','image-error','预览不可用，请核对图片链接');error.hidden=true;
 img.onerror=()=>{img.hidden=true;error.hidden=false};img.onload=()=>{img.hidden=false;error.hidden=true};
 function updatePreview(){img.hidden=false;error.hidden=true;img.src=safeUrl(image.url.trim())?(image.displayUrl||image.url.trim()):'images/image_404.jpg'}
 updatePreview();preview.append(img,error);
 if(state.images.length>1)preview.append(galleryArrow('previous',()=>switchImage(-1)),galleryArrow('next',()=>switchImage(1)));
 preview.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();switchImage(event.key==='ArrowLeft'?-1:1);gallery.querySelector('.image-preview').focus({preventScroll:true})}});
 const replace=button('更换图片',()=>{if(state.busy||state.uploading)return;$('replaceUpload').click()},'gallery-replace');replace.disabled=state.uploading;preview.append(replace);
 const count=el('span','gallery-count',(index+1)+' / '+state.images.length);count.setAttribute('aria-live','polite');preview.append(count);card.append(preview);
 const controls=el('div','toolbar image-tools');
 function reorder(step){const target=index+step;if(target<0||target>=state.images.length)return;[state.images[index],state.images[target]]=[state.images[target],state.images[index]];state.imageIndex=target;changed();renderImages()}
 const before=button('前移',()=>reorder(-1)),after=button('后移',()=>reorder(1));before.disabled=index===0;after.disabled=index===state.images.length-1;
 controls.append(before,after,button('删图',()=>{if(state.uploading)return status('请等待图片上传完成',true);if(!confirm('删除当前图片？保存云端后才生效，历史版本仍会保留。'))return;state.images.splice(index,1);changed();renderImages()},'danger'));card.append(controls);
 const label=el('label','','当前图片链接'),input=el('input');input.type='url';input.value=image.url;input.maxLength=4096;input.setAttribute('aria-label','当前图片链接');
 input.addEventListener('input',()=>{image.url=input.value;image.displayUrl='';changed();updatePreview()});input.addEventListener('change',updatePreview);label.append(input);card.append(label);
 const actions=el('div','image-actions');actions.append(button('复制图链',()=>copyText(input.value.trim())),button('查看原图',()=>{if(!safeUrl(input.value.trim()))return status('请填写有效图片链接',true);window.open(input.value.trim(),'_blank','noopener,noreferrer')}));card.append(actions);gallery.append(card);
}
function linkField(record,index,key,name,max){const label=el('label',['url','remark','unzipPassword'].includes(key)?'full':'',name),input=el(key==='remark'?'textarea':'input');input.value=record[key]||'';input.maxLength=max;input.dataset.field=key;input.setAttribute('aria-label','第'+(index+1)+'组'+name);if(key==='remark')input.rows=2;else input.type='text';
 if(key==='url'){input.inputMode='url';input.placeholder='https://…';input.addEventListener('paste',event=>{const text=event.clipboardData?.getData('text/plain')||'';if(/https?:\/\//i.test(text)&&(/[\r\n]/.test(text)||/提取码|分享的文件/.test(text))){event.preventDefault();$('shareText').value=text;$('shareText').closest('details').open=true;recognize();$('shareText').scrollIntoView({block:'center'});status('已放入分享识别区，请核对后追加或填入选中组。')}})}
 input.addEventListener('input',()=>{record[key]=input.value;changed()});label.append(input);return label;
}
function renderLinks(){
 $('links').replaceChildren();$('linkCount').textContent=state.records.length+' 组';$('linkState').textContent='当前表单 '+state.records.length+' 组'+(state.base.published?' · 云端 '+state.base.records.length+' 组':' · 尚未发布');
 state.records.forEach((record,index)=>{const card=el('article','link-card');card.dataset.linkId=record.id;const head=rowHeader((record.channel==='external'?'外盘下载 ':'网盘链接 ')+(index+1),state.records,index,renderLinks);head.append(el('small','',record.id));card.append(head);const fields=el('div','fields');
  for(const [key,label,max] of [['url','链接',4096],['driveName','网盘名称',100],['extractionCode','提取码',500],['unzipPassword','解压码',2000],['remark','备注',2000]]){
   const field=linkField(record,index,key,label,max);
   if(key==='unzipPassword'&&state.presets.length){const quick=el('div','quick-code'),select=el('select');select.setAttribute('aria-label','第'+(index+1)+'组快捷解压码');const blank=el('option','','快捷解压码');blank.value='';select.append(blank);for(const preset of state.presets){const option=el('option','',preset.label);option.value=preset.id;select.append(option)}const input=field.querySelector('input');select.onchange=()=>{const preset=state.presets.find(p=>p.id===select.value);if(!preset)return;record.unzipPassword=preset.value;input.value=preset.value;changed()};quick.append(input,select);field.append(quick)}if(key==='remark'){const select=el('select');select.className='quick-remark';select.setAttribute('aria-label','第'+(index+1)+'组快捷备注');const blank=el('option','',state.remarks.length?'选择快捷备注':!state.remarksLoaded?'正在读取快捷备注':state.remarksError?'快捷备注读取失败':'暂无快捷备注');blank.value='';select.disabled=!state.remarks.length;select.append(blank);for(const preset of state.remarks){const option=el('option','',preset.label);option.value=preset.id;select.append(option)}select.onchange=()=>{const preset=state.remarks.find(p=>p.id===select.value);if(!preset)return;record.remark=preset.value;field.querySelector('textarea').value=preset.value;changed();select.value=''};field.append(select);if(state.admin.role==='owner')field.append(button('设置快捷备注',openRemarkSettings,'quick-remark-settings'));if(state.remarksError)field.append(button('重试读取快捷备注',loadRemarks))}fields.append(field)
  }card.append(fields);$('links').append(card)
 });if(!state.records.length)$('links').append(el('p','hint','暂无下载链接。可以粘贴识别，也可以手动添加。'));
}
function ownerUnzipDefault(){
 if(state.admin?.id!=='initial-owner-v2'||state.admin.role!=='owner')return '';
 return state.presets.find(preset=>preset.label.trim()==='天笑')?.value||'';
}
function emptyRecord(){return {id:makeId('lnk_'),resourceId:state.id,url:'',driveName:'',extractionCode:'',unzipPassword:ownerUnzipDefault(),remark:''}}
function appendShareRecords(result){
 const known=new Set(state.records.map(record=>record.url.trim()));
 const fresh=result.records.filter(record=>!known.has(record.url));
 const patches=[];
 for(const incoming of result.records){
  const existing=state.records.find(r=>r.channel!=='external'&&r.url.trim()===incoming.url);
  if(!existing)continue;
  const patch={};
  if(!existing.remark?.trim()&&incoming.remark)patch.remark=incoming.remark;
  if(!existing.unzipPassword&&ownerUnzipDefault())patch.unzipPassword=ownerUnzipDefault();
  if(Object.keys(patch).length)patches.push({existing,patch});
 }
 if(!fresh.length&&!patches.length){
  $('importStatus').textContent=result.records.length?'这些链接已在列表中。':result.warnings.join('；');
  return;
 }
 if(state.records.length+fresh.length>64){
  $('importStatus').textContent='最多可保存64组链接，本次未导入，请调整后重试。';
  return;
 }
 for(const {existing,patch} of patches)Object.assign(existing,patch);
 for(const record of fresh){
  state.records.push({...emptyRecord(),url:record.url,driveName:record.driveName,
   extractionCode:record.extractionCode,remark:record.remark});
 }
 changed();renderLinks();
 $('shareText').value='';
 $('importPreview').replaceChildren();
 const notes=[...new Set([...result.warnings,...fresh.flatMap(record=>record.warnings)])];
 $('importStatus').textContent='已导入 '+fresh.length+' 组网盘链接。'+(patches.length?'已补填 '+patches.length+' 组已有链接。':'')+notes.join('；');
}
function recognize(){
 try{const result=ResourceLinkEditor.parseShareText($('shareText').value);$('importPreview').replaceChildren();$('importStatus').textContent=result.warnings.join('；')||'识别到 '+result.records.length+' 组，请核对后添加。';
  result.records.forEach(record=>{const item=el('div','import-item');item.append(el('strong','',[record.driveName||'未知网盘',record.remark].filter(Boolean).join(' · ')),el('p','',record.url),el('p','','提取码：'+(record.extractionCode||'未识别')));for(const warning of record.warnings||[])item.append(el('p','hint',warning));$('importPreview').append(item)});
  if(!result.records.length)return;const actions=el('div','toolbar');actions.append(button('追加为新链接',()=>appendShareRecords(result)));
  if(result.records.length===1&&state.records.length){const select=el('select');select.setAttribute('aria-label','选择要填入的链接组');state.records.forEach((record,i)=>{const option=el('option','','第'+(i+1)+'组 · '+(record.remark||record.driveName||'未命名'));option.value=i;select.append(option)});actions.append(select,button('填入选中组',()=>{const index=Number(select.value);if(!state.records[index])return;if(!confirm('替换此组的网址和提取码？手填网盘名称、解压码和备注会保留。'))return;state.records[index]=ResourceLinkEditor.applyDetected(state.records[index],result.records[0]);if(!state.records[index].unzipPassword)state.records[index].unzipPassword=ownerUnzipDefault();changed();renderLinks();$('importStatus').textContent='已填入选中组，解压码和备注未改动。'}))}$('importPreview').append(actions);
 }catch(error){$('importStatus').textContent=error.message}
}
let presetDraft=[];
function renderPresets(){
 $('presetRows').replaceChildren();presetDraft.forEach((preset,index)=>{const row=el('div','preset-row');for(const [key,label,max] of [['label','名称',80],['value','解压码',2000]]){const wrap=el('label','',label),input=el('input');input.value=preset[key];input.maxLength=max;input.addEventListener('input',()=>preset[key]=input.value);wrap.append(input);row.append(wrap)}row.append(button('删除',()=>{presetDraft.splice(index,1);renderPresets()},'danger'));$('presetRows').append(row)})
}
async function loadPresets(){try{const result=await request('/api/admin/link-presets');state.presets=result.presets;state.presetRevision=result.revision;presetDraft=copy(result.presets);renderPresets();if(state.id)renderLinks()}catch(error){$('presetStatus').textContent='快捷码暂不可用：'+error.message}}
async function uploadImages(replacing=false){
 if(state.uploading||state.busy)return status('请等待当前操作完成',true);
 const picker=$(replacing?'replaceUpload':'imageUpload'),targetId=replacing?state.images[state.imageIndex]?.id:null,files=[...picker.files];picker.value='';if(!files.length)return;if(replacing&&!targetId)return;if(!replacing&&state.images.length+files.length>100)return status('每个资源最多100张图片',true);
 state.uploading=true;$('imageUpload').disabled=true;$('saveResource').disabled=true;let success=0;
 try{for(let i=0;i<files.length;i++){const file=files[i];if(!file.type.startsWith('image/'))continue;$('uploadStatus').textContent='正在上传 '+(i+1)+' / '+files.length+'：'+file.name;const body=new FormData();body.append('file',file);body.append('folder',$('imageFolder').value);const compression=await ResourceImageTools.appendVariants(body,file);if(compression.warning)status(compression.warning,true);
   try{const result=await request('/api/admin/upload-image',{method:'POST',body});if(!safeUrl(result.url||''))throw Error('上传未返回有效图片地址');if(result.warning)status(result.warning,true);if(replacing){const target=state.images.find(image=>image.id===targetId);if(!target)throw Error('待更换图片已移除');target.url=result.url;target.displayUrl=result.optimized?.detail||''}else{state.images.push({id:makeId('img_'),url:result.url,displayUrl:result.optimized?.detail||''});state.imageIndex=state.images.length-1}success++;changed();renderImages()}catch(error){status('图片 '+file.name+' 上传失败：'+error.message,true)}
  }$('uploadStatus').textContent='已上传 '+success+' / '+files.length+' 张，保存资源后才会使用这些图片。';
 }finally{state.uploading=false;$('imageUpload').disabled=false;$('saveResource').disabled=state.busy;renderImages()}
}
async function save(event){
 event.preventDefault();if(state.busy||state.uploading||loadingId||!state.id)return;let body;
 try{body=payload()}catch(error){status(error.message,true);return}
 if((state.base.cloudDraft||state.base.revision===0&&state.id.startsWith('card_copy_'))&&!body.records.length){status('当前草稿尚未填写下载链接，不能发布。请填写新资源的下载链接。',true);return}
 if(!body.records.length&&!confirm(state.base.published&&state.base.records.length?'这将清空当前已发布资源的 '+state.base.records.length+' 组下载链接。资源 ID：'+state.id+'。确认仍要发布这份空链接内容吗？':'此资源没有下载链接，仍要保存云端吗？'))return;
 const beforeSiteRevision=state.base.siteRevision;const fingerprint=JSON.stringify(body);if(state.lastSubmission?.fingerprint!==fingerprint)state.lastSubmission={fingerprint,requestId:makeId('edit_')};body.requestId=state.lastSubmission.requestId;persistDraft(true);busy(true);status('正在保存当前资源的资料、图片和链接…');
 try{const result=await request('/api/admin/resource',{method:'POST',body:JSON.stringify(body)});if(result.contractVersion!==1||result.resource.id!==state.id)throw Error('保存响应与当前资源不匹配，请保留草稿并重新读取核对');
  clearTimeout(draftTimer);const key=storageKey();removeDraft(state.id);resourceCache.set(state.id,copy(result.resource));showResource(result.resource);$('saveState').textContent=result.unchanged?'内容未变，仍为当前云端版本':'已保存云端 · 版本 '+result.resource.revision;status('当前资源已保存云端，其他资源和站点设置未改动。');notifyHost('saved',{resourceId:result.resource.id,revision:result.resource.revision,metadata:result.resource.metadata,hasExternal:result.resource.records.some(r=>r.channel==='external'),hasCloud:result.resource.records.some(r=>r.channel!=='external'),published:result.resource.published,siteRevision:result.resource.siteRevision,beforeSiteRevision,changed:!result.unchanged});

  const summary={id:result.resource.id,publisherAccountId:result.resource.publisherAccountId,title:result.resource.metadata.title,tags:result.resource.metadata.tags,revision:result.resource.revision,createdAt:result.resource.createdAt||0,published:result.resource.published,copySourceId:result.resource.copySourceId||null},index=state.resources.findIndex(r=>r.id===summary.id);listChanges.set(summary.id,summary);if(index>=0)state.resources[index]=summary;else state.resources.unshift(summary);renderList();
 }catch(error){status(error.message,true);$('saveState').textContent='尚未确认保存，编辑内容已保留';persistDraft()}
 finally{busy(false)}
}
function applyDraft(draft,fromStorage=false){
 if(state.busy||state.uploading||loadingId)throw Error('请等待当前操作完成后再载入草稿');
 if(!draft||draft.version!==1||draft.resourceId!==state.id||!Number.isSafeInteger(draft.baseRevision)||draft.baseRevision<0||!draft.metadata||!Array.isArray(draft.images)||draft.images.length>100||!Array.isArray(draft.records)||draft.records.length>64)throw Error('草稿格式无效，或不属于当前资源');
 const ids=new Set();for(const r of draft.records){if(!/^lnk_[a-zA-Z0-9_-]{8,96}$/.test(r.id)||ids.has(r.id)||r.resourceId!==state.id)throw Error('草稿链接 ID 或资源绑定无效');ids.add(r.id);for(const key of ['url','driveName','extractionCode','unzipPassword','remark'])if(typeof r[key]!=='string')throw Error('草稿下载字段不完整')}
 for(const image of draft.images)if(typeof image.url!=='string')throw Error('草稿图片格式无效');
 const cloudRevision=state.base.revision;for(const name of names)if(typeof draft.metadata[name]!=='string')throw Error('草稿资料字段不完整');for(const name of names)$(name).value=draft.metadata[name]
 $('size').value=String(draft.sizeText||'');$('isPinned').checked=!!draft.isPinned;state.images=copy(draft.images);state.records=copy(draft.records);state.base.revision=draft.baseRevision;state.restoreRevision=draft.restoreRevision||null;state.lastSubmission=draft.lastSubmission||null;state.availableDraft=null;state.copySourceId=draft.copySourceId||draft.baseSnapshot?.copySourceId||state.copySourceId;$('draftBanner').hidden=true;renderImages();renderLinks();
 if(fromStorage){
  state.dirty=true;state.draftPending=false;$('editorTitle').textContent=$('title').value||'未命名草稿';
  $('draftState').textContent='草稿已保存到本机，尚未发布';$('saveState').textContent=state.base.published?'修改草稿已保存 · 尚未发布':'新资源草稿已保存 · 尚未发布';
 }else changed();
 status(cloudRevision===draft.baseRevision?'已打开本机草稿，继续编辑后可发布。':'草稿来自版本 '+draft.baseRevision+'，云端为版本 '+cloudRevision+'。请先导出，再重新读取云端核对；过期草稿不能覆盖云端。',cloudRevision!==draft.baseRevision);
}
function exportDraft(){const blob=new Blob([JSON.stringify(rawDraft(),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=state.id+'-draft.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function historyTime(value){
 if(value===null||value===undefined||value===''||value===0||value==='0')return '时间未记录';
 let time=typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;
 if(typeof time==='number'){if(!Number.isFinite(time)||time<=0)return '时间未记录';if(time<1e11)time*=1000}
 const date=new Date(time);return Number.isNaN(date.getTime())?'时间未记录':date.toLocaleString('zh-CN');
}
async function loadHistory(){
 if(!$('historyDetails').open||$('historyDetails').dataset.loaded||state.base.revision===0)return;
 const id=state.id,turn=navigation;$('historyList').textContent='正在读取历史版本…';try{const result=await request('/api/links/history?cardId='+encodeURIComponent(id));if(state.id!==id||turn!==navigation)return;$('historyList').replaceChildren();
  for(const version of result.versions){if(version.resourceId!==state.id)throw Error('历史资源 ID 不匹配');const item=el('details');item.append(el('summary','','版本 '+version.revision+' · '+historyTime(version.updated_at)));item.append(el('p','',version.metadata?.title||'无标题'));for(const record of version.records)item.append(el('p','',record.url),el('p','','网盘：'+record.driveName+'；提取码：'+record.extractionCode+'；解压码：'+record.unzipPassword+'；备注：'+record.remark));if(version.audit)item.append(el('pre','',JSON.stringify(version.audit,null,2)));
   const restore=button('载入此版本到表单',()=>{if(!version.metadata||!confirm('载入这份历史资料和链接？仍需核对并保存后才会生效。'))return;const base=copy(state.base);showResource({...base,metadata:copy(version.metadata),records:copy(version.records)});state.restoreRevision=version.revision;changed();status('已载入历史版本 '+version.revision+'，核对后点击保存云端。')});restore.disabled=!version.active||!version.metadata;item.append(restore);$('historyList').append(item)
  }$('historyDetails').dataset.loaded='1';if(!result.versions.length)$('historyList').textContent='暂无历史版本';
 }catch(error){if(state.id===id&&turn===navigation)$('historyList').textContent=error.message}
}
function setTheme(theme){document.documentElement.dataset.theme=theme;try{localStorage.setItem('tx-resource-editor-theme',theme)}catch(error){}}
let booting=false;async function boot(){if(booting)return;booting=true;$('locked').hidden=true;$('retryAccess').disabled=true;
 let theme;try{theme=localStorage.getItem('tx-resource-editor-theme')}catch(error){}setTheme(theme|| (matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'));
 $('themeButton').onclick=()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
 try{const result=await request('/api/admin/session');state.admin=result.admin;if(!['owner','contributor'].includes(state.admin.role))throw Object.assign(Error('此账号没有资源编辑权限'),{status:403});$('account').textContent=state.admin.role==='owner'?'主管理员':'资源管理员';$('account').textContent=state.admin.displayName||$('account').textContent;$('account').title=state.admin.role==='owner'?'主管理员':'资源管理员';document.body.classList.toggle('contributor',state.admin.role==='contributor');if(state.admin.role==='owner')await loadPresets();$('workspace').hidden=false;
  if(matchMedia('(max-width:720px)').matches)$('resourceBrowser').open=false;
  if(hostQuery.get('mine')==='1'){$('resourceFilter').value='mine';$('resourceBrowser').open=true}
  renderList();loadList();if(state.admin.role!=='owner')loadPresets();loadRemarks();request('/api/admin/imgbed-folders').then(result=>{for(const folder of result.folders||[]){const option=el('option','',folder);option.value=folder;$('imageFolder').append(option)}}).catch(error=>$('uploadStatus').textContent='文件夹暂不可用，将使用默认文件夹。');
  const query=new URLSearchParams(location.search),id=query.get('id');if(query.get('settings')==='remarks'||pendingRemarkSettings)openRemarkSettings();if(id&&/^[a-zA-Z0-9_-]{1,160}$/.test(id)){if(query.get('new')==='1')createResource(id);else await loadResource(id,true)}else if(query.get('new')==='1')createResource();else status('请选择已有资源，或新增一份资源。');
 }catch(error){const unauthorized=[401,403].includes(error.status);$('locked').hidden=false;$('workspace').hidden=true;$('accessTitle').textContent=unauthorized?'需要管理员登录':'验证连接暂不可用';$('accessMessage').textContent=unauthorized?'管理员登录已失效或无编辑权限，请返回网站重新登录。':'暂时未能连接验证服务，登录状态已保留。请重试，无需因此重新登录。';$('accessReturn').textContent=unauthorized?'返回网站登录':'返回网站';$('retryAccess').hidden=unauthorized;status(error.message,true)}finally{booting=false;$('retryAccess').disabled=false}
}

async function copyResource(){
 if(state.busy||state.uploading||loadingId||!state.base?.published||!canLeave())return;
 const source=state.base,storage='tx-resource-copy:'+state.admin.id+':'+source.id+':'+source.revision;
 let requestId;try{requestId=sessionStorage.getItem(storage)}catch(_){}
 if(!/^edit_[a-zA-Z0-9_-]{16,80}$/.test(requestId||''))requestId=makeId('edit_');
 try{sessionStorage.setItem(storage,requestId)}catch(_){}
 busy(true);status('正在准备复制草稿，原资源和下载链接保持不变…');
 try{
  const result=await request('/api/admin/resource/copy',{method:'POST',body:JSON.stringify({contractVersion:1,sourceId:source.id,baseRevision:source.revision,requestId})});
  const r=result.resource;if(result.contractVersion!==1||!r||r.id===source.id||r.metadata?.id!==r.id||(!r.published&&(!result.draftOnly||r.revision!==0||r.records?.length!==0||r.copySourceId!==source.id)))throw Error('复制响应无效，请保留当前页面后重试');
  ++navigation;clearTimeout(draftTimer);resourceCache.set(r.id,copy(r));
  if(r.published){
   const summary={id:r.id,publisherAccountId:r.publisherAccountId,title:r.metadata.title,tags:r.metadata.tags,revision:r.revision,createdAt:r.createdAt||0,published:true,copySourceId:r.copySourceId||source.id};listChanges.set(r.id,summary);state.resources=[summary,...state.resources.filter(x=>x.id!==r.id)];
  }
  showResource(r);
  if(!r.published){state.dirty=true;state.draftPending=true;if(!persistDraft(true))throw Error('复制草稿未能写入本机，请保留当前表单并导出草稿')}
  try{sessionStorage.removeItem(storage)}catch(_){}
  loadedView();status(r.published?'已打开此前创建并发布的复制件，请核对资源 ID。':'新资源草稿已保存到本机，尚未发布，请填写下载链接后发布。');
  if(r.published)notifyHost('saved',{resourceId:r.id,revision:r.revision,metadata:r.metadata,published:true,siteRevision:r.siteRevision,beforeSiteRevision:source.siteRevision,changed:!result.replayed});
 }catch(error){status('复制尚未确认：'+error.message+'。重试将核对同一份副本，不会重复新增。',true)}finally{busy(false)}
}

$('copyResource').onclick=copyResource;
$('newResource').onclick=()=>createResource();$('resourceSearch').oninput=renderList;$('resourceFilter').onchange=renderList;$('refreshList').onclick=()=>loadList(true);$('saveDraft').onclick=()=>{clearTimeout(draftTimer);if(persistDraft())status('草稿已保存，可在资源列表的“草稿”中继续编辑；尚未发布。')};
$('editor').addEventListener('submit',save);$('editor').addEventListener('input',event=>{if(event.target.closest('#basic'))changed()});
$('isPinned').addEventListener('change',changed);$('addImage').onclick=()=>{if(state.images.length>=100)return status('每个资源最多100张图片',true);state.images.push({id:makeId('img_'),url:''});state.imageIndex=state.images.length-1;changed();renderImages()};$('imageUpload').onchange=()=>uploadImages();$('replaceUpload').onchange=()=>uploadImages(true);
$('addExternalLink').onclick=()=>{
 if(state.records.length>=64)return status('每个资源最多64组链接',true);
 state.records.push({...emptyRecord(),channel:'external'});
 changed();renderLinks();
 $('links').lastElementChild?.querySelector('input')?.focus();
};
$('addLink').onclick=()=>{if(state.records.length>=64)return status('每个资源最多64组链接',true);state.records.push(emptyRecord());changed();renderLinks()};$('importShare').onclick=()=>{
 try{appendShareRecords(ResourceLinkEditor.parseShareText($('shareText').value))}
 catch(error){$('importStatus').textContent=error.message}
};
$('recognize').onclick=recognize;$('clearShareText').onclick=()=>{$('shareText').value='';$('importPreview').replaceChildren();$('importStatus').textContent='';$('shareText').focus()};
$('addPreset').onclick=()=>{if(presetDraft.length>=20)return;$('presetStatus').textContent='';presetDraft.push({id:makeId('preset_'),label:'',value:''});renderPresets()};
$('savePresets').onclick=async()=>{const b=$('savePresets');b.disabled=true;try{const result=await request('/api/admin/link-presets',{method:'PUT',body:JSON.stringify({baseRevision:state.presetRevision,presets:presetDraft})});state.presets=result.presets;state.presetRevision=result.revision;presetDraft=copy(result.presets);renderPresets();if(state.id)renderLinks();$('presetStatus').textContent='快捷码已保存，不会自动更改已有链接。'}catch(error){$('presetStatus').textContent=error.message}finally{b.disabled=false}};
function clearDraftView(id,hide=true){
 ++navigation;clearTimeout(draftTimer);if(hide)removedDraftIds.add(id);resourceCache.delete(id);listChanges.delete(id);state.resources=state.resources.filter(r=>r.id!==id);
 state.id=null;state.base=null;state.copySourceId=null;state.records=[];state.images=[];state.dirty=false;state.draftPending=false;state.availableDraft=null;state.lastSubmission=null;state.restoreRevision=null;
 setLoading(null);$('editor').hidden=true;$('welcome').hidden=false;$('draftBanner').hidden=true;$('resourceLoading').hidden=true;
 const address=new URL(location.href);address.searchParams.delete('id');address.searchParams.delete('new');history.replaceState(null,'',address.href);renderList();
}
async function deleteCurrentDraft(localOnly=false){
 if(state.busy||state.uploading||loadingId||!state.id)return;
 const id=state.id,base=copy(state.base),cloud=!!base.cloudDraft&&!localOnly;
 if(!cloud&&!draftFor(id)&&!state.dirty){status('当前资源没有可删除的本机草稿。');return}
 const message=cloud?'删除这份云端草稿及当前浏览器的对应草稿？它将从草稿列表移除，历史资料和图片仍保留，原资源不变。':base.revision===0?'删除这份未发布草稿并退出编辑？原资源和已发布内容不变。':'删除本机编辑草稿并重新显示云端资料？已发布内容不变。';
 if(!confirm(message))return;
 clearTimeout(draftTimer);
 if(cloud){
  busy(true);
  try{
   const result=await request('/api/admin/resource',{method:'DELETE',body:JSON.stringify({contractVersion:1,cardId:id,baseRevision:base.revision,draftOnly:true})});
   if(result.contractVersion!==1||result.cardId!==id||!result.draftDeleted)throw Error('删除结果与当前草稿不匹配，请刷新列表核对');
   const localRemoved=removeDraft(id);clearDraftView(id);
   status(localRemoved?'云端草稿已删除，历史资料保留；刷新后不会重新显示。':'云端草稿已删除，但本机存储清理失败，请保留导出并检查浏览器存储。',!localRemoved);
  }catch(error){status('草稿未删除：'+error.message,true);if(state.draftPending)draftTimer=setTimeout(persistDraft,250)}finally{busy(false)}
  return;
 }
 if(!removeDraft(id)){status('本机草稿删除失败，浏览器未能清理存储；内容仍保留。',true);return}
 state.dirty=false;state.draftPending=false;state.availableDraft=null;$('draftBanner').hidden=true;
 if(base.revision===0){clearDraftView(id);status('未发布草稿已删除；刷新后不会恢复。')}
 else{resourceCache.delete(id);await loadResource(id,true,true);if(state.id===id&&!loadingId&&$('resourceLoading').hidden)status('本机草稿已删除，已重新显示云端资料。')}
}
$('deleteDraft').onclick=()=>deleteCurrentDraft();
$('exportDraft').onclick=exportDraft;$('importDraft').onchange=async()=>{const file=$('importDraft').files[0];$('importDraft').value='';if(!file)return;try{if(file.size>3000000)throw Error('草稿文件过大');const draft=JSON.parse(await file.text());if(!confirm('将草稿载入当前表单？云端不会立即改变。'))return;applyDraft(draft)}catch(error){status(error.message,true)}};
$('restoreDraft').onclick=()=>{try{applyDraft(state.availableDraft)}catch(error){status(error.message,true)}};$('discardDraft').onclick=()=>deleteCurrentDraft(true);
$('reloadResource').onclick=()=>{if(!canLeave())return;if(state.base.revision===0){status('这是尚未发布的本机草稿，没有云端版本；可继续编辑或发布。');return}loadResource(state.id,true,true)};
$('historyDetails').addEventListener('toggle',loadHistory);
window.addEventListener('beforeunload',event=>{if(state.busy||state.uploading||(state.dirty&&!persistDraft())){event.preventDefault();event.returnValue=''}});
window.addEventListener('pagehide',()=>{if(state.dirty)persistDraft()});
$('deleteResource').onclick=async()=>{if(state.busy||state.uploading)return;if(!confirm('将此资源移出网站列表？历史资料和图片仍保留。若有未保存修改，请先保存或导出草稿。'))return;busy(true);try{const result=await request('/api/admin/resource',{method:'DELETE',body:JSON.stringify({contractVersion:1,cardId:state.id,baseRevision:state.base.revision})});notifyHost('saved',{resourceId:state.id,revision:state.base.revision,published:false,siteRevision:result.siteRevision,beforeSiteRevision:state.base.siteRevision,changed:!result.alreadyRemoved});state.dirty=false;busy(false);leaveEditor()}catch(error){status(error.message,true);busy(false)}};
$('closeEditor').onclick=leaveEditor;$('retryAccess').onclick=()=>boot();
if(embedded)$('locked').querySelector('a').onclick=event=>{event.preventDefault();leaveEditor()};
let remarkDraft=[],remarkBusy=false;
function renderRemarks(){
 $('remarkRows').replaceChildren();
 remarkDraft.forEach((preset,index)=>{
  const row=el('div','remark-preset-row');
  const name=el('label','','名称'),label=el('input');label.maxLength=80;label.value=preset.label;label.setAttribute('aria-label','快捷备注 '+(index+1)+' 名称');label.oninput=()=>preset.label=label.value;name.append(label);
  const content=el('label','','备注内容'),value=el('textarea');value.rows=2;value.maxLength=2000;value.value=preset.value;value.setAttribute('aria-label','快捷备注 '+(index+1)+' 内容');value.oninput=()=>preset.value=value.value;content.append(value);
  row.append(name,content,button('删除',()=>{remarkDraft.splice(index,1);renderRemarks()},'danger'));$('remarkRows').append(row);
 });
 $('remarkRows').querySelectorAll('input,textarea,button').forEach(input=>input.disabled=remarkBusy||!state.remarksLoaded);
 $('addRemark').disabled=remarkBusy||!state.remarksLoaded||remarkDraft.length>=20;$('saveRemarks').disabled=remarkBusy||!state.remarksLoaded;
}
async function loadRemarks(){
 state.remarksLoaded=false;renderRemarks();
 try{const result=await request('/api/admin/remark-presets');if(!Array.isArray(result.presets))throw Error('快捷备注格式无效');state.remarks=result.presets;state.remarkRevision=result.revision;remarkDraft=copy(result.presets);state.remarksError=false;$('remarkStatus').textContent=result.presets.length?'已读取 '+result.presets.length+' 条快捷备注。':'还没有快捷备注，可点击“添加快捷备注”设置。'}
 catch(error){state.remarksError=true;$('remarkStatus').textContent='快捷备注暂不可用：'+error.message}
 finally{state.remarksLoaded=true;renderRemarks();if(state.id)renderLinks()}
}
function openRemarkSettings(){
 if(state.admin?.role!=='owner')return;
 pendingRemarkSettings=false;$('remarkManager').open=true;$('remarkManager').scrollIntoView({block:'start',behavior:'smooth'});
}
$('remarkSettingsButton').onclick=openRemarkSettings;$('linkRemarkSettings').onclick=openRemarkSettings;
$('addRemark').onclick=()=>{if(remarkBusy||remarkDraft.length>=20)return;remarkDraft.push({id:makeId('preset_'),label:'',value:''});$('remarkStatus').textContent='';renderRemarks()};
$('saveRemarks').onclick=async()=>{
 if(remarkBusy)return;remarkBusy=true;renderRemarks();
 try{const result=await request('/api/admin/remark-presets',{method:'PUT',body:JSON.stringify({baseRevision:state.remarkRevision,presets:remarkDraft})});state.remarks=result.presets;state.remarkRevision=result.revision;remarkDraft=copy(result.presets);if(state.id)renderLinks();$('remarkStatus').textContent='快捷备注已保存；已有链接的备注保持不变。'}
 catch(error){$('remarkStatus').textContent=error.message}
 finally{remarkBusy=false;renderRemarks()}
};

let activeEditorTab='basic';
function setEditorTab(name){
 const tab=document.querySelector('[data-editor-tab="'+name+'"]');if(!tab||tab.hidden)name='basic';activeEditorTab=name;
 for(const panel of document.querySelectorAll('#editorFields>.panel'))panel.hidden=panel.id!==name;
 for(const button of document.querySelectorAll('[data-editor-tab]')){const selected=button.dataset.editorTab===name;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1}
 window.scrollTo({top:0});
}
for(const button of document.querySelectorAll('[data-editor-tab]'))button.onclick=()=>setEditorTab(button.dataset.editorTab);
document.querySelector('.section-nav').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const tabs=[...document.querySelectorAll('[data-editor-tab]')].filter(tab=>!tab.hidden),current=tabs.findIndex(tab=>tab.dataset.editorTab===activeEditorTab),next=tabs[(current+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];setEditorTab(next.dataset.editorTab);next.focus()});

$('resourceBrowser').addEventListener('toggle',()=>{if($('resourceBrowser').open&&state.admin)loadList().catch(error=>status(error.message,true))});
window.addEventListener('storage',event=>{
 if(!state.admin||!event.key?.startsWith(draftPrefix()))return;
 if(event.newValue===null&&event.oldValue&&state.id&&event.key===storageKey()&&!draftFor(state.id)){
  const id=state.id;clearTimeout(draftTimer);state.dirty=false;state.draftPending=false;state.availableDraft=null;
  if(state.base?.revision===0){clearDraftView(id,false);loadList(true)}else loadResource(id,true,true);
 }
 renderList();
});
notifyHost('ready');
boot();
})();
