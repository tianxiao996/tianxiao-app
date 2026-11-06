(function(){
 'use strict';let modal,busy=false,version='',pending=[],pendingBatch='';
 const make=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n},$=id=>document.getElementById(id);
 async function api(path,options={}){const token=sessionStorage.getItem('ADMIN_TOKEN');if(!token)throw Error('请先登录管理员');const r=await fetch('https://api.tian-xiao.com/api/admin/meme-captcha'+path,{...options,cache:'no-store',headers:{Authorization:'Bearer '+token,...options.headers}}),d=await r.json();if(!r.ok||d.success===false||d.error)throw Error(d.error||'操作失败');return d}
 function status(text){$('memeImportStatus').textContent=text}
 async function refresh(){const d=await api('');version=d.version;$('memeUndoImport').disabled=!d.canUndo;$('memeCatalogList').textContent=d.items.map(x=>x.label).join('、');$('memeCatalogCount').textContent='当前题库：'+d.items.length+' 张图片，'+new Set(d.items.map(x=>x.label)).size+' 种名称'}
 function init(){
  if(modal)return;modal=make('div');modal.id='memeImageManager';modal.hidden=true;
  const box=make('section');box.className='meme-image-manager-box';box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-labelledby','memeManagerTitle');
  const close=make('button','×');close.type='button';close.className='meme-manager-close';close.setAttribute('aria-label','关闭验证图片管理');close.onclick=()=>{if(busy){status('正在导入，请等待完成后关闭');return}modal.hidden=true};
  const title=make('h2','验证图片管理');title.id='memeManagerTitle';box.append(close,title,make('p','选择图片后填写名称，题目会显示“请选择该名称”。默认使用文件名；同名图片属于同一类。原图会保留，验证图片自动压缩。'));
  const input=make('input');input.type='file';input.accept='image/png,image/jpeg,image/webp,image/gif';input.multiple=true;input.id='memeImportFiles';input.onchange=()=>{pendingBatch=crypto.randomUUID();pending=[...input.files].map(file=>({file,label:file.name.replace(/\.[^.]+$/,'')}));$('memePendingImages').replaceChildren();for(const item of pending){const row=make('label',item.file.name),name=make('input');name.type='text';name.maxLength=80;name.value=item.label;name.setAttribute('aria-label','图片名称：'+item.file.name);name.oninput=()=>item.label=name.value;row.append(name);$('memePendingImages').append(row)}status('已选择 '+pending.length+' 张图片，请核对名称后导入')};
  const rows=make('div');rows.id='memePendingImages';const upload=make('button','压缩并导入');upload.id='memeImportSubmit';upload.type='button';upload.onclick=async()=>{
   if(busy)return;if(!pending.length)return status('请先选择图片');if(pending.length>100)return status('每次最多导入100张图片');if(pending.some(x=>!x.label.trim()))return status('每张图片都需要名称');
   busy=true;upload.disabled=input.disabled=true;let done=0;const failed=[];
   for(const item of pending){try{status('正在压缩并导入 '+(done+1)+' / '+pending.length+'：'+item.file.name);const image=await ResourceImageTools.compress(item.file,{maxEdge:640,quality:.78,force:true}),form=new FormData();form.append('label',item.label.trim());form.append('batchId',pendingBatch);form.append('original',item.file,item.file.name);form.append('image',image,'captcha.webp');await api('',{method:'POST',body:form});done++}catch(error){failed.push(item.file.name+'：'+error.message)}}
   pending=pending.filter(x=>failed.some(f=>f.startsWith(x.file.name+'：')));busy=false;upload.disabled=input.disabled=false;try{await refresh()}catch(error){failed.push('题库刷新失败：'+error.message)}status('已导入 '+done+' 张。'+(failed.length?'失败项目：'+failed.join('；'):'新图片已经生效，原图已保留。'));if(!pending.length){input.value='';$('memePendingImages').replaceChildren()}
  };
  const undo=make('button','撤销最近一批导入');undo.type='button';undo.id='memeUndoImport';undo.onclick=async()=>{if(busy||!confirm('撤销最近一批题库导入？图片原文件和历史题库仍保留。'))return;busy=true;try{await api('/undo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version})});await refresh();status('已恢复上一份题库，图片原文件仍保留')}catch(error){status(error.message)}finally{busy=false}};
  const message=make('p');message.id='memeImportStatus';message.setAttribute('role','status');const count=make('p');count.id='memeCatalogCount';const list=make('p');list.id='memeCatalogList';box.append(input,rows,upload,undo,message,count,list);modal.append(box);document.body.append(modal);
 }
 window.openMemeImageManager=async function(){init();modal.hidden=false;try{await refresh()}catch(error){status(error.message)}};
})();
