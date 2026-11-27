import test from 'node:test';
import assert from 'node:assert/strict';
import {PoseFeed,orientationGravity} from '../docs/pose.js';
import {SensorEngine,toScreenVector,anglesFromGravity} from '../docs/sensor.js';
import {WebCamera,containedRect,previewRelation,cameraParameters} from '../docs/camera.js';
import {formShot,areaFromPoints} from '../docs/records.js';
import {readHeaders,inspectPhoto} from '../docs/photo.js';
import {sha256} from '../docs/storage.js';

function jpegFixture(little) {
  const bytes=new Uint8Array(440), v=new DataView(bytes.buffer), at=8, sub=80;
  v.setUint16(0,little?0x4949:0x4d4d);v.setUint16(2,42,little);v.setUint32(4,at,little);
  function ifd(offset,fields) {
    v.setUint16(offset,fields.length,little);
    fields.forEach(([id,type,n,inline],i)=>{
      const p=offset+2+i*12;
      v.setUint16(p,id,little);v.setUint16(p+2,type,little);v.setUint32(p+4,n,little);
      if(type===3 && n===1) v.setUint16(p+8,inline,little);else v.setUint32(p+8,inline,little);
    });
  }
  ifd(at,[[0x010f,2,7,250],[0x0112,3,1,6],[0x8769,4,1,sub],[0x8825,4,1,360]]);
  ifd(sub,[[0x920a,5,1,280],[0xa405,3,1,24],[0xa404,5,1,288],[0x829a,5,1,296],
    [0x8827,3,1,64],[0x829d,5,1,304],[0x9003,2,20,320],[0xa434,2,7,344],[0xa002,4,1,4000],[0xa003,4,1,3000]]);
  bytes.set(new TextEncoder().encode('Sample\0'),250);
  bytes.set(new TextEncoder().encode('2026:11:27 12:13:14\0'),320);
  bytes.set(new TextEncoder().encode('Lens-A\0'),344);
  for(const [p,n,d] of [[280,59,10],[288,0,1],[296,1,100],[304,18,10]]) {v.setUint32(p,n,little);v.setUint32(p+4,d,little);}
  ifd(360,[[0x0110,2,7,390]]);bytes.set(new TextEncoder().encode('SECRET\0'),390);
  const len=bytes.length+8;
  return Uint8Array.from([255,216,255,225,len>>8,len&255,69,120,105,102,0,0,...bytes,
    255,192,0,11,8,0x0b,0xb8,0x0f,0xa0,1,1,17,0,255,217]);
}
for (const little of [true,false]) test('TIFF endian '+little+' whitelisted EXIF, orientation, unknowns and exact file bytes',async()=>{
  const bytes=jpegFixture(little),blob=new Blob([bytes],{type:'image/jpeg'}),data=await inspectPhoto(blob),f=data.exif;
  assert.deepEqual(data.encodedDimensions.value,{width:4000,height:3000});assert.deepEqual(data.displayDimensions.value,{width:3000,height:4000});
  assert.equal(f.make.value,'Sample');assert.equal(f.lensModel.value,'Lens-A');assert.equal(f.model.value,null);assert.equal(f.model.source,'无法获取');
  assert.equal(f.focalLengthMm.value,5.9);assert.equal(f.equivalent35mm.value,24);assert.equal(f.digitalZoomRatio.value,0);
  assert.equal(f.exposureTimeSec.value,.01);assert.equal(f.iso.value,64);assert.equal(f.fNumber.value,1.8);assert.equal(f.dateTimeOriginal.source,'照片EXIF实读');
  assert.equal(JSON.stringify(data).includes('SECRET'),false);assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),bytes);
});
test('truncated or out-of-bounds JPEG tags do not throw or invent parameters',()=>{
  const bytes=jpegFixture(true); for(let i=0;i<bytes.length;i+=7) assert.doesNotThrow(()=>readHeaders(bytes.slice(0,i)));
  bytes.fill(255,16,20);const file=readHeaders(bytes);assert.equal(file.exif.focalLengthMm.value,null);
  const unknown=readHeaders(new Uint8Array([1,2,3]));assert.equal(unknown.dimensions,null);assert.equal(unknown.format,null);
});
const g=9.80665, rad=Math.PI/180, near=(x,y)=>assert.ok(Math.abs(x-y)<1e-7,x+' vs '+y);
const directions=[[0,0],[0,17],[0,-17],[-23,0],[23,0],[12,-18]];
test('physically constructed fused attitudes: six poses at every screen orientation',()=>{
  for (const screenAngle of [0,90,180,270]) for(const [roll,pitch] of directions) {
    const x=-Math.sin(roll*rad),y=-Math.sin(pitch*rad),z=Math.sqrt(1-x*x-y*y);
    const v=toScreenVector({x,y,z},360-screenAngle),beta=Math.asin(v.y)/rad,gamma=Math.atan2(-v.x,v.z)/rad;
    const got=anglesFromGravity(orientationGravity(beta,gamma),screenAngle);near(got.roll,roll);near(got.pitch,pitch);
  }
  assert.equal(orientationGravity(null,0),null);assert.equal(orientationGravity(720,0),null);
});
function emit(feed,k,t,evt) {feed.ingest(k,evt,{perfMs:t,wallIso:'2026-11-27T01:02:03.000Z'},0);}
test('fusion fallback & priority; relative-only never claims an independently confirmed horizontal reference',()=>{
  const f=new PoseFeed();const o={alpha:0,beta:-17,gamma:0,absolute:false};
  for(let t=0;t<=1600;t+=20) emit(f,'orientation',t,o);
  assert.equal(f.state(1600,0).status,'relative-estimate');near(f.state(1600,0).angles.pitch,17);
  for(let t=1620;t<=2520;t+=20) emit(f,'absolute',t,{...o,absolute:true});
  assert.equal(f.state(2520,0).source,'absolute');assert.equal(f.state(2520,0).valid,true);
  const v=orientationGravity(-17,0);
  for(let t=2540;t<=3440;t+=20) {emit(f,'motion',t,{accelerationIncludingGravity:v});emit(f,'gravity',t+1,v);}
  assert.equal(f.state(3442,0).source,'gravity');assert.equal(f.state(4000,0).angles,null);
  assert.ok(f.raw(3400,3442).some(s=>s.source==='gravity'));assert.ok(f.raw(3400,3442).some(s=>s.source==='motion'));
});
test('opposing sources and independent movement flags never yield a stable measurement',()=>{
  const f=new PoseFeed();
  for(let t=0;t<=1600;t+=20){emit(f,'gravity',t,{x:0,y:0,z:g});emit(f,'motion',t,{accelerationIncludingGravity:orientationGravity(0,19)});}
  assert.equal(f.state(1600,0).status,'disagreement');assert.equal(f.state(1600,0).valid,false);
});
test('live filter follows a changing tilt by 200ms; dropout never freezes last value',()=>{
  const e=new SensorEngine();for(let t=0;t<=1200;t+=20) e.ingest({receivedPerfMs:t,screenAngle:0,accelerationIncludingGravity:orientationGravity(t>1000?-20:0,0)});
  const s=e.snapshot(1200);assert.equal(s.valid,false);assert.ok(s.angles.pitch>16 && s.angles.pitch<20);assert.equal(e.snapshot(1900).angles,null);
});
test('letterboxing maps guides and center to image coordinates for portrait, landscape and odd sizes',()=>{
  for (const [w,h,fw,fh] of [[393,852,1080,1920],[800,400,3840,2160],[360,723,640,480]]) {
    const r=containedRect(w,h,fw,fh);near(r.width/r.height,fw/fh);near(r.x+r.width/2,w/2);near(r.y+r.height/2,h/2);
    const [s,,,sy,tx,ty]=r.stageCssToFrame;near((r.x+r.width/3)*s+tx,fw/3);near((r.y+2*r.height/3)*sy+ty,2*fh/3);
    assert.deepEqual(previewRelation('video-frame-png',r).photoFromPreview,[1,0,0,1,0,0]);
    assert.equal(previewRelation('image-capture-still',r).photoFromPreview,null);
  }
  const cover=containedRect(393,852,640,480,'cover');
  assert.ok(cover.x<0 && cover.visibleFrame.left>0 && cover.croppedPixels>0);
  near(cover.gridFrameX[0],cover.stageCssToFrame[0]*131+cover.stageCssToFrame[4]);
  assert.deepEqual(cover.guidesCssRect,{x:0,y:0,width:393,height:852});
  assert.equal(containedRect(0,800,4,3),null);
});
test('takePhoto requests max, retries width then default, keeps returned Blob and final attempt clocks',async()=>{
  const cam=new WebCamera({});cam.stream={getVideoTracks:()=>[{readyState:'live'}]};cam.photoCaps={imageWidth:{max:8128},imageHeight:{max:6096}};
  const blob=new Blob([jpegFixture(true)]),called=[];
  cam.capture={takePhoto:async o=>{called.push(o);if(Object.keys(o).length) throw new Error('Unsupported combination');return blob;}};
  const snap=await cam.take(()=>({marker:'pre'}),at=>at.perfMs);
  assert.equal(snap.blob,blob);assert.deepEqual(called,[{imageWidth:8128,imageHeight:6096},{imageWidth:8128},{imageHeight:6096},{}]);
  assert.equal(snap.method,'image-capture-still');assert.equal(snap.context,snap.begin.perfMs);assert.ok(snap.tries[0].error);
});
test('focus distance and focal length remain distinct and missing intrinsics are null',()=>{
  const p=cameraParameters({focusDistance:.2,zoom:1},{width:{min:320,max:4096}},'example',[]);
  assert.equal(p.focusDistance.value,.2);assert.equal(p.focalLength.value,null);assert.equal(p.principalPoint.source,'无法获取');
  assert.equal(p.zoom.source,'浏览器接口实读');assert.equal(p.widthRange.value.max,4096);
});
const at={perfMs:300,wallIso:'2026-11-27T03:00:00.000Z',timeOriginMs:1000},end={...at,perfMs:460};
for(const method of ['image-capture-still','video-frame-png','system-confirmed','system-unconfirmed','gallery-from-system','native-import']) {
  test('sidecar provenance, bytes and exposure honesty for '+method,async()=>{
    const photo=new Blob([jpegFixture(true)],{type:'image/jpeg'});
    const shot=await formShot({id:'unit',blob:photo,action:at,begin:at,complete:end,method,geometry:{width:300},
      before:{raw:[{receivedPerfMs:296}],pose:{angles:{roll:3,pitch:1},status:'moving',valid:false}},camera:{hasTakePhoto:true}});
    const m=shot.metadata,web=['image-capture-still','video-frame-png'].includes(method);
    assert.equal(m.photo.sha256,await sha256(photo));assert.equal(m.photo.filename,'unit.jpg');
    assert.equal(m.timing.synchronized,false);assert.equal(m.timing.exposureInstant,null);assert.equal(m.timing.uncertaintyMs,null);
    assert.equal(m.posture.atExposure,null);assert.equal(m.timing.browserOperationMs,160);
    assert.equal(!!m.camera,web);assert.equal(!!m.posture.atRequest,web);assert.equal(!!m.preview.rect,web);
  });
}
test('non-JPEG original remains exportable and unknown encoding is labeled',async()=>{
  const blob=new File([Uint8Array.of(3,1,1)],'test.heic',{type:'image/heic'});
  const m=await inspectPhoto(blob);assert.equal(m.extension,'heic');assert.equal(m.encodedDimensions.value,null);assert.equal(m.exif.iso.value,null);
});
test('manual image area is normalized to the original pixel grid',()=>{
  assert.equal(areaFromPoints([{x:0,y:0},{x:.5,y:0},{x:.5,y:.5},{x:0,y:.5}],{width:4000,height:3000}),3000000);
  assert.equal(areaFromPoints([],{width:4000,height:3000}),null);
});
