(function(root){
'use strict';
root.openResourceEditor=function(id){
 if(!root.adminToken){root.showToast?.('请先登录管理员');return}
 const url=new URL('admin-resource.html',location.href);
 if(id==='new')url.searchParams.set('new','1');
 else if(id){
  url.searchParams.set('id',id);
  const card=document.querySelector('[data-card-id="'+CSS.escape(id)+'"]');
  if(card&&root.resourceCardFromDom)try{sessionStorage.setItem('tx-resource-transfer:'+id,JSON.stringify({accountId:root.adminProfile?.id,metadata:root.resourceCardFromDom(card)}))}catch(error){root.showToast?.('无法带入本地编辑，请先导出保留；新页面会读取云端资料')}
 }
 // Same-origin window creation copies this tab's sessionStorage. The token is
 // never placed in a URL or persistent storage. Detach the opener immediately.
 const child=window.open(url.href,'_blank');if(child)child.opener=null;else root.showToast?.('浏览器阻止了新页面，请允许此站点打开标签页后重试');
};
const originalAdd=root.addCard;
root.addCard=function(...args){if(document.body.classList.contains('admin-mode')&&root.adminToken)return root.openResourceEditor('new');return originalAdd?.apply(this,args)};
const originalEnter=root.enterAdmin;
root.enterAdmin=async function(...args){const result=await originalEnter.apply(this,args);if(root.adminProfile?.role==='owner'&&document.body.classList.contains('admin-mode')){
 const slot=document.getElementById('adminBar')||document.getElementById('adminHeaderSlot');if(slot&&!slot.querySelector('#openResourceManager')){const button=document.createElement('button');button.id='openResourceManager';button.type='button';button.textContent='资源管理';button.addEventListener('click',()=>root.openResourceEditor());slot.append(button)}
}return result};
try{const channel=new BroadcastChannel('tx-resource-editor');channel.addEventListener('message',event=>{if(event.data?.type==='saved'&&document.body.classList.contains('admin-mode'))root.showToast?.('资源已在独立页面保存。主页面需刷新同步，刷新前请保留本页未保存编辑。',6500)})}catch(error){}
})(window);
