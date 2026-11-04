(function () {
  'use strict';
  const BASE = 'https://img.tian-xiao.com/site-ui/illustration-20261104/';
  const pictures = {
    desktop: ['desktop-blue.jpg', 'desktop-chocolate.jpg'],
    mobile: ['mobile-blue.jpg', 'mobile-friends.jpg', 'mobile-night.png']
  };
  const narrow = matchMedia('(max-width: 767px)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let paused = false;
  try { paused = localStorage.getItem('tx-wallpaper-paused') === '1'; } catch (_) {}
  let timer = 0, generation = 0, busy = false, active = 0, index = -1;
  let images, next, toggle, status;
  const automatic = () => !paused && !reduced.matches && !document.hidden && !(navigator.connection && navigator.connection.saveData);
  function schedule() {
    clearTimeout(timer);
    if (automatic()) timer = setTimeout(() => change(false), 28000);
  }
  function controls() {
    const stopped = paused || reduced.matches || !!(navigator.connection && navigator.connection.saveData);
    toggle.textContent = stopped ? '开启轮播' : '暂停轮播';
    toggle.setAttribute('aria-pressed', String(!stopped));
    toggle.disabled = reduced.matches || !!(navigator.connection && navigator.connection.saveData);
    toggle.title = reduced.matches ? '已跟随系统的减少动态效果设置' : (toggle.disabled ? '已跟随节省流量设置' : '每 28 秒缓慢切换背景');
  }
  async function change(manual) {
    if (busy) return;
    const token = ++generation;
    const list = narrow.matches ? pictures.mobile : pictures.desktop;
    const targetIndex = (index + 1) % list.length;
    const target = images[1 - active];
    const loadingImage = new Image();
    loadingImage.decoding = 'async'; loadingImage.fetchPriority = 'low';
    busy = true; next.disabled = true;
    clearTimeout(timer);
    if (manual) status.textContent = '正在加载背景';
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
      status.textContent = '';
    } catch (_) {
      if (token === generation) status.textContent = manual ? '背景暂时不可用，可再试一次' : '';
    } finally {
      if (token === generation) { busy = false; next.disabled = false; schedule(); }
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
    const hero = document.createElement('section');
    hero.className = 'illustration-hero'; hero.setAttribute('aria-label', '欢迎与站点推荐');
    hero.innerHTML = '<div class="illustration-intro"><div class="illustration-kicker">天笑の窝 · 资源导航</div><h1>在这里，遇见<br>喜欢的故事。</h1><p>收藏热爱，也发现下一份惊喜。</p><div class="wallpaper-actions"><button id="nextWallpaper" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 8a8 8 0 0 1 14-2l2 2M20 3v5h-5M20 16a8 8 0 0 1-14 2l-2-2M4 21v-5h5"/></svg>换张背景</button><button id="toggleWallpaper" type="button"></button><span id="wallpaperStatus" role="status"></span></div></div>';
    const banner = document.getElementById('bannerSection');
    main.prepend(hero);
    if (banner) hero.appendChild(banner);
    const heading = document.createElement('div');
    heading.className = 'illustration-section-label'; heading.textContent = '作品一览';
    const box = document.getElementById('box');
    if (box && box.parentNode === main) main.insertBefore(heading, box);
    next = document.getElementById('nextWallpaper');
    toggle = document.getElementById('toggleWallpaper');
    status = document.getElementById('wallpaperStatus');
    next.addEventListener('click', () => change(true));
    toggle.addEventListener('click', () => {
      paused = !paused;
      try { localStorage.setItem('tx-wallpaper-paused', paused ? '1' : '0'); } catch (_) {}
      controls(); schedule();
    });
    document.addEventListener('visibilitychange', schedule);
    reduced.addEventListener('change', () => { controls(); schedule(); });
    if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', () => { controls(); schedule(); });
    narrow.addEventListener('change', () => {
      generation++; busy = false; index = -1; change(false);
    });
    controls();
    // Decorative artwork never blocks the resource loader or the page's onload.
    if (document.readyState === 'complete') change(false);
    else window.addEventListener('load', () => change(false), { once: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
