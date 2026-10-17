import * as T from 'three';
import {OrbitControls} from './vendor/OrbitControls.js';
import {Reflector} from './vendor/Reflector.js';
import {mergeGeometries} from './vendor/BufferGeometryUtils.js';

// All geometry and textures are generated here. No models, images or runtime CDN.
const canvas=document.querySelector('canvas');
const small=matchMedia('(max-width:700px)').matches;
const reduced=matchMedia('(prefers-reduced-motion:reduce)').matches;
const renderer=new T.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,small?1.5:1.8));
renderer.setClearColor(0x111d30);renderer.outputColorSpace=T.SRGBColorSpace;
renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.17;
renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
const scene=new T.Scene();scene.fog=new T.FogExp2(0x17263c,.011);
const camera=new T.OrthographicCamera(-12,12,12,-12,.1,100);
camera.position.set(16,13,20);
const controls=new OrbitControls(camera,canvas);controls.target.set(0,1.65,0);
controls.enableDamping=true;controls.dampingFactor=.065;controls.minZoom=.65;controls.maxZoom=2.3;
controls.maxPolarAngle=Math.PI*.475;controls.minPolarAngle=.32;controls.enablePan=false;
controls.rotateSpeed=.6;controls.zoomSpeed=.8;
const model=new T.Group();scene.add(model);
const ambient=new T.HemisphereLight(0xa7c6ff,0x46415c,1.45);scene.add(ambient);
const moon=new T.DirectionalLight(0xb5cfff,1.9);moon.position.set(-7,15,8);moon.castShadow=true;
moon.shadow.mapSize.set(small?1024:2048,small?1024:2048);Object.assign(moon.shadow.camera,{left:-13,right:13,top:13,bottom:-13,near:1,far:42});moon.shadow.bias=-.0008;moon.shadow.normalBias=.035;scene.add(moon);
const warm=new T.PointLight(0xffb36e,45,16,2);warm.position.set(-1,3.4,-.5);scene.add(warm);
const streetLight=new T.PointLight(0x8eceff,24,12,2);streetLight.position.set(5.9,5.5,4.6);scene.add(streetLight);
const gradient=new T.DataTexture(new Uint8Array([62,122,196,255]),4,1,T.RedFormat);gradient.needsUpdate=true;gradient.minFilter=gradient.magFilter=T.NearestFilter;
const materials=new Map();
function mat(color,emissive=0,intensity=0){const key=[color,emissive,intensity].join();if(!materials.has(key))materials.set(key,new T.MeshToonMaterial({color,gradientMap:gradient,emissive,emissiveIntensity:intensity}));return materials.get(key)}
const ink=new T.LineBasicMaterial({color:0x192338,transparent:true,opacity:.72});
const boxGeo=new T.BoxGeometry(1,1,1);const edges=new T.EdgesGeometry(boxGeo);
function box(x,y,z,w,h,d,color,outline=false,parent=model){const mesh=new T.Mesh(boxGeo,typeof color==='object'?color:mat(color));mesh.position.set(x,y,z);mesh.scale.set(w,h,d);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);if(outline){const e=new T.LineSegments(edges,ink);mesh.add(e)}return mesh}
function cylinder(x,y,z,r,h,color,parent=model,r2=r){const mesh=new T.Mesh(new T.CylinderGeometry(r2,r,h,12),typeof color==='object'?color:mat(color));mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh}
function pipe(points,r,color,parent=model){const curve=new T.CatmullRomCurve3(points.map(p=>new T.Vector3(...p)));const mesh=new T.Mesh(new T.TubeGeometry(curve,Math.max(8,points.length*5),r,6,false),mat(color));parent.add(mesh);return mesh}
function segment(a,b,r,color,parent=model){const from=new T.Vector3(...a),to=new T.Vector3(...b),dir=to.clone().sub(from);const mesh=cylinder(0,0,0,r,dir.length(),color,parent);mesh.position.copy(from.add(to).multiplyScalar(.5));mesh.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),dir.normalize());return mesh}
function ring(x,y,z,r,color,parent=model){const mesh=new T.Mesh(new T.TorusGeometry(r,.018,5,36),mat(color));mesh.position.set(x,y,z);parent.add(mesh);return mesh}
function texture(w,h,draw){const c=document.createElement('canvas');c.width=w;c.height=h;draw(c.getContext('2d'),w,h);const tx=new T.CanvasTexture(c);tx.colorSpace=T.SRGBColorSpace;tx.anisotropy=4;return tx}
function sign(x,y,z,w,h,text,bg='#fff4d6',fg='#305d6a',size=82,ry=0,parent=model){const tx=texture(1024,256,(c,W,H)=>{c.fillStyle=bg;c.fillRect(0,0,W,H);c.fillStyle=fg;c.textAlign='center';c.textBaseline='middle';c.font=`700 ${size}px "Yu Gothic","Microsoft YaHei",sans-serif`;c.fillText(text,W/2,H/2,W-48)});const m=new T.MeshBasicMaterial({map:tx,side:T.DoubleSide});const p=new T.Mesh(new T.PlaneGeometry(w,h),m);p.position.set(x,y,z);p.rotation.y=ry;parent.add(p);return p}
function poster(x,y,z,w,h,title,accent='#db6b63',ry=0,parent=model){const tx=texture(256,360,(c,W,H)=>{c.fillStyle='#fff2d6';c.fillRect(0,0,W,H);c.fillStyle=accent;c.fillRect(10,10,W-20,74);c.fillStyle='#fff8e7';c.font='bold 30px sans-serif';c.textAlign='center';c.fillText(title,W/2,58);c.fillStyle=accent;c.beginPath();c.arc(W/2,185,65,0,7);c.fill();c.fillStyle='#f6d596';c.fillRect(65,155,128,52);c.fillStyle='#554c5b';c.font='bold 24px sans-serif';c.fillText('新発売',W/2,292);c.font='20px sans-serif';c.fillText('いつもの、しあわせ',W/2,328)});const p=new T.Mesh(new T.PlaneGeometry(w,h),new T.MeshBasicMaterial({map:tx,side:T.DoubleSide}));p.position.set(x,y,z);p.rotation.y=ry;parent.add(p);return p}
const glowTx=texture(128,128,(c,w,h)=>{const g=c.createRadialGradient(w/2,h/2,0,w/2,h/2,w/2);g.addColorStop(0,'rgba(255,255,255,.7)');g.addColorStop(.2,'rgba(255,255,255,.25)');g.addColorStop(1,'rgba(255,255,255,0)');c.fillStyle=g;c.fillRect(0,0,w,h)});
function halo(x,y,z,color,size){const s=new T.Sprite(new T.SpriteMaterial({map:glowTx,color,transparent:true,opacity:.65,depthWrite:false,blending:T.AdditiveBlending}));s.position.set(x,y,z);s.scale.set(size,size,1);model.add(s);return s}
let seed=71;function rand(){seed=(seed*1664525+1013904223)>>>0;return seed/4294967296}

