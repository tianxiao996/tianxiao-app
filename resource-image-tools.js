(function(){
 'use strict';
 async function compress(file,{maxEdge=1400,quality=.78,force=false}={}){
  if(!file?.size||file.size>20*1024*1024)throw Error('请选择20MB以内的图片');
  const head=new Uint8Array(await file.slice(0,65536).arrayBuffer()),text=new TextDecoder('latin1').decode(head);
  if(!force&&(/^GIF8/.test(text)||text.includes('acTL')||text.includes('ANIM')||text.slice(0,64).includes('avis')))return file;
  const image=await createImageBitmap(file);try{
   if(image.width*image.height>60000000)throw Error('图片像素过大，请先缩小图片');
   const scale=Math.min(1,maxEdge/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
   const context=canvas.getContext('2d');context.drawImage(image,0,0,canvas.width,canvas.height);
   const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',quality));if(!blob||blob.type!=='image/webp')throw Error('此浏览器暂不支持 WebP 压缩');
   return force||blob.size<file.size?blob:file;
  }finally{image.close()}
 }
 async function appendVariants(body,file){
  let detail,thumb;try{detail=await compress(file);thumb=await compress(file,{maxEdge:480,quality:.72})}catch(error){return {warning:'自动压缩未完成，保留原图：'+error.message}}
  if(detail!==file)body.append('detail',detail,'detail.webp');if(thumb!==file)body.append('thumb',thumb,'thumb.webp');return {detailBytes:detail.size,thumbBytes:thumb.size,originalBytes:file.size};
 }
 window.ResourceImageTools={compress,appendVariants};
})();
