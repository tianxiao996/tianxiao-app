(function () {
 'use strict';
 let current = null, previousFocus = null;
 const base = 'https://api.tian-xiao.com';
 function cancelled() { return Object.assign(new Error('取消'), { code: 'CANCELLED' }); }
 function init() {
  if (document.getElementById('memeCaptchaModal')) return;
  const modal = document.createElement('div'); modal.id = 'memeCaptchaModal'; modal.hidden = true;
  modal.innerHTML = '<section class="meme-captcha-box" role="dialog" aria-modal="true" aria-labelledby="memeCaptchaTitle" aria-describedby="memeCaptchaQuestion"><button type="button" class="meme-captcha-close" aria-label="关闭图片验证"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m4 4 12 12M16 4 4 16"/></svg></button><h2 id="memeCaptchaTitle">图片验证</h2><div id="memeCaptchaQuestion"></div><div id="memeCaptchaGrid"></div><p id="memeCaptchaMessage" role="status" aria-live="polite"></p><div class="meme-captcha-actions"><button type="button" id="memeCaptchaRetry" hidden>重试加载</button><button type="button" id="memeCaptchaRefresh">换一题</button></div></section>';
  document.body.appendChild(modal);
  modal.querySelector('.meme-captcha-close').onclick = () => close(cancelled());
  modal.addEventListener('click', e => { if (e.target === modal) close(cancelled()); });
  document.getElementById('memeCaptchaRefresh').onclick = () => current && load(current);
  document.getElementById('memeCaptchaRetry').onclick = () => current && load(current);
  document.addEventListener('keydown', e => {
   if (!current) return;
   if (e.key === 'Escape') { e.preventDefault(); close(cancelled()); }
   if (e.key !== 'Tab') return;
   const items = [...modal.querySelectorAll('button:not(:disabled):not([hidden])')];
   if (!items.length) return;
   if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1).focus(); }
   else if (!e.shiftKey && (document.activeElement === items.at(-1) || !modal.contains(document.activeElement))) { e.preventDefault(); items[0].focus(); }
  });
 }
 function active(session, generation) { return current === session && session.generation === generation; }
 function message(text) { document.getElementById('memeCaptchaMessage').textContent = text; }
 function disableGrid() { document.querySelectorAll('#memeCaptchaGrid button').forEach(b => { b.disabled = true; }); }
 function close(error, token) {
  if (!current) return;
  const session = current; current = null; session.controller?.abort(); clearTimeout(session.expiryTimer);
  document.getElementById('memeCaptchaModal').hidden = true;
  document.getElementById('memeCaptchaGrid').replaceChildren();
  if (previousFocus?.isConnected) previousFocus.focus();
  error ? session.reject(error) : session.resolve(token);
 }
 async function jsonRequest(path, body, session) {
  const controller = new AbortController(); session.controller = controller;
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
   const response = await fetch(base + path, { method: 'POST', credentials: 'omit', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
   const data = await response.json();
   if (!response.ok || !data.success) throw Error(data.error || '验证暂不可用，请重试');
   return data;
  } finally { clearTimeout(timer); }
 }
 async function load(session) {
  const generation = ++session.generation; session.controller?.abort(); clearTimeout(session.expiryTimer); session.id = null; session.busy = false;
  const grid = document.getElementById('memeCaptchaGrid'), refresh = document.getElementById('memeCaptchaRefresh'), retry = document.getElementById('memeCaptchaRetry');
  grid.replaceChildren(); document.getElementById('memeCaptchaQuestion').textContent = '正在加载题目…'; message(''); retry.hidden = true; refresh.disabled = true;
  try {
   const data = await jsonRequest('/api/meme-captcha/new', { purpose: session.purpose, subject: session.subject }, session);
   if (!active(session, generation)) return;
   if (!data.id || !Array.isArray(data.images) || data.images.length !== 4 || !Number.isFinite(data.expiresAt)) throw Error('题目数据无效，请重试');
   session.id = data.id; document.getElementById('memeCaptchaQuestion').textContent = data.question;
   let loaded = 0, failed = false; message('正在加载图片…');
   const loadedTimer = setTimeout(() => { if (active(session, generation) && loaded < 4) { failed = true; disableGrid(); message('图片加载较慢，请重试或换一题'); retry.hidden = false; } }, 60000);
   for (let i = 0; i < 4; i++) {
    if (typeof data.images[i] !== 'string' || !data.images[i].startsWith('/api/meme-captcha/image?')) throw Error('图片地址无效');
    const button = document.createElement('button'); button.type = 'button'; button.disabled = true; button.setAttribute('aria-label', '选择第' + (i + 1) + '张图片');
    const img = document.createElement('img'); img.alt = '候选图片' + (i + 1); img.draggable = false;
    img.onload = () => { if (!active(session, generation)) return; loaded++; if (loaded === 4 && !failed) { clearTimeout(loadedTimer); [...grid.children].forEach(b => { b.disabled = false; }); message('点击符合题目的图片'); } };
    img.onerror = () => { if (active(session, generation)) { failed = true; clearTimeout(loadedTimer); disableGrid(); message('有图片加载失败，请重试或换一题'); retry.hidden = false; } };
    button.onclick = () => submit(session, generation, i, button);
    button.appendChild(img); grid.appendChild(button); img.src = base + data.images[i];
   }
   session.expiryTimer = setTimeout(() => { if (active(session, generation)) { disableGrid(); message('题目已过期，请换一题'); retry.hidden = false; } }, Math.max(0, data.expiresAt - Date.now()));
  } catch (e) {
   if (active(session, generation)) { disableGrid(); document.getElementById('memeCaptchaQuestion').textContent = '题目加载失败'; message(e.name === 'AbortError' ? '连接超时，请重试' : e.message); retry.hidden = false; }
  } finally { if (active(session, generation)) refresh.disabled = false; }
 }
 async function submit(session, generation, selection, button) {
  if (!active(session, generation) || session.busy || !session.id) return;
  session.busy = true; disableGrid(); button.classList.add('selected'); message('正在验证…'); document.getElementById('memeCaptchaRefresh').disabled = true;
  try {
   const data = await jsonRequest('/api/meme-captcha/verify', { id: session.id, selection }, session);
   if (active(session, generation)) { if (typeof data.token !== 'string' || !data.token.startsWith('meme.')) throw Error('验证结果无效，请换一题'); close(null, data.token); }
  } catch (e) {
   if (active(session, generation)) { message(e.name === 'AbortError' ? '连接超时，请换一题重试' : e.message); document.getElementById('memeCaptchaRetry').hidden = false; }
  } finally { if (active(session, generation)) { session.busy = false; document.getElementById('memeCaptchaRefresh').disabled = false; } }
 }
 window.cancelMemeCaptcha = () => close(cancelled());
 window.requestMemeCaptcha = function (purpose, subject) {
  init(); if (current) close(cancelled()); previousFocus = document.activeElement;
  return new Promise((resolve, reject) => {
   const session = { purpose, subject, resolve, reject, generation: 0 }; current = session;
   document.getElementById('memeCaptchaModal').hidden = false;
   document.querySelector('#memeCaptchaModal .meme-captcha-close').focus(); load(session);
  });
 };
})();
