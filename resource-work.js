(function(root){
'use strict';
function normalizeRj(value){return String(value??'')}
function fromCard(card){const result={};if(card.dataset.resourceVersion)result.gameVersion=card.dataset.resourceVersion;if(card.hasAttribute('data-resource-rj'))result.rjCode=card.dataset.resourceRj;if(card.hasAttribute('data-resource-company'))result.company=card.dataset.resourceCompany;if(card.hasAttribute('data-resource-translation'))result.translationTeam=card.dataset.resourceTranslation;if(card.hasAttribute('data-resource-official-url'))result.officialUrl=card.dataset.resourceOfficialUrl;return result}
function workIcon(kind){
 const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
 for(const [key,value]of Object.entries({viewBox:'0 0 24 24',width:'18',height:'18',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'}))svg.setAttribute(key,value);
 const paths=kind==='cart'?['M3 3h2l2.4 11.4a2 2 0 0 0 2 1.6H18a2 2 0 0 0 2-1.6L21 7H6','M10 21h.01','M18 21h.01']:['M14 3h7v7','M21 3l-9 9','M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5'];
 for(const d of paths){const path=document.createElementNS(ns,'path');path.setAttribute('d',d);svg.append(path)}
 return svg;
}
function information(card,detailView=false){
 const meta=fromCard(card),row=document.createElement('div');row.className='resource-work-meta';
 for(const [key,label]of [...(detailView?[['gameVersion','版本号']]:[]),['rjCode','DL编号'],['company','开发者'],['translationTeam','汉化']]){
  if(!meta[key]?.trim())continue;
  const item=document.createElement('div');item.className='resource-work-item resource-work-field';item.dataset.workField=key;
  const name=document.createElement('span');name.className='resource-work-label';name.textContent=label;
  const value=document.createElement('span');value.className='resource-work-value';value.textContent=meta[key];
  item.append(name,value);row.append(item);
 }
 if(row.childElementCount)row.classList.add('has-work-fields');
 if(meta.officialUrl){
  try{
   const url=new URL(meta.officialUrl);
   if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password){
    const actions=document.createElement('div');actions.className='resource-work-actions';
    const item=document.createElement('a');item.className='resource-official-link';item.href=url.href;item.target='_blank';item.rel='noopener noreferrer';
    item.setAttribute('aria-label','正版购买（在新标签页打开）');
    const label=document.createElement('span');label.textContent='正版购买';
    item.append(workIcon('cart'),label,workIcon('external'));actions.append(item);row.append(actions);
   }
  }catch(error){}
 }
 return row.childElementCount?row:null;
}

function render(){for(const card of document.querySelectorAll('#box>.card')){const info=card.querySelector('.info-box'),description=info?.querySelector('.desc-wrap');if(!info||!description)continue;info.querySelector(':scope>.resource-work-meta')?.remove();const row=information(card);if(row)description.before(row)}}
function detail(card){const body=document.getElementById('cardDetailBody');requestAnimationFrame(()=>{if(!body||!body.querySelector('.detail-title-gradient'))return;body.querySelector('.resource-work-detail')?.remove();const row=information(card,true);if(!row)return;row.classList.add('resource-work-detail');const panel=body.querySelector('.quiet-detail-meta');if(panel)panel.append(row);else{const anchor=body.querySelector('.detail-date')||body.querySelector('.detail-title-gradient');anchor?.after(row)}})}
root.ResourceWork={fromCard,normalizeRj,render,detail};
if(typeof document!=='undefined'){const refresh=root.refreshUI;if(refresh)root.refreshUI=function(...args){const r=refresh.apply(this,args);render();return r};const open=root.openCardDetail;if(open)root.openCardDetail=function(card,...args){const r=open.call(this,card,...args);detail(card);return r};for(const name of ['enterAdmin','exitAdmin']){const fn=root[name];if(fn)root[name]=async function(...args){const r=await fn.apply(this,args);render();return r}}render();const box=document.getElementById('box');if(box){let queued=false;new MutationObserver(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;render()})}).observe(box,{childList:true})}}
if(typeof module!=='undefined'&&module.exports)module.exports={normalizeRj};
})(typeof window!=='undefined'?window:globalThis);
