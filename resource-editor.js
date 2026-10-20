(function(){
'use strict';
const API='https://api.tian-xiao.com',$=id=>document.getElementById(id),copy=value=>JSON.parse(JSON.stringify(value));
const state={admin:null,base:null,id:null,images:[],imageIndex:0,records:[],dirty:false,busy:false,uploading:false,resources:[],presets:[],presetRevision:0,restoreRevision:null,lastSubmission:null,availableDraft:null};
const hostQuery=new URLSearchParams(location.search),embedded=window.parent!==window&&hostQuery.get('embedded')==='1',hostChannel=hostQuery.get('editorChannel');
let lastSiteRevision=Number(hostQuery.get('siteRevision'))||0;
function notifyHost(type,data={}){if(embedded)window.parent.postMessage({type:'resource-editor:'+type,channel:hostChannel,...data},location.origin)}
function leaveEditor(){if(!canLeave())return;state.dirty=false;if(embedded)notifyHost('closed');else location.assign('./')}
if(embedded)document.documentElement.classList.add('embedded-editor');
window.addEventListener('message',event=>{if(embedded&&event.origin===location.origin&&event.source===window.parent&&event.data?.channel===hostChannel&&event.data.type==='resource-editor:request-close')leaveEditor()});
window.addEventListener('keydown',event=>{if(embedded&&event.key==='Escape'){event.preventDefault();leaveEditor()}});
const names=['title','tags','rjCode','company','translationTeam','desc','directDl','officialUrl'];
const makeId=prefix=>prefix+crypto.randomUUID().replaceAll('-','');
function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node}
function button(text,action,cls){const node=el('button',cls,text);node.type='button';node.addEventListener('click',action);return node}
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error)}
function storageKey(){return 'tx-resource-editor:'+state.admin.id+':'+state.id}
function safeUrl(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&value===value.trim()}catch(error){return false}}
async function request(path,options={}){
 const token=sessionStorage.getItem('ADMIN_TOKEN');if(!token)throw Error('管理员登录已失效，请返回网站登录');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
 try{const response=await fetch(API+path,{...options,signal:controller.signal,cache:'no-store',headers:{Authorization:'Bearer '+token,...(!(options.body instanceof FormData)?{'Content-Type':'application/json'}:{}),...options.headers}});let data;try{data=await response.json()}catch(error){throw Error('服务器未返回有效数据，编辑内容已保留')}
  if(!response.ok||data.success===false){const error=Error(data.error||'请求失败');error.status=response.status;throw error}return data;
 }catch(error){if(error.name==='AbortError')throw Error('请求超时，保存结果可能尚未确认。请保留草稿后重试或重新读取核对。');throw error}finally{clearTimeout(timer)}
}
function rawDraft(){return {version:1,resourceId:state.id,baseRevision:state.base.revision,metadata:Object.fromEntries(names.map(name=>[name,$(name).value])),sizeText:$('size').value,isPinned:$('isPinned').checked,images:copy(state.images),records:copy(state.records),restoreRevision:state.restoreRevision,lastSubmission:state.lastSubmission,savedAt:Date.now()}}
let draftTimer;
function persistDraft(){if(!state.id||!state.base)return;try{sessionStorage.setItem(storageKey(),JSON.stringify(rawDraft()));$('draftState').textContent='草稿已暂存到当前标签页'}catch(error){$('draftState').textContent='暂存空间不足，请导出草稿';status('无法暂存草稿，请点击“导出草稿”保存一份',true)}}
function changed(){state.dirty=true;$('saveState').textContent='有未保存修改';clearTimeout(draftTimer);draftTimer=setTimeout(persistDraft,250);$('editorTitle').textContent=$('title').value||'新增资源'}
function busy(value){state.busy=value;$('editorFields').disabled=value;$('saveResource').disabled=value||state.uploading;$('reloadResource').disabled=value;$('newResource').disabled=value;$('saveResource').textContent=value?'正在保存…':'保存云端'}
function canLeave(){if(state.busy||state.uploading)return false;if(!state.dirty)return true;clearTimeout(draftTimer);persistDraft();return confirm('当前内容尚未保存到云端，确定切换？本标签页草稿会保留。')}
function renderList(){
 const query=$('resourceSearch').value.trim().toLowerCase();const matched=state.resources.filter(r=>(r.title+' '+r.tags+' '+r.id).toLowerCase().includes(query));$('resourceCount').textContent='('+state.resources.length+')';$('resourceList').replaceChildren();
 for(const resource of matched.slice(0,100)){const item=button('',()=>loadResource(resource.id),resource.id===state.id?'selected':'');item.append(el('span','',resource.title||'未命名资源'),el('small','','版本 '+resource.revision));$('resourceList').append(item)}
 if(matched.length>100)$('resourceList').append(el('p','hint','仅显示前100项，请输入编号或标题查找。'));if(!matched.length)$('resourceList').append(el('p','hint','没有匹配资源'));
}
async function loadList(){if(state.admin.role!=='owner')return;const result=await request('/api/admin/resources');state.resources=result.resources;renderList()}
function newMetadata(id){return {id,title:'',tags:'',desc:'',images:[],isPinned:false,isFav:false,directDl:''}}
function showResource(resource){
 clearTimeout(draftTimer);
 if(Number.isSafeInteger(resource.siteRevision))lastSiteRevision=resource.siteRevision;state.imageIndex=0;state.id=resource.id;state.base=copy(resource);state.images=resource.metadata.images.map(url=>({id:makeId('img_'),url}));state.records=resource.records.map(r=>({...r,resourceId:resource.id}));state.restoreRevision=null;state.lastSubmission=null;state.dirty=false;state.availableDraft=null;
 for(const name of names)$(name).value=resource.metadata[name]||'';$('size').value=resource.metadata.size?.label||'';$('isPinned').checked=!!resource.metadata.isPinned;
 $('editorTitle').textContent=resource.metadata.title||'新增资源';$('resourceId').textContent=resource.id;$('resourceState').textContent=resource.published?'编辑已发布资源':resource.revision?'已移出列表的资源':'新增资源';$('deleteResource').hidden=!resource.published||state.admin.role!=='owner';$('revision').textContent='版本 '+resource.revision;
 $('draftBanner').hidden=true;$('historyList').replaceChildren();$('historyDetails').open=false;delete $('historyDetails').dataset.loaded;
 $('editor').hidden=false;$('welcome').hidden=true;$('newResource').hidden=resource.revision===0;document.querySelector('[data-editor-tab=history]').hidden=resource.revision===0||state.admin.role!=='owner';setEditorTab(activeEditorTab);renderImages();renderLinks();renderList();$('saveState').textContent=resource.revision?'已读取云端版本':'新资源尚未保存';$('draftState').textContent='编辑内容会暂存到当前标签页';
 const address=new URL(location.href);address.searchParams.set('id',resource.id);if(resource.revision===0)address.searchParams.set('new','1');else address.searchParams.delete('new');history.replaceState(null,'',address.href);
 if(resource.requiresRepair)status('此资源有无效旧网址，请逐组核对后保存。请以当前下载链接表单为准。',true);
 else status(resource.revision?'已读取当前云端资源。':'填写内容后点击保存云端，才会发布新资源。');
 try{const saved=sessionStorage.getItem(storageKey());if(saved){state.availableDraft=JSON.parse(saved);$('draftBanner').hidden=false;$('draftMessage').textContent='此标签页留有 '+new Date(state.availableDraft.savedAt).toLocaleString('zh-CN')+' 的草稿，是否恢复？'}}catch(error){status('草稿读取失败，云端内容已正常加载',true)}

}

