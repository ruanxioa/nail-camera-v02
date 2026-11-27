import {clock} from './pose.js';
import {evidence} from './photo.js';

const rear = name => /back|rear|environment|后置|背面/i.test(name || '');
const front = name => /front|user[- ]?facing|前置|前摄|自拍/i.test(name || '');
const main = name => /主摄|主镜头|\bmain\b|primary|(?:^|\s)1[.0]*[×x](?:\s|$)/i.test(name || '') && !/超广|长焦|ultra|tele|macro|微距/i.test(name || '');
const errorText = e => [e.name,e.message].filter(Boolean).join(' · ');
const dims = s => s?.width && s?.height ? {width:s.width,height:s.height} : null;
const area = s => (s?.width || 0)*(s?.height || 0);
const failAfter = (ms, text) => { const e = new Error(text); e.name='TimeoutError'; return e; };
async function deadline(promise, ms, message) {
  let id;
  try { return await Promise.race([promise,new Promise((_,reject)=>{id=setTimeout(()=>reject(failAfter(ms,message)),ms);})]); }
  finally { clearTimeout(id); }
}
const allowedTrackKeys=new Set(('deviceId width height aspectRatio frameRate facingMode resizeMode zoom pan tilt torch focusMode focusDistance pointsOfInterest exposureMode exposureTime exposureCompensation iso whiteBalanceMode colorTemperature brightness contrast saturation sharpness backgroundBlur focalLength fieldOfView principalPoint distortionCoefficients effectivePixelWidth effectivePixelHeight advanced').split(' '));
function trackValues(obj,aliases) {
  return safe(Object.fromEntries(Object.entries(obj).filter(([k])=>allowedTrackKeys.has(k))),aliases);
}
function safe(obj, aliases) {
  if (Array.isArray(obj)) return obj.map(v=>safe(v,aliases));
  if (!obj || typeof obj !== 'object') return obj;
  const result={};
  for (const [k,v] of Object.entries(obj)) {
    if (k==='groupId' || /serial|gps|latitude|longitude/i.test(k)) continue;
    if (k==='deviceId') {result.deviceSelection=typeof v==='string' ? aliases.get(v) || '本机会话镜头' : '指定本机会话镜头'; continue;}
    result[k]=safe(v,aliases);
  }
  return result;
}
function get(track,method) {try{return track?.[method]?.() || {};}catch{return {};}}
export function cameraParameters(settings,caps,label,devices) {
  return {
    label:evidence(label || null,'浏览器接口实读'), facingMode:evidence(settings.facingMode,'浏览器接口实读'),
    cameras:evidence(devices,'浏览器接口实读'), preview:evidence(dims(settings),'浏览器接口实读','getSettings'),
    widthRange:evidence(caps.width,'浏览器接口实读','范围的两端不能证明宽高任意组合可用'),
    heightRange:evidence(caps.height,'浏览器接口实读'), frameRate:evidence(settings.frameRate,'浏览器接口实读'),
    zoom:evidence(settings.zoom,'浏览器接口实读','逻辑镜头报告的倍率'), zoomRange:evidence(caps.zoom,'浏览器接口实读'),
    focusMode:evidence(settings.focusMode,'浏览器接口实读'), focusModes:evidence(caps.focusMode,'浏览器接口实读'),
    focusDistance:evidence(settings.focusDistance,'浏览器接口实读','MediaTrackSettings.focusDistance，通常以米表示；不是镜头焦距'),
    focusDistanceRange:evidence(caps.focusDistance,'浏览器接口实读'),
    focalLength:evidence(settings.focalLength,'浏览器接口实读','仅记录设备实际返回的同名属性，单位按设备定义'),
    fieldOfView:evidence(settings.fieldOfView,'浏览器接口实读','仅当设备明确返回'),
    principalPoint:evidence(settings.principalPoint,'浏览器接口实读','未做相机标定'),
    distortion:evidence(settings.distortionCoefficients,'浏览器接口实读','未做相机标定')
  };
}
export function containedRect(width,height,frameWidth,frameHeight,fit='contain') {
  if (![width,height,frameWidth,frameHeight].every(n=>Number.isFinite(n)&&n>0)) return null;
  const scale=(fit==='cover'?Math.max:Math.min)(width/frameWidth,height/frameHeight);
  const w=frameWidth*scale,h=frameHeight*scale,x=(width-w)/2,y=(height-h)/2;
  const visibleFrame={left:Math.max(0,-x/scale),top:Math.max(0,-y/scale),width:Math.min(frameWidth,width/scale),height:Math.min(frameHeight,height/scale)};
  const guidesCssRect={x:Math.max(0,x),y:Math.max(0,y),width:Math.min(width,w),height:Math.min(height,h)};
  const gridFrameX=[1/3,2/3].map(f=>visibleFrame.left+visibleFrame.width*f);
  const gridFrameY=[1/3,2/3].map(f=>visibleFrame.top+visibleFrame.height*f);
  return {x,y,width:w,height:h,frameWidth,frameHeight,scale,fit,visibleFrame,guidesCssRect,gridFrameX,gridFrameY,
    croppedPixels:Math.max(0,Math.round(frameWidth*frameHeight-visibleFrame.width*visibleFrame.height)),
    frameToStageCss:[scale,0,0,scale,x,y],stageCssToFrame:[1/scale,0,0,1/scale,-x/scale,-y/scale]};
}
export function previewRelation(method,rect) {
  if (!rect) return {rect:null,photoFromPreview:null,reason:'没有属于此次采集的网页预览'};
  return {rect,photoFromPreview:method==='video-frame-png' ? [1,0,0,1,0,0] : null,
    reason:method==='video-frame-png' ? '截图采用该帧原始像素；预览画布坐标的逆变换见 rect' :
      '网页预览完整呈现；静态照片的视场、方向、裁切及畸变可能不同，浏览器未提供二者的配准'};
}
export class WebCamera {
  constructor(video) {
    this.video=video; this.stream=null; this.aliases=new Map(); this.devices=[]; this.attempts=[]; this.listError=null;
  }
  get track() {return this.stream?.getVideoTracks()[0] || null;}
  async enumerate() {
    try {
      const list=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');
      this.devices=list.map(d=>{
        if (!this.aliases.has(d.deviceId)) this.aliases.set(d.deviceId,'镜头 '+(this.aliases.size+1));
        return {id:d.deviceId, alias:this.aliases.get(d.deviceId), label:d.label||null};
      });
      this.listError=null;
    } catch (e) {this.listError=errorText(e);}
    return this.devices;
  }
  publicDevices() {return this.devices.map(({alias,label})=>({alias,label}));}
  stop() {
    for (const t of this.stream?.getTracks() || []) t.stop();
    this.stream=null; this.video.srcObject=null;
  }
  async start(chosen='',isRetry=false) {
    if (!globalThis.isSecureContext) throw new Error('请用 HTTPS 在浏览器打开本页');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('这个浏览器没有开放网页相机，可用系统拍摄或导入');
    this.stop(); if (!isRetry) this.attempts=[];
    this.photoCaps=null; this.photoCapsError=null;this.photoSettings=null;this.photoSettingsError=null;
    const supported=navigator.mediaDevices.getSupportedConstraints?.() || {};
    const target={width:{ideal:3840},height:{ideal:2160}};
    if (supported.resizeMode) target.resizeMode={ideal:'none'};
    const known=this.devices.find(d=>d.id===chosen);
    if (known && front(known.label)) throw new Error('请选一个后置镜头');
    const candidates=chosen ? [{deviceId:{exact:chosen},...target}] :
      [{facingMode:{exact:'environment'},...target},{facingMode:{ideal:'environment'},...target}];
    let last;
    for (const video of candidates) {
      const attempt={action:'getUserMedia',constraints:safe(video,this.aliases)}; this.attempts.push(attempt);
      try {
        this.stream=await navigator.mediaDevices.getUserMedia({audio:false,video});
        attempt.actual=dims(get(this.track,'getSettings')); attempt.ok=true;break;
      } catch(e) {last=e;attempt.error=errorText(e);if (['NotAllowedError','SecurityError'].includes(e.name)) throw e;}
    }
    if (!this.stream) throw last || new Error('无法开启后置相机');
    try {
      const t=this.track, settings=get(t,'getSettings');
      await this.enumerate();
      if (settings.facingMode==='user' || front(t.label)) throw new Error('浏览器选中了前置相机，请在设置中选择后置镜头');
      if (chosen && settings.deviceId && settings.deviceId!==chosen) throw new Error('实际镜头与所选镜头不符');
      const better=!chosen && this.devices.find(d=>d.id && main(d.label) && !front(d.label) && (rear(d.label) || /主摄/.test(d.label)));
      if (better && better.id!==settings.deviceId) {
        try {return await this.start(better.id,true);}
        catch(e) {this.attempts.push({action:'preferMain',error:errorText(e)}); if (settings.deviceId) return await this.start(settings.deviceId,true); throw e;}
      }
      this.lensDescription=chosen ? '请求所选镜头 deviceId exact' : '浏览器选择后置镜头';
      this.rearEvidence=settings.facingMode || (rear(t.label) ? '后置（据镜头名称）' :
        this.attempts.find(a=>a.action==='getUserMedia' && a.ok && a.constraints?.facingMode?.exact==='environment') ? '后置（严格约束已接受）' : '朝向未报告，请目视确认');
      let base=get(t,'getConstraints');
      const caps=get(t,'getCapabilities');
      if (settings.deviceId && supported.deviceId) {
        const pin={...base,deviceId:{exact:settings.deviceId}};
        if (await this.apply(t,pin,'lockLens')) {base=pin;this.lensDescription='已提交指定镜头约束；系统内部光学切换不可观测';}
      }
      const w=caps.width?.max,h=caps.height?.max;
      if (Number.isFinite(w) && Number.isFinite(h) && w*h>area(settings)) {
        const high={...base,width:{ideal:w},height:{ideal:h}};
        if (await this.apply(t,high,'tryLargerPreview')) {
          if (area(get(t,'getSettings'))<area(settings)) await this.apply(t,base,'restoreLargerResult');
          else base=high;
        }
      }
      const adv=[];
      if (caps.zoom && caps.zoom.min<=1 && caps.zoom.max>=1) adv.push({zoom:1});
      if (caps.focusMode?.includes('continuous')) adv.push({focusMode:'continuous'});
      if (adv.length) await this.apply(t,{...base,advanced:[...(base.advanced||[]),...adv]},'oneTimesAndFocus');
      this.capture=null;
      if (typeof ImageCapture==='function') {
        try {this.capture=new ImageCapture(t);}catch(e){this.photoCapsError=errorText(e);}
      }
      this.video.srcObject=this.stream;
      await deadline(this.video.play(),12000,'预览没有开始，请重新开启相机');
      if(this.capture?.getPhotoCapabilities) {
        try {
          const pc=await deadline(this.capture.getPhotoCapabilities(),2500,'读取静态照片能力超时');
          this.photoCaps={imageWidth:pc.imageWidth ? {...pc.imageWidth} : null,imageHeight:pc.imageHeight ? {...pc.imageHeight} : null,
            fillLightMode:pc.fillLightMode ?? null,redEyeReduction:pc.redEyeReduction ?? null};
        } catch(e){this.photoCapsError=errorText(e);}
      }
      if(this.capture?.getPhotoSettings) {
        try {
          const p=await deadline(this.capture.getPhotoSettings(),1800,'读取静态照片设置超时');
          this.photoSettings={imageWidth:p.imageWidth??null,imageHeight:p.imageHeight??null,
            fillLightMode:p.fillLightMode??null,redEyeReduction:p.redEyeReduction??null};
        } catch(e){this.photoSettingsError=errorText(e);}
      }
      return this.describe();
    } catch(e){this.stop();throw e;}
  }
  async apply(track,constraints,action) {
    const entry={action,constraints:safe(constraints,this.aliases)};
    this.attempts.push(entry);
    try {await track.applyConstraints(constraints);entry.ok=true;entry.actual=trackValues(get(track,'getSettings'),this.aliases);return true;}
    catch(e) {entry.ok=false;entry.error=errorText(e);return false;}
  }
  describe() {
    const t=this.track;if (!t) return null;
    const s=get(t,'getSettings'), c=get(t,'getCapabilities');
    return {source:'浏览器接口实读',label:t.label || null,availableDevices:this.publicDevices(),enumerationError:this.listError,
      settings:trackValues(s,this.aliases),capabilities:trackValues(c,this.aliases),constraints:trackValues(get(t,'getConstraints'),this.aliases),
      requests:JSON.parse(JSON.stringify(this.attempts)),requestedPreview:{width:3840,height:2160,mode:'ideal'},
      actualVideoDimensions:this.video.videoWidth ? {width:this.video.videoWidth,height:this.video.videoHeight} : null,
      photoCapabilities:this.photoCaps,photoCapabilitiesError:this.photoCapsError,initialPhotoSettings:this.photoSettings,
      initialPhotoSettingsError:this.photoSettingsError,hasTakePhoto:typeof this.capture?.takePhoto==='function',
      zoomOneConfirmed:s.zoom===1, lensSelection:this.lensDescription, rearEvidence:this.rearEvidence,
      parameters:cameraParameters(s,c,t.label,this.publicDevices())};
  }
  async take(getGeometry,onAttempt=()=>{},frameRequested=false) {
    if (!this.track || this.track.readyState!=='live') throw new Error('相机已关闭，请先开启相机');
    const tries=[];
    if (this.capture?.takePhoto && !frameRequested) {
      const w=this.photoCaps?.imageWidth?.max,h=this.photoCaps?.imageHeight?.max;
      const options=[];
      if (w>0 && h>0) options.push({imageWidth:w,imageHeight:h});
      if (w>0) options.push({imageWidth:w});
      if (h>0) options.push({imageHeight:h});
      options.push({});
      for (const settings of options) {
        const geometry=getGeometry(), begin=clock();
        const record={settings,request:begin}; tries.push(record);
        try {
          const pending=this.capture.takePhoto(settings), context=onAttempt(begin);
          const blob=await deadline(pending,15000,'静态拍照超时，请重新开启相机');
          record.complete=clock(); if (!blob || !blob.size) throw new Error('相机返回空照片');
          record.ok=true;
          return {blob,method:'image-capture-still',begin,complete:record.complete,context,tries,geometry,
            frameInfo:null,reason:'ImageCapture.takePhoto 返回文件'};
        } catch(e) {
          record.error=errorText(e);record.complete=clock();
          if (e.name==='TimeoutError') {this.stop();throw e;}
        }
      }
    }
    const video=this.video;
    if (video.readyState<2 || !video.videoWidth || !video.videoHeight) throw new Error('没有可保存的视频画面，请重开相机');
    const geometry=getGeometry(), canvas=document.createElement('canvas');
    canvas.width=video.videoWidth;canvas.height=video.videoHeight;
    const surface=canvas.getContext('2d',{alpha:false}), videoElementTimeAtCopySec=video.currentTime;
    const begin=clock();surface.drawImage(video,0,0);
    const copied=clock(), context=onAttempt(begin);
    const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b ? resolve(b) : reject(new Error('画面保存失败')),'image/png'));
    return {blob,method:'video-frame-png',begin,complete:clock(),context,tries,geometry,
      frameInfo:{copyStart:begin,copyComplete:copied,width:canvas.width,height:canvas.height,videoElementTimeAtCopySec},
      reason:frameRequested ? '用户指定满屏视频取景；保存整个原尺寸视频帧及可见区域映射' : this.capture?.takePhoto ? '静态接口请求均失败；保存当时视频帧的原尺寸 PNG' : '浏览器未开放静态接口；保存当时视频帧的原尺寸 PNG'};
  }
}
