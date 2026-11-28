(() => {
 'use strict';
 function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
 }
 const marks = {
  archive:'M3 4h18v5H3z M5 9v11h14V9 M10 13h4',
  plus:'M12 5v14 M5 12h14', close:'M6 6l12 12 M18 6L6 18',
  back:'M19 12H5 M11 6l-6 6 6 6', arrow:'M8 5l7 7-7 7',
  file:'M6 3h8l4 4v14H6z M14 3v5h4 M9 13h6 M9 16h4',
  download:'M12 3v12 M7 10l5 5 5-5 M4 16v4h16v-4',
  chat:'M3 4h18v13H9l-6 4z', user:'M15.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0 M5 20v-1a7 7 0 0 1 14 0v1',
  shield:'M12 2l8 3v6c0 5-4 9-8 11-4-2-8-6-8-11V5z M12 7v6 M12 16v.1'
 };
 function icon(key) {
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  for(const [k,v] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':1.65,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'})) svg.setAttribute(k,v);
  const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',marks[key]);svg.append(path);return svg;
 }
 function btn(text, handler, style='secondary', mark) {
  const b=el('button',null,'sv-btn sv-'+style);b.type='button';
  if(mark)b.append(icon(mark));
  b.append(el('span',text));
  b.onclick=async()=>{if(b.disabled)return;b.disabled=true;const at=epoch;try{await handler()}catch(e){if(epoch===at)notice(e.message)}finally{b.disabled=false}};
  return b;
 }
 const token=()=>sessionStorage.getItem('ADMIN_TOKEN')||currentUser?.sessionToken||'';
 const dialog=el('dialog',null,'game-saves'), head=el('div',null,'sv-head'), heading=el('h2'), nav=el('div',null,'sv-nav'), main=el('div',null,'sv-main'), status=el('p',null,'sv-status');
 heading.id='saves-heading';dialog.setAttribute('aria-labelledby',heading.id);status.setAttribute('role','status');
 const close=btn('关闭',()=>dialog.close(),'icon','close');
 nav.append(heading);head.append(nav,close);dialog.append(head,status,main);document.body.append(dialog);
 let card='',game='',source=null,entry=null,epoch=0;
 let saveProbe = null;

 function cancelSaveProbe() {
  saveProbe?.abort();
  saveProbe = null;
 }

 function displaySaveAccess(container, item, turn) {
  const active = () => epoch === turn && dialog.open;
  const session = token();
  container.replaceChildren();
  if (!session) {
   container.append(btn('登录后打开链接', () => login(), 'secondary', 'user'));
   return;
  }

  cancelSaveProbe();
  const controller = new AbortController();
  saveProbe = controller;
  const timer = setTimeout(() => controller.abort(), 25000);
  const progress = el('span', '正在核实网盘文件…');
  progress.setAttribute('role', 'status');
  container.append(progress);

  async function verify() {
   try {
    const data = await api('download', {id:item.id}, 'POST', undefined, controller.signal);
    if (!active() || session !== token()) return;
    const url = new URL(data.url);
    if (url.protocol !== 'https:' || url.username || url.password || data.success !== true) {
     throw Error('网盘链接暂不可用，请重试');
    }
    const passcode = typeof data.code === 'string' ? data.code : '';
    if (passcode && ['pan.baidu.com','yun.baidu.com'].includes(url.hostname)) url.searchParams.set('pwd', passcode);
    const link = el('a', '打开链接');
    link.href = url.href;
    link.referrerPolicy = 'no-referrer';
    link.onclick = event => {
     if (session === token()) return;
     event.preventDefault();
     displaySaveAccess(container, item, turn);
    };
    container.replaceChildren(link);
    if (passcode) {
     const value = el('code', passcode);
     const label = el('span', '提取码：');
     label.append(value);
     const copy = btn('复制提取码', async () => {
      if (session !== token()) { displaySaveAccess(container, item, turn); return; }
      try {
       await navigator.clipboard.writeText(passcode);
       if (active()) notice('提取码已复制');
      } catch {
       if (active()) {
        const range = document.createRange();
        range.selectNodeContents(value);
        const selection = window.getSelection();
        selection.removeAllRanges(); selection.addRange(range);
        notice('提取码已选中，可手动复制');
       }
      }
     }, 'text');
     container.append(label, copy);
    }
   } catch (error) {
    if (!active() || saveProbe !== controller) return;
    if (session !== token()) { displaySaveAccess(container, item, turn); return; }
    const message = controller.signal.aborted ? '核验超时，请重试' : error.message || '核验失败，请重试';
    progress.textContent = message;
    container.append(btn('重新核验', () => displaySaveAccess(container, item, turn)));
   } finally {
    clearTimeout(timer);
    if (saveProbe === controller) saveProbe = null;
   }
  }
  verify();
 }

 function notice(text){status.textContent=text}
 function view(title,back){
  cancelSaveProbe();epoch++;nav.replaceChildren();if(back)nav.append(btn('返回列表',back,'icon','back'));
  heading.textContent=title;nav.append(heading);main.replaceChildren();main.scrollTop=0;notice('');
  if(!dialog.open)dialog.showModal();
 }
 function login(){if(token())return true;dialog.close();openUserModal();showToast('请登录后继续');return false}
 async function api(action,params={},method='GET',data,signal){
  const auth=token(),headers=auth?{Authorization:'Bearer '+auth}:{};
  if(data)headers['Content-Type']='application/json';
  const r=await fetch(WORKER_BASE+'/api/saves/'+action+'?'+new URLSearchParams(params),{method,headers,body:data?JSON.stringify(data):undefined,cache:'no-store',signal});
  const j=await r.json();if(auth!==token())throw Error('账号已切换，请重新打开存档');if(!r.ok)throw Error(j.error||'请求失败');return j;
 }
 function label(text,control){const node=el('label',text,'sv-field');node.append(control);return node}
 function size(n){return n>=1048576?(n/1048576).toFixed(2)+' MiB':n>=1024?(n/1024).toFixed(1)+' KiB':n+' 字节'}
 function syncCount(b,id){api('count',{card:id}).then(j=>{b.querySelector('span').textContent='玩家存档（'+j.count+'）'}).catch(()=>{})}
 dialog.addEventListener('close',()=>{if(dialog.open)return;cancelSaveProbe();epoch++;main.replaceChildren();if(entry?.isConnected)syncCount(entry,card)});
 function artwork(id,from){
  const host=from||document.querySelector('#box [data-card-id="'+CSS.escape(id)+'"]');
  const img=host?.querySelector('.slider-box img,.card-thumb img');
  const src=img?.dataset.src||img?.getAttribute('src');
  if(!src||!/^https?:\/\//i.test(src))return null;
  const copy=el('img');copy.src=src;copy.alt='';copy.addEventListener('error',()=>copy.remove(),{once:true});return copy;
 }
 function gameStrip(title,id,from){
  const band=el('div',null,'sv-game'),image=artwork(id,from);
  if(image)band.append(image);
  const copy=el('div');copy.append(el('small','所属作品'),el('strong',title));band.append(copy);return band;
 }
 function date(ms){return ms?new Date(ms).toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'}):''}
 function byline(name,time){
  const line=el('div',null,'sv-byline');line.append(icon('user'),el('span',name||'玩家'));if(time)line.append(el('time',date(time)));return line;
 }
 function warning(item){return el('p',item.reports>=15?'已下架 · 投毒举报达到 15 人':'风险提示 · 已有 '+item.reports+' 人举报投毒','sv-warning')}
 function chips(item){const box=el('div',null,'sv-tags');box.append(el('span',item.provider),el('span',size(item.bytes)));return box}
 function empty(text,action){
  const node=el('div',null,'sv-empty');node.append(icon('archive'),el('p',text));if(action)node.append(action);return node;
 }
 const share=()=>btn('分享存档',()=>{if(login())submitForm()},'primary','plus');
 function scanPanel(){
  const panel=el('aside',null,'sv-safety');
  const title=el('strong','存档文件查毒');
  title.prepend(icon('shield'));
  const links=el('div',null,'sv-scanners');
  for(const [name,url] of [
   ['VirScan','https://www.virscan.org/'],
   ['VirusTotal','https://www.virustotal.com/gui/home/upload'],
   ['MetaDefender Cloud','https://metadefender.com/']
  ]){
   const link=el('a',name);
   link.href=url;link.target='_blank';link.rel='noopener noreferrer';links.append(link);
  }
  panel.append(title,el('p','使用前请任选一个网站，上传下载好的存档或压缩包进行检测。样本可能被共享，请勿上传含个人信息的文件。'),links);
  return panel;
 }
 async function showList(mine=false){
  if(mine&&!login())return;
  view(mine?'我的投稿':'玩家存档',mine&&card?()=>showList(false):null);const turn=epoch;
  if(!mine)main.append(gameStrip(game,card,source),scanPanel());
  const bar=el('div',null,'sv-toolbar'),count=el('h3',mine?'已发布的存档':'存档列表'),actions=el('div',null,'sv-actions');
  bar.append(count,actions);if(!mine)actions.append(btn('我的投稿',()=>showList(true),'text','user'));
  const list=el('div',null,'sv-list');main.append(bar,list);let offset=0;
  async function load(){
   const j=await api(mine?'mine':'list',{card,offset});if(turn!==epoch)return;
   list.querySelector('.save-more')?.remove();
   if(!offset){if(j.items.length&&!mine)actions.append(share());else if(!j.items.length)list.append(empty(mine?'还没有存档投稿':'这款游戏还没有玩家分享存档。',mine?null:share()))}
   for(const item of j.items){
    const row=el('article',null,'sv-card'+(item.reports>=10?' sv-risk':'')),body=el('div',null,'sv-card-body'),top=el('div',null,'sv-card-top'),bottom=el('div',null,'sv-card-bottom');
    const thumb=el('div',null,'sv-filemark'),photo=mine?artwork(item.card):null;thumb.append(photo||icon('file'));if(photo)thumb.classList.add('sv-cover');
    const title=el('h4',mine?item.title:(item.note||item.authorName+'的存档'));top.append(title);body.append(top);
    if(mine&&item.note)body.append(el('p',item.note,'sv-note'));
    body.append(chips(item));bottom.append(byline(item.authorName,item.created));
    const tools=el('div',null,'sv-actions');
    if(mine)tools.append(btn('删除投稿',async()=>{if(!confirm('确定删除这份存档投稿及其评论？网盘里的原文件由你管理。'))return;await api('item',{id:item.id},'DELETE');if(turn===epoch)await showList(true)},'text'));
    if(item.reports<15)tools.append(btn('查看存档',()=>detail(item,mine),'open','arrow'));bottom.append(tools);
    if(item.reports>=10)body.append(warning(item));body.append(bottom);row.append(thumb,body);list.append(row);
   }
   offset+=j.items.length;
   if(j.more){const more=btn('加载更多',load);more.classList.add('save-more');list.append(more)}
  }
  try{await load()}catch(e){if(turn===epoch){notice(e.message);list.append(btn('重试',()=>showList(mine)))}}
 }
 function submitForm(){
  view('分享存档',()=>showList(false));
  const turn=epoch, owner=token(), resourceId=card;
  const form=el('form',null,'sv-compose'), draft=el('textarea'), feedback=el('small','', 'sv-help');
  const url=el('input'), code=el('input'), note=el('textarea'), send=el('button','发布存档','sv-btn sv-primary');
  draft.rows=3;draft.maxLength=60000;draft.placeholder='粘贴完整分享文案，发布时只提交下方字段。';
  feedback.setAttribute('role','status');feedback.hidden=true;
  url.type='url';url.required=true;url.placeholder='https://';code.maxLength=16;
  note.placeholder='适用哪个版本？玩到哪里？';send.type='submit';
  const fields=el('div',null,'sv-fields');
  fields.append(label('国内网盘单文件链接',url),label('提取码（选填）',code));
  form.append(label('分享文案（草稿）',draft),feedback,fields,label('文件说明（最多 120 字）',note),
   el('p','仅限可核实大小的单个存档文件，最大 5 MiB。','sv-help'),send);
  main.append(gameStrip(game,card,source),form);

  const codeParams=['pwd','password','passcode','access_code'];
  function linkParts(value){
   try{
    const u=new URL(value), codes=[];
    for(const name of codeParams){
     codes.push(...u.searchParams.getAll(name).filter(Boolean));
     u.searchParams.delete(name);
    }
    return {url:u.href,codes};
   }catch{return {url:value,codes:[]}}
  }
  function shareRecord(record){
   const u=new URL(record.url);
   // App install pages and other web links can accompany the actual share.
   const drive=record.driveName;
   if(['百度网盘','夸克网盘','UC网盘','阿里云盘','123云盘'].includes(drive) ||
      ['www.123pan.cn','www.123pan.com.cn'].includes(u.hostname))return /^\/s\/[^/]+\/?$/.test(u.pathname);
   if(drive==='天翼云盘')return /^\/t\/[^/]+\/?$/.test(u.pathname);
   if(drive==='蓝奏云')return /^\/(?:tp\/)?[ib][\w-]+\/?$/.test(u.pathname);
   return false;
  }
  let manualUrl=false,manualCode=false,lastUrl='',records=[];
  function sync(){
   const only=records.length===1 ? records[0] : null;
   if(!manualUrl)url.value=only ? linkParts(only.url).url : '';
   const current=linkParts(url.value.trim());
   if(lastUrl && lastUrl!==current.url){manualCode=false;code.value=''}
   lastUrl=current.url;
   const selected=records.find(r=>linkParts(r.url).url===current.url);
   const candidates=new Set([...current.codes,...(selected ? linkParts(selected.url).codes : [])]);
   if(selected?.extractionCode)candidates.add(selected.extractionCode);
   const conflict=candidates.size>1 || selected?.warnings.some(w=>w.includes('不同的提取码'));
   if(!manualCode)code.value=candidates.size===1&&!conflict ? [...candidates][0] : '';
   const needsCode=!!conflict && !(manualCode&&code.value.trim());
   code.setCustomValidity(needsCode?'发现不同的提取码，请在此确认实际使用的提取码。':'');
   feedback.hidden=!draft.value.trim();
   if(feedback.hidden){feedback.textContent='';return}
   if(needsCode){feedback.textContent='提取码不一致，请手动核对。';return}
   if(records.length>1&&!selected){feedback.textContent='检测到多个分享链接，请保留一条，或在下方填写要发布的链接。';return}
   if(manualUrl && !selected){feedback.textContent='使用下方手动填写的链接。';return}
   feedback.textContent=selected ? (code.value?'已识别分享链接，使用下方提取码。':'已识别分享链接，提取码留空。') : '没有识别到网盘分享链接，可在下方手动填写。';
  }
  draft.addEventListener('input',()=>{
   const text=draft.value.replace(/(https?)\\+[:：]\/\//gi,'$1://');
   if(!url.value.trim())manualUrl=false;
   try{
    const result=ResourceLinkEditor.parseShareText(text);
    records=result.records.filter(shareRecord);
    if(result.warnings.some(w=>w.includes('重复分享链接'))){
     const repeated=new Map(records.map(r=>[linkParts(r.url).url,{record:r,codes:new Set(r.extractionCode?[r.extractionCode]:[])}]));
     const plain=text.replace(/\[[^\]\n]*\]\((https?:\/\/[^\s()]+)\)/gi,'$1');
     for(const block of plain.split(/(?=https?:\/\/)/i)){
      const item=ResourceLinkEditor.parseShareText(block).records[0];
      if(!item)continue;
      const group=repeated.get(linkParts(item.url).url);
      if(!group)continue;
      for(const value of [...linkParts(item.url).codes,item.extractionCode])if(value)group.codes.add(value);
      if(group.codes.size>1 || item.warnings.some(w=>w.includes('不同的提取码'))){
       group.record.warnings.push('发现不同的提取码，请手动核对');
      }else if(group.codes.size===1){
       group.record.extractionCode=[...group.codes][0];
      }
     }
    }
   }catch(error){
    records=[];sync();
    feedback.hidden=false;feedback.textContent='内容较多，请只保留一条分享文案，或手动填写链接。';
    return;
   }
   sync();
  });
  url.addEventListener('input',()=>{manualUrl=true;sync()});
  code.addEventListener('input',()=>{manualCode=true;sync()});
  form.addEventListener('submit',async e=>{
   e.preventDefault();if(send.disabled)return;
   if(token()!==owner || card!==resourceId || !owner){notice('账号或作品已切换，请重新打开投稿。');return}
   if([...note.value].length>120){notice('文件说明最多 120 字');return}
   const target=linkParts(url.value.trim()).url;
   send.disabled=true;notice('正在核实文件数量和大小…');
   try{
    await api('submit',{card:resourceId},'POST',{url:target,code:code.value.trim(),note:note.value});
    if(epoch===turn)await showList(false);
   }catch(err){if(epoch===turn)notice(err.message)}finally{send.disabled=false}
  });
 }
 function detail(item,mine){
  view('存档详情',()=>showList(mine));const turn=epoch;
  const info=el('div',null,'sv-panel'),links=el('div',null,'sv-links'),tools=el('div',null,'sv-actions');
  info.append(el('h3',item.note||item.authorName+'的存档'),chips(item),byline(item.authorName,item.created));if(item.reports>=10)info.append(warning(item));
  tools.append(btn('举报投毒',async()=>{if(!login()||!confirm('确认举报这份存档可能含有恶意文件？'))return;await api('report',{id:item.id},'POST');if(turn===epoch){await showList(mine);notice('举报已记录')}},'text'));
  info.append(scanPanel(),links,tools);
  displaySaveAccess(links, item, turn);
  const comments=el('section',null,'sv-comments'),form=el('form'),input=el('textarea'),to=el('small'),send=el('button','发表评论','sv-btn sv-secondary'),list=el('div');
  let parent=null,offset=0;const cancel=btn('取消回复',()=>{parent=null;to.textContent='';cancel.hidden=true},'text');cancel.hidden=true;
  input.required=true;send.type='submit';comments.append(el('h3','存档评论'),form,list);form.append(to,cancel,label('评论或回复',input),send);
  main.append(gameStrip(item.title,item.card,item.card===card?source:null),info,comments);
  async function load(reset=false){
   const start=reset?0:offset,j=await api('comments',{id:item.id,offset:start});if(turn!==epoch)return;
   if(reset)list.replaceChildren();list.querySelector('.save-more')?.remove();
   if(!start&&!j.items.length)list.append(el('p','暂无评论','sv-help'));
   for(const c of j.items){
    const row=el('article',null,'sv-comment');row.append(byline(c.name+(c.parentName?' 回复 '+c.parentName:''),c.created),el('p',c.body),btn('回复',()=>{if(!login())return;parent=c.id;to.textContent='回复 '+c.name;cancel.hidden=false;input.focus()},'text'));list.append(row);
   }
   offset=start+j.items.length;if(j.more){const b=btn('更多评论',()=>load());b.classList.add('save-more');list.append(b)}
  }
  form.onsubmit=async e=>{e.preventDefault();if(!login()||send.disabled)return;send.disabled=true;try{await api('comments',{id:item.id},'POST',{body:input.value,parent});if(turn!==epoch)return;input.value='';parent=null;to.textContent='';cancel.hidden=true;await load(true)}catch(err){if(turn===epoch)notice(err.message)}finally{send.disabled=false}};
  load(true).catch(e=>{if(turn===epoch)notice(e.message)});
 }
 window.gameSaveButton=(id,title,from)=>{
  const b=btn('玩家存档',()=>{card=id;game=title;source=from;entry=b;return showList(false)},'secondary','archive');b.dataset.card=id;syncCount(b,id);return b;
 };
 window.openMyGameSaves=()=>{card='';game='';source=null;entry=null;return showList(true)};
})();
