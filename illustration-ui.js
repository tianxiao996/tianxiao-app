(function () {
  'use strict';
  const BASE = 'https://img.tian-xiao.com/site-ui/illustration-20261104/';
  const pictures = {
    desktop: ['desktop-blue.jpg', 'desktop-chocolate.jpg'],
    mobile: ['mobile-blue.jpg', 'mobile-friends.jpg', 'mobile-night.png']
  };
  const narrow = matchMedia('(max-width: 767px)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  // The removed controls must not leave visitors stuck with a paused background.
  try { localStorage.removeItem('tx-wallpaper-paused'); } catch (_) {}
  let timer = 0, generation = 0, busy = false, active = 0, index = -1;
  let images;
  const automatic = () => !reduced.matches && !document.hidden && !(navigator.connection && navigator.connection.saveData);
  function schedule() {
    clearTimeout(timer);
    if (automatic()) timer = setTimeout(change, 28000);
  }
  async function change() {
    if (busy) return;
    const token = ++generation;
    const list = narrow.matches ? pictures.mobile : pictures.desktop;
    const targetIndex = (index + 1) % list.length;
    const target = images[1 - active];
    const loadingImage = new Image();
    loadingImage.decoding = 'async'; loadingImage.fetchPriority = 'low';
    busy = true;
    clearTimeout(timer);
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 18000);
        function cleanup() { clearTimeout(timeout); loadingImage.onload = null; loadingImage.onerror = null; }
        loadingImage.onload = () => { cleanup(); resolve(); };
        loadingImage.onerror = () => { cleanup(); reject(new Error('image')); };
        loadingImage.src = BASE + list[targetIndex];
      });
      if (loadingImage.decode) await loadingImage.decode();
      if (token !== generation) return;
      target.src = loadingImage.src;
      target.classList.add('is-visible');
      images[active].classList.remove('is-visible');
      active = 1 - active; index = targetIndex;
    } catch (_) {
      // Retain the current image and retry during the next cycle.
    } finally {
      if (token === generation) { busy = false; schedule(); }
    }
  }
  function init() {
    const main = document.getElementById('mainScroll');
    if (!main || document.getElementById('illustrationBackdrop')) return;
    const backdrop = document.createElement('div');
    backdrop.id = 'illustrationBackdrop'; backdrop.setAttribute('aria-hidden', 'true');
    backdrop.innerHTML = '<img alt="" decoding="async" fetchpriority="low"><img alt="" decoding="async" fetchpriority="low">';
    document.body.prepend(backdrop);
    images = [...backdrop.querySelectorAll('img')];
    const heading = document.createElement('div');
    heading.className = 'illustration-section-label'; heading.textContent = '作品一览';
    const box = document.getElementById('box');
    if (box && box.parentNode === main) main.insertBefore(heading, box);
    document.addEventListener('visibilitychange', schedule);
    reduced.addEventListener('change', schedule);
    if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', schedule);
    narrow.addEventListener('change', () => {
      generation++; busy = false; index = -1; change();
    });
    // Decorative artwork never blocks the resource loader or the page's onload.
    if (document.readyState === 'complete') change();
    else window.addEventListener('load', change, { once: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
