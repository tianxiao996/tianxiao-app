(function(root){
'use strict';
const emptyRecord=()=>({id:'lnk_'+crypto.randomUUID(),url:'',driveName:'',remark:'',extractionCode:'',unzipPassword:''});
function detectDrive(raw){
 let host;try{host=new URL(raw).hostname.toLowerCase()}catch(e){return ''}
 const at=domain=>host===domain||host.endsWith('.'+domain);
 if(at('pan.baidu.com')||at('yun.baidu.com'))return '百度网盘';
 if(at('pan.quark.cn'))return '夸克网盘';
 if(at('drive.uc.cn'))return 'UC网盘';
 if(at('alipan.com')||at('aliyundrive.com'))return '阿里云盘';
 if(/(?:^|\.)(?:lanzou[a-z]*|lanzn)\.com$/.test(host))return '蓝奏云';
 if(at('123pan.com')||at('123684.com')||at('123865.com')||at('123912.com'))return '123云盘';
 if(at('cloud.189.cn'))return '天翼云盘';
 if(at('caiyun.139.com')||at('yun.139.com'))return '中国移动云盘';
 if(at('pan.xunlei.com'))return '迅雷云盘';
 if(at('weiyun.com'))return '微云';
 if(at('115.com'))return '115网盘';
 if(at('mega.nz')||at('mega.io'))return 'MEGA';
 if(at('drive.google.com'))return 'Google Drive';
 if(at('1drv.ms')||at('onedrive.live.com'))return 'OneDrive';
 if(at('dropbox.com'))return 'Dropbox';
 return '';
}
function parseShareText(input){
 const text=String(input||'').replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/https?：\/\//gi,m=>m.replace('：',':')).replace(/\r\n?/g,'\n');
 if(text.length>60000)throw Error('一次粘贴的内容最多60,000字符，请分批识别');
 const links=[],warnings=[];
 const pattern=/https?:\/\/[^\s<>"'“”‘’（）()\[\]【】]+/gi;let match;
 while((match=pattern.exec(text))){
  let value=match[0].split(/(?:提取码|提取碼|访问码|访问碼|复制这段|複製這段)/)[0].replace(/[,，。；;！!？?、：:）)\]}】>]+$/g,'');
  let url;try{url=new URL(value)}catch(e){continue}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password){warnings.push('已忽略带内嵌账号密码的网址');continue}
  links.push({url:value,start:match.index,end:match.index+value.length,driveName:detectDrive(value)});
  if(links.length>64)throw Error('每个资源最多64组链接，请分批处理');
 }
 const codePattern=/(提取码|提取碼|提取密码|提取密碼|访问码|訪問碼|访问密码|訪問密碼|取件码|分享密码|密码|密碼)\s*[：:=]?\s*([A-Za-z0-9_-]{1,32})(?![A-Za-z0-9_-])/g;
 function codes(chunk){const found=[];for(const m of chunk.matchAll(codePattern)){const prefix=chunk.slice(Math.max(0,m.index-8),m.index);if(/(?:解压|解壓|压缩|壓縮)\s*$/.test(prefix))continue;found.push(m[2])}return [...new Set(found)]}
 const seen=new Set(),records=[];
 for(let i=0;i<links.length;i++){
  const link=links[i],url=new URL(link.url),notes=[];
  // Keep meaningful URL query parameters and fragments intact. A password in
  // the URL is evidence only for that URL, never for a neighbouring record.
  const queryCode=link.driveName?['pwd','password','passcode','access_code'].map(k=>url.searchParams.get(k)).find(v=>v&&/^[A-Za-z0-9_-]{1,32}$/.test(v)):null;
  const startBlank=text.lastIndexOf('\n\n',link.start),nextBlank=text.indexOf('\n\n',link.end);
  const blockStart=startBlank<0?0:startBlank+2,blockEnd=nextBlank<0?text.length:nextBlank;
  const inBlock=links.filter(x=>x.start>=blockStart&&x.start<blockEnd);
  let labelled=[];
  if(inBlock.length===1)labelled=codes(text.slice(blockStart,blockEnd));
  else{
   const after=text.slice(link.end,Math.min(i+1<links.length?links[i+1].start:text.length,blockEnd));
   // Only the same line or an immediately adjacent code line is unambiguous
   // in a multi-link block. A list of trailing codes is never zipped by index.
   const lines=after.split('\n');labelled=codes(lines[0]);
   if(!labelled.length&&lines[1]&&/^\s*(?:提取|访问|訪問|取件|分享密码|密码|密碼)/.test(lines[1]))labelled=codes(lines[1]);
  }
  const candidates=[...new Set([...(queryCode?[queryCode]:[]),...labelled])];
  let extractionCode='';
  if(candidates.length===1)extractionCode=candidates[0];
  else if(candidates.length>1)notes.push('发现不同的提取码，请手动核对');
  if(!link.driveName)notes.push('未识别网盘名称，可手动填写');
  if(link.driveName&&!extractionCode&&!candidates.length)notes.push('未识别到提取码，请核对是否需要');
  if(/解压|解壓|压缩密码/.test(text.slice(blockStart,blockEnd)))notes.push('解压码请手动填写，未自动导入');
  const identity=new URL(link.url);if(link.driveName)for(const key of ['pwd','password','passcode','access_code'])identity.searchParams.delete(key);
  const key=identity.toString();if(seen.has(key)){warnings.push('已忽略重复分享链接，请核对提取码');continue}seen.add(key);
  records.push({url:link.url,driveName:link.driveName,extractionCode,remark:'',warnings:notes});
 }
 if(!records.length)warnings.push('没有识别到 HTTP/HTTPS 链接');
 return {records,warnings};
}
// Explicitly leaves the manually entered unzip password alone.
function applyDetected(existing,detected){return {...existing,url:detected.url,driveName:existing.driveName.trim()?existing.driveName:detected.driveName,extractionCode:detected.extractionCode,remark:existing.remark,unzipPassword:existing.unzipPassword}}
function node(tag,className,text){const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el}
function button(text,action){const el=node('button','rle-button',text);el.type='button';el.addEventListener('click',action);return el}
async function open(cardId,wrap){
 const token=root.adminToken||sessionStorage.getItem('ADMIN_TOKEN');if(!token){root.showToast?.('请先登录管理员');return}
 if(document.getElementById('resourceLinkEditor'))return;
 const page=node('section');page.id='resourceLinkEditor';page.setAttribute('role','dialog');page.setAttribute('aria-modal','true');page.setAttribute('aria-labelledby','rleTitle');
 const shell=node('div','rle-shell'),header=node('header','rle-header'),titleBox=node('div'),title=node('h1','','管理资源链接');title.id='rleTitle';
 const card=wrap?.closest('.card')||document.querySelector('[data-card-id="'+CSS.escape(cardId)+'"]');titleBox.append(title,node('p','rle-resource-name',card?.querySelector('.g-name')?.textContent||'当前资源'));
 let dirty=false,saving=false,closed=false,records=[],presets=[],presetRevision=0,base=null,restoreRevision=null,hasPending=false;
 const abort=new AbortController();
 const close=()=>{if(saving)return;if(dirty&&!confirm('当前修改尚未保存，确定关闭？'))return;closed=true;abort.abort();page.remove();document.body.style.overflow=oldOverflow;previousFocus?.focus?.()};
 const closeButton=button('×',close);closeButton.classList.add('rle-close');closeButton.setAttribute('aria-label','关闭链接编辑器');header.append(titleBox,closeButton);
 const body=node('main','rle-body'),status=node('p','rle-status','正在读取 R2 中的链接...');status.setAttribute('role','status');body.append(status);shell.append(header,body);page.append(shell);
 const previousFocus=document.activeElement,oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';document.body.append(page);closeButton.focus();
 page.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close()}if(e.key==='Tab'){const controls=[...page.querySelectorAll('button,input,textarea,select,summary')].filter(x=>!x.disabled&&x.getClientRects().length);if(!controls.length)return;const first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}});
 async function request(path,options={}){const response=await fetch((root.ResourceLinkEditorConfig?.base||root.WORKER_BASE)+path,{...options,signal:abort.signal,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},cache:'no-store'});let data;try{data=await response.json()}catch(e){throw Error('服务器未返回有效数据，请刷新后重试')}if(!response.ok)throw Error(data.error||'请求失败（'+response.status+'）');return data}
 try{base=await request('/api/links/get?schema=2&cardId='+encodeURIComponent(cardId));if(base.schemaVersion!==2||base.contractVersion!==1||base.resourceId!==cardId||base.editingEnabled===false)throw Error('当前资源存储暂不支持编辑，请刷新后重试');records=(base.records||[]).map(r=>({...r}));hasPending=!!base.reviewRequired}
 catch(error){if(!closed){status.textContent='读取失败：'+error.message;body.append(button('重试',()=>{dirty=false;close();open(cardId,wrap)}))}return}
 if(closed)return;
 let canManagePresets=false;
 try{const data=await request('/api/admin/link-presets');presets=data.presets;presetRevision=data.revision;canManagePresets=data.canManage}catch(e){status.textContent='链接已读取；快捷解压码暂不可用：'+e.message}
 const info=node('p','rle-hint','每组链接及密码独立保存到 R2。已有解压码原样保留；新解压码手动填写或主动选择快捷码。网盘名称为空时才自动识别。保存链接后立即生效。');body.append(info);
 if(base.legacyArchive){const details=node('details','rle-section');details.append(node('summary','','迁移前原文存档（只读）'),node('p','rle-hint','存档仅供人工核对，不会解析、自动回填或参与下载展示。'),node('pre','rle-legacy',base.legacyArchive.text||'原文为空'));body.append(details)}
 if(base.requiresRepair)body.append(node('p','rle-warning','部分旧链接无效或尚待核对，请手动修正每组独立字段后保存。'));
 const importer=node('section','rle-section'),importTitle=node('h2','','粘贴分享内容，自动识别'),paste=node('textarea','rle-share-input');paste.placeholder='粘贴网盘完整分享文案，支持多组链接。只识别网址、提取码和网盘名称。';paste.rows=5;paste.maxLength=60000;paste.setAttribute('aria-label','网盘分享内容');
 const preview=node('div','rle-import-preview'),importStatus=node('p','rle-status');importStatus.setAttribute('role','status');
 const rows=node('div','rle-record-list');let detected=[];
 function recognize(){try{const result=parseShareText(paste.value);detected=result.records;preview.replaceChildren();importStatus.textContent=result.warnings.join('；')||('识别到 '+detected.length+' 组链接，核对后再添加。');detected.forEach((r,index)=>{const item=node('div','rle-detected');item.append(node('strong','',`第 ${index+1} 组 · ${r.driveName||'未知网盘'}`),node('p','rle-url',r.url),node('p','','提取码：'+(r.extractionCode||'未识别')));r.warnings.forEach(w=>item.append(node('p','rle-warning',w)));preview.append(item)});if(detected.length){const actions=node('div','rle-actions');actions.append(button('追加为新链接',()=>{const known=new Set(records.map(r=>r.url));let count=0;for(const r of detected){if(known.has(r.url))continue;records.push({...emptyRecord(),url:r.url,driveName:r.driveName,extractionCode:r.extractionCode});known.add(r.url);count++}if(records.length>64){records.splice(64);importStatus.textContent='最多保留64组链接，请分批处理'}else importStatus.textContent='已追加 '+count+' 组，请填写解压码和备注';dirty=true;renderRows()}));if(detected.length===1&&records.length){const select=node('select');select.setAttribute('aria-label','选择要填入的链接组');records.forEach((r,i)=>{const option=node('option','',`第 ${i+1} 组 · ${r.remark||r.driveName||'未命名'}`);option.value=String(i);select.append(option)});actions.append(select,button('填入选中组',()=>{const i=Number(select.value);if((records[i].url||records[i].extractionCode)&&!confirm('替换选中组的网址和提取码？手填网盘名称、解压码和备注会保留。'))return;records[i]=applyDetected(records[i],detected[0]);dirty=true;renderRows();importStatus.textContent='已填入第 '+(i+1)+' 组，解压码未改动'}))}preview.append(actions)}}catch(e){importStatus.textContent=e.message}}
 importer.append(importTitle,paste,button('识别分享内容',recognize),importStatus,preview);body.append(importer);
 if(canManagePresets){const manager=node('details','rle-section');manager.append(node('summary','','管理快捷解压码'));const list=node('div'),message=node('p','rle-status');message.setAttribute('role','status');let draft=presets.map(p=>({...p}));
  function renderPresetManager(){list.replaceChildren();draft.forEach((p,index)=>{const row=node('div','rle-preset-row');const label=node('input'),value=node('input');label.value=p.label;label.placeholder='名称';label.maxLength=80;label.setAttribute('aria-label','快捷码名称');value.value=p.value;value.placeholder='解压码';value.maxLength=2000;value.setAttribute('aria-label','快捷解压码');label.oninput=()=>p.label=label.value;value.oninput=()=>p.value=value.value;row.append(label,value,button('删除',()=>{draft.splice(index,1);renderPresetManager()}));list.append(row)})}
  renderPresetManager();const actions=node('div','rle-actions');actions.append(button('添加快捷码',()=>{if(draft.length>=20){message.textContent='最多20个快捷解压码';return}draft.push({id:'preset_'+crypto.randomUUID(),label:'',value:''});renderPresetManager()}));
  const store=button('保存快捷码',async()=>{store.disabled=true;try{const result=await request('/api/admin/link-presets',{method:'PUT',body:JSON.stringify({baseRevision:presetRevision,presets:draft})});presets=result.presets;presetRevision=result.revision;draft=presets.map(p=>({...p}));message.textContent='快捷解压码已保存；不会自动修改任何链接';renderPresetManager();renderRows()}catch(e){message.textContent=e.message}finally{store.disabled=false}});actions.append(store);manager.append(node('p','rle-hint','预设供管理员主动选用，修改预设不会更改已经保存的资源。'),list,actions,message);body.append(manager)
 }
 const recordsSection=node('section','rle-section');recordsSection.append(node('h2','','链接分组'),rows,button('手动添加一组',()=>{if(records.length>=64){status.textContent='每个资源最多64组链接';return}records.push(emptyRecord());dirty=true;renderRows()}));body.append(recordsSection);
 function renderRows(){rows.replaceChildren();records.forEach((record,index)=>{const row=node('article','rle-record');row.dataset.linkId=record.id;const head=node('div','rle-record-header');head.append(node('h3','',`第 ${index+1} 组`));for(const [text,step]of [['上移',-1],['下移',1]]){const move=button(text,()=>{[records[index],records[index+step]]=[records[index+step],records[index]];dirty=true;renderRows()});move.disabled=index+step<0||index+step>=records.length;head.append(move)}head.append(button('删除',()=>{if(!confirm('删除这一组？保存后才生效，历史版本仍保留。'))return;records.splice(index,1);dirty=true;renderRows()}));row.append(head);
  for(const [field,labelText,max]of [['driveName','网盘名称',100],['url','链接',4096],['extractionCode','提取码',500],['unzipPassword','解压码（手动填写）',2000],['remark','备注',2000]]){const label=node('label','rle-field'),input=node(field==='remark'?'textarea':'input');input.dataset.field=field;input.value=record[field];input.maxLength=max;input.setAttribute('aria-label',`第${index+1}组${labelText}`);if(field==='remark')input.rows=2;else input.type='text';if(field==='url'){input.placeholder='https://…';input.inputMode='url';input.spellcheck=false;input.addEventListener('paste',e=>{const text=e.clipboardData?.getData('text/plain')||'';if(/https?:\/\//i.test(text)&&(/[\r\n]/.test(text)||/(?:提取码|通过.+分享)/.test(text))){e.preventDefault();paste.value=text;recognize();importer.scrollIntoView({behavior:'smooth',block:'start'});importStatus.textContent='已识别粘贴内容，点击“填入选中组”或追加，解压码不会改动'}});input.addEventListener('blur',()=>{record.url=input.value.trim();input.value=record.url;if(!record.driveName.trim()){record.driveName=detectDrive(record.url);row.querySelector('[data-field=driveName]').value=record.driveName}})}input.addEventListener('input',()=>{record[field]=input.value;dirty=true});label.append(node('span','',labelText),input);row.append(label);
   if(field==='unzipPassword'&&presets.length){const quick=node('div','rle-actions'),select=node('select');select.setAttribute('aria-label',`第${index+1}组选择快捷解压码`);const choose=node('option','','选择快捷解压码');choose.value='';select.append(choose);presets.forEach(p=>{const o=node('option','',p.label);o.value=p.id;select.append(o)});quick.append(select,button('填入快捷码',()=>{const p=presets.find(p=>p.id===select.value);if(!p)return;if(record.unzipPassword&&record.unzipPassword!==p.value&&!confirm('用选中的快捷码替换当前解压码？'))return;record.unzipPassword=p.value;input.value=p.value;dirty=true}));row.append(quick)}
  }rows.append(row)});if(!records.length)rows.append(node('p','rle-hint','还没有链接，可粘贴识别或手动添加。'))}
 renderRows();
 const history=node('details','rle-section');history.append(node('summary','','历史版本'));const historyList=node('div');history.append(historyList);history.addEventListener('toggle',async()=>{
  if(!history.open||history.dataset.loaded)return;historyList.textContent='读取中...';
  try{const result=await request('/api/links/history?cardId='+encodeURIComponent(cardId));historyList.replaceChildren();
   for(const version of result.versions){if(version.resourceId!==cardId||version.records.some(r=>r.resourceId!==cardId))throw Error('历史记录所属资源不匹配');const entry=node('details','rle-detected');entry.append(node('summary','','版本 '+version.revision+' · '+new Date(version.updated_at).toLocaleString('zh-CN')+' · '+(version.active?'完整记录':'待核对')));
    for(const record of version.records){entry.append(node('p','rle-url',record.url),node('p','','网盘：'+(record.driveName||'未填写')+'；提取码：'+(record.extractionCode||'未填写')+'；解压码：'+(record.unzipPassword||'未填写')+'；备注：'+(record.remark||'未填写')))}
    if(version.legacyArchive?.text)entry.append(node('p','rle-hint','该版本保留的迁移原文：'),node('pre','rle-legacy',version.legacyArchive.text));
    if(version.audit)entry.append(node('p','rle-hint','字段修改记录（只读）'),node('pre','rle-legacy',JSON.stringify(version.audit,null,2)));
    const b=button('载入完整记录',()=>{if(!confirm('载入此历史版本？核对后点击保存才会生效。'))return;records=version.records.map(r=>({...r}));restoreRevision=version.revision;dirty=true;renderRows();status.textContent='已载入历史版本，尚未保存'});b.disabled=!version.active;entry.append(b);historyList.append(entry)
   }if(!result.versions.length)historyList.textContent='暂无历史版本';history.dataset.loaded='1'
  }catch(e){historyList.textContent=e.message}
 });if(root.adminProfile?.role!=='contributor')body.append(history);
 const footer=node('footer','rle-footer'),save=button('保存到 R2',async()=>{
  if(saving)return;
  const snapshot=records.map(r=>({...r,resourceId:cardId,url:r.url.trim(),driveName:r.driveName.trim()||detectDrive(r.url)}));
  for(let i=0;i<snapshot.length;i++){try{const url=new URL(snapshot[i].url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error()}catch(e){status.textContent='第 '+(i+1)+' 组链接无效，请填写完整 HTTP/HTTPS 网址';rows.children[i]?.querySelector('[data-field=url]')?.focus();return}}
  if(!snapshot.length&&!confirm('保存后此资源将没有下载链接。确定继续？'))return;
  saving=true;save.disabled=true;closeButton.disabled=true;page.classList.add('rle-saving');status.textContent='正在保存完整记录到 R2...';
  try{const result=await request('/api/links/save',{method:'POST',body:JSON.stringify({contractVersion:1,cardId,baseRevision:base.revision,records:snapshot,restoreRevision,card:root.resourceCardFromDom(card)})});if(card&&Number(card.dataset.resourceRevision||0)===base.revision)card.dataset.resourceRevision=String(result.revision);base.revision=result.revision;root.resourceSiteRevision=result.siteRevision;records=result.records.map(r=>({...r}));hasPending=false;dirty=false;if(card){card.dataset.useKv='done';const lt=card.querySelector('.link-text');if(lt)lt.textContent=''}status.textContent='已保存到 R2，版本 '+result.revision;root.autoSave?.();root.showToast?.('链接已保存到 R2');renderRows()}
  catch(e){status.textContent='保存失败：'+e.message+'。编辑内容已保留，请勿关闭页面。'}
  finally{saving=false;save.disabled=false;closeButton.disabled=false;page.classList.remove('rle-saving')}
 });footer.append(button('关闭',close),save);shell.append(footer);if(status.textContent==='正在读取 R2 中的链接...')status.textContent='已读取 '+records.length+' 组链接，版本 '+base.revision;
}
const api={parseShareText,detectDrive,applyDetected,open};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.ResourceLinkEditor=api;
})(typeof window!=='undefined'?window:globalThis);
