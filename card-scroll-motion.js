(function (global) {
 'use strict';
 global.ResourceCardMotion?.destroy();
 const root=document.getElementById('mainScroll'),box=document.getElementById('box'),header=document.querySelector('body > header');
 if(!root||!box||!global.requestAnimationFrame)return;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 const entries=new Map(),properties=['--card-scroll-angle','--card-scroll-y','--card-scroll-scale','--card-scroll-opacity'];
 let frame=0,layoutDirty=true,destroyed=false,frames=0,height=0,insetTop=0;
 const clamp=value=>Math.max(0,Math.min(1,value));
 const enabled=()=>!destroyed&&!reduced.matches&&!document.body.classList.contains('admin-mode');

 // offsetTop/offsetHeight describe the original layout. Measuring transformed
 // rectangles here would make a folded card repeatedly enter/leave its trigger.
 function layoutTop(card){
  let top=0,node=card;
  while(node&&node!==root){top+=node.offsetTop;node=node.offsetParent}
  return node===root?top:null;
 }
 function restore(entry){
  const card=entry.card;
  card.classList.remove('card-scroll-motion');
  for(const key of properties)card.style.removeProperty(key);
  if(entry.originalWillChange)card.style.willChange=entry.originalWillChange;
  else card.style.removeProperty('will-change');
  resize?.unobserve(card);
 }
 function clear(){for(const entry of entries.values())restore(entry);entries.clear()}
 function schedule(){if(!destroyed&&!document.hidden&&!frame)frame=requestAnimationFrame(render)}
 function refresh(){if(destroyed)return;layoutDirty=true;schedule()}
 function onScroll(){
  // User scrolling takes priority over the short initial page entrance.
  for(const entry of entries.values())entry.introStart=null;
  schedule();
 }
 function sync(now){
  layoutDirty=false;height=root.clientHeight;insetTop=0;
  if(!enabled()){clear();return}
  // The desktop header overlays the scroll pane. Start the top exit at its
  // visible lower edge, rather than hiding the entire fold behind the header.
  if(header){const pane=root.getBoundingClientRect(),bar=header.getBoundingClientRect();if(bar.right>pane.left&&bar.left<pane.right&&bar.top<pane.bottom)insetTop=Math.max(0,Math.min(height,bar.bottom-pane.top-root.clientTop))}
  const active=new Set(box.querySelectorAll(':scope > .card.active-render:not(.card-expanded)'));
  for(const [card,entry]of entries)if(!active.has(card)||!card.isConnected){restore(entry);entries.delete(card)}
  const viewTop=root.scrollTop+insetTop,viewBottom=root.scrollTop+height;let stagger=0;
  for(const card of active){
   const top=layoutTop(card);
   if(top===null)continue;
   let entry=entries.get(card);
   if(!entry){
    entry={card,top,height:card.offsetHeight,originalWillChange:card.style.willChange,last:'',introStart:null};
    if(top<viewBottom&&top+entry.height>viewTop)entry.introStart=now+Math.min(stagger++*45,135);
    entries.set(card,entry);card.classList.add('card-scroll-motion');resize?.observe(card);
   }
   entry.top=top;entry.height=card.offsetHeight;
  }
 }
 function apply(entry,progress,edge,near){
  const hidden=1-progress,angle=edge*hidden*78,y=edge*-hidden*24,scale=1-hidden*.045,opacity=1-hidden*.82;
  const signature=[angle.toFixed(2),y.toFixed(2),scale.toFixed(4),opacity.toFixed(4)].join(':');
  if(signature!==entry.last){
   entry.last=signature;
   entry.card.style.setProperty(properties[0],angle.toFixed(2)+'deg');
   entry.card.style.setProperty(properties[1],y.toFixed(2)+'px');
   entry.card.style.setProperty(properties[2],scale.toFixed(4));
   entry.card.style.setProperty(properties[3],opacity.toFixed(4));
  }
  const will=near&&progress<.999?'transform, opacity':entry.originalWillChange;
  if(entry.card.style.willChange!==will){if(will)entry.card.style.willChange=will;else entry.card.style.removeProperty('will-change')}
 }
 function render(now){
  frame=0;if(destroyed||document.hidden)return;frames++;
  if(layoutDirty)sync(now);
  if(!enabled())return;
  const top=root.scrollTop+insetTop,bottom=root.scrollTop+height;let running=false;
  for(const entry of entries.values()){
   const range=Math.min(220,Math.max(64,entry.height*1.15),(height-insetTop)*.32);
   if(range<=0){apply(entry,1,-1,false);continue}
   const entering=clamp((bottom-entry.top)/range),leaving=clamp((entry.top+entry.height-top)/range);
   const raw=Math.min(entering,leaving);let progress=raw*raw*(3-2*raw),edge=entering<leaving?-1:1;
   const near=entry.top<bottom+range&&entry.top+entry.height>top-range;
   if(entry.introStart!==null){
    const initial=clamp((now-entry.introStart)/440),ease=1-Math.pow(1-initial,3);
    if(ease<progress){progress=ease;edge=-1}
    if(initial<1&&near)running=true;else entry.introStart=null;
   }
   apply(entry,progress,edge,near);
  }
  if(running)schedule();
 }
 const resize='ResizeObserver'in global?new ResizeObserver(refresh):null;
 resize?.observe(root);resize?.observe(box);if(header)resize?.observe(header);
 const mutations=new MutationObserver(records=>{
  if(records.some(record=>record.type==='childList'&&record.target===box||record.type==='attributes'&&record.target.parentElement===box&&record.target.classList.contains('card')))refresh();
 });
 mutations.observe(box,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
 const bodyChanges=new MutationObserver(refresh);bodyChanges.observe(document.body,{attributes:true,attributeFilter:['class']});
 function visibility(){if(document.hidden){if(frame)cancelAnimationFrame(frame);frame=0}else refresh()}
 root.addEventListener('scroll',onScroll,{passive:true});
 global.addEventListener('resize',refresh,{passive:true});document.addEventListener('visibilitychange',visibility);
 if(reduced.addEventListener)reduced.addEventListener('change',refresh);else reduced.addListener(refresh);
 global.ResourceCardMotion={
  refresh,
  getState:()=>({enabled:enabled(),trackedCards:entries.size,framePending:!!frame,frames,destroyed}),
  destroy(){
   if(destroyed)return;destroyed=true;if(frame)cancelAnimationFrame(frame);frame=0;
   mutations.disconnect();bodyChanges.disconnect();resize?.disconnect();clear();
   root.removeEventListener('scroll',onScroll);global.removeEventListener('resize',refresh);document.removeEventListener('visibilitychange',visibility);
   if(reduced.removeEventListener)reduced.removeEventListener('change',refresh);else reduced.removeListener(refresh);
  }
 };
 refresh();
})(window);
