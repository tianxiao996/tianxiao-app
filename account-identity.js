(function(){
'use strict';
const $=id=>document.getElementById(id);let loading=null,epoch=0,focusReturn=null,entering=null,viewToken=null;
const adminActive=()=>!!sessionStorage.getItem('ADMIN_TOKEN');
function adminViewReady(){return viewToken===sessionStorage.getItem('ADMIN_TOKEN')&&document.body.classList.contains('admin-mode')&&!!$('adminBar')&&!!$('adminBarBtns')&&['owner','contributor'].includes(window.adminProfile?.role)}
function clearAdminView(){
 viewToken=null;isEditMode=false;adminAuditMode=false;window.adminProfile=null;
 document.body.classList.remove('admin-mode','admin-contributor');
 $('adminHeaderSlot')?.replaceChildren();$('adminMainSlot')?.replaceChildren();$('adminDashboard')?.remove();
 updateSidebarAdminUI();resetAllCardStates();refreshUI();
}
// The poll frame has independently revalidated the shared account on the server.
window.addEventListener('message',event=>{
 const frame=$('pollPanelFrame');
 if(!frame||event.origin!==location.origin||event.source!==frame.contentWindow||event.data?.type!=='tx-poll:expired')return;
 if(adminActive()||localStorage.getItem('tx_user'))return;
 if(currentUser?.isAdmin||document.body.classList.contains('admin-mode')){
  ++epoch;loading=null;clearSocial();clearAdminView();closeAccount();
 }else if(currentUser){
  currentUser=null;_userHomeData=null;_isUserBanned=false;_banInfo=null;updateUserEntryBtn();
 }
});
function restoreAdminView(){
 if(!adminActive()||adminViewReady())return;
 return window.enterAdmin().catch(e=>showToast(e.message));
}
function clearSocial(){currentUser=null;_userHomeData=null;_isUserBanned=false;_banInfo=null;favorites=new Set();updateUserEntryBtn();initCardFavorites()}
// Admin favorites are server-owned; preserve the ordinary account's existing
// browser cache rather than sharing or erasing it when switching identities.
const oldSaveFavorites=saveFavorites;window.saveFavorites=function(){if(!adminActive())return oldSaveFavorites.apply(this,arguments)};
async function api(path,options={}){
 const token=sessionStorage.getItem('ADMIN_TOKEN');if(!token)throw Error('管理员登录已失效');
 const r=await fetch(WORKER_BASE+path,{...options,cache:'no-store',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers}}),j=await r.json();
 if(token!==sessionStorage.getItem('ADMIN_TOKEN'))throw Error('账号已切换，请重新操作');
 if(!r.ok||j.success===false){const e=Error(j.error||'请求失败');e.status=r.status;throw e}return j;
}
function showAccountData(a){
 $('adminPublicName').textContent=a.username;
 $('adminPublicRole').textContent=a.role==='owner'?'主管理员':'资源管理员';
 $('adminAvatarInitial').textContent=Array.from(a.username||'管')[0];
 const avatar=$('adminPublicAvatar');
 if(a.avatar){avatar.src=a.avatar;avatar.hidden=false}else{avatar.hidden=true;avatar.removeAttribute('src')}
 if(!$('adminNicknameEditor').open)$('adminNickname').value=a.username;
 $('adminFavoriteCount').textContent=favorites.size+' 部作品';
 $('adminIdentityStatus').textContent='';
}
async function refreshAdminIdentity(){
 if(loading)return loading;const token=sessionStorage.getItem('ADMIN_TOKEN');if(!token)return;
 const turn=++epoch;loading=(async()=>{
  const j=await api('/api/account/session');if(turn!==epoch||token!==sessionStorage.getItem('ADMIN_TOKEN'))return;
  currentUser={...j.account,sessionToken:token,isAdmin:true};localStorage.removeItem('tx_user');_userHomeData=null;_isUserBanned=false;_banInfo=null;
  favorites=new Set(j.favorites||[]);saveFavorites();initCardFavorites();updateUserEntryBtn();showAccountData(currentUser);
  if(window.adminProfile)window.adminProfile.displayName=currentUser.username;
  if(currentCommentCardId)loadComments(currentCommentCardId);return currentUser;
 })().catch(e=>{if(token===sessionStorage.getItem('ADMIN_TOKEN')&&turn===epoch){$('adminIdentityStatus').textContent=e.message;if(e.status===401){sessionStorage.removeItem('ADMIN_TOKEN');clearSocial();clearAdminView();showToast('管理员登录已过期，请重新登录')}}throw e}).finally(()=>loading=null);return loading;
}
function openAdminAccount(){
 if(dialog.open)return;
 focusReturn=document.activeElement;
 $('adminNicknameEditor').open=false;
 if(currentUser?.isAdmin&&currentUser.sessionToken===sessionStorage.getItem('ADMIN_TOKEN'))showAccountData(currentUser);
 else{
  $('adminPublicName').textContent='读取账号中…';$('adminPublicRole').textContent='';
  $('adminPublicAvatar').hidden=true;$('adminPublicAvatar').removeAttribute('src');$('adminAvatarInitial').textContent='';
  $('adminNickname').value='';$('adminFavoriteCount').textContent='';
 }
 $('adminIdentityStatus').textContent='';dialog.showModal();
 refreshAdminIdentity().catch(()=>{});
}
function closeAccount(){if($('adminIdentityDialog').open)$('adminIdentityDialog').close();focusReturn?.focus();focusReturn=null}
const dialog=document.createElement('dialog');dialog.id='adminIdentityDialog';dialog.setAttribute('aria-labelledby','adminIdentityTitle');
const identityPaths={
 close:'M6 6l12 12M18 6L6 18', next:'m9 6 6 6-6 6',
 works:'M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8zm0 2h18',
 saves:'M3 4h18v5H3zM5 9v11h14V9M10 13h4',
 heart:'M12 20S3 14.4 3 8.7c0-4.4 5.7-6 9-1.5 3.3-4.5 9-2.9 9 1.5 0 5.7-9 11.3-9 11.3z',
 polls:'M4 20h16M6 16v-5m6 5V4m6 12V8',
 edit:'m14.5 4.5 5 5M4 20l4.5-1 12-12a1.7 1.7 0 0 0 0-2.4l-2.1-2.1a1.7 1.7 0 0 0-2.4 0L4.9 15.6 4 20z',
 leave:'M10 4H5v16h5M10 12h11m-5-5 5 5-5 5'
};
const icon=key=>`<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="${identityPaths[key]}"/></svg>`;
function actionText(mark,title,desc){
 return `<span class="identity-mark">${icon(mark)}</span><span class="identity-link-text"><strong>${title}</strong><small>${desc}</small></span>${icon('next')}`;
}
dialog.innerHTML=`
 <div class="identity-top">
  <h2 id="adminIdentityTitle">我的主页</h2>
  <button id="closeAdminIdentity" type="button" aria-label="关闭" autofocus>${icon('close')}</button>
 </div>
 <div class="identity-scroll">
  <div class="identity-profile">
   <div class="identity-portrait"><span id="adminAvatarInitial" aria-hidden="true"></span><img id="adminPublicAvatar" alt="" hidden></div>
   <div class="identity-name"><strong id="adminPublicName">读取账号中…</strong><span id="adminPublicRole"></span></div>
  </div>
  <section class="identity-content">
   <h3>我的内容</h3>
   <div class="identity-grid">
    <button id="adminMyResources" type="button">${actionText('works','我的发布','查看与编辑游戏资源')}</button>
    <button id="adminMyGameSaves" type="button">${actionText('saves','我的投稿','管理分享的玩家存档')}</button>
    <button id="adminViewFavorites" type="button">${actionText('heart','我的收藏','<span id="adminFavoriteCount"></span>')}</button>
    <a href="polls.html" data-open-poll aria-haspopup="dialog" aria-controls="pollPanel">${actionText('polls','游戏投票','进入活动列表')}</a>
   </div>
  </section>
  <details id="adminNicknameEditor">
   <summary>${icon('edit')}<span>修改昵称</span>${icon('next')}</summary>
   <form id="adminNicknameForm"><label for="adminNickname">对外显示的昵称</label>
    <div><input id="adminNickname" maxlength="20" autocomplete="nickname" required><button id="saveAdminNickname" type="submit">保存昵称</button></div>
   </form>
  </details>
  <p id="adminIdentityStatus" role="status"></p>
  <div class="identity-footer"><button id="adminAccountLogout" type="button">${icon('leave')}退出管理员账号</button></div>
 </div>`;
document.body.append(dialog);$('closeAdminIdentity').onclick=closeAccount;
$('adminPublicAvatar').onerror=()=>{$('adminPublicAvatar').hidden=true};
$('adminNicknameEditor').addEventListener('toggle',()=>{
 if($('adminNicknameEditor').open){
  $('adminNickname').value=currentUser?.isAdmin?currentUser.username:'';
  $('adminNickname').focus();
 }
});
$('adminNicknameForm').onsubmit=async e=>{
 e.preventDefault();const b=$('saveAdminNickname');b.disabled=true;
 try{const j=await api('/api/account/profile',{method:'PUT',body:JSON.stringify({displayName:$('adminNickname').value})});if(currentUser?.isAdmin){Object.assign(currentUser,j.account);updateUserEntryBtn();$('adminNicknameEditor').open=false;showAccountData(currentUser);if(window.adminProfile)window.adminProfile.displayName=currentUser.username;dialog.querySelector('summary').focus()}$('adminIdentityStatus').textContent='昵称已保存。';if(currentCommentCardId)loadComments(currentCommentCardId)}catch(e){$('adminIdentityStatus').textContent=e.message}finally{b.disabled=false}
};
$('adminMyGameSaves').onclick=()=>window.openMyGameSaves();
$('adminMyResources').onclick=()=>{closeAccount();window.openResourceEditor(null,{mine:true})};
$('adminViewFavorites').onclick=()=>{closeAccount();currentCat='收藏';currentPage=1;refreshUI()};
$('adminAccountLogout').onclick=async()=>{closeAccount();await exitAdmin()};
const userModal=openUserModal,userHome=openUserHome,oldLogout=doLogout,oldEnter=enterAdmin,oldExit=exitAdmin;
window.openUserModal=function(){if(adminActive())return openAdminAccount();return userModal.apply(this,arguments)};
window.openUserHome=function(){if(adminActive())return openAdminAccount();return userHome.apply(this,arguments)};
const oldSidebarLogin=onSidebarLoginClick;window.onSidebarLoginClick=function(){if(adminActive()){closeSidebar();return adminViewReady()?openAdminAccount():restoreAdminView()}return oldSidebarLogin.apply(this,arguments)};
window.doLogout=async function(){if(adminActive())return exitAdmin();return oldLogout.apply(this,arguments)};
window.enterAdmin=async function(){
 const token=sessionStorage.getItem('ADMIN_TOKEN');
 if(!token)return oldEnter.apply(this,arguments);
 if(entering?.token===token)return entering.promise;
 const context=this,args=arguments,flight={token,promise:null};
 flight.promise=(async()=>{
  if(!currentUser?.isAdmin||currentUser.sessionToken!==token){clearSocial();localStorage.removeItem('tx_user')}
  $('userModal')?.classList.remove('show');$('userHomeModal')?.classList.remove('show');
  const r=await oldEnter.apply(context,args);
  if(token!==sessionStorage.getItem('ADMIN_TOKEN')){if(!adminActive()){if(currentUser?.isAdmin&&currentUser.sessionToken===token)clearSocial();clearAdminView()}return r}
  if(!document.body.classList.contains('admin-mode')||!window.adminProfile)return r;
  viewToken=token;await refreshAdminIdentity().catch(e=>showToast(e.message));
  if(token!==sessionStorage.getItem('ADMIN_TOKEN')||!adminViewReady())return r;
  const bar=$('adminBarBtns');
  if(bar&&!$('adminPublicAccount')){const account=document.createElement('button');account.id='adminPublicAccount';account.type='button';account.textContent='我的账号';account.onclick=openAdminAccount;bar.append(account)}
  if(bar&&!$('adminOpenPolls')){const poll=document.createElement('button');poll.id='adminOpenPolls';poll.type='button';poll.textContent='游戏投票';poll.setAttribute('aria-haspopup','dialog');poll.setAttribute('aria-controls','pollPanel');poll.onclick=()=>window.openPollPanel(poll);bar.append(poll)}return r;
 })();
 entering=flight;try{return await flight.promise}finally{if(entering===flight)entering=null}
};
window.exitAdmin=async function(){++epoch;loading=null;viewToken=null;const r=await oldExit.apply(this,arguments);clearSocial();closeAccount();if(currentCommentCardId)loadComments(currentCommentCardId);return r};
const oldFavorite=toggleFavorite;
window.toggleFavorite=async function(button){
 if(!adminActive())return oldFavorite.apply(this,arguments);
 const card=button.closest('.card'),id=card?.dataset.cardId;if(!id||button.dataset.favoritePending)return;
 button.dataset.favoritePending='1';try{if(!currentUser?.isAdmin)await refreshAdminIdentity();const remove=favorites.has(id);await api('/api/account/favorites',{method:'POST',body:JSON.stringify({cardId:id,action:remove?'remove':'add'})});if(remove)favorites.delete(id);else favorites.add(id);saveFavorites();initCardFavorites();if(currentCat==='收藏')refreshUI()}catch(e){showToast(e.message)}finally{delete button.dataset.favoritePending}
};
const oldSync=syncFavoriteToCloud;window.syncFavoriteToCloud=function(id,action){if(adminActive())return api('/api/account/favorites',{method:'POST',body:JSON.stringify({cardId:id,action})}).catch(e=>showToast(e.message));return oldSync.apply(this,arguments)};
// A new main-page document has an empty admin DOM even when its tab-scoped
// login token survives navigation. Revalidate and restore the complete view.
if(document.readyState!=='complete')document.addEventListener('DOMContentLoaded',restoreAdminView,{once:true});else restoreAdminView();
window.addEventListener('load',restoreAdminView,{once:true});
window.addEventListener('pageshow',event=>{if(event.persisted)restoreAdminView()});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)restoreAdminView()});
})();