// A single square collectible base; every physical prop belongs to this group.
box(0,-.45,0,16,.9,16,0x25334b,true);
box(0,.025,0,15.9,.12,15.9,0x27364b,true);
box(0,-.18,7.99,15.8,.12,.025,0x66839a);
for(let x=-7.5;x<8;x+=.55)box(x,-.48,8.005,.25,.03,.015,0x35465e);
// Sidewalk and the turning road.
box(-1,.18,-1.7,12,.28,11.5,0x6e8291,true);
box(5.45,.17,-3.8,.65,.28,7.7,0x5a6f82,true);
for(let x=-6.8;x<5;x+=.62)box(x,.32,4.02,.58,.24,.27,0x92a0a5,true);
for(let z=-7.4;z<4;z+=.62)box(5.08,.32,z,.27,.24,.58,0x8c9aa4,true);
const paving=new T.Group();model.add(paving);
for(let x=-6.8;x<4.9;x+=.8)for(let z=-6.8;z<3.8;z+=.8){box(x,.327,z,.77,.018,.77,((Math.round(x*10)+Math.round(z*10))%3)?0x718590:0x80939a,false,paving)}
const reflector=new Reflector(new T.PlaneGeometry(15.7,3.75),{color:0x566b85,textureWidth:small?256:768,textureHeight:small?256:768,clipBias:.003});reflector.rotation.x=-Math.PI/2;reflector.position.set(0,.105,6.02);model.add(reflector);
reflector.material.fragmentShader=reflector.material.fragmentShader.replace('gl_FragColor = vec4( blendOverlay( base.rgb, color ), 1.0 );','gl_FragColor = vec4( mix(blendOverlay(base.rgb, color), vec3(0.045,0.075,0.12), 0.58), 1.0 );');
box(6.65,.10,-1.9,2.6,.025,11.8,mat(0x253b50));
for(let i=0;i<6;i++)box(-5.9+i*.78,.126,5.6,.42,.018,2.4,0xc5d5d5);
for(let z=-6.8;z<3;z+=2.1)box(6.65,.126,z,.11,.016,1.05,0x9aafb3);
// Parking lines, drain and utility cover.
for(const x of [1.15,3.45])box(x,.34,3,.055,.015,1.6,0xc8d0bb);
box(2.3,.34,3.77,2.3,.015,.055,0xc8d0bb);sign(2.3,.35,2.8,.5,.4,'P','#718590','#cfdbcd',150).rotation.x=-Math.PI/2;
box(-1,.344,3.77,10.8,.018,.13,0x253747);
for(let x=-6.2;x<4.4;x+=.18)box(x,.357,3.77,.028,.02,.12,0x89959b);
const manhole=cylinder(4.5,.13,6.35,.43,.025,0x34485c);for(let i=-2;i<3;i++)box(4.5,.15,6.35+i*.11,.64,.015,.025,0x53677c);

