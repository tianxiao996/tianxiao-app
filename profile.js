/* Profile layout adapted from Tabler's profile page (MIT). Cropping: Cropper.js 1.6.2 (MIT). */
let avatarCropper = null, avatarObjectUrl = null, avatarSaving = false, avatarFocusReturn = null;
function chooseUserAvatar(){if(!currentUser){openUserModal();return}if(_isUserBanned){showToast("账号被封禁，无法修改头像");return}document.getElementById("userAvatarFile").click()}
function onUserAvatarFile(input){
  const file=input.files[0];input.value="";if(!file)return;
  if(!["image/jpeg","image/png","image/webp"].includes(file.type)){showToast("请选择 JPG、PNG 或 WebP 图片");return}
  if(file.size>10*1024*1024){showToast("原图请控制在 10 MB 内");return}
  closeAvatarCrop();avatarFocusReturn=document.activeElement;avatarObjectUrl=URL.createObjectURL(file);
  const image=document.getElementById("avatarCropImage"),modal=document.getElementById("avatarCropModal");
  modal.hidden=false;document.getElementById("avatarCropStatus").textContent="";
  image.onload=()=>{
    if(!image.naturalWidth||image.naturalWidth>16384||image.naturalHeight>16384||image.naturalWidth*image.naturalHeight>40000000){closeAvatarCrop();showToast("图片尺寸过大，请选择较小的图片");return}
    avatarCropper=new Cropper(image,{aspectRatio:1,viewMode:1,dragMode:"move",autoCropArea:1,preview:".avatar-crop-preview",background:false,responsive:true,restore:false,checkOrientation:true,zoomOnWheel:true,cropBoxMovable:true,cropBoxResizable:true,toggleDragModeOnDblclick:false});
    document.getElementById("avatarSaveBtn").focus();
  };
  image.onerror=()=>{closeAvatarCrop();showToast("图片无法读取，请重新选择")};image.src=avatarObjectUrl;
}
function closeAvatarCrop(){if(avatarSaving)return;if(avatarCropper){avatarCropper.destroy();avatarCropper=null}const image=document.getElementById("avatarCropImage");if(image){image.onload=null;image.onerror=null;image.removeAttribute("src")}if(avatarObjectUrl){URL.revokeObjectURL(avatarObjectUrl);avatarObjectUrl=null}document.getElementById("avatarCropModal").hidden=true;avatarFocusReturn?.focus();avatarFocusReturn=null}
function zoomAvatarCrop(amount){if(!avatarSaving)avatarCropper?.zoom(amount)}
function rotateAvatarCrop(){if(!avatarSaving)avatarCropper?.rotate(90)}
function resetAvatarCrop(){if(!avatarSaving)avatarCropper?.reset()}
async function saveUserAvatar(){
  if(!avatarCropper||!currentUser||avatarSaving)return;
  const status=document.getElementById("avatarCropStatus"),button=document.getElementById("avatarSaveBtn");
  avatarSaving=true;button.disabled=true;status.textContent="正在上传头像...";
  try{
    const canvas=avatarCropper.getCroppedCanvas({width:512,height:512,fillColor:"#fff",imageSmoothingEnabled:true,imageSmoothingQuality:"high"});
    if(!canvas)throw new Error("图片还没准备好，请稍后重试");
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",.9));if(!blob)throw new Error("裁剪失败，请重新选择图片");
    const response=await fetch(USER_API+"/api/user/avatar/upload",{method:"POST",headers:{Authorization:"Bearer "+currentUser.sessionToken,"Content-Type":"image/jpeg"},body:blob});
    const data=await response.json();if(!response.ok||!data.success)throw new Error(data.error||"上传失败，请重试");
    currentUser.avatar=data.avatar;localStorage.setItem("tx_user",JSON.stringify(currentUser));
    if(_userHomeData)_userHomeData.avatar=data.avatar;
    renderUserHome(_userHomeData||currentUser);avatarSaving=false;closeAvatarCrop();showToast("头像已更新");
    if(currentCommentCardId&&document.getElementById("commentSection"))loadComments(currentCommentCardId);
  }catch(error){status.textContent=error.message||"上传失败，请重试"}finally{avatarSaving=false;button.disabled=false}
}
document.addEventListener("keydown",event=>{
  const modal=document.getElementById("avatarCropModal");if(!modal||modal.hidden)return;
  if(event.key==="Escape"){event.preventDefault();closeAvatarCrop()}
  if(event.key==="Tab"){const buttons=[...modal.querySelectorAll("button:not([disabled])")];if(!buttons.length)return;const first=buttons[0],last=buttons[buttons.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}}
});
