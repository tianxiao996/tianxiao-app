(function(){
'use strict';

const inMainSite=window.frameElement?.id==='pollPanelFrame';
if(inMainSite){
 document.documentElement.classList.add('poll-embedded');
 const send=(type,id)=>window.parent.postMessage({type,id},location.origin);
 document.addEventListener('click',event=>{
  const link=event.target.closest?.('.brand,.back-link,#loginHint a');
  if(!link)return;
  event.preventDefault();
  if(link.closest('#loginHint'))send('tx-poll:login',active?.id);
  else send('tx-poll:close');
 });
 document.addEventListener('keydown',event=>{
  if(event.key!=='Escape'||event.defaultPrevented||document.querySelector('dialog[open]'))return;
  event.preventDefault();send('tx-poll:close');
 });
 window.pollPanelCanClose=()=>{
  if(!busy||voteSession&&!voteSession.sending)return true;
  message('正在提交，请稍候再关闭投票页。');return false;
 };
}else{
 try{sessionStorage.setItem('TX_RETURN_FROM_POLLS','1')}catch(_){}
}

const API='https://api.tian-xiao.com',$=id=>document.getElementById(id),PHASE={submission:'征集投稿',voting:'开放投票',closed:'已结束'};
let account=null,active=null,busy=false,selection=0,previewURLs=[],deadlineTimer=null,viewing=null,returnFocus=null;
const token=()=>sessionStorage.getItem('ADMIN_TOKEN')||(()=>{try{return JSON.parse(localStorage.getItem('tx_user')||'{}').sessionToken||''}catch(_){return ''}})();
function message(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error)}
function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}
async function api(path,options={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000),auth=token();
 try{const r=await fetch(API+path,{...options,signal:controller.signal,cache:'no-store',headers:{...(auth?{Authorization:'Bearer '+auth}:{}),...(!(options.body instanceof FormData)?{'Content-Type':'application/json'}:{}),...options.headers}}),j=await r.json();if(auth!==token())throw Error('账号已切换，请刷新页面');if(!r.ok||j.success===false)throw Object.assign(Error(j.error||'请求失败'),{status:r.status,reset:j.reset===true});return j}catch(e){if(e.name==='AbortError')throw Error('连接超时，请刷新核对后重试');throw e}finally{clearTimeout(timer)}
}
function localDate(value){if(!value)return '';const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)}
function attachRules(form,rules={choiceMode:'single',minChoices:1,maxChoices:1,allowChange:true,resultsVisibility:'always',endsAt:null},locked=false){
 form.querySelector('.rules-slot').replaceChildren($('rulesTemplate').content.cloneNode(true));const f=form.elements;f.choiceMode.value=rules.choiceMode;f.minChoices.value=rules.minChoices;f.maxChoices.value=rules.maxChoices;f.allowChange.checked=rules.allowChange;f.resultsVisibility.value=rules.resultsVisibility;f.endsAt.value=localDate(rules.endsAt);
 f.choiceMode.onchange=()=>{const single=f.choiceMode.value==='single';form.querySelector('.choice-bounds').hidden=single;if(single){f.minChoices.value=1;f.maxChoices.value=1}else if(Number(f.maxChoices.value)<2)f.maxChoices.value=3};form.querySelector('.choice-bounds').hidden=rules.choiceMode==='single';for(const name of ['choiceMode','minChoices','maxChoices','allowChange','resultsVisibility'])f[name].disabled=locked;form.querySelector('.rules-lock').hidden=!locked;
}
function readRules(form){const f=form.elements,single=f.choiceMode.value==='single',endsAt=f.endsAt.value?new Date(f.endsAt.value).getTime():null;if(endsAt!==null&&!Number.isFinite(endsAt))throw Error('截止时间格式无效');return {choiceMode:single?'single':'multiple',minChoices:single?1:Number(f.minChoices.value),maxChoices:single?1:Number(f.maxChoices.value),allowChange:f.allowChange.checked,resultsVisibility:f.resultsVisibility.value,endsAt}}
function normalizedPollGameSize(value){
 if(typeof value!=='string'||value.length>40)return '';
 const match=/^(\d{1,12}(?:\.\d{1,6})?)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i.exec(value.trim());
 if(!match||Number(match[1])<=0)return '';
 const units={KIB:'KiB',MIB:'MiB',GIB:'GiB',TIB:'TiB'};
 const unit=match[2].toUpperCase();
 return Number(match[1])+' '+(units[unit]||unit);
}
function renderEmpty(kind='none'){
 const fragment=$('emptyTemplate').content.cloneNode(true);
 if(kind==='error'){fragment.querySelector('.empty-title').textContent='暂时没能读取活动';fragment.querySelector('.empty-description').textContent='请点击“刷新活动”重试，你的投稿和选票不会因此改变。'}
 else if(kind==='choose'){fragment.querySelector('.empty-title').textContent='请选择投票活动';fragment.querySelector('.empty-description').textContent='从活动列表选择一场投票。'}
 $('detail').replaceChildren(fragment);
}
async function loadList(){
 $('reloadList').disabled=true;try{const j=await api('/api/polls');$('pollList').replaceChildren();$('pollCount').textContent=j.polls.length;document.querySelector('.workspace').classList.toggle('empty-mode',!j.polls.length);for(const p of j.polls){const b=node('button');b.type='button';b.dataset.pollId=p.id;b.dataset.phase=p.status;b.setAttribute('aria-current',String(active?.id===p.id));b.append(node('strong',p.title),node('small',PHASE[p.status]+' · '+(p.choiceMode==='multiple'?'多选':'单选')+' · '+p.entries+'/'+p.participantLimit+' 人投稿'+(p.votes===null?' · 结果未公开':' · '+p.votes+' 票')));b.onclick=()=>openPoll(p.id);$('pollList').append(b)}if(!active)renderEmpty(j.polls.length?'choose':'none');return j.polls}catch(e){message(e.message,true);if(!active)renderEmpty('error');return []}finally{$('reloadList').disabled=false}
}
function clearPreviews(){for(const url of previewURLs)URL.revokeObjectURL(url);previewURLs=[]}
async function openPoll(id){if(busy)return;const turn=++selection;message('正在读取投票…');try{const j=await api('/api/polls/detail?id='+encodeURIComponent(id));if(turn!==selection)return;active=j.poll;render();const u=new URL(location.href);u.searchParams.set('id',id);if(!inMainSite)history.replaceState(null,'',u);message('')}catch(e){if(turn===selection)message(e.message,true)}}
function ruleSummary(p){const r=p.rules;return (r.choiceMode==='single'?'单选，每个账号选择一款':'多选，每个账号选择'+r.minChoices+'–'+r.maxChoices+'款')+' · '+(r.allowChange?'允许改投与撤回':'提交后不可更改')}
function startDeadline(p){
 clearInterval(deadlineTimer);const el=document.querySelector('#detail .deadline');if(!el)return;if(!p.rules.endsAt){el.textContent='';return}const end=new Date(p.rules.endsAt).toLocaleString(),start=performance.now(),serverTime=p.serverNow||Date.now();
 const tick=()=>{const left=p.rules.endsAt-(serverTime+performance.now()-start);if(p.status==='closed'){el.textContent='活动已结束 · 原截止时间 '+end;clearInterval(deadlineTimer);return}if(left<=0){el.textContent=p.status==='voting'?'截止时间已到，正在读取最终结果…':'投票截止时间已到，请管理员调整时间';if(p.status==='voting'&&!busy){clearInterval(deadlineTimer);openPoll(p.id)}return}const sec=Math.ceil(left/1000),days=Math.floor(sec/86400),hours=Math.floor(sec/3600)%24,min=Math.floor(sec/60)%60;el.textContent='投票截止 '+end+' · 剩余 '+(days?days+'天 ':'')+String(hours).padStart(2,'0')+':'+String(min).padStart(2,'0')+':'+String(sec%60).padStart(2,'0')};tick();if(p.status!=='closed')deadlineTimer=setInterval(tick,1000);
}
function showLarge(entry,index){returnFocus=document.activeElement;viewing={entry,index};if(!$('imageDialog').open)$('imageDialog').showModal();paintLarge();$('closeImage').focus()}
function paintLarge(){if(!viewing)return;const {entry,index}=viewing;$('largeImage').src=API+entry.imageUrls[index];$('largeImage').alt=entry.title+'，第'+(index+1)+'张';$('imageCaption').textContent=entry.title+' · '+(index+1)+'/'+entry.imageUrls.length;$('previousImage').disabled=index===0;$('nextImage').disabled=index===entry.imageUrls.length-1}
function closeLarge(){if($('imageDialog').open)$('imageDialog').close();viewing=null;$('largeImage').removeAttribute('src');if(returnFocus?.isConnected)returnFocus.focus();returnFocus=null}
function gallery(entry){
 const wrap=node('div',undefined,'entry-gallery'),main=node('button',undefined,'gallery-main'),img=node('img');let current=0;main.type='button';main.setAttribute('aria-label','放大查看「'+entry.title+'」');img.src=API+entry.imageUrls[0];img.alt=entry.title;img.loading='lazy';img.onerror=()=>{img.alt='图片加载失败，请刷新重试'};main.append(img);main.onclick=()=>showLarge(entry,current);wrap.append(main);
 if(entry.imageUrls.length>1){const strip=node('div',undefined,'gallery-thumbs');entry.imageUrls.forEach((url,index)=>{const b=node('button');b.type='button';b.setAttribute('aria-label','查看第'+(index+1)+'张图片');b.setAttribute('aria-pressed',String(index===0));const thumb=node('img');thumb.src=API+url;thumb.alt='第'+(index+1)+'张';thumb.loading='lazy';b.append(thumb);b.onclick=()=>{current=index;img.src=API+url;for(const other of strip.children)other.setAttribute('aria-pressed',String(other===b))};strip.append(b)});wrap.append(strip)}return wrap;
}
function render(){
 clearPreviews();clearInterval(deadlineTimer);if($('imageDialog').open)closeLarge();const p=active,fragment=$('detailTemplate').content.cloneNode(true),find=s=>fragment.querySelector(s),myEntry=p.entries.find(e=>e.mine);
 find('.poll-heading').dataset.phase=p.status;find('.entry-count').textContent=String(p.entries.length);
 find('.title').textContent=p.title;find('.phase').textContent=PHASE[p.status];find('.description').textContent=p.description;
 find('.meta').textContent=p.creatorName+' 发起';
 const stats=find('.poll-stats');
 function stat(label,value){
  const box=node('div',undefined,'poll-stat');
  box.append(node('small',label),node('strong',value));stats.append(box);
 }
 stat('已投稿',p.entries.length+' / '+p.participantLimit);
 if(p.resultsVisible){stat('投票人数',String(p.voterCount));stat('已投票数',String(p.totalSelections))}
 find('.rule-summary').textContent=ruleSummary(p);find('.reload').onclick=()=>openPoll(p.id);
 const manage=find('.manage');manage.hidden=!p.canManage;if(p.canManage){manage.elements.limit.value=p.participantLimit;manage.elements.phase.value=p.status;attachRules(manage,p.rules,p.rulesLocked);manage.onsubmit=e=>{e.preventDefault();mutate(()=>api('/api/polls/detail',{method:'PUT',body:JSON.stringify({id:p.id,revision:p.revision,status:manage.elements.phase.value,participantLimit:Number(manage.elements.limit.value),rules:readRules(manage)})}),'投票设置已保存')}}
 const form=find('.nominate');form.hidden=!account||p.status!=='submission'||!!myEntry||p.entries.length>=p.participantLimit;let files=[];
 const paintPreviews=()=>{clearPreviews();form.querySelector('.submission-previews').replaceChildren();for(const [index,file] of files.entries()){const figure=node('figure'),img=node('img');img.src=URL.createObjectURL(file);previewURLs.push(img.src);img.alt='待投稿图片'+(index+1);const remove=node('button','移除第'+(index+1)+'张');remove.type='button';remove.onclick=()=>{files.splice(index,1);paintPreviews()};figure.append(img,remove);form.querySelector('.submission-previews').append(figure)}form.querySelector('.image-count').textContent='已选'+files.length+'/4张，可分次添加'};
 form.elements.images.onchange=()=>{const incoming=Array.from(form.elements.images.files);form.elements.images.value='';const merged=[...files];for(const f of incoming){if(!merged.some(x=>x.name===f.name&&x.size===f.size&&x.lastModified===f.lastModified))merged.push(f)}if(merged.length>4){message('每款游戏最多上传4张图片，请先移除不需要的图片',true);return}files=merged;paintPreviews()};
 form.onsubmit=e=>{e.preventDefault();mutate(async()=>{const title=form.elements.title.value.trim();if(!title||files.length<1||files.length>4)throw Error('请填写游戏名称并选择1–4张图片');const gameSize=normalizedPollGameSize(form.elements.gameSize.value);if(!gameSize)throw Error('请填写游戏大小和单位，例如 1.5 GB 或 800 MB');const body=new FormData();body.append('pollId',p.id);body.append('title',title);body.append('gameSize',gameSize);for(const [i,file] of files.entries()){message('正在压缩第'+(i+1)+'/'+files.length+'张图片…');const image=await compress(file);body.append('images',image,'game-'+i+'.'+({'image/webp':'webp','image/png':'png','image/jpeg':'jpg'}[image.type]))}return api('/api/polls/entries',{method:'POST',body})},'游戏已提交，等待管理员开始投票')};
 find('.participation').textContent=myEntry?'你已投稿「'+myEntry.title+'」。':p.status==='submission'&&p.entries.length>=p.participantLimit?'投稿人数已满，等待管理员开始投票。':p.status==='voting'?(account?'选好后点击提交投票。':'登录后可投票。'):p.status==='submission'?'每人可提交一款候选游戏。':'';
 find('.result-notice').textContent=!p.resultsVisible?(p.rules.resultsVisibility==='after_vote'?'提交投票后可查看结果，活动结束后向所有人公开。':'结果在活动结束后公开。'):p.canManage&&p.status!=='closed'&&p.rules.resultsVisibility!=='always'?'管理员可查看实时结果，其他用户按公开规则查看。':'';
 const entries=find('.entries'),selected=new Set(p.myVotes),choices=[],locked=!account||p.status!=='voting'||!p.rules.allowChange&&p.myVotes.length>0;if(!p.entries.length){const empty=node('div',undefined,'candidates-empty');empty.append(node('span','暂无候选游戏','empty-candidate-title'),node('p',p.status==='submission'?'投稿后会显示在这里。':'当前活动还没有候选游戏。'));entries.append(empty)}
 const submit=find('.submit-ballot'),withdraw=find('.withdraw-ballot'),countLabel=find('.selection-count'),identical=()=>selected.size===p.myVotes.length&&p.myVotes.every(id=>selected.has(id));
 const updateSelection=()=>{for(const {card,input,text} of choices){input.checked=selected.has(input.value);text.textContent=input.checked?(p.myVotes.includes(input.value)?'已投这款':'已选择'):'选择这款';card.classList.toggle('selected',input.checked)}countLabel.textContent='已选 '+selected.size+' 款 · '+(p.rules.choiceMode==='single'?'请选择一款':'须选 '+p.rules.minChoices+'–'+p.rules.maxChoices+' 款');submit.disabled=!!locked||selected.size<p.rules.minChoices||selected.size>p.rules.maxChoices||identical();submit.textContent=identical()&&p.myVotes.length?'已提交投票':p.myVotes.length?'保存改投':'提交投票'};
 for(const e of p.entries){
  const card=node('article',undefined,'entry'),body=node('div',undefined,'entry-body');
  body.append(node('h3',e.title));
  const metadata=node('div',undefined,'entry-meta');
  metadata.append(node('span',e.gameSize||'大小未标注','size-tag'),node('span',e.mine?'我的投稿':e.submitterName+' 投稿'));
  body.append(metadata);
  const row=node('div',undefined,'vote-row');
  if(p.resultsVisible){
   row.append(node('strong',e.votes+' 票'));
  }
  if(p.status==='voting'){const label=node('label',undefined,'vote-choice'),input=node('input'),text=node('span',p.myVotes.includes(e.id)?'已投这款':'选择这款');input.type=p.rules.choiceMode==='single'?'radio':'checkbox';input.name='candidate';input.value=e.id;input.disabled=!!locked;input.setAttribute('aria-label','选择「'+e.title+'」');input.onchange=()=>{if(input.checked){if(p.rules.choiceMode==='single')selected.clear();if(selected.size>=p.rules.maxChoices){input.checked=false;message('本活动最多选择'+p.rules.maxChoices+'款游戏',true);return}selected.add(e.id)}else selected.delete(e.id);updateSelection()};label.append(input,text);row.append(label);choices.push({card,input,text})}body.append(row);card.append(gallery(e),body);entries.append(card)}
 find('.ballot-actions').hidden=p.status!=='voting';withdraw.hidden=!account||!p.rules.allowChange||p.myVotes.length===0;withdraw.onclick=()=>mutate(()=>api('/api/polls/vote',{method:'POST',body:JSON.stringify({pollId:p.id,entryIds:[],revision:p.revision})}),'投票已撤回');find('.vote-form').onsubmit=e=>{e.preventDefault();if(submit.disabled)return;mutate(()=>askForVote(p.id,[...selected],p.revision),'投票已记录')};updateSelection();if(!p.rules.allowChange&&p.myVotes.length>0)countLabel.textContent='本活动不允许改投，你的选票已记录。';
 $('detail').replaceChildren(fragment);for(const b of document.querySelectorAll('#pollList button')){const current=b.dataset.pollId===p.id;b.setAttribute('aria-current',String(current));if(current){b.dataset.phase=p.status;b.querySelector('small').textContent=PHASE[p.status]+' · '+(p.rules.choiceMode==='multiple'?'多选':'单选')+' · '+p.entries.length+'/'+p.participantLimit+' 人投稿'+(p.resultsVisible?' · '+p.totalSelections+' 票':' · 结果未公开')}}const activityList=$('pollList'),currentActivity=activityList.querySelector('[aria-current=true]');if(currentActivity&&activityList.scrollWidth>activityList.clientWidth){activityList.scrollLeft+=currentActivity.getBoundingClientRect().left-activityList.getBoundingClientRect().left}startDeadline(p);
}