// Building: open architectural cutaway above the central aisles.
box(-1.5,.47,-1.55,8.6,.25,6.8,0xc8c0a9,true);
box(-1.5,.61,-1.55,8.25,.05,6.5,0xe2d6b5);
for(let x=-5.5;x<2.7;x+=.65)box(x,.642,-1.55,.015,.008,6.5,0xb5b69e);
for(let z=-4.7;z<1.8;z+=.65)box(-1.5,.643,z,8.25,.008,.015,0xb5b69e);
box(-1.5,2.15,-4.85,8.65,3.25,.18,0xc0bfae,true);
box(-5.8,2.15,-1.55,.18,3.25,6.6,0x97a6aa,true);
box(-1.5,3.83,-3.95,8.8,.22,2.1,0x596f83,true);
box(-1.5,3.99,-4.9,8.85,.22,.16,0x94a7ad,true);
box(-5.84,3.7,-1.5,.16,.27,6.85,0x93a6a9,true);
box(2.84,3.7,-1.5,.16,.27,6.85,0x93a6a9,true);
box(-1.5,3.65,1.9,9.15,.28,1.2,0x657d88,true);
box(-1.5,3.82,2.43,9.25,.12,.12,0xb4bcaa,true);
box(-1.5,3.48,2.43,9.25,.09,.15,mat(0xffe4a1,0xffc267,1.4));
// Front fascia, teal and coral stripes and hand-lettered store name.
box(-1.5,3.18,2.15,8.85,.63,.22,0xede5c9,true);
box(-1.5,3.48,2.28,8.85,.09,.03,mat(0x65b9b7,0x3c9f9f,.3));
box(-1.5,2.88,2.28,8.85,.07,.03,0xe39783);
const shopSign=sign(-1.65,3.19,2.274,6.2,.48,'天笑   まちかどマート','#f7ebcd','#376e78',155);
sign(2.07,3.2,2.275,1,.42,'24 H','#eabf84','#4d5462',115);
halo(-1,3.1,2.5,0xffd69a,7);
// Glass panes with thin aluminium framing and rain sheen.
const glass=new T.MeshPhysicalMaterial({color:0xb5dce0,transparent:true,opacity:.17,roughness:.13,metalness:.1,depthWrite:false,side:T.DoubleSide});
for(const x of [-5.55,-3.4,-1.3,1.05,2.7])box(x,1.76,1.85,.07,2.2,.1,0x566e7d,true);
box(-1.4,.76,1.85,8.55,.18,.12,0x7c9297);box(-1.4,2.81,1.85,8.55,.11,.12,0x566e7d);
for(const [x,w]of[[-4.48,2.07],[-2.35,2.02],[1.88,1.53]])box(x,1.76,1.84,w,1.95,.025,glass);
box(2.78,1.77,-1.55,.025,2.1,6.4,glass);
for(let z=-4.7;z<1.9;z+=1.6)box(2.84,1.77,z,.10,2.16,.065,0x58717d,true);
// Sliding double door.
const doorLeft=new T.Group(),doorRight=new T.Group();model.add(doorLeft,doorRight);
for(const [g,x]of[[doorLeft,-.75],[doorRight,.34]]){g.position.x=x;box(0,1.71,1.91,1.05,1.98,.028,glass,false,g);for(const xx of[-.51,.51])box(xx,1.72,1.94,.05,2.05,.06,0x65818b,true,g);box(0,.72,1.94,1.07,.06,.06,0x6a808b,false,g);box(0,2.74,1.94,1.07,.06,.06,0x6a808b,false,g);box(0,1.4,1.95,1.06,.16,.015,mat(0xa7c6c0),false,g)}
box(-.22,.68,2.04,2.3,.035,.3,0x5b7281);box(-.22,.35,2.45,2.35,.035,.72,0x334859,true);sign(-.22,.375,2.45,1.35,.4,'WELCOME','#334859','#a8c3c0',118).rotation.x=-Math.PI/2;
sign(-.22,2.64,1.96,1.75,.18,'いらっしゃいませ','#e7e0bc','#476f71',75);
poster(-4.5,1.8,1.88,.62,.92,'お弁当','#d07f55');poster(2,1.9,1.88,.55,.8,'新商品','#699b94');

