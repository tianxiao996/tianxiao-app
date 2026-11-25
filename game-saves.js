(() => {
 'use strict';
 const make=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
 const button=(text,handler)=>{const b=make('button',text);b.type='button';b.onclick=async()=>{if(b.disabled)return;b.disabled=true;try{await handler()}catch(e){if(b.isConnected)notice(e.message)}finally{b.disabled=false}};return b};
 const token=()=>sessionStorage.getItem('ADMIN_TOKEN')||currentUser?.sessionToken||'';
 const dialog=make('dialog',undefined,'game-saves'),head=make('header'),heading=make('h2'),status=make('p'),main=make('div');
 heading.id='saves-heading';dialog.setAttribute('aria-labelledby',heading.id);status.setAttribute('role','status');
 head.append(heading,button('关闭',()=>dialog.close()));dialog.append(head,status,main);document.body.append(dialog);
 let card='',game='',generation=0,originButton;
 const notice=text=>{status.textContent=text};
 function present(title){
  generation++;heading.textContent=title;main.replaceChildren();notice('');
  if(!dialog.open)dialog.showModal();
 }
 function login(){if(token())return true;dialog.close();openUserModal();showToast('请登录后继续');return false}
 async function api(action,params={},method='GET',data){
  const auth=token(),headers=auth?{Authorization:'Bearer '+auth}:{};
  if(data)headers['Content-Type']='application/json';
  const r=await fetch(WORKER_BASE+'/api/saves/'+action+'?'+new URLSearchParams(params),{method,headers,body:data?JSON.stringify(data):undefined,cache:'no-store'});
  const j=await r.json();if(auth!==token())throw Error('账号已切换，请重新打开存档');if(!r.ok)throw Error(j.error||'请求失败');return j;
 }
 function label(text,control){const el=make('label',text);el.append(control);return el}
 function formatSize(n){return n>=1048576?(n/1048576).toFixed(2)+' MiB':n>=1024?(n/1024).toFixed(1)+' KiB':n+' 字节'}
 function syncCount(node,id){
  api('count',{card:id}).then(j=>{node.textContent='玩家存档（'+j.count+'）'}).catch(()=>{});
 }
 dialog.addEventListener('close',()=>{if(dialog.open)return;generation++;main.replaceChildren();if(originButton?.isConnected)syncCount(originButton,originButton.dataset.card)});
 async function showList(mine=false){
  if(mine&&!login())return;
  present(mine?'我的投稿':'玩家存档');const turn=generation;
  const bar=make('div',undefined,'save-actions');main.append(bar);
  if(!mine){bar.append(button('分享存档',()=>{if(login())submitForm()}),button('我的投稿',()=>showList(true)))}
  else if(card)bar.append(button('返回作品存档',()=>showList(false)));
  const list=make('div');main.append(list);let offset=0;
  async function load(){
   const j=await api(mine?'mine':'list',{card,offset});if(turn!==generation)return;
   list.querySelector('.save-more')?.remove();
   if(!j.items.length&&!offset)list.append(make('p',mine?'还没有存档投稿':'这款游戏还没有玩家分享存档。'));
   for(const item of j.items){
    const row=make('article');list.append(row);if(item.reports>=10)row.className='save-risk';
    if(mine)row.append(make('strong',item.title));
    row.append(make('p',item.note||'未填写说明'),make('small',item.authorName+' · '+item.provider+' · '+formatSize(item.bytes)));
    if(item.reports>=10)row.append(make('p',item.reports>=15?'已下架 · 投毒举报达到 15 人':'风险提示 · 已有 '+item.reports+' 人举报投毒','risk-label'));
    const actions=make('div',undefined,'save-actions');row.append(actions);
    if(item.reports<15)actions.append(button('查看存档',()=>detail(item,mine)));
    if(mine)actions.append(button('删除投稿',async()=>{if(!confirm('确定删除这份存档投稿及其评论？网盘里的原文件由你管理。'))return;await api('item',{id:item.id},'DELETE');if(turn===generation)await showList(true)}));
   }
   offset+=j.items.length;
   if(j.more){const more=button('加载更多',load);more.className='save-more';list.append(more)}
  }
  try{await load()}catch(e){if(turn===generation){notice(e.message);list.append(button('重试',()=>showList(mine)))}}
 }
 function submitForm(){
  present('分享存档');const turn=generation;
  const f=make('form'),url=make('input'),code=make('input'),note=make('textarea'),send=make('button','发布存档');
  url.type='url';url.required=true;url.placeholder='https://';code.maxLength=16;note.placeholder='适用哪个版本？玩到哪里？';send.type='submit';
  f.append(make('strong',game),make('p','请分享单个存档文件，最大 5 MiB。文件夹、多文件分享或无法核实大小的链接会被拒绝。'),label('国内网盘单文件链接',url),label('提取码（选填）',code),label('文件说明（最多 120 字）',note),send,button('返回',()=>showList(false)));main.append(f);
  f.onsubmit=async e=>{e.preventDefault();if(send.disabled)return;if([...note.value].length>120){notice('文件说明最多 120 字');return}send.disabled=true;notice('正在核实文件数量和大小…');try{await api('submit',{card},'POST',{url:url.value.trim(),code:code.value.trim(),note:note.value});if(turn===generation)await showList(false)}catch(err){if(turn===generation)notice(err.message)}finally{send.disabled=false}};
 }
 function detail(item,mine){
  present('存档详情');const turn=generation;
  const comments=make('section'),links=make('div'),tools=make('div',undefined,'save-actions'),scanner=make('div',undefined,'save-actions');
  main.append(button('返回列表',()=>showList(mine)),make('h3',item.title),make('p',item.note||'未填写说明'),make('small',item.authorName+' · '+item.provider+' · '+formatSize(item.bytes)));
  if(item.reports>=10)main.append(make('p','风险提示 · 已有 '+item.reports+' 人举报投毒','risk-label'));
  main.append(make('p','未知来源的文件，使用前务必扫毒。在线检测可能会共享提交的样本，请勿上传含个人信息的文件。'),scanner,tools,links,comments);
  for(const [name,url] of [['VirusTotal','https://www.virustotal.com/gui/home/upload'],['VirScan','https://www.virscan.org/'],['MetaDefender Cloud','https://metadefender.com/']]){
   const a=make('a',name);a.href=url;a.target='_blank';a.rel='noopener noreferrer';scanner.append(a);
  }
  tools.append(button('下载存档',async()=>{if(!login())return;notice('正在核实网盘文件…');const j=await api('download',{id:item.id},'POST');if(turn!==generation)return;notice('');const a=make('a','打开'+item.provider);a.href=j.url;a.target='_blank';a.rel='noopener noreferrer';links.replaceChildren(a);if(j.code)links.append(make('span',' 提取码 '+j.code))}),
   button('举报投毒',async()=>{if(!login()||!confirm('确认举报这份存档可能含有恶意文件？'))return;await api('report',{id:item.id},'POST');if(turn===generation){await showList(mine);notice('举报已记录')}}));
  const form=make('form'),input=make('textarea'),to=make('small'),send=make('button','发表评论'),list=make('div');let parent=null,offset=0;
  const cancel=button('取消回复',()=>{parent=null;to.textContent='';cancel.hidden=true});cancel.hidden=true;
  input.required=true;send.type='submit';comments.append(make('h3','存档评论'),form,list);form.append(to,cancel,label('评论或回复',input),send);
  async function load(reset=false){
   const start=reset?0:offset,j=await api('comments',{id:item.id,offset:start});if(turn!==generation)return;
   if(reset)list.replaceChildren();list.querySelector('.save-more')?.remove();
   if(!start&&!j.items.length)list.append(make('p','暂无评论'));
   for(const c of j.items){
    const row=make('article');row.append(make('small',c.name+(c.parentName?' 回复 '+c.parentName:'')+' · '+new Date(c.created).toLocaleDateString()),make('p',c.body),button('回复',()=>{if(!login())return;parent=c.id;to.textContent='回复 '+c.name;cancel.hidden=false;input.focus()}));list.append(row);
   }
   offset=start+j.items.length;if(j.more){const more=button('更多评论',()=>load());more.className='save-more';list.append(more)}
  }
  form.onsubmit=async e=>{e.preventDefault();if(!login()||send.disabled)return;send.disabled=true;try{await api('comments',{id:item.id},'POST',{body:input.value,parent});if(turn!==generation)return;input.value='';parent=null;to.textContent='';cancel.hidden=true;await load(true)}catch(err){if(turn===generation)notice(err.message)}finally{send.disabled=false}};
  load(true).catch(e=>{if(turn===generation)notice(e.message)});
 }
 window.gameSaveButton=(id,title)=>{
  const b=button('玩家存档',()=>{card=id;game=title;originButton=b;return showList(false)});b.dataset.card=id;syncCount(b,id);return b;
 };
 window.openMyGameSaves=()=>{card='';game='';originButton=null;return showList(true)};
})();

