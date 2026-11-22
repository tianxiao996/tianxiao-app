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
 $('adminPublicName').textContent=a.username;$('adminPublicRole').textContent=a.role==='owner'?'主管理员':'资源管理员';$('adminNickname').value=a.username;
 $('adminIdentityStatus').textContent='昵称用于评论、投稿和投票，不会修改登录账号。';
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
 focusReturn=document.activeElement;$('adminIdentityDialog').showModal();$('adminIdentityStatus').textContent='正在读取管理员身份…';$('adminNickname').focus();
 refreshAdminIdentity().catch(()=>{});
}
function closeAccount(){if($('adminIdentityDialog').open)$('adminIdentityDialog').close();focusReturn?.focus();focusReturn=null}
const dialog=document.createElement('dialog');dialog.id='adminIdentityDialog';dialog.setAttribute('aria-labelledby','adminIdentityTitle');
dialog.innerHTML='<div class="identity-heading"><h2 id="adminIdentityTitle">管理员账号</h2><button id="closeAdminIdentity" type="button" aria-label="关闭">×</button></div><p><strong id="adminPublicName">正在读取</strong> <span id="adminPublicRole"></span></p><form id="adminNicknameForm"><label for="adminNickname">对外昵称</label><input id="adminNickname" maxlength="20" autocomplete="nickname" required><button id="saveAdminNickname" type="submit">保存昵称</button></form><p id="adminIdentityStatus" role="status"></p><div class="identity-actions"><button id="adminMyResources" type="button">我的发布</button><button id="adminViewFavorites" type="button">我的收藏</button><a href="polls.html">游戏投票</a><button id="adminAccountLogout" type="button">退出管理员账号</button></div>';
document.body.append(dialog);$('closeAdminIdentity').onclick=closeAccount;
$('adminNicknameForm').onsubmit=async e=>{
 e.preventDefault();const b=$('saveAdminNickname');b.disabled=true;
 try{const j=await api('/api/account/profile',{method:'PUT',body:JSON.stringify({displayName:$('adminNickname').value})});if(currentUser?.isAdmin){Object.assign(currentUser,j.account);updateUserEntryBtn();showAccountData(currentUser);if(window.adminProfile)window.adminProfile.displayName=currentUser.username}$('adminIdentityStatus').textContent='昵称已保存，登录账号保持不变。';if(currentCommentCardId)loadComments(currentCommentCardId)}catch(e){$('adminIdentityStatus').textContent=e.message}finally{b.disabled=false}
};
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
  if(bar&&!$('adminOpenPolls')){const poll=document.createElement('button');poll.id='adminOpenPolls';poll.type='button';poll.textContent='游戏投票';poll.onclick=()=>location.assign('polls.html');bar.append(poll)}return r;
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