async function loadResource(id,skipGuard=false){
 if(!skipGuard&&!canLeave())return;status('正在读取资源…');
 try{const result=await request('/api/admin/resource?id='+encodeURIComponent(id));if(result.contractVersion!==1||result.resource.id!==id)throw Error('资源数据格式或 ID 不匹配');showResource(result.resource);if(matchMedia('(max-width:720px)').matches)$('resourceBrowser').open=false;window.scrollTo({top:0})}
 catch(error){status(error.message,true)}
}
function createResource(id){
 if(!canLeave())return;id=id||'card_'+Date.now()+'_'+crypto.randomUUID().slice(0,9).replaceAll('-','');showResource({id,revision:0,siteRevision:lastSiteRevision,published:false,metadata:newMetadata(id),records:[],legacyArchive:{text:'',urls:[]}});window.scrollTo({top:0});
}
function parseSize(value){const text=value.trim();if(!text)return null;const match=/^(\d+(?:\.\d+)?)\s*(B|Ki?B?|Mi?B?|Gi?B?|Ti?B?)$/i.exec(text);if(!match)throw Error('大小请填写如 3.4GB、500MB，或留空');const unit=match[2].toUpperCase().replace('IB','B'),power={B:0,K:1,KB:1,M:2,MB:2,G:3,GB:3,T:4,TB:4}[unit],bytes=Math.round(Number(match[1])*1024**power);if(!Number.isSafeInteger(bytes)||bytes<=0)throw Error('资源大小必须大于0且在有效范围内');return {bytes,label:String(Number(match[1]))+' '+['B','KB','MB','GB','TB'][power],source:'manual'}}
function payload(){
 const metadata={...state.base.metadata,id:state.id};for(const name of names)metadata[name]=$(name).value;
 metadata.images=state.images.map(image=>image.url.trim());metadata.isPinned=state.admin.role==='owner'&&$('isPinned').checked;
 if(state.admin.role!=='owner'){metadata.directDl='';metadata.isFav=false}
 if($('size').value!==(state.base.metadata.size?.label||''))metadata.size=parseSize($('size').value);
 if(!metadata.title.trim()){setEditorTab('basic');$('title').focus();throw Error('请填写资源标题')}
 metadata.officialUrl=metadata.officialUrl.trim();if(metadata.officialUrl&&!safeUrl(metadata.officialUrl)){setEditorTab('basic');$('officialUrl').focus();throw Error('正版链接请填写完整的 HTTP/HTTPS 网址，或留空')}metadata.rjCode=metadata.rjCode.trim().toUpperCase();
 if(metadata.rjCode&&!/^(?:RJ|VJ)\d{6,10}$/.test(metadata.rjCode)){setEditorTab('basic');$('rjCode').focus();throw Error('DL编号请填写 RJ 或 VJ 加6到10位数字，也可留空')}
 if(metadata.images.length>100||metadata.images.some(url=>!safeUrl(url)))throw Error('图片链接无效，请填写完整的 HTTP/HTTPS 网址，或删除空图片组');
 const records=state.records.map(record=>({...record,resourceId:state.id,url:record.url.trim(),driveName:record.driveName.trim()||ResourceLinkEditor.detectDrive(record.url)}));
 const ids=new Set(),urls=new Set();for(let i=0;i<records.length;i++){const r=records[i];if(!safeUrl(r.url))throw Error('第 '+(i+1)+' 组下载链接无效');if(ids.has(r.id)||urls.has(r.url))throw Error('存在重复链接或 ID，请逐组核对');ids.add(r.id);urls.add(r.url)}
 return {contractVersion:1,cardId:state.id,baseRevision:state.base.revision,metadata,records,...(state.restoreRevision?{restoreRevision:state.restoreRevision}:{})};
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
 function updatePreview(){img.hidden=false;error.hidden=true;img.src=safeUrl(image.url.trim())?image.url.trim():'images/image_404.jpg'}
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
 input.addEventListener('input',()=>{image.url=input.value;changed()});input.addEventListener('change',updatePreview);label.append(input);card.append(label);
 const actions=el('div','image-actions');actions.append(button('复制图链',()=>copyText(input.value.trim())),button('查看原图',()=>{if(!safeUrl(input.value.trim()))return status('请填写有效图片链接',true);window.open(input.value.trim(),'_blank','noopener,noreferrer')}));card.append(actions);gallery.append(card);
}
function linkField(record,index,key,name,max){const label=el('label',['url','remark','unzipPassword'].includes(key)?'full':'',name),input=el(key==='remark'?'textarea':'input');input.value=record[key]||'';input.maxLength=max;input.dataset.field=key;input.setAttribute('aria-label','第'+(index+1)+'组'+name);if(key==='remark')input.rows=2;else input.type='text';
 if(key==='url'){input.inputMode='url';input.placeholder='https://…';input.addEventListener('paste',event=>{const text=event.clipboardData?.getData('text/plain')||'';if(/https?:\/\//i.test(text)&&(/[\r\n]/.test(text)||/提取码|分享的文件/.test(text))){event.preventDefault();$('shareText').value=text;$('shareText').closest('details').open=true;recognize();$('shareText').scrollIntoView({block:'center'});status('已放入分享识别区，请核对后追加或填入选中组。')}})}
 input.addEventListener('input',()=>{record[key]=input.value;changed()});label.append(input);return label;
}
function renderLinks(){
 $('links').replaceChildren();$('linkCount').textContent=state.records.length+' 组';
 state.records.forEach((record,index)=>{const card=el('article','link-card');card.dataset.linkId=record.id;const head=rowHeader('链接 '+(index+1),state.records,index,renderLinks);head.append(el('small','',record.id));card.append(head);const fields=el('div','fields');
  for(const [key,label,max] of [['url','链接',4096],['driveName','网盘名称',100],['extractionCode','提取码',500],['unzipPassword','解压码',2000],['remark','备注',2000]]){
   const field=linkField(record,index,key,label,max);
   if(key==='unzipPassword'&&state.presets.length){const quick=el('div','quick-code'),select=el('select');select.setAttribute('aria-label','第'+(index+1)+'组快捷解压码');const blank=el('option','','快捷解压码');blank.value='';select.append(blank);for(const preset of state.presets){const option=el('option','',preset.label);option.value=preset.id;select.append(option)}const input=field.querySelector('input');select.onchange=()=>{const preset=state.presets.find(p=>p.id===select.value);if(!preset)return;record.unzipPassword=preset.value;input.value=preset.value;changed()};quick.append(input,select);field.append(quick)}fields.append(field)
  }card.append(fields);$('links').append(card)
 });if(!state.records.length)$('links').append(el('p','hint','暂无下载链接。可以粘贴识别，也可以手动添加。'));
}
function emptyRecord(){return {id:makeId('lnk_'),resourceId:state.id,url:'',driveName:'',extractionCode:'',unzipPassword:'',remark:''}}
function recognize(){
 try{const result=ResourceLinkEditor.parseShareText($('shareText').value);$('importPreview').replaceChildren();$('importStatus').textContent=result.warnings.join('；')||'识别到 '+result.records.length+' 组，请核对后添加。';
  result.records.forEach(record=>{const item=el('div','import-item');item.append(el('strong','',record.driveName||'未知网盘'),el('p','',record.url),el('p','','提取码：'+(record.extractionCode||'未识别')));for(const warning of record.warnings||[])item.append(el('p','hint',warning));$('importPreview').append(item)});
  if(!result.records.length)return;const actions=el('div','toolbar');actions.append(button('追加为新链接',()=>{const known=new Set(state.records.map(r=>r.url.trim()));let added=0;for(const record of result.records){if(known.has(record.url))continue;if(state.records.length>=64)break;state.records.push({...emptyRecord(),url:record.url,driveName:record.driveName,extractionCode:record.extractionCode});known.add(record.url);added++}if(added){changed();renderLinks()}$('importStatus').textContent='已追加 '+added+' 组。解压码和备注请自行填写；每个资源最多64组。'}));
  if(result.records.length===1&&state.records.length){const select=el('select');select.setAttribute('aria-label','选择要填入的链接组');state.records.forEach((record,i)=>{const option=el('option','','第'+(i+1)+'组 · '+(record.remark||record.driveName||'未命名'));option.value=i;select.append(option)});actions.append(select,button('填入选中组',()=>{const index=Number(select.value);if(!state.records[index])return;if(!confirm('替换此组的网址和提取码？手填网盘名称、解压码和备注会保留。'))return;state.records[index]=ResourceLinkEditor.applyDetected(state.records[index],result.records[0]);changed();renderLinks();$('importStatus').textContent='已填入选中组，解压码和备注未改动。'}))}$('importPreview').append(actions);
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
 try{for(let i=0;i<files.length;i++){const file=files[i];if(!file.type.startsWith('image/'))continue;$('uploadStatus').textContent='正在上传 '+(i+1)+' / '+files.length+'：'+file.name;const body=new FormData();body.append('file',file);body.append('folder',$('imageFolder').value);
   try{const result=await request('/api/admin/upload-image',{method:'POST',body});if(!safeUrl(result.url||''))throw Error('上传未返回有效图片地址');if(replacing){const target=state.images.find(image=>image.id===targetId);if(!target)throw Error('待更换图片已移除');target.url=result.url}else{state.images.push({id:makeId('img_'),url:result.url});state.imageIndex=state.images.length-1}success++;changed();renderImages()}catch(error){status('图片 '+file.name+' 上传失败：'+error.message,true)}
  }$('uploadStatus').textContent='已上传 '+success+' / '+files.length+' 张，保存资源后才会使用这些图片。';
 }finally{state.uploading=false;$('imageUpload').disabled=false;$('saveResource').disabled=state.busy;renderImages()}
}
async function save(event){
 event.preventDefault();if(state.busy||state.uploading||!state.id)return;let body;
 try{body=payload()}catch(error){status(error.message,true);return}
 if(!body.records.length&&!confirm('此资源没有下载链接，仍要保存云端吗？'))return;
 const beforeSiteRevision=state.base.siteRevision;const fingerprint=JSON.stringify(body);if(state.lastSubmission?.fingerprint!==fingerprint)state.lastSubmission={fingerprint,requestId:makeId('edit_')};body.requestId=state.lastSubmission.requestId;persistDraft();busy(true);status('正在保存当前资源的资料、图片和链接…');
 try{const result=await request('/api/admin/resource',{method:'POST',body:JSON.stringify(body)});if(result.contractVersion!==1||result.resource.id!==state.id)throw Error('保存响应与当前资源不匹配，请保留草稿并重新读取核对');
  clearTimeout(draftTimer);const key=storageKey();sessionStorage.removeItem(key);showResource(result.resource);$('saveState').textContent=result.unchanged?'内容未变，仍为当前云端版本':'已保存云端 · 版本 '+result.resource.revision;status('当前资源已保存云端，其他资源和站点设置未改动。');notifyHost('saved',{resourceId:result.resource.id,revision:result.resource.revision,metadata:result.resource.metadata,published:result.resource.published,siteRevision:result.resource.siteRevision,beforeSiteRevision,changed:!result.unchanged});

  if(state.admin.role==='owner')loadList().catch(error=>status('资源已保存；列表刷新失败：'+error.message,true));
  else{$('editorFields').disabled=true;$('saveResource').disabled=true;$('saveResource').dataset.published='1';status('新资源已发布。此账号仅可新增，不能继续修改已发布资源。')}
 }catch(error){status(error.message,true);$('saveState').textContent='尚未确认保存，编辑内容已保留';persistDraft()}
 finally{busy(false);if($('saveResource').dataset.published){$('saveResource').disabled=true;$('editorFields').disabled=true}}
}
function applyDraft(draft){
 if(state.busy||state.uploading)throw Error('请等待当前操作完成后再载入草稿');
 if(!draft||draft.version!==1||draft.resourceId!==state.id||!Number.isSafeInteger(draft.baseRevision)||draft.baseRevision<0||!draft.metadata||!Array.isArray(draft.images)||draft.images.length>100||!Array.isArray(draft.records)||draft.records.length>64)throw Error('草稿格式无效，或不属于当前资源');
 const ids=new Set();for(const r of draft.records){if(!/^lnk_[a-zA-Z0-9_-]{8,96}$/.test(r.id)||ids.has(r.id)||r.resourceId!==state.id)throw Error('草稿链接 ID 或资源绑定无效');ids.add(r.id);for(const key of ['url','driveName','extractionCode','unzipPassword','remark'])if(typeof r[key]!=='string')throw Error('草稿下载字段不完整')}
 for(const image of draft.images)if(typeof image.url!=='string')throw Error('草稿图片格式无效');
 const cloudRevision=state.base.revision;for(const name of names){if(typeof draft.metadata[name]!=='string')throw Error('草稿资料字段不完整');$(name).value=draft.metadata[name]}
 $('size').value=String(draft.sizeText||'');$('isPinned').checked=!!draft.isPinned;state.images=copy(draft.images);state.records=copy(draft.records);state.base.revision=draft.baseRevision;state.restoreRevision=draft.restoreRevision||null;state.lastSubmission=draft.lastSubmission||null;state.availableDraft=null;$('draftBanner').hidden=true;renderImages();renderLinks();changed();
 status(cloudRevision===draft.baseRevision?'草稿已恢复，核对后保存云端。':'草稿来自版本 '+draft.baseRevision+'，云端为版本 '+cloudRevision+'。请先导出，再重新读取云端核对；过期草稿不能覆盖云端。',cloudRevision!==draft.baseRevision);
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
 $('historyList').textContent='正在读取历史版本…';try{const result=await request('/api/links/history?cardId='+encodeURIComponent(state.id));$('historyList').replaceChildren();
  for(const version of result.versions){if(version.resourceId!==state.id)throw Error('历史资源 ID 不匹配');const item=el('details');item.append(el('summary','','版本 '+version.revision+' · '+historyTime(version.updated_at)));item.append(el('p','',version.metadata?.title||'无标题'));for(const record of version.records)item.append(el('p','',record.url),el('p','','网盘：'+record.driveName+'；提取码：'+record.extractionCode+'；解压码：'+record.unzipPassword+'；备注：'+record.remark));if(version.audit)item.append(el('pre','',JSON.stringify(version.audit,null,2)));
   const restore=button('载入此版本到表单',()=>{if(!version.metadata||!confirm('载入这份历史资料和链接？仍需核对并保存后才会生效。'))return;const base=copy(state.base);showResource({...base,metadata:copy(version.metadata),records:copy(version.records)});state.restoreRevision=version.revision;changed();status('已载入历史版本 '+version.revision+'，核对后点击保存云端。')});restore.disabled=!version.active||!version.metadata;item.append(restore);$('historyList').append(item)
  }$('historyDetails').dataset.loaded='1';if(!result.versions.length)$('historyList').textContent='暂无历史版本';
 }catch(error){$('historyList').textContent=error.message}
}
function setTheme(theme){document.documentElement.dataset.theme=theme;try{localStorage.setItem('tx-resource-editor-theme',theme)}catch(error){}}
async function boot(){
 let theme;try{theme=localStorage.getItem('tx-resource-editor-theme')}catch(error){}setTheme(theme|| (matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'));
 $('themeButton').onclick=()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
 try{const result=await request('/api/admin/session');state.admin=result.admin;if(!['owner','contributor'].includes(state.admin.role))throw Error('此账号没有资源编辑权限');$('account').textContent=state.admin.role==='owner'?'主管理员':'仅可新增';$('account').title=state.admin.username;document.body.classList.toggle('contributor',state.admin.role==='contributor');$('workspace').hidden=false;
  if(matchMedia('(max-width:720px)').matches)$('resourceBrowser').open=false;
  loadPresets();request('/api/admin/imgbed-folders').then(result=>{for(const folder of result.folders||[]){const option=el('option','',folder);option.value=folder;$('imageFolder').append(option)}}).catch(error=>$('uploadStatus').textContent='文件夹暂不可用，将使用默认文件夹。');
  const query=new URLSearchParams(location.search),id=query.get('id');if(id&&/^[a-zA-Z0-9_-]{1,160}$/.test(id)){if(query.get('new')==='1')createResource(id);else await loadResource(id,true)}else if(query.get('new')==='1'||state.admin.role==='contributor')createResource();else status('请选择已有资源，或新增一份资源。');
 }catch(error){$('locked').hidden=false;$('workspace').hidden=true;status(error.message,true)}
}
$('newResource').onclick=()=>{delete $('saveResource').dataset.published;$('editorFields').disabled=false;$('saveResource').disabled=false;createResource()};$('resourceSearch').oninput=renderList;
$('editor').addEventListener('submit',save);$('editor').addEventListener('input',event=>{if(event.target.closest('#basic'))changed()});
$('isPinned').addEventListener('change',changed);$('addImage').onclick=()=>{if(state.images.length>=100)return status('每个资源最多100张图片',true);state.images.push({id:makeId('img_'),url:''});state.imageIndex=state.images.length-1;changed();renderImages()};$('imageUpload').onchange=()=>uploadImages();$('replaceUpload').onchange=()=>uploadImages(true);
$('addLink').onclick=()=>{if(state.records.length>=64)return status('每个资源最多64组链接',true);state.records.push(emptyRecord());changed();renderLinks()};$('recognize').onclick=recognize;
$('addPreset').onclick=()=>{if(presetDraft.length>=20)return;$('presetStatus').textContent='';presetDraft.push({id:makeId('preset_'),label:'',value:''});renderPresets()};
$('savePresets').onclick=async()=>{const b=$('savePresets');b.disabled=true;try{const result=await request('/api/admin/link-presets',{method:'PUT',body:JSON.stringify({baseRevision:state.presetRevision,presets:presetDraft})});state.presets=result.presets;state.presetRevision=result.revision;presetDraft=copy(result.presets);renderPresets();if(state.id)renderLinks();$('presetStatus').textContent='快捷码已保存，不会自动更改已有链接。'}catch(error){$('presetStatus').textContent=error.message}finally{b.disabled=false}};
$('exportDraft').onclick=exportDraft;$('importDraft').onchange=async()=>{const file=$('importDraft').files[0];$('importDraft').value='';if(!file)return;try{if(file.size>3000000)throw Error('草稿文件过大');const draft=JSON.parse(await file.text());if(!confirm('将草稿载入当前表单？云端不会立即改变。'))return;applyDraft(draft)}catch(error){status(error.message,true)}};
$('restoreDraft').onclick=()=>{try{applyDraft(state.availableDraft)}catch(error){status(error.message,true)}};$('discardDraft').onclick=()=>{if(!confirm('清除此资源在当前标签页的暂存草稿？云端和当前表单都不会改变。'))return;sessionStorage.removeItem(storageKey());state.availableDraft=null;$('draftBanner').hidden=true};
$('reloadResource').onclick=()=>{if(!canLeave())return;if(state.base.revision===0&&!state.base.published){if(!confirm('重新读取会用云端内容替换表单；若此资源尚未发布，读取会失败。继续？'))return}loadResource(state.id,true)};
$('historyDetails').addEventListener('toggle',loadHistory);
window.addEventListener('beforeunload',event=>{if(state.dirty||state.busy||state.uploading){if(state.dirty)persistDraft();event.preventDefault();event.returnValue=''}});
window.addEventListener('pagehide',()=>{if(state.dirty)persistDraft()});
$('deleteResource').onclick=async()=>{if(state.busy||state.uploading)return;if(!confirm('将此资源移出网站列表？历史资料和图片仍保留。若有未保存修改，请先保存或导出草稿。'))return;busy(true);try{const result=await request('/api/admin/resource',{method:'DELETE',body:JSON.stringify({contractVersion:1,cardId:state.id,baseRevision:state.base.revision})});notifyHost('saved',{resourceId:state.id,revision:state.base.revision,published:false,siteRevision:result.siteRevision,beforeSiteRevision:state.base.siteRevision,changed:!result.alreadyRemoved});state.dirty=false;busy(false);leaveEditor()}catch(error){status(error.message,true);busy(false)}};
$('closeEditor').onclick=leaveEditor;
if(embedded)$('locked').querySelector('a').onclick=event=>{event.preventDefault();leaveEditor()};
let activeEditorTab='basic';
function setEditorTab(name){
 const tab=document.querySelector('[data-editor-tab="'+name+'"]');if(!tab||tab.hidden)name='basic';activeEditorTab=name;
 for(const panel of document.querySelectorAll('#editorFields>.panel'))panel.hidden=panel.id!==name;
 for(const button of document.querySelectorAll('[data-editor-tab]')){const selected=button.dataset.editorTab===name;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1}
 window.scrollTo({top:0});
}
for(const button of document.querySelectorAll('[data-editor-tab]'))button.onclick=()=>setEditorTab(button.dataset.editorTab);
document.querySelector('.section-nav').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const tabs=[...document.querySelectorAll('[data-editor-tab]')].filter(tab=>!tab.hidden),current=tabs.findIndex(tab=>tab.dataset.editorTab===activeEditorTab),next=tabs[(current+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];setEditorTab(next.dataset.editorTab);next.focus()});

$('resourceBrowser').addEventListener('toggle',()=>{if($('resourceBrowser').open&&state.admin?.role==='owner')loadList().catch(error=>status(error.message,true))});
notifyHost('ready');
boot();
})();