// Interior: generous little products on the aisles and back refrigerators.
const productColors=[0xe5a76d,0xf0c978,0x8ab19c,0xdf8e8d,0x7698bc,0xe6d7b2];
const productBatch=[];
function product(x,y,z,w,h,d,c){productBatch.push({x,y,z,w,h,d,c})}
function shelf(x,z,w=2.2,d=.72){box(x,1.28,z,w,1.32,d,0xd1c7ae,true);for(let layer=0;layer<3;layer++){const y=.94+layer*.43;box(x,y,z,w+.04,.065,d+.07,0xf3e6c5,true);for(let i=0;i<7;i++)for(let side of[-1,1]){const h=.19+rand()*.12;product(x-w/2+.18+i*(w-.32)/6,y+.05+h/2,z+side*d*.28,.15,h,.15,productColors[Math.floor(rand()*6)])}}sign(x,1.97,z+d/2+.04,w,.18,'お菓子 ・ スナック','#e6d9b4','#5a7776',90)}
shelf(-3.95,-1.2,2.1);shelf(-1.1,-1.5,2.3);shelf(-3.95,.28,2.1);
// Chilled bento case, with individual boxes, rice balls and labels.
box(.75,1.03,-2.45,1.15,.8,2.3,0xc8d4c5,true);
for(let j=0;j<4;j++)for(let k=0;k<2;k++){box(.48+k*.5,1.46,-3.25+j*.5,.40,.07,.36,0x3b4651);box(.48+k*.5,1.51,-3.25+j*.5,.33,.045,.28,0xf1e5bf);product(.48+k*.5,1.56,-3.25+j*.5,.11,.065,.16,0xc48266)}
sign(.75,1.13,-1.28,1.0,.22,'お弁当','#e6c095','#6a6758',100);
for(let i=0;i<5;i++){const x=-5.15+i*1.35;box(x,1.81,-4.52,1.22,2.25,.42,0x6f8586,true);box(x,1.85,-4.27,1.06,1.9,.028,mat(0xadc6ba,0x8cb8b0,.3));for(let row=0;row<4;row++){const y=.96+row*.43;box(x,y,-4.08,1.10,.035,.35,0xd1d5be);for(let j=0;j<5;j++)product(x-.42+j*.21,y+.16,-4.07,.12,.25,.12,productColors[(j+row+i)%6])}box(x+.51,1.8,-4.03,.025,.4,.025,0xf0dfb8);box(x,2.86,-4.04,1.2,.06,.05,mat(0xffe9af,0xffde9a,1));sign(x,3.04,-4.13,1.2,.24,['DRINKS','お茶','ミルク','珈琲','冷たい'][i],'#ede1bd','#577b78',85)}
// Counter, register, coffee and oden.
box(1.65,1.15,.18,1.48,1.05,2.5,0xc99573,true);box(1.65,1.72,.18,1.62,.10,2.65,0xede3c8,true);
box(1.57,1.9,.6,.58,.28,.48,0x3b4c5e,true);const register=box(1.57,2.16,.54,.57,.38,.08,0x50697b,true);register.rotation.x=-.18;box(1.57,2.16,.49,.45,.26,.015,mat(0xb7d7be,0x9bc6a3,.55));
box(1.67,2.01,-.6,.48,.53,.45,0x495b65,true);box(1.67,2.07,-.35,.3,.16,.035,0xa2c0b9);cylinder(1.67,1.83,-.3,.075,.14,0xf7ebcf);
box(1.64,1.86,-.11,.6,.15,.45,0x7f8984,true);for(let i=0;i<6;i++)cylinder(1.43+(i%3)*.2,1.96,-.22+Math.floor(i/3)*.19,.058,.06,0xd3ae76);
sign(1.64,1.34,1.45,1.35,.28,'お会計   CASHIER','#e7d5b1','#5a786f',85);
// Magazine stand, ice cream freezer and rear door.
box(-5.13,1.05,1.05,.74,.76,.55,0x7d897e,true);for(let i=0;i<4;i++)poster(-5.4+i*.18,1.54,1.36,.16,.36,'旅',i%2?'#7388ad':'#df9a74');
box(-2.95,1.02,-3.25,1.8,.73,.7,0xaaaeb0,true);box(-2.95,1.42,-3.25,1.8,.07,.73,glass);sign(-2.95,1.1,-2.88,1.5,.24,'ICE CREAM','#dbd5bc','#6c8c94',90);
box(-5.68,1.7,-3.2,.08,2.1,1.03,0x718087,true);sign(-5.61,2.16,-3.2,.6,.3,'STAFF','#e2d9be','#5a686f',85,Math.PI/2);
for(let i=0;i<3;i++){box(-4+i*2.4,3.53,-2.25,1.8,.07,.19,mat(0xffedb3,0xffd48d,1.3));halo(-4+i*2.4,3.45,-2.25,0xffd99a,2.7)}
sign(-2.7,3.2,-4.72,3,.33,'おいしい毎日、ここから。','#e8dfc5','#65897d',81);
for(let i=0;i<3;i++){const a=box(-.3,.66,-.1-i*.37,.25,.008,.2,0xc7b06e);a.rotation.y=Math.PI/4}
// Batch the several hundred products by color to keep mobile draw calls down.
const dummy=new T.Object3D();for(const c of productColors){const list=productBatch.filter(p=>p.c===c),mesh=new T.InstancedMesh(boxGeo,mat(c),list.length);list.forEach((p,i)=>{dummy.position.set(p.x,p.y,p.z);dummy.scale.set(p.w,p.h,p.d);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix)});mesh.castShadow=true;model.add(mesh)}

