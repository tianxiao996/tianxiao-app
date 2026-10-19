(function(root){
'use strict';
const key='tx-resource-return';
root.renderResourceEditEntries=function(){
 for(const card of document.querySelectorAll('#box>.card')){
  card.querySelectorAll('.resource-edit-entry').forEach(el=>el.remove());
  if(!root.adminToken||root.adminProfile?.role!=='owner'||!document.body.classList.contains('admin-mode')||adminAuditMode)continue;
  const slot=card.querySelector('.card-preview-bottom');if(!slot)continue;
  const edit=document.createElement('button');edit.type='button';edit.className='resource-edit-entry';edit.textContent='编辑资源';edit.addEventListener('click',event=>{event.stopPropagation();root.openResourceEditor(card.dataset.cardId)});slot.append(edit);
 }
};
root.openResourceEditor=function(id){
 if(!root.adminToken){root.showToast?.('请先登录管理员');return}
 const url=new URL('admin-resource.html',location.href);if(id==='new')url.searchParams.set('new','1');else if(id)url.searchParams.set('id',id);
 const scroll=document.getElementById('mainScroll');
 try{sessionStorage.setItem(key,JSON.stringify({accountId:root.adminProfile?.id,category:currentCat,page:currentPage,search:document.getElementById('search').value,mainTop:scroll?.scrollTop||0,windowTop:root.scrollY,at:Date.now(),adminMode:true}))}
 catch(error){root.showToast?.('无法保存返回位置，将直接进入编辑页')}
 location.assign(url.href);
};
root.addCard=function(){root.openResourceEditor('new')};
const enter=root.enterAdmin;
root.enterAdmin=async function(...args){
 const result=await enter.apply(this,args);
 if(root.adminProfile?.role==='owner'&&document.body.classList.contains('admin-mode')){
  const slot=document.getElementById('adminBarBtns')||document.getElementById('adminBar');
  if(slot&&!slot.querySelector('#openResourceManager')){const button=document.createElement('button');button.id='openResourceManager';button.type='button';button.textContent='资源管理';button.onclick=()=>root.openResourceEditor();slot.append(button)}
 }
 root.renderResourceEditEntries();return result;
};
let restoring=false;
async function restore(){
 if(restoring)return;let saved;try{saved=JSON.parse(sessionStorage.getItem(key)||'null')}catch(error){sessionStorage.removeItem(key);return}
 if(!saved)return;
 if(typeof saved.at!=='number'||Date.now()-saved.at>86400000||!sessionStorage.getItem('ADMIN_TOKEN')){sessionStorage.removeItem(key);return}
 if(typeof _cloudLoadDone==='undefined'||!_cloudLoadDone||document.getElementById('globalLoadingOverlay')?.classList.contains('show')){setTimeout(restore,100);return}
 restoring=true;
 try{
  if(saved.adminMode&&!document.body.classList.contains('admin-mode'))await root.enterAdmin();
  if(root.adminProfile?.id!==saved.accountId)return;
  document.getElementById('search').value=typeof saved.search==='string'?saved.search:'';
  currentCat=typeof saved.category==='string'?saved.category:'all';currentPage=Number.isSafeInteger(saved.page)&&saved.page>0?saved.page:1;
  renderNav();refreshUI(currentPage);
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const scroll=document.getElementById('mainScroll');if(scroll)scroll.scrollTop=Math.max(0,Number(saved.mainTop)||0);root.scrollTo(0,Math.max(0,Number(saved.windowTop)||0));
 }finally{sessionStorage.removeItem(key);restoring=false}
}
root.addEventListener('pageshow',event=>{if(event.persisted&&sessionStorage.getItem(key)){location.reload();return}restore()});
restore();
})(window);
