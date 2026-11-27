/* Run in a disposable desktop Chromium process. Hardware, sensor and system picker responses are simulated. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const {chromium}=await import(process.env.QA_PLAYWRIGHT ? pathToFileURL(process.env.QA_PLAYWRIGHT).href : 'playwright-core');
const dir=fileURLToPath(new URL('../docs/',import.meta.url)), out=process.env.QA_OUTPUT;
if(out) await mkdir(out,{recursive:true});
const server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  if(!/^[a-zA-Z0-9.-]+$/.test(name)){res.writeHead(404).end();return;}
  try {const body=await readFile(path.join(dir,name));res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(body);}
  catch {res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port+'/';
const browser=await chromium.launch({executablePath:process.env.QA_CHROME,headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
const passed=[],errors=[];
function pass(s){passed.push(s);console.log('PASS',s);}
async function getShots(page){return page.evaluate(async()=>{const {listShots}=await import('./storage.js');return (await listShots()).map(s=>s.metadata);});}
async function count(page,n){
  const limit=Date.now()+18000;
  while(Date.now()<limit) {if((await getShots(page)).length===n) return;await page.waitForTimeout(100);}
  throw new Error('Expected '+n+' saved records. '+await page.locator('#toast').innerText());
}
try {
  const ctx=await browser.newContext({viewport:{width:393,height:852},deviceScaleFactor:2.75,isMobile:true,hasTouch:true,acceptDownloads:true});
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(9000);
  await page.addInitScript(()=>{
    const props=(node,vals)=>Object.entries(vals).forEach(([k,v])=>Object.defineProperty(node,k,{configurable:true,value:v}));
    props(window,{GravitySensor:undefined});
    window.testConfig={method:'still',tilt:0,noEvents:false,skipMotion:false,denied:false};
    const cfg=window.testConfig;
    let testImage;
    window.testPhoto=async()=>{
      if (testImage) return testImage;
      const c=document.createElement('canvas');c.width=800;c.height=600;
      const g=c.getContext('2d');g.fillStyle='#babcb6';g.fillRect(0,0,c.width,c.height);
      g.fillStyle='#775032';g.fillRect(255,80,210,430);g.fillStyle='#e5d6ce';g.fillRect(275,100,170,260);
      const jpeg=await new Promise(r=>c.toBlob(r,'image/jpeg',.91));
      // A real encoded JPEG with a minimal little-endian IFD0 Orientation=6.
      const bytes=new Uint8Array(await jpeg.arrayBuffer());
      const exif=Uint8Array.from([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
      testImage=new Blob([bytes.slice(0,2),exif,bytes.slice(2)],{type:'image/jpeg'});return testImage;
    };
    const v={width:640,height:480,facingMode:'environment',deviceId:'only-in-this-session',groupId:'must-not-export',zoom:1,frameRate:25,focusMode:'continuous',focusDistance:.1};
    const limits={width:{min:320,max:4096},height:{min:240,max:3072},zoom:{min:1,max:4},focusMode:['continuous']};
    props(navigator.mediaDevices,{
      getSupportedConstraints:()=>({facingMode:true,deviceId:true,resizeMode:true}),
      enumerateDevices:async()=>[{kind:'videoinput',deviceId:v.deviceId,label:'rear main test camera'}],
      getUserMedia:async({video})=>{
        if(cfg.denied) throw new DOMException('拒绝','NotAllowedError');
        const c=document.createElement('canvas');v.width=cfg.portrait?360:640;v.height=cfg.portrait?640:480;
        c.width=v.width;c.height=v.height;const gc=c.getContext('2d');
        function frame(){gc.fillStyle='#748478';gc.fillRect(0,0,c.width,c.height);gc.fillStyle='#ede5d5';gc.fillRect(c.width/2-50,c.height/2-120,95,170);}
        frame();const stream=c.captureStream(25), track=stream.getVideoTracks()[0];
        let constraints=video;props(track,{getSettings:()=>v,getCapabilities:()=>limits,getConstraints:()=>constraints,
          applyConstraints:async c=>{constraints=c;}});
        const timer=setInterval(frame,60), stop=track.stop.bind(track);props(track,{stop:()=>{clearInterval(timer);stop();}});
        return stream;
      }});
    props(window,{ImageCapture:class {
      async getPhotoCapabilities(){return {imageWidth:{min:320,max:800},imageHeight:{min:240,max:600}};}
      async takePhoto(options){if(cfg.method!=='still') throw new DOMException('静态接口不支持','NotSupportedError');
        if(options.imageWidth!==800 || options.imageHeight!==600) throw new Error('incorrect request');
        return window.testPhoto();}
    }});
    const emit=(type,data)=>{const event=new Event(type);props(event,data);window.dispatchEvent(event);};
    setInterval(()=>{
      if(cfg.noEvents)return;
      const degrees=cfg.tilt, r=degrees*Math.PI/180;
      if(!cfg.skipMotion) emit('devicemotion',{accelerationIncludingGravity:{x:-Math.sin(r)*9.80665,y:0,z:Math.cos(r)*9.80665},acceleration:{x:0,y:0,z:0},rotationRate:{alpha:0,beta:0,gamma:0},interval:25});
      emit('deviceorientation',{alpha:0,beta:0,gamma:degrees,absolute:true});
    },25);
  });
  await page.goto(base);await page.getByRole('button',{name:'开启相机',exact:true}).click();
  await page.waitForFunction(()=>!document.getElementById('shutter').disabled);
  await page.waitForFunction(()=>document.getElementById('poseStatus').dataset.state==='ready');
  assert.equal(await page.locator('#roll').innerText(),'0.0°');
  await page.evaluate(()=>{window.testConfig.tilt=16;});
  await page.waitForFunction(()=>document.getElementById('poseStatus').dataset.state==='moving' && document.getElementById('roll').textContent.includes('°'));
  await page.waitForFunction(()=>document.getElementById('roll').textContent==='+16.0°' && document.getElementById('poseStatus').dataset.state==='ready');
  await page.evaluate(()=>{window.testConfig.skipMotion=true;});
  await page.waitForTimeout(700);assert.equal(await page.locator('#roll').innerText(),'+16.0°');
  await page.evaluate(()=>{window.testConfig.noEvents=true;});
  await page.waitForFunction(()=>document.getElementById('roll').textContent==='—');
  await page.evaluate(()=>{window.testConfig.noEvents=false;window.testConfig.skipMotion=false;});
  pass('real DOM: stable, moving live values, alternate source and stale blank');
  let layout=await page.evaluate(()=>{
    const q=id=>document.getElementById(id).getBoundingClientRect().toJSON();
    const c=document.querySelector('.cross').getBoundingClientRect();
    return {g:q('guides'),s:q('stage'),sh:q('shutter'),c:[c.x+c.width/2,c.y+c.height/2],scroll:document.documentElement.scrollHeight,h:innerHeight};
  });
  assert.ok(Math.abs(layout.g.width/layout.g.height-640/480)<.002);
  assert.ok(Math.abs(layout.c[0]-(layout.g.x+layout.g.width/2))<1 && Math.abs(layout.c[1]-(layout.g.y+layout.g.height/2))<1);
  assert.equal(layout.scroll,layout.h);assert.ok(layout.sh.bottom<=layout.h);
  await page.locator('#settings').click();await page.locator('#gridToggle').uncheck();assert.equal(await page.locator('#grid').isVisible(),false);
  await page.locator('#gridToggle').check();await page.locator('#diag summary').click();await page.waitForFunction(()=>document.getElementById('diagnostics').textContent.includes('最近频率Hz'));
  await page.locator('#closePanel').click();
  if(out) await page.screenshot({path:path.join(out,'portrait.png')});
  await page.setViewportSize({width:852,height:393});assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight),393);
  assert.ok((await page.locator('#shutter').boundingBox()).x<852);
  if(out) await page.screenshot({path:path.join(out,'landscape.png')});
  await page.setViewportSize({width:393,height:852});pass('mobile portrait and landscape, overlay coordinates, grid toggle, diagnostics, no scroll');
  const fileBuffer=Buffer.from(await page.evaluate(async()=>Array.from(new Uint8Array(await (await window.testPhoto()).arrayBuffer()))));
  const originalSha=createHash('sha256').update(fileBuffer).digest('hex');
  const requestedURLs=[];page.on('request',r=>{if(/^https?:/.test(r.url())) requestedURLs.push(r.url());});
  await page.locator('#shutter').click();await count(page,1);
  let m=(await getShots(page))[0];assert.equal(m.method,'image-capture-still');assert.equal(m.photo.sha256,originalSha);
  assert.equal(m.photo.exif.orientation.value,6);assert.deepEqual(m.photo.encodedDimensions.value,{height:600,width:800});
  assert.deepEqual(m.photo.displayDimensions.value,{width:600,height:800});
  assert.equal(m.camera.actualVideoDimensions.width,640);assert.equal(m.camera.requestedPreview.width,3840);
  assert.ok(m.camera.requests.some(x=>x.action==='tryLargerPreview'));assert.equal(m.photoRequests[0].settings.imageWidth,800);
  assert.ok(m.posture.samples.beforeRequest.length && m.posture.samples.afterCompletion.length);
  assert.equal(m.timing.synchronized,false);assert.equal(JSON.stringify(m).includes('only-in-this-session'),false);assert.equal(JSON.stringify(m).includes('must-not-export'),false);
  pass('A still, requested/preview/final sizes distinct, original SHA, valid EXIF orientation, sensor windows');
  await page.evaluate(()=>{window.testConfig.method='frame';});await page.locator('#shutter').click();await count(page,2);
  m=(await getShots(page))[0];assert.equal(m.method,'video-frame-png');assert.equal(m.photo.format,'png');assert.deepEqual(m.photo.encodedDimensions.value,{width:640,height:480});
  assert.deepEqual(m.preview.photoFromPreview,[1,0,0,1,0,0]);assert.equal(m.photoRequests.length,4);
  const pixel=await page.evaluate(async id=>{const shots=await (await import('./storage.js')).listShots(),blob=shots.find(x=>x.id===id).photo;
    const b=await createImageBitmap(blob),c=document.createElement('canvas');c.width=b.width;c.height=b.height;const g=c.getContext('2d');g.drawImage(b,0,0);
    return [...g.getImageData(320,240,1,1).data].slice(0,3);},m.id);
  assert.ok(pixel[0]>220 && pixel[2]<235);pass('A fallback, native-size PNG, center pixel excludes visible white cross');
  async function pick(button,reply,n,name='fixture.jpg',buffer=fileBuffer,mime='image/jpeg'){
    const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator(button).click()]);
    await chooser.setFiles({name,mimeType:mime,buffer});if(reply) await page.locator(reply).click();await count(page,n);
    return (await getShots(page))[0];
  }
  m=await pick('#systemMode','#wasCamera',3);assert.equal(m.method,'system-confirmed');assert.equal(m.posture.atRequest,null);assert.equal(m.timing.exposureInstant,null);
  assert.equal(m.photo.sha256,originalSha);assert.equal(m.camera,null);assert.equal(m.preview.rect,null);
  m=await pick('#systemMode','#wasGallery',4);assert.equal(m.method,'gallery-from-system');
  m=await pick('#systemMode','#wasUnknown',5);assert.equal(m.method,'system-unconfirmed');pass('B confirmed camera, picker-only and unknown kept distinct; no external exposure pose');
  m=await pick('#importMode',null,6);assert.equal(m.method,'native-import');assert.equal(m.photo.sha256,originalSha);assert.equal(m.posture.samples.afterCompletion.length,0);
  assert.equal(m.posture.atRequest,null);pass('C existing JPEG stays byte-identical; no invented capture pose');
  await page.locator('#album').click();await page.locator('.shot').first().click();await page.locator('#mark').click();
  const r=await page.locator('#photoView').boundingBox();
  for(const [x,y] of [[.2,.15],[.6,.15],[.6,.3],[.2,.3]]) await page.locator('#imageWrap').click({position:{x:r.width*x,y:r.height*y}});
  await page.locator('#notes').fill('合成样图的边缘观察');await page.locator('#saveReview').click();
  await page.waitForFunction(()=>document.getElementById('panelMsg').textContent.includes('保存在本机'));
  m=(await getShots(page))[0];assert.ok(m.review.estimatedNailPixels>10000);assert.equal(m.review.points.length,4);
  await page.locator('#zoomView').click();await page.locator('#zoomView').click();
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#exportShot').click()]);
  const zip=await readFile(await download.path());assert.equal(download.suggestedFilename(),m.id+'.zip');
  const items=[];let at=0;while(zip.readUInt32LE(at)===0x04034b50){
    const n=zip.readUInt16LE(at+26),len=zip.readUInt32LE(at+18),start=at+30+n;
    items.push([zip.toString('utf8',at+30,start),zip.subarray(start,start+len)]);at=start+len;
  }
  assert.equal(items.length,2);assert.equal(items[0][0],m.id+'.jpg');assert.deepEqual(items[0][1],fileBuffer);
  assert.equal(JSON.parse(items[1][1].toString()).id,m.id);assert.equal(JSON.parse(items[1][1].toString()).photo.sha256,originalSha);
  await page.locator('#closePanel').click();pass('local album, manual nail area and notes, 1:1 view, actual downloaded ZIP verified byte-for-byte');
  const heic=Buffer.from([0,0,0,24,102,116,121,112,104,101,105,99]);
  m=await pick('#importMode',null,7,'example.heic',heic,'image/heic');assert.equal(m.photo.extension,'heic');assert.equal(m.photo.sha256,createHash('sha256').update(heic).digest('hex'));
  assert.equal(m.photo.encodedDimensions.value,null);pass('unsupported file preserved with unavailable EXIF and dimensions');
  assert.deepEqual(requestedURLs,[]);await page.reload();assert.equal((await getShots(page)).length,7);await page.locator('#album').click();
  await page.locator('.shot').first().waitFor();assert.equal(await page.locator('.shot').count(),7);await page.locator('#closePanel').click();
  pass('records survive reload; no HTTP requests during photo capture, import, inspection or export');
  await page.evaluate(()=>{window.testConfig.denied=true;});await page.locator('#start').click();
  await page.waitForFunction(()=>document.getElementById('startHint').textContent.includes('相机没有获准'));
  assert.ok(await page.locator('#importMode').isEnabled());pass('camera denial shown, other capture routes available');
  await page.evaluate(()=>{window.testConfig.denied=false;window.testConfig.portrait=true;});await page.locator('#start').click();
  await page.waitForFunction(()=>!document.getElementById('shutter').disabled);
  const portrait=await page.locator('#guides').boundingBox();assert.ok(portrait.height/852>.80);
  if(out) await page.screenshot({path:path.join(out,'portrait-camera.png')});
  await page.locator('#settings').click();await page.locator('#framing').selectOption('frame');await page.locator('#closePanel').click();
  const filled=await page.locator('#guides').boundingBox();assert.equal(Math.round(filled.height),852);
  if(out) await page.screenshot({path:path.join(out,'full-view.png')});
  await page.locator('#shutter').click();await count(page,8);m=(await getShots(page))[0];
  assert.equal(m.method,'video-frame-png');assert.deepEqual(m.photo.encodedDimensions.value,{width:360,height:640});
  assert.equal(m.preview.rect.fit,'cover');assert.ok(m.preview.rect.croppedPixels>0);assert.equal(m.photoRequests.length,0);
  pass('portrait live image and full-screen crop with exact transformation to entire saved frame');
  await ctx.close();assert.deepEqual(errors,[]);
  // Exercise the browser native API stack using Chromium's synthetic device, without JS camera mocks.
  const regular=await browser.newContext({permissions:['camera'],viewport:{width:390,height:844}});
  const rp=await regular.newPage();await rp.goto(base);await rp.locator('#start').click();
  await rp.waitForFunction(()=>!document.getElementById('shutter').disabled,null,{timeout:20000});
  await rp.locator('#shutter').click();await count(rp,1);const native=(await getShots(rp))[0];
  assert.ok(native.photo.encodedDimensions.value);assert.equal(native.timing.synchronized,false);
  console.log('CHROMIUM_VIRTUAL_DEVICE',JSON.stringify({method:native.method,preview:native.camera.actualVideoDimensions,final:native.photo.encodedDimensions.value,exif:native.photo.exifStatus}));
  pass('Chromium getUserMedia and browser capture with built-in virtual camera');
  if(out) await writeFile(path.join(out,'browser-result.json'),JSON.stringify({browser:browser.version(),passed,errors,virtualDevice:{method:native.method,preview:native.camera.actualVideoDimensions,final:native.photo.encodedDimensions.value}},null,2));
  await regular.close();
} finally {await browser.close();server.close();}