// Vending machine with little cans, coin slot and pickup hatch.
const vending=new T.Group();vending.position.set(-6.55,.34,1.25);model.add(vending);
box(0,1.18,0,1.05,2.3,.78,0xb75e71,true,vending);box(-.08,1.55,.405,.82,1.25,.02,mat(0xe2f1e1,0xbddfd7,.4),false,vending);
for(let row=0;row<3;row++)for(let col=0;col<4;col++){cylinder(-.36+col*.19,1.17+row*.35,.45,.055,.22,productColors[(row+col)%6],vending);box(-.36+col*.19,1.02+row*.35,.44,.11,.03,.02,mat(0x93dad5,0x7bbdb7,.4),false,vending)}
box(.33,.65,.42,.20,.12,.03,0x33495e,false,vending);box(-.16,.39,.42,.65,.23,.04,0x263b50,true,vending);sign(0,2.17,.405,.92,.21,'つめた〜い','#e6d8b9','#527988',80,0,vending);halo(-6.55,1.8,1.9,0x8ddce2,2.4);
// Umbrella rack and two closed umbrellas.
box(-2.12,.62,2.26,.7,.5,.4,0x586d79,true);box(-2.12,.9,2.26,.74,.045,.46,0xa5b5b4,true);
for(let i=0;i<3;i++){const x=-2.35+i*.23;segment([x,.69,2.26],[x,1.55,2.26],.023,0x8ba5b5);cylinder(x,1.16,2.26,.065,.70,[0x98adb9,0xd6b29e,0x7f9a93][i]);pipe([[x,1.5,2.26],[x,1.63,2.26],[x+.10,1.67,2.26],[x+.15,1.59,2.26]],.025,0x324a5c)}
// Waste sorting bins.
for(let i=0;i<2;i++){box(3.6,.87,.8-i*.85,.6,1.04,.62,0x789294,true);box(3.6,1.42,.8-i*.85,.65,.08,.65,0xc2ccc0,true);box(3.6,1.28,1.12-i*.85,.29,.13,.025,0x304b5c);sign(3.6,1,1.13-i*.85,.4,.22,i?'びん・缶':'もえるごみ','#c7d3c8','#536c78',65)}
// Bicycle; detailed flat wheels, frame triangles, basket and saddle.
const bike=new T.Group();bike.position.set(-4.1,.38,2.8);bike.rotation.y=-.12;model.add(bike);
for(const x of[-.78,.78]){const tire=new T.Mesh(new T.TorusGeometry(.43,.045,8,40),mat(0x263849));tire.position.set(x,.46,0);bike.add(tire);const rim=ring(x,.46,0,.37,0xa8b5b4,bike);for(let i=0;i<10;i++){const a=i*Math.PI/5;segment([x,.46,0],[x+Math.cos(a)*.37,.46+Math.sin(a)*.37,0],.006,0x859fa9,bike)}}
for(const [a,b]of[[[-.78,.46,0],[-.25,1.04,0]],[[-.25,1.04,0],[.10,.46,0]],[[.10,.46,0],[-.78,.46,0]],[[-.25,1.04,0],[.52,1.08,0]],[[.52,1.08,0],[.1,.46,0]],[[.52,1.08,0],[.78,.46,0]]])segment(a,b,.028,0xc28f89,bike);
box(-.3,1.16,0,.4,.07,.22,0x2e4353,true,bike);segment([.53,1.04,0],[.48,1.43,0],.025,0x9db3b5,bike);segment([.48,1.43,-.22],[.48,1.43,.22],.025,0x859ca4,bike);box(.76,1.27,0,.43,.32,.38,0x91a8ad,true,bike);box(.76,1.45,0,.45,.035,.4,0xc1ccbf,true,bike);segment([.03,.47,0],[-.15,.13,.28],.018,0x536c7c,bike);
// Side alley, service entrance and AC outdoor unit.
box(3.7,.35,-3.1,1.25,.04,7.5,0x405569,true);
box(3.7,1.22,-3.8,.76,.64,.42,0xb9c5bd,true);box(3.7,1.23,-3.56,.6,.48,.03,0x536c78);for(let j=0;j<7;j++)box(3.7,1.03+j*.065,-3.53,.57,.018,.018,0x99b0b2);
pipe([[3.32,1.5,-3.8],[3.0,1.5,-3.8],[3,2.6,-3.8]],.045,0xb5c0b4);
box(4.15,.67,-5.75,.72,.6,.6,0x997f72,true);box(3.35,.62,-6,.65,.5,.62,0x7f8881,true);
box(-1.5,.34,-6.4,9,.04,2.5,0x4f6677,true);
// Bulletin board on the side wall.
box(2.92,2.0,-2.3,.08,1.35,1.5,0x384e60,true);poster(2.97,2.03,-2.65,.48,.88,'街の便り','#c38f70',Math.PI/2);poster(2.97,2.03,-1.95,.48,.88,'夏の夜','#7e9c9c',Math.PI/2);
// Rooftop service equipment and gutters.
box(1.35,4.2,-4,.92,.6,.85,0x9eafb2,true);const fan=ring(1.35,4.51,-4,.28,0x536b7a);fan.rotation.x=-Math.PI/2;for(let i=0;i<4;i++){const blade=box(1.35,4.53,-4,.40,.025,.06,0x738e9a);blade.rotation.y=i*Math.PI/4}
pipe([[-5.9,3.7,2.35],[-5.9,3.7,2.6],[-5.9,.55,2.6]],.055,0x688390);
// Street light and pole; all wires terminate on the square base.
cylinder(5.8,3.35,4.38,.075,6.45,0x61788e);cylinder(5.8,.58,4.38,.20,.75,0x50697d);
pipe([[5.8,6.3,4.38],[5.8,6.65,4.38],[5.4,6.75,4.38],[5.08,6.6,4.38]],.07,0x8296a1);box(5.06,6.54,4.38,.7,.14,.36,0x8fa7b2,true);box(5.06,6.46,4.38,.55,.035,.28,mat(0xffedbe,0xffd88a,1.4));halo(5.06,6.35,4.38,0xffdfa3,2.8);
cylinder(-6.8,3.7,-5.7,.115,6.95,0x66788c);for(let y=.75;y<2;y+=.22)cylinder(-6.8,y,-5.7,.12,.10,0xc4b97f);
box(-6.8,6.45,-5.7,1.9,.1,.14,0x71859a,true);for(const x of[-7.5,-6.1])cylinder(x,6.62,-5.7,.09,.3,0xc4c9bc);
pipe([[-7.5,6.75,-5.7],[-1,5.9,-6.6],[6.9,6.65,-5.8]],.021,0x283b52);pipe([[-6.1,6.75,-5.7],[0,6.25,-5.8],[6.9,6.6,-5.8]],.018,0x2c4056);
cylinder(6.9,3.5,-5.8,.09,6.5,0x657c90);box(6.9,6.55,-5.8,1.0,.08,.12,0x7d92a4);
// Traffic lights, street sign, guard rails and bollards.
cylinder(6.8,2.15,.9,.055,3.7,0x5d788d);box(6.8,3.97,.9,.45,1.12,.36,0x344e61,true);
const signal=[];for(let i=0;i<3;i++){const m=mat([0xb75e65,0xc7a36b,0x65b7af][i],[0xc65d65,0xd5af65,0x5ed5ba][i],i===2?1.3:.08),disc=cylinder(6.8,4.3-i*.34,1.1,.115,.035,m);disc.rotation.x=Math.PI/2;signal.push(m)}
cylinder(-6.6,1.4,4,.04,2.25,0x8ea9b3);const roadSign=new T.Mesh(new T.CircleGeometry(.29,28),mat(0x5b91ab));roadSign.position.set(-6.6,2.6,4);model.add(roadSign);sign(-6.6,2.6,4.01,.4,.18,'30','#5b91ab','#ecedcc',120);
for(const x of[-6.45,-4.85]){cylinder(x,.85,4.15,.045,1.1,0xadc2bd);cylinder(x,1.02,4.15,.05,.16,0xd9b279)}segment([-6.45,1.21,4.15],[-4.85,1.21,4.15],.04,0xb6c7bd);
for(const z of[1.6,3.5])cylinder(5.4,.83,z,.06,.95,0x99b4b9);segment([5.4,1.13,1.6],[5.4,1.13,3.5],.04,0xb8cbc7);
// Tiny vegetation, a discarded umbrella cover box and lane plaques.
for(const z of[-1.3,-2.1]){box(-6.6,.62,z,.55,.55,.55,0xb59a85,true);for(let j=0;j<7;j++){const leaf=new T.Mesh(new T.IcosahedronGeometry(.16,0),mat(j%2?0x729b9a:0x8aa898));leaf.position.set(-6.6+(rand()-.5)*.42,1+rand()*.4,z+(rand()-.5)*.35);model.add(leaf)}}
sign(-5.68,2.6,-1.8,.65,.3,'営業中','#c8d4c9','#4b7c7e',85,Math.PI/2);

