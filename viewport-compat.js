(function () {
 'use strict';
 const root=document.documentElement,viewport=window.visualViewport;
 let frame=0,last='',settle=0;
 function apply(){
  frame=0;
  // Pinch zoom should magnify the existing layout, not make it reflow smaller.
  if(viewport&&Math.abs(viewport.scale-1)>.01)return;
  const layoutHeight=window.innerHeight||root.clientHeight;
  const height=Math.round(viewport&&viewport.height>0?Math.min(layoutHeight,viewport.height):layoutHeight);
  const top=Math.max(0,Math.round(viewport?.offsetTop||0));
  if(!height)return;
  const signature=height+':'+top;
  if(signature!==last){
   last=signature;
   root.style.setProperty('--app-viewport-height',height+'px');
   root.style.setProperty('--app-viewport-top',top+'px');
  }
  const bottom=document.querySelector('.gate-bottom'),scroll=document.querySelector('.gate-scroll-area');
  if(bottom&&scroll){
   const value=(bottom.offsetHeight||130)+'px';
   if(scroll.style.bottom!==value)scroll.style.bottom=value;
  }
 }
 function schedule(){if(!frame)frame=requestAnimationFrame(apply)}
 // Keyboard/orientation animations can publish their final metrics late on iOS.
 // One bounded follow-up avoids continuous polling or a timer per scroll event.
 function settled(){schedule();clearTimeout(settle);settle=setTimeout(schedule,300)}
 window.addEventListener('resize',settled,{passive:true});
 window.addEventListener('orientationchange',settled,{passive:true});
 window.addEventListener('pageshow',settled,{passive:true});
 viewport?.addEventListener('resize',settled,{passive:true});
 viewport?.addEventListener('scroll',schedule,{passive:true});
 document.addEventListener('focusin',settled);
 document.addEventListener('focusout',settled);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)settled()});
 const bottom=document.querySelector('.gate-bottom');
 if(bottom&&'ResizeObserver'in window)new ResizeObserver(schedule).observe(bottom);
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',settled,{once:true});
 else settled();
})();