const voteDialog=$('voteCheck'),voteGrid=$('votePictures'),votePrompt=$('votePrompt'),voteHint=$('voteHint'),voteRetry=$('voteRetry'),voteCancel=$('voteCancel');
let voteSession=null;
function askForVote(pollId,entryIds,revision){
 if(voteSession)throw Error('投票验证已打开');
 return new Promise((resolve,reject)=>{
  const session={pollId,entryIds,revision,auth:token(),resolve,reject,turn:0,sending:false,timer:null};
  voteSession=session;
  voteCancel.disabled=false;voteRetry.disabled=false;
  voteDialog.showModal();
  nextVoteQuestion(session);
 });
}
function finishVote(session,outcome,error){
 if(session!==voteSession)return;
 clearTimeout(session.timer);
 voteSession=null;
 voteDialog.close();
 voteGrid.replaceChildren();
 if(error)session.reject(error);else session.resolve(outcome);
}
function lockVotePictures(){for(const b of voteGrid.children)b.disabled=true}
async function nextVoteQuestion(session){
 if(session!==voteSession||session.sending)return;
 const turn=++session.turn;
 const current=()=>session===voteSession&&session.turn===turn;
 clearTimeout(session.timer);
 voteGrid.replaceChildren();voteRetry.disabled=true;
 votePrompt.textContent='正在读取题目…';voteHint.textContent='';
 try{
  if(session.auth!==token())throw Error('账号已切换，请取消后重新投票');
  const q=await api('/api/polls/vote-challenge',{method:'POST',body:JSON.stringify({pollId:session.pollId})});
  if(!current())return;
  if(!q.success||q.required!==1||q.stage!==1||typeof q.id!=='string'||typeof q.question!=='string'||!Array.isArray(q.images)||q.images.length!==4||!Number.isFinite(q.expiresAt)||!Number.isFinite(q.serverNow))throw Error('题目读取失败，请换一题');
  const lifetime=Math.max(0,Math.min(60000,q.expiresAt-q.serverNow));
  let loaded=0,unavailable=false;
  const disable=(text)=>{unavailable=true;lockVotePictures();voteHint.textContent=text};
  session.timer=setTimeout(()=>{if(current()&&!session.sending)disable('题目已过期，请换一题。')},lifetime);
  votePrompt.textContent=q.question;voteHint.textContent='正在加载图片…';
  q.images.forEach((url,i)=>{
   if(url!=='/api/meme-captcha/image?id='+q.id+'&slot='+i)throw Error('题目读取失败，请换一题');
   const button=node('button'),img=node('img');
   button.type='button';button.disabled=true;button.setAttribute('aria-label','选择第'+(i+1)+'张图');img.alt='候选图片 '+(i+1);img.draggable=false;
   img.onload=()=>{if(!current()||unavailable)return;if(++loaded===4){for(const b of voteGrid.children)b.disabled=false;voteHint.textContent='选对图片即提交本次选票。'}};
   img.onerror=()=>{if(current())disable('图片未能加载，请换一题。')};
   button.onclick=async()=>{
    if(!current()||button.disabled||session.sending)return;
    if(session.auth!==token()){finishVote(session,null,Error('账号已切换，请重新投票'));return}
    session.sending=true;lockVotePictures();clearTimeout(session.timer);voteRetry.disabled=true;voteCancel.disabled=true;
    voteHint.textContent='正在提交选票…';
    try{
     const result=await api('/api/polls/vote',{method:'POST',body:JSON.stringify({pollId:session.pollId,entryIds:session.entryIds,revision:session.revision,captchaId:q.id,captchaSelection:i})});
     finishVote(session,result);
    }catch(e){
     if(!current())return;
     if(!e.reset){finishVote(session,null,e);return}
     session.sending=false;voteRetry.disabled=false;voteCancel.disabled=false;
     voteHint.textContent=e.message;voteRetry.focus();
    }
   };
   button.append(img);voteGrid.append(button);img.src=API+url;
  });
 }catch(e){
  if(current()){clearTimeout(session.timer);voteGrid.replaceChildren();votePrompt.textContent='暂时无法验证';voteHint.textContent=e.message}
 }finally{if(current()&&!session.sending)voteRetry.disabled=false}
}
function cancelVote(){
 const session=voteSession;
 if(session&&!session.sending)finishVote(session,null,Object.assign(Error('已取消投票验证'),{cancelled:true}));
}
voteCancel.onclick=cancelVote;
voteDialog.addEventListener('cancel',event=>{event.preventDefault();cancelVote()});
voteRetry.onclick=()=>{if(voteSession)nextVoteQuestion(voteSession)};
async function mutate(action,success){if(busy)return;busy=true;++selection;const controls=[...document.querySelectorAll('button,input,textarea,select')].filter(n=>!voteDialog.contains(n)),old=controls.map(n=>n.disabled);controls.forEach(n=>n.disabled=true);try{const j=await action();active=j.poll;await loadList();busy=false;render();message(success)}catch(e){if(!e.cancelled)message(e.message,true)}finally{controls.forEach((n,i)=>{if(n.isConnected)n.disabled=old[i]});busy=false}}
async function compress(file,maxEdge=960){
 if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>12*1024*1024)throw Error('请选择12MB以内的JPG、PNG或WebP图片');const image=await createImageBitmap(file);try{if(!image.width||!image.height||image.width*image.height>40000000)throw Error('图片尺寸过大');const scale=Math.min(1,maxEdge/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);for(const type of ['image/webp','image/jpeg']){if(type==='image/jpeg'){const paint=canvas.getContext('2d');paint.globalCompositeOperation='destination-over';paint.fillStyle='#fff';paint.fillRect(0,0,canvas.width,canvas.height);paint.globalCompositeOperation='source-over'}for(const quality of [.8,.65,.5]){const blob=await new Promise(r=>canvas.toBlob(r,type,quality));if(blob&&blob.size<=800000&&['image/webp','image/png','image/jpeg'].includes(blob.type))return blob;if(blob?.type!==type)break}}throw Error('图片仍过大，请选择较小的图片')}finally{image.close()}
}
// Runs inside the voting page's existing scope; no second account or API client.
let carousel={slides:[],canManage:false,maxSlides:20},carouselCurrent=null,carouselTimer=null,carouselHovered=false,carouselFocused=false,carouselUploadTarget=null;
const carouselReduced=matchMedia('(prefers-reduced-motion:reduce)');
function carouselSlide(){return carousel.slides.find(s=>s.id===carouselCurrent)||null}
function carouselSchedule(){
 clearTimeout(carouselTimer);
 if(carousel.slides.filter(s=>s.imageUrl).length<2||carouselReduced.matches||document.hidden||carouselHovered||carouselFocused||!carouselSlide()?.imageUrl)return;
 carouselTimer=setTimeout(()=>{if(!busy){const ready=carousel.slides.filter(s=>s.imageUrl),i=ready.findIndex(s=>s.id===carouselCurrent);carouselCurrent=ready[(i+1)%ready.length].id;paintCarousel()}else carouselSchedule()},6000);
}
function paintCarousel(){
 const region=$('pollCarousel'),slide=carouselSlide(),image=$('pollCarouselImage');
 region.hidden=!carousel.canManage&&!carousel.slides.some(s=>s.imageUrl);
 $('carouselTools').hidden=!carousel.canManage;
 $('carouselNew').disabled=busy;
 $('carouselDelete').disabled=busy||!slide?.canEdit;
 $('carouselUpload').disabled=busy||!!slide&&!slide.canEdit;
 $('carouselPrevious').hidden=$('carouselNext').hidden=carousel.slides.length<2;
 $('carouselPrevious').disabled=$('carouselNext').disabled=busy;
 $('carouselPosition').textContent=carousel.slides.length?String(carousel.slides.findIndex(s=>s.id===carouselCurrent)+1)+' / '+carousel.slides.length:'0 / 0';
 image.hidden=!slide?.imageUrl;
 $('carouselHint').hidden=!!slide?.imageUrl;
 $('carouselHint').textContent=slide?'点击左下角“上传”添加图片':'暂无轮播图';
 if(slide?.imageUrl){const src=API+slide.imageUrl;if(image.getAttribute('src')!==src)image.src=src;image.alt='投票轮播图，第'+(carousel.slides.findIndex(s=>s.id===carouselCurrent)+1)+'张'}else image.removeAttribute('src');
 const dots=$('carouselDots');dots.replaceChildren();
 carousel.slides.forEach((s,i)=>{const b=node('button');b.type='button';b.setAttribute('aria-label','查看第'+(i+1)+'张轮播图');b.setAttribute('aria-pressed',String(s.id===carouselCurrent));b.disabled=busy;b.onclick=()=>{carouselCurrent=s.id;paintCarousel()};dots.append(b)});
 carouselSchedule();
}
function carouselApply(j){
 const oldIndex=carousel.slides.findIndex(s=>s.id===carouselCurrent);carousel=j.carousel;
 carouselCurrent=j.selectedId||carousel.slides.find(s=>s.id===carouselCurrent)?.id||carousel.slides[Math.max(0,Math.min(oldIndex,carousel.slides.length-1))]?.id||null;
}
async function loadCarousel(){
 try{carouselApply(await api('/api/polls/carousel'));paintCarousel()}catch(e){if(account?.kind==='admin')message('轮播图加载失败：'+e.message,true)}
}
async function carouselMutate(action,success){
 if(busy)return;busy=true;clearTimeout(carouselTimer);
 const controls=[...document.querySelectorAll('button,input,textarea,select')],old=controls.map(n=>n.disabled);controls.forEach(n=>n.disabled=true);
 try{const result=await action();carouselApply(result);message(result.cleanupPending?'操作已保存，但 R2 图片清理暂未完成，系统会自动重试':success,!!result.cleanupPending)}catch(e){message(e.message,true);try{carouselApply(await api('/api/polls/carousel'))}catch(_){} }
 finally{controls.forEach((n,i)=>{if(n.isConnected)n.disabled=old[i]});busy=false;paintCarousel()}
}
function carouselMove(step){if(busy||carousel.slides.length<2)return;const i=carousel.slides.findIndex(s=>s.id===carouselCurrent);carouselCurrent=carousel.slides[(i+step+carousel.slides.length)%carousel.slides.length].id;paintCarousel()}
$('carouselNew').onclick=()=>carouselMutate(()=>api('/api/polls/carousel',{method:'POST',body:'{}'}),'已新增图片位置，请点击上传');
$('carouselDelete').onclick=()=>{const slide=carouselSlide();if(!slide?.canEdit)return;carouselMutate(()=>api('/api/polls/carousel',{method:'DELETE',body:JSON.stringify({id:slide.id,revision:slide.revision})}),'轮播图及 R2 图片已删除')};
$('carouselUpload').onclick=()=>{if(!busy){carouselUploadTarget=carouselSlide();$('carouselFile').value='';$('carouselFile').click()}};
$('carouselFile').onchange=()=>{
 const file=$('carouselFile').files[0];$('carouselFile').value='';if(!file)return;
 const target=carouselUploadTarget;carouselUploadTarget=null;
 carouselMutate(async()=>{
  message('正在压缩并上传轮播图片…');const blob=await compress(file,1600);let slide=target;
  if(!slide){const created=await api('/api/polls/carousel',{method:'POST',body:'{}'});carouselApply(created);slide=carouselSlide()}
  const body=new FormData();body.append('id',slide.id);body.append('revision',String(slide.revision));body.append('image',blob,'carousel.'+({'image/webp':'webp','image/png':'png','image/jpeg':'jpg'}[blob.type]));
  return api('/api/polls/carousel/upload',{method:'POST',body});
 },'轮播图片已保存');
};
$('carouselPrevious').onclick=()=>carouselMove(-1);$('carouselNext').onclick=()=>carouselMove(1);
$('pollCarouselImage').onerror=()=>{if(carouselSlide()?.imageUrl){$('pollCarouselImage').hidden=true;$('carouselHint').hidden=false;$('carouselHint').textContent='图片加载失败，请切换图片或刷新重试'}};
$('pollCarousel').onkeydown=e=>{if(e.key==='ArrowLeft'){e.preventDefault();carouselMove(-1)}if(e.key==='ArrowRight'){e.preventDefault();carouselMove(1)}};
$('pollCarousel').addEventListener('pointerenter',()=>{carouselHovered=true;clearTimeout(carouselTimer)});
$('pollCarousel').addEventListener('pointerleave',()=>{carouselHovered=false;carouselSchedule()});
$('pollCarousel').addEventListener('focusin',()=>{carouselFocused=true;clearTimeout(carouselTimer)});
$('pollCarousel').addEventListener('focusout',e=>{if(!$('pollCarousel').contains(e.relatedTarget)){carouselFocused=false;carouselSchedule()}});
document.addEventListener('visibilitychange',carouselSchedule);carouselReduced.addEventListener('change',carouselSchedule);
window.addEventListener('pagehide',()=>clearTimeout(carouselTimer));

