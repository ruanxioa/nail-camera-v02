import {PoseFeed,clock,screenRotation,signGuide} from './pose.js';
import {WebCamera,containedRect} from './camera.js';
import {formShot,methods} from './records.js';
import {listShots,saveShot} from './storage.js';
import {Gallery,sizeText} from './gallery.js';

const $=id=>document.getElementById(id);
const camera=new WebCamera($('video')), pose=new PoseFeed(), volatile=new Map();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let busy=false,picker=null,returned=null,lastToast,lastDimensions=null,thumbnail=null,lastError='',lastDiag=0;
let lastPhotoKind='',storageError='';
const panel=$('panel');
function msg(text) {
  if (panel.open || panel.hasAttribute('open')) {$('panelMsg').textContent=text;return;}
  const box=$('toast');box.hidden=false;box.textContent=text;clearTimeout(lastToast);lastToast=setTimeout(()=>{box.hidden=true;},3900);
}
function open(page,title) {
  for (const id of ['settingsPage','detailPage','albumPage','confirmPage']) $(id).hidden=id!==page;
  $('panelTitle').textContent=title;$('panelMsg').textContent='';
  if (!panel.hasAttribute('open')) {if (panel.showModal) panel.showModal();else panel.setAttribute('open','');}
  panel.scrollTop=0;
}
function close() {
  if (returned) {void finishExternal('system-unconfirmed');return;}
  if (panel.close) panel.close();else panel.removeAttribute('open');
  gallery.release();$('panelMsg').textContent='';
}
$('closePanel').onclick=close;
panel.addEventListener('cancel',e=>{if(returned){e.preventDefault();void finishExternal('system-unconfirmed');}else gallery.release();});
function setBusy(value) {
  busy=value;for(const id of ['start','webMode','systemMode','importMode','lens','framing']) $(id).disabled=value;
  $('shutter').disabled=value || camera.track?.readyState!=='live';
}
function rect() {
  const stage=$('stage').getBoundingClientRect(), v=$('video');
  const fill=$('framing').value==='frame' || (camera.track && !camera.capture?.takePhoto);
  const r=containedRect(stage.width,stage.height,v.videoWidth,v.videoHeight,fill?'cover':'contain');
  return r ? {...r,gridEnabled:$('gridToggle').checked,crossFramePixel:{x:r.frameWidth/2,y:r.frameHeight/2},stageClientOrigin:{x:stage.x,y:stage.y},stageCssSize:{width:stage.width,height:stage.height},
    devicePixelRatio:window.devicePixelRatio,screenAngle:screenRotation(),videoMirrored:false,coordinateOrigin:'top-left; CSS px; full decoded preview'} : null;
}
function layout() {
  const r=rect(), guide=$('guides');guide.hidden=!r || !camera.track;
  if(r) {
    $('video').style.objectFit=r.fit;
    const g=r.guidesCssRect;
    Object.assign(guide.style,{left:g.x+'px',top:g.y+'px',width:g.width+'px',height:g.height+'px'});
  }
  const a=camera.track && r ? '预览 '+r.frameWidth+' × '+r.frameHeight : '预览待开启';
  $('resolution').textContent=a+(lastDimensions ? ' · 上张 '+lastPhotoKind+' '+sizeText(lastDimensions) : '');
}
window.addEventListener('resize',layout);window.addEventListener('orientationchange',()=>setTimeout(layout,150));
$('video').addEventListener('resize',layout);$('video').addEventListener('loadedmetadata',layout);
if (window.ResizeObserver) new ResizeObserver(layout).observe($('stage'));
function updateLenses() {
  const select=$('lens');select.replaceChildren(new Option('自动选后置',''));
  for(const d of camera.devices) if(d.id) select.add(new Option(d.alias+' '+(d.label||'名称未开放'),d.id));
  select.value=camera.track?.getSettings?.().deviceId||'';
}
function startPane(hint) {
  $('startPane').hidden=false;$('start').textContent='开启相机';$('startHint').textContent=hint||'弹出提示时，点「允许」';
  $('guides').hidden=true;layout();
}
async function startCamera(lens='') {
  if(busy) return;
  setBusy(true);lastError='';$('startHint').textContent='正在等相机，请留意权限提示';
  void pose.start();
  try {
    await camera.start(lens);$('startPane').hidden=true;updateLenses();layout();
    camera.track?.addEventListener('ended',()=>{if(!camera.track || camera.track.readyState==='ended'){
      camera.stop();startPane('相机已暂停，点上方按钮重新开启');setBusy(false);}});
    if (!camera.video.videoWidth) msg('相机已开启，等候第一帧');
  } catch(e) {
    lastError=e.name+' '+e.message;
    const hint=['NotAllowedError','SecurityError'].includes(e.name) ? '相机没有获准。点地址栏旁的网站设置，允许相机，或点下方「系统拍摄」。' : e.message;
    camera.stop();updateLenses();startPane(hint);msg(hint);
  } finally {setBusy(false);pose.refreshPermissions();}
}
$('start').onclick=()=>startCamera();
$('webMode').onclick=()=>camera.track ? msg('点下方白色圆钮拍照') : startCamera();
$('lens').onchange=()=>{const id=$('lens').value;close();void startCamera(id);};
$('enablePose').onclick=()=>{void pose.start().then(()=>msg(pose.state().reason));};
$('poseSource').onchange=()=>{pose.preferred=$('poseSource').value;lastDiag=0;renderPose();};
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement) await document.exitFullscreen();
  else if(document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
  else throw new Error('浏览器没有开放系统全屏，当前已占满网页可用区域');close();layout();}catch(e){msg(e.message);}};
