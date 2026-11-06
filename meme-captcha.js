(function () {
 'use strict';
 let current = null, previousFocus = null;
 const base = 'https://api.tian-xiao.com';
 function cancelled() { return Object.assign(new Error('取消'), { code: 'CANCELLED' }); }
 function init() {
  if (document.getElementById('memeCaptchaModal')) return;
  const modal = document.createElement('div'); modal.id = 'memeCaptchaModal'; modal.hidden = true;
  modal.innerHTML = '<section class="meme-captcha-box" role="dialog" aria-modal="true" aria-labelledby="memeCaptchaTitle" aria-describedby="memeCaptchaQuestion"><button type="button" class="meme-captcha-close" aria-label="关闭图片验证"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m4 4 12 12M16 4 4 16"/></svg></button><h2 id="memeCaptchaTitle">图片验证<span id="memeCaptchaExpiry" role="timer" aria-live="off" hidden></span></h2><div id="memeCaptchaQuestion"></div><div id="memeCaptchaGrid"></div><p id="memeCaptchaMessage" role="status" aria-live="polite"></p><div class="meme-captcha-actions"><button type="button" id="memeCaptchaRetry" hidden>重试加载</button><button type="button" id="memeCaptchaRefresh">换一题</button></div></section>';
  document.body.appendChild(modal);
  modal.querySelector('.meme-captcha-close').onclick = () => close(cancelled());
  modal.addEventListener('click', e => { if (e.target === modal) close(cancelled()); });
  document.getElementById('memeCaptchaRefresh').onclick = () => current && load(current);
  document.getElementById('memeCaptchaRetry').onclick = () => current && load(current);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') current?.refreshExpiry?.(); });
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
 function message(text) { const el = document.getElementById('memeCaptchaMessage'); if (el.textContent !== text) el.textContent = text; }
 function expiry(text) { const el = document.getElementById('memeCaptchaExpiry'); el.hidden = !text; if (el.textContent !== text) el.textContent = text; }
 function gridBusy(value) { document.getElementById('memeCaptchaGrid').setAttribute('aria-busy', String(value)); }
 function clearTimers(session) { for (const key of ['expiryTimer', 'imageTimer', 'resetTimer', 'cooldownTimer', 'questionTimer']) clearTimeout(session[key]); session.refreshExpiry = null; }
 function disableGrid() { document.querySelectorAll('#memeCaptchaGrid button').forEach(b => { b.disabled = true; }); }
 function showCooldown(session, seconds) {
  clearTimers(session); const generation = ++session.generation;
  session.id = null; session.busy = false; gridBusy(false); disableGrid();
  document.getElementById('memeCaptchaQuestion').textContent = '图片验证已暂停';
  const until = Date.now() + seconds * 1000;
  const refresh = document.getElementById('memeCaptchaRefresh'), retry = document.getElementById('memeCaptchaRetry');
  refresh.disabled = true; retry.hidden = true; expiry('冷却中');
  function tick() {
   if (!active(session, generation)) return;
   const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
   if (!left) { expiry(''); message('等待已结束，可以换题重试'); refresh.disabled = false; retry.hidden = false; return; }
   message('连续答错，暂停验证（剩余 ' + left + ' 秒）');
   session.cooldownTimer = setTimeout(tick, 250);
  }
  tick();
 }
 function close(error, token) {
  if (!current) return;
  const session = current; current = null; session.controller?.abort(); clearTimers(session);
  document.getElementById('memeCaptchaModal').hidden = true;
  gridBusy(false); expiry(''); document.getElementById('memeCaptchaGrid').replaceChildren();
  if (previousFocus?.isConnected) previousFocus.focus();
  error ? session.reject(error) : session.resolve(token);
 }
 async function jsonRequest(path, body, session) {
  const controller = new AbortController(); session.controller = controller;
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
   const response = await fetch(base + path, { method: 'POST', credentials: 'omit', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
   const data = await response.json();
   if (!response.ok || !data.success) throw Object.assign(Error(data.error || '验证暂不可用，请重试'), { status: response.status, attemptsLeft: data.attemptsLeft, cooldownSeconds: response.status === 429 && data.cooldown === true && Number.isFinite(data.retryAfter) && data.retryAfter > 0 ? data.retryAfter : null, reset: data.reset === true && (response.status === 403 || response.status === 409) });
   return data;
  } finally { clearTimeout(timer); }
 }
 async function load(session) {
  const generation = ++session.generation; session.controller?.abort(); clearTimers(session); session.id = null; session.busy = false;
  const grid = document.getElementById('memeCaptchaGrid'), refresh = document.getElementById('memeCaptchaRefresh'), retry = document.getElementById('memeCaptchaRetry');
  gridBusy(true); expiry(''); grid.replaceChildren(); document.getElementById('memeCaptchaQuestion').textContent = '正在加载题目…'; message(''); retry.hidden = true; refresh.disabled = true;
  try {
   const data = await jsonRequest('/api/meme-captcha/new', { purpose: session.purpose, subject: session.subject }, session);
   if (!active(session, generation)) return;
   showChallenge(session,data);
  } catch (e) {
   if (active(session, generation)) { if (e.cooldownSeconds) { showCooldown(session, e.cooldownSeconds); return; } clearTimeout(session.imageTimer); clearTimeout(session.questionTimer); expiry(''); gridBusy(false); disableGrid(); document.getElementById('memeCaptchaQuestion').textContent = '题目加载失败'; message(e.name === 'AbortError' ? '连接超时，请重试' : e.message); retry.hidden = false; }
  } finally { if (active(session, generation)) refresh.disabled = false; }
 }
 function showChallenge(session,data){
  if(!data||data.required!==2||![1,2].includes(data.stage)||!data.id||!Array.isArray(data.images)||data.images.length!==4||!Number.isFinite(data.expiresAt)||data.images.some(u=>typeof u!=='string'||!u.startsWith('/api/meme-captcha/image?')))throw Error('题目数据无效，请重试');
  const generation=++session.generation;clearTimers(session);session.busy=false;const grid=document.getElementById('memeCaptchaGrid'),retry=document.getElementById('memeCaptchaRetry');grid.replaceChildren();gridBusy(true);retry.hidden=true;document.getElementById('memeCaptchaRefresh').disabled=false;
   if (data.required!==2 || ![1,2].includes(data.stage) || !data.id || !Array.isArray(data.images) || data.images.length !== 4 || !Number.isFinite(data.expiresAt)) throw Error('题目数据无效，请重试');
   session.id = data.id; document.getElementById('memeCaptchaQuestion').textContent = data.question+'（第 '+data.stage+'/2 题）';
   let loaded = 0, failed = false; message('正在加载图片…');
   const loadedTimer = session.imageTimer = setTimeout(() => { if (active(session, generation) && loaded < 4) { failed = true; gridBusy(false); disableGrid(); message('图片加载较慢，请重试或换一题'); retry.hidden = false; } }, 60000);
   for (let i = 0; i < 4; i++) {
    if (typeof data.images[i] !== 'string' || !data.images[i].startsWith('/api/meme-captcha/image?')) throw Error('图片地址无效');
    const button = document.createElement('button'); button.type = 'button'; button.disabled = true; button.setAttribute('aria-label', '选择第' + (i + 1) + '张图片');
    const img = document.createElement('img'); img.crossOrigin = 'anonymous'; img.alt = '候选图片' + (i + 1); img.draggable = false;
    img.onload = () => { if (!active(session, generation)) return; loaded++; if (loaded === 4 && !failed) { clearTimeout(loadedTimer); gridBusy(false); [...grid.children].forEach(b => { b.disabled = false; }); message(data.stage===2?'已连续答对1题，请完成第2题':'请连续答对两题'); } };
    img.onerror = () => { if (active(session, generation)) { failed = true; clearTimeout(loadedTimer); gridBusy(false); disableGrid(); message('有图片加载失败，请重试或换一题'); retry.hidden = false; } };
    button.onclick = () => submit(session, generation, i, button);
    button.appendChild(img); grid.appendChild(button); img.src = base + data.images[i];
   }
   session.expiryTimer = setTimeout(() => { if (active(session, generation)) { failed = true; clearTimeout(loadedTimer); clearTimeout(session.questionTimer); session.refreshExpiry = null; expiry('已过期'); gridBusy(false); disableGrid(); message('题目已过期，请换一题'); retry.hidden = false; } }, Math.max(0, data.expiresAt - Date.now()));
   session.refreshExpiry = () => {
    if (!active(session, generation) || session.busy) return;
    clearTimeout(session.questionTimer);
    const left = Math.max(0, Math.ceil((data.expiresAt - Date.now()) / 1000));
    expiry(left ? '剩余 ' + left + ' 秒' : '已过期');
    if (left) session.questionTimer = setTimeout(session.refreshExpiry, Math.min(1000, data.expiresAt - Date.now()));
   };
   session.refreshExpiry();
 }
 async function submit(session, generation, selection, button) {
  if (!active(session, generation) || session.busy || !session.id) return;
  session.busy = true; clearTimers(session); expiry('验证中'); gridBusy(true); disableGrid(); button.classList.add('selected'); message('正在验证…'); document.getElementById('memeCaptchaRefresh').disabled = true;
  try {
   const data = await jsonRequest('/api/meme-captcha/verify', { id: session.id, selection }, session);
   if (active(session, generation)) { if(data.completed===false&&data.nextChallenge){showChallenge(session,data.nextChallenge);return} if (data.completed!==true||typeof data.token !== 'string' || !/^meme\.[a-f0-9]{64}$/.test(data.token)) throw Error('验证结果无效，请换一题'); close(null, data.token); }
  } catch (e) {
   if (active(session, generation)) {
    if (e.cooldownSeconds) { showCooldown(session, e.cooldownSeconds); return; }
    gridBusy(false); expiry(''); session.id = null;
    message(e.reset ? (e.status === 403 ? '选错了，连续正确次数已清零；' + (Number.isInteger(e.attemptsLeft) ? '再错 ' + e.attemptsLeft + ' 次将暂停验证；' : '') + '正在换一题…' : '题目已失效，正在换一题…') : (e.name === 'AbortError' ? '连接超时，请换一题重试' : e.message));
    document.getElementById('memeCaptchaRetry').hidden = !!e.reset;
    if (e.reset) session.resetTimer = setTimeout(() => { if (active(session, generation)) load(session); }, 700);
   }
  } finally { if (active(session, generation)) { gridBusy(false); session.busy = false; document.getElementById('memeCaptchaRefresh').disabled = false; } }
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