attachRules($('createForm'));$('reloadList').onclick=async()=>{if(busy)return;const recover=!account&&!!token();if(recover)await refreshPollAccount();await loadList();if(recover&&account&&active)await openPoll(active.id)};$('newPoll').onclick=()=>{$('createForm').hidden=false;$('pollTitle').focus()};$('cancelCreate').onclick=()=>{$('createForm').hidden=true;$('newPoll').focus()};
$('createForm').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;++selection;$('createSubmit').disabled=true;try{const j=await api('/api/polls',{method:'POST',body:JSON.stringify({title:$('pollTitle').value,description:$('pollDescription').value,participantLimit:Number($('pollLimit').value),rules:readRules($('createForm'))})});active=j.poll;await loadList();busy=false;render();$('createForm').hidden=true;$('createForm').reset();attachRules($('createForm'));const u=new URL(location.href);u.searchParams.set('id',active.id);if(!inMainSite)history.replaceState(null,'',u);message('投票已发起，现已开放投稿。')}catch(e){message(e.message,true)}finally{busy=false;$('createSubmit').disabled=false}};
$('closeImage').onclick=closeLarge;$('imageDialog').addEventListener('cancel',e=>{e.preventDefault();closeLarge()});$('previousImage').onclick=()=>{if(viewing&&viewing.index>0){viewing.index--;paintLarge()}};$('nextImage').onclick=()=>{if(viewing&&viewing.index<viewing.entry.imageUrls.length-1){viewing.index++;paintLarge()}};$('imageDialog').onkeydown=e=>{if(e.key==='ArrowLeft')$('previousImage').click();if(e.key==='ArrowRight')$('nextImage').click()};
// Match the main site's icons and TX_DARK_MODE preference.
const mainThemeKey='TX_DARK_MODE',themeMedia=matchMedia('(prefers-color-scheme: dark)');
const mainThemeIcons={light:"<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z\"/></svg>",dark:"<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"4\"/><line x1=\"12\" y1=\"2\" x2=\"12\" y2=\"5\"/><line x1=\"12\" y1=\"19\" x2=\"12\" y2=\"22\"/><line x1=\"2\" y1=\"12\" x2=\"5\" y2=\"12\"/><line x1=\"19\" y1=\"12\" x2=\"22\" y2=\"12\"/><line x1=\"4.22\" y1=\"4.22\" x2=\"6.34\" y2=\"6.34\"/><line x1=\"17.66\" y1=\"17.66\" x2=\"19.78\" y2=\"19.78\"/><line x1=\"4.22\" y1=\"19.78\" x2=\"6.34\" y2=\"17.66\"/><line x1=\"17.66\" y1=\"6.34\" x2=\"19.78\" y2=\"4.22\"/></svg>"};
function savedMainTheme(){try{return localStorage.getItem(mainThemeKey)}catch(_){return null}}
function applyVoteTheme(dark){
 document.documentElement.dataset.theme=dark?'dark':'light';
 const button=$('theme');button.innerHTML=mainThemeIcons[dark?'dark':'light'];
 button.title=dark?'日间模式':'夜间模式';button.setAttribute('aria-label',dark?'切换至日间模式':'切换至夜间模式');button.setAttribute('aria-pressed',String(dark));
}
function syncVoteTheme(){const saved=savedMainTheme();applyVoteTheme(saved!==null?saved==='1':themeMedia.matches)}
$('theme').onclick=()=>{const dark=document.documentElement.dataset.theme!=='dark';try{localStorage.setItem(mainThemeKey,dark?'1':'0')}catch(_){}applyVoteTheme(dark)};
window.addEventListener('storage',event=>{if(event.key===mainThemeKey||event.key===null)syncVoteTheme()});
window.addEventListener('pageshow',syncVoteTheme);
themeMedia.addEventListener('change',()=>{if(savedMainTheme()===null)syncVoteTheme()});
syncVoteTheme();
async function refreshPollAccount(){if(token()){try{account=(await api('/api/account/session')).account}catch(e){message(e.message,true);if(e.status===401){sessionStorage.removeItem('ADMIN_TOKEN');localStorage.removeItem('tx_user');if(inMainSite)window.parent.postMessage({type:'tx-poll:expired'},location.origin)}}}$('accountName').textContent=account?account.username+(account.kind==='admin'?' · 管理员':''):token()?'身份待确认':'未登录';$('loginHint').hidden=!!account||!!token();$('newPoll').hidden=account?.kind!=='admin';}
(async()=>{await refreshPollAccount();const [list]=await Promise.all([loadList(),loadCarousel()]),id=new URL(location.href).searchParams.get('id');if(id)await openPoll(id);else if(list.length)await openPoll(list[0].id)})();
window.addEventListener('beforeunload',e=>{if(busy){e.preventDefault();e.returnValue=''}});window.addEventListener('pagehide',()=>{clearPreviews();clearInterval(deadlineTimer)});
})();