$('gridToggle').onchange=()=>{$('grid').hidden=!$('gridToggle').checked;};
$('framing').onchange=()=>{layout();msg($('framing').value==='frame'?'铺满取景会保存完整视频帧，成片包括屏幕外的部分':'已优先保存静态原片');};
$('calibrate').onclick=()=>{try{pose.calibrate();msg('当前数据来源已校准');}catch(e){msg(e.message);}};
$('resetCal').onclick=()=>{pose.reset();msg('已清除本次校准');};
$('settings').onclick=()=>{open('settingsPage','设置与诊断');pose.refreshPermissions();lastDiag=0;renderPose();};
function format(n) {if (!Number.isFinite(n)) return '—';const s=Math.abs(n).toFixed(1);return (s==='0.0'?'':n>0?'+':'−')+s+'°';}
function renderPose() {
  const now=performance.now(), result=pose.state(now), a=result.angles;
  $('roll').textContent=format(a?.roll);$('pitch').textContent=format(a?.pitch);
  $('poseStatus').textContent=result.reason;$('poseStatus').dataset.state=result.status;
  const b=$('bubble');b.hidden=!a;
  if(a){
    const mag=Math.hypot(a.roll,a.pitch), gain=mag ? Math.min(38/mag,38/15) : 0;
    b.style.left=(50+a.roll*gain)+'%';b.style.top=(50-a.pitch*gain)+'%';b.classList.toggle('estimate',!result.valid);
  }
  if(panel.hasAttribute('open') && !$('settingsPage').hidden && now-lastDiag>450) {
    lastDiag=now;$('calState').textContent=result.calibration ? '当前来源已校准' : '当前来源未校准';
    if($('diag').open) {
      const d=pose.diagnostics(now);
      $('diagSummary').textContent=result.sourceLabel+' · '+result.reason+'。 '+signGuide;
      $('diagnostics').textContent=JSON.stringify({权限:pose.permissions,安全连接:window.isSecureContext,页面可见:!document.hidden,
        屏幕角度:screenRotation(),运动事件:{总数:d.motion.count,有效向量:d.motion.usable,最近频率Hz:d.motion.hz,末次距今ms:d.motion.ageMs,状态:d.motion.status,原始:d.motion.lastRaw},
        姿态事件:{总数:d.orientation.count,有效向量:d.orientation.usable,最近频率Hz:d.orientation.hz,末次距今ms:d.orientation.ageMs,状态:d.orientation.status,原始:d.orientation.lastRaw},
        独立重力接口:d.gravity,绝对姿态事件:d.absolute,当前来源:result.sourceLabel,有稳定读数:result.valid,当前原因:result.reason,最近相机失败:lastError||null,
        相机:camera.describe(),本地存储错误:storageError||null},null,2);
    }
  }
}
setInterval(()=>{if(!document.hidden) renderPose();},120);
async function allShots() {
  const ids=new Map();try {for(const s of await listShots()) ids.set(s.id,s);}catch(e){storageError=e.message;}
  for (const [id,s] of volatile) ids.set(id,s);
  return [...ids.values()].sort((a,b)=>b.createdAt-a.createdAt);
}
async function persist(shot) {
  try {await saveShot(shot);volatile.delete(shot.id);storageError='';return true;}
  catch(e){volatile.set(shot.id,shot);storageError=e.message;return false;}
}
const gallery=new Gallery({all:allShots,persist,open,msg});
$('album').onclick=()=>gallery.show().catch(e=>msg(e.message));
function updateLast(shot) {
  if(!shot) return;
  lastDimensions=shot.metadata.photo.encodedDimensions.value || shot.metadata.photo.displayDimensions.value;
  lastPhotoKind=({'image-capture-still':'静态','video-frame-png':'视频帧','system-confirmed':'系统','system-unconfirmed':'待确认'})[shot.metadata.method]||'导入';
  const previous=thumbnail;thumbnail=URL.createObjectURL(shot.photo);$('thumb').style.backgroundImage='url("'+thumbnail+'")';
  if(previous) URL.revokeObjectURL(previous);layout();
}
allShots().then(shots=>updateLast(shots[0]));
function makeId() {
  const id=crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('');
  return 'N02-'+id;
}
const before=at=>({pose:pose.state(at.perfMs),raw:pose.raw(at.perfMs-900,at.perfMs)});
function endpoint(at) {
  return {returnPose:pose.state(at.perfMs),nearCompletion:pose.raw(at.perfMs-450,at.perfMs)};
}
async function after(complete) {
  const end=complete.perfMs+650;
  await sleep(Math.max(0,end-performance.now()));
  return pose.raw(complete.perfMs,end);
}
async function finishRecord(data) {
  const it=await formShot({...data,id:makeId(),permissions:{...pose.permissions},
    windows:{beforeRequestMs:[data.begin.perfMs-900,data.begin.perfMs],nearCompletionMs:[data.complete.perfMs-450,data.complete.perfMs],
      afterCompletionMs:[data.complete.perfMs,data.complete.perfMs+650]}});
  const stored=await persist(it);updateLast(it);
  msg(stored ? '已存入相册 · '+methods[it.metadata.method]+' · '+sizeText(lastDimensions) : '本机存储失败，先到相册导出，关闭页面后会丢失');
}
$('shutter').onclick=async()=>{
  if(busy || !camera.track) return;
  setBusy(true);const action=clock(), info=camera.describe();msg('拍摄中…');
  try {
    const result=await camera.take(rect,at=>({...before(at),cameraAtRequest:camera.describe()}),$('framing').value==='frame'), end=endpoint(result.complete);
    const cameraInfo=result.context.cameraAtRequest || info;
    cameraInfo.settingsAtReturn=camera.describe()?.settings || null;
    await finishRecord({...result,...end,action,camera:cameraInfo,before:result.context,after:await after(result.complete)});
  } catch(e){lastError=e.name+' '+e.message;msg('拍摄失败 · '+e.message);if(!camera.track) startPane(e.message);}
  finally {setBusy(false);}
};
function openPicker(kind) {
  if (busy || returned) return;
  const input=$(kind==='system'?'systemInput':'fileInput'), at=clock();
  picker={kind,begin:at,before:kind==='system' ? before(at) : null,captureHintSupported:'capture' in input};
  if(kind==='system' && camera.track) { camera.stop();startPane('系统拍完后，可点这里重新开启网页相机');setBusy(false); }
  input.value='';
  try {input.click();}catch(e){picker=null;msg('浏览器未能打开'+(kind==='system'?'系统相机，请用原生相机拍摄后点「导入原图」':'文件选择器'));}
}
$('systemMode').onclick=()=>openPicker('system');$('importMode').onclick=()=>openPicker('import');
for(const [id,kind] of [['systemInput','system'],['fileInput','import']]) {
  const input=$(id);
  input.addEventListener('cancel',()=>{picker=null;msg('已取消');});
  input.addEventListener('change',()=>{
    const file=input.files?.[0], context=picker;picker=null;
    if(!file || !context || context.kind!==kind) {msg('未收到文件');return;}
    const at=clock(), ends=kind==='system' ? endpoint(at) : {returnPose:null,nearCompletion:[]};
    setBusy(true);returned={context,file,at,ends,post:kind==='system' ? after(at) : Promise.resolve([])};
    if (kind==='system') open('confirmPage','确认拍摄来源');
    else void finishExternal('native-import');
  });
}
async function finishExternal(method) {
  const item=returned;if(!item) return;returned=null;close();
  const {context,file,at,ends,post}=item;
  try {
    await finishRecord({blob:file,method,action:context.begin,begin:context.begin,complete:at,before:context.before,...ends,after:await post,
      reason:methods[method],external:{requested:context.kind,captureHintProperty:context.captureHintSupported,
        systemLaunch:method==='system-confirmed'?'用户确认打开相机并新拍':method==='gallery-from-system'?'只打开了相册':
          method==='native-import'?'已有文件，拍摄设备以 EXIF 为准':'未确认',exposurePoseUnavailable:true}});
    if(method==='gallery-from-system') msg('这个浏览器只打开了相册，已按已有照片保存');
  } catch(e){msg('保存文件失败 · '+e.message);}finally {setBusy(false);}
}
$('wasCamera').onclick=()=>finishExternal('system-confirmed');
$('wasGallery').onclick=()=>finishExternal('gallery-from-system');
$('wasUnknown').onclick=()=>finishExternal('system-unconfirmed');
window.addEventListener('pagehide',()=>{camera.stop();if(thumbnail) URL.revokeObjectURL(thumbnail);});
window.addEventListener('pageshow',e=>{if(e.persisted){startPane();setBusy(false);allShots().then(s=>updateLast(s[0]));}});
renderPose();layout();