// Wet highlights: irregular pools with soft neon streaks, no opaque mirror floor.
const puddleMat=new T.MeshBasicMaterial({color:0x86b8c7,transparent:true,opacity:.14,depthWrite:false});
for(let i=0;i<18;i++){const p=new T.Mesh(new T.CircleGeometry(.4+rand()*.8,32),puddleMat);p.rotation.x=-Math.PI/2;p.scale.y=.25+rand()*.4;p.position.set(-7+rand()*14,.135,4.2+rand()*3.5);model.add(p)}
const sheen=new T.MeshBasicMaterial({color:0xffce93,transparent:true,opacity:.16,depthWrite:false,blending:T.AdditiveBlending});
const lightPool=new T.Mesh(new T.PlaneGeometry(8,3.5),new T.MeshBasicMaterial({map:glowTx,color:0xffbd79,transparent:true,opacity:.35,depthWrite:false,blending:T.AdditiveBlending}));lightPool.rotation.x=-Math.PI/2;lightPool.position.set(-1.3,.145,5.1);model.add(lightPool);
const vendingPool=new T.Mesh(new T.PlaneGeometry(2.5,2),new T.MeshBasicMaterial({map:glowTx,color:0x82c9df,transparent:true,opacity:.3,depthWrite:false,blending:T.AdditiveBlending}));vendingPool.rotation.x=-Math.PI/2;vendingPool.position.set(-6.2,.15,4.7);model.add(vendingPool);
for(let i=0;i<35;i++){const m=new T.Mesh(new T.PlaneGeometry(.08+rand()*.7,.025+rand()*.07),sheen);m.rotation.x=-Math.PI/2;m.position.set(-5.6+rand()*8.4,.14,4.25+rand()*3.5);model.add(m)}
// Procedural rain streaks, wrapped around the base instead of infinite scenery.
const rainCount=small?600:1400,rainPos=new Float32Array(rainCount*6),rainSpeed=[];
for(let i=0;i<rainCount;i++){const x=-7.8+rand()*15.6,z=-7.8+rand()*15.6,y=.6+rand()*9;rainPos.set([x,y,z,x-.04,y+.23,z-.015],i*6);rainSpeed.push(5+rand()*5)}
const rainGeo=new T.BufferGeometry();rainGeo.setAttribute('position',new T.BufferAttribute(rainPos,3));const rain=new T.LineSegments(rainGeo,new T.LineBasicMaterial({color:0xaccbdb,transparent:true,opacity:.25,depthWrite:false}));model.add(rain);
// Raindrops on the front glass remain outside the shelves.
const glassDrops=[];for(let i=0;i<36;i++){const x=-5.5+rand()*8.1,z=1.89;const drop=segment([x,1+rand()*1.7,z],[x,1.06+rand()*1.7,z],.008,0xb9d8de);drop.scale.y=.15;glassDrops.push({mesh:drop,speed:.12+rand()*.2})}
const rippleGeo=new T.RingGeometry(.96,1,36);const ripples=[];
for(let i=0;i<(small?18:32);i++){const m=new T.MeshBasicMaterial({color:0xb7d5d6,transparent:true,opacity:.1,side:T.DoubleSide,depthWrite:false});const p=new T.Mesh(rippleGeo,m);p.rotation.x=-Math.PI/2;p.position.set(-7.1+rand()*14.2,.16,4.3+rand()*3.3);model.add(p);ripples.push({mesh:p,phase:rand()})}
const drips=[];for(let i=0;i<15;i++){const d=segment([-5.8+i*.61,2.8,2.5],[-5.8+i*.61,2.9,2.5],.009,0xc5d8de);drips.push({mesh:d,phase:rand()})}
// Merge static solid geometry and contour lines by material. Animated parts stay separate.
model.updateMatrixWorld(true);
const moving=new Set([...drips.map(d=>d.mesh),...glassDrops.map(d=>d.mesh)]);
const solidGroups=new Map(),lineParts=[];
model.traverse(o=>{
 if(o.isLineSegments&&o.material===ink){if(o.parent?.parent!==doorLeft&&o.parent?.parent!==doorRight)lineParts.push(o.geometry.clone().applyMatrix4(o.matrixWorld));return}
 if(!o.isMesh||o.isInstancedMesh||o.isReflector||o.material.transparent||moving.has(o)||o.parent===doorLeft||o.parent===doorRight)return;
 const group=solidGroups.get(o.material)||[];group.push(o);solidGroups.set(o.material,group);
});
const oldLines=[];model.traverse(o=>{if(o.isLineSegments&&o.material===ink&&o.parent?.parent!==doorLeft&&o.parent?.parent!==doorRight)oldLines.push(o)});oldLines.forEach(o=>o.removeFromParent());
if(lineParts.length)model.add(new T.LineSegments(mergeGeometries(lineParts),ink));
for(const [material,objects]of solidGroups){if(objects.length<2)continue;const pieces=objects.map(o=>o.geometry.clone().applyMatrix4(o.matrixWorld));const merged=mergeGeometries(pieces);if(merged){const m=new T.Mesh(merged,material);m.castShadow=true;m.receiveShadow=true;model.add(m);objects.forEach(o=>o.removeFromParent());pieces.forEach(g=>g.dispose())}}
// Deliberately quiet, no autoplay camera orbit and no audio.
let elapsed=0,last=performance.now(),paused=document.hidden,frames=0;
function resize(){const w=innerWidth,h=innerHeight,a=w/h,span=26.3/Math.min(a,1.45);camera.left=-span*a/2;camera.right=span*a/2;camera.top=span/2;camera.bottom=-span/2;camera.updateProjectionMatrix();renderer.setSize(w,h,false)}
addEventListener('resize',resize);resize();controls.update();
document.addEventListener('visibilitychange',()=>{paused=document.hidden;last=performance.now()});
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();paused=true});canvas.addEventListener('webglcontextrestored',()=>location.reload());
addEventListener('keydown',e=>{if(e.key==='Escape'&&history.length>1)history.back()});
function tick(now){requestAnimationFrame(tick);if(paused)return;const dt=Math.min((now-last)/1000,.04);last=now;elapsed+=dt;controls.update();
 if(!reduced){
  for(let i=0;i<rainCount;i++){const k=i*6;rainPos[k+1]-=rainSpeed[i]*dt;rainPos[k+4]-=rainSpeed[i]*dt;const inside=rainPos[k]>-5.9&&rainPos[k]<2.95&&rainPos[k+2]>-4.9&&rainPos[k+2]<2.5;if(rainPos[k+1]<(inside?3.9:.45)){rainPos[k+1]=9;rainPos[k+4]=9.23}}rainGeo.attributes.position.needsUpdate=true;
  for(const r of ripples){const phase=(elapsed*.55+r.phase)%1;r.mesh.scale.setScalar(.03+phase*.45);r.mesh.material.opacity=(1-phase)*.28}
  for(const d of drips)d.mesh.position.y=3.15-((elapsed*1.3+d.phase)%1)*2.6;
  for(const d of glassDrops){d.mesh.position.y-=d.speed*dt;if(d.mesh.position.y<.8)d.mesh.position.y=2.65}
  const cycle=elapsed%22,door=cycle>9&&cycle<14?Math.min(1,(cycle-9)*1.4,(14-cycle)*1.4):0;doorLeft.position.x=-.75-door*.86;doorRight.position.x=.34+door*.86;
  const flicker=Math.sin(elapsed*1.1)*.012+(elapsed%31>30.72?Math.sin(elapsed*90)*.09:0);shopSign.material.color.setScalar(1+flicker);warm.intensity=45*(1+flicker);
  const state=Math.floor(elapsed/13)%3;signal.forEach((m,i)=>m.emissiveIntensity=i===state?1.2:.08);
 }
 renderer.render(scene,camera);frames++;
}
requestAnimationFrame(tick);
// Read-only diagnostics for local verification; no controls are drawn on the scene.
Object.defineProperty(window,'rainyCorner',{value:{scene,camera,controls,renderer,model,get frames(){return frames},get elapsed(){return elapsed},get meshCount(){let n=0;scene.traverse(o=>{if(o.isMesh)n++});return n}},writable:false});
