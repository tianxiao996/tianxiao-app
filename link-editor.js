(function(root){
'use strict';
function detectDrive(raw){
 let host;try{host=new URL(raw).hostname.toLowerCase()}catch(e){return ''}
 const at=domain=>host===domain||host.endsWith('.'+domain);
 if(at('pan.baidu.com')||at('yun.baidu.com'))return '百度网盘';
 if(at('pan.quark.cn'))return '夸克网盘';
 if(at('drive.uc.cn'))return 'UC网盘';
 if(at('alipan.com')||at('aliyundrive.com'))return '阿里云盘';
 if(/(?:^|\.)(?:lanzou[a-z]*|lanzn)\.com$/.test(host))return '蓝奏云';
 if(at('123pan.com')||at('123684.com')||at('123865.com')||at('123912.com'))return '123云盘';
 if(at('cloud.189.cn'))return '天翼云盘';
 if(at('caiyun.139.com')||at('yun.139.com'))return '中国移动云盘';
 if(at('pan.xunlei.com'))return '迅雷云盘';
 if(at('weiyun.com'))return '微云';
 if(at('115.com'))return '115网盘';
 if(at('mega.nz')||at('mega.io'))return 'MEGA';
 if(at('drive.google.com'))return 'Google Drive';
 if(at('1drv.ms')||at('onedrive.live.com'))return 'OneDrive';
 if(at('dropbox.com'))return 'Dropbox';
 return '';
}
function parseShareText(input){
 const text=String(input||'').replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/https?：\/\//gi,m=>m.replace('：',':')).replace(/\r\n?/g,'\n');
 if(text.length>60000)throw Error('一次粘贴的内容最多60,000字符，请分批识别');
 const links=[],warnings=[];
 const pattern=/https?:\/\/[^\s<>"'“”‘’（）()\[\]【】]+/gi;let match;
 while((match=pattern.exec(text))){
  let value=match[0].split(/(?:提取码|提取碼|访问码|访问碼|复制这段|複製這段)/)[0].replace(/[,，。；;！!？?、：:）)\]}】>]+$/g,'');
  let url;try{url=new URL(value)}catch(e){continue}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password){warnings.push('已忽略带内嵌账号密码的网址');continue}
  links.push({url:value,start:match.index,end:match.index+value.length,driveName:detectDrive(value)});
  if(links.length>64)throw Error('每个资源最多64组链接，请分批处理');
 }
 const codePattern=/(提取码|提取碼|提取密码|提取密碼|访问码|訪問碼|访问密码|訪問密碼|取件码|分享密码|密码|密碼)\s*[：:=]?\s*([A-Za-z0-9_-]{1,32})(?![A-Za-z0-9_-])/g;
 function codes(chunk){const found=[];for(const m of chunk.matchAll(codePattern)){const prefix=chunk.slice(Math.max(0,m.index-8),m.index);if(/(?:解压|解壓|压缩|壓縮)\s*$/.test(prefix))continue;found.push(m[2])}return [...new Set(found)]}
 const seen=new Set(),records=[];
 for(let i=0;i<links.length;i++){
  const link=links[i],url=new URL(link.url),notes=[];
  // Keep meaningful URL query parameters and fragments intact. A password in
  // the URL is evidence only for that URL, never for a neighbouring record.
  const queryCode=link.driveName?['pwd','password','passcode','access_code'].map(k=>url.searchParams.get(k)).find(v=>v&&/^[A-Za-z0-9_-]{1,32}$/.test(v)):null;
  const startBlank=text.lastIndexOf('\n\n',link.start),nextBlank=text.indexOf('\n\n',link.end);
  const blockStart=startBlank<0?0:startBlank+2,blockEnd=nextBlank<0?text.length:nextBlank;
  const inBlock=links.filter(x=>x.start>=blockStart&&x.start<blockEnd);
  let labelled=[];
  if(inBlock.length===1)labelled=codes(text.slice(blockStart,blockEnd));
  else{
   const after=text.slice(link.end,Math.min(i+1<links.length?links[i+1].start:text.length,blockEnd));
   // Only the same line or an immediately adjacent code line is unambiguous
   // in a multi-link block. A list of trailing codes is never zipped by index.
   const lines=after.split('\n');labelled=codes(lines[0]);
   if(!labelled.length&&lines[1]&&/^\s*(?:提取|访问|訪問|取件|分享密码|密码|密碼)/.test(lines[1]))labelled=codes(lines[1]);
  }
  const candidates=[...new Set([...(queryCode?[queryCode]:[]),...labelled])];
  let extractionCode='';
  if(candidates.length===1)extractionCode=candidates[0];
  else if(candidates.length>1)notes.push('发现不同的提取码，请手动核对');
  if(!link.driveName)notes.push('未识别网盘名称，可手动填写');
  if(link.driveName&&!extractionCode&&!candidates.length)notes.push('未识别到提取码，请核对是否需要');
  if(/解压|解壓|压缩密码/.test(text.slice(blockStart,blockEnd)))notes.push('解压码请手动填写，未自动导入');
  const identity=new URL(link.url);if(link.driveName)for(const key of ['pwd','password','passcode','access_code'])identity.searchParams.delete(key);
  const key=identity.toString();if(seen.has(key)){warnings.push('已忽略重复分享链接，请核对提取码');continue}seen.add(key);
  records.push({url:link.url,driveName:link.driveName,extractionCode,remark:'',warnings:notes});
 }
 if(!records.length)warnings.push('没有识别到 HTTP/HTTPS 链接');
 return {records,warnings};
}
// Explicitly leaves the manually entered unzip password alone.
function applyDetected(existing,detected){return {...existing,url:detected.url,driveName:existing.driveName.trim()?existing.driveName:detected.driveName,extractionCode:detected.extractionCode,remark:existing.remark,unzipPassword:existing.unzipPassword}}
const api={parseShareText,detectDrive,applyDetected};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.ResourceLinkEditor=api;
})(typeof window!=='undefined'?window:globalThis);
