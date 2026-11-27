import {methods,areaFromPoints} from './records.js';
import {photoLabels} from './photo.js';
import {shotZip} from './storage.js';
const $=id=>document.getElementById(id);
const dims=m=>m.photo.encodedDimensions.value || m.photo.displayDimensions.value;
export const sizeText=v=>v ? v.width+' × '+v.height : '尺寸未读到';
const el=(tag,text)=>{const node=document.createElement(tag);node.textContent=text;return node;};
const value=v=>v==null ? '—' : typeof v==='object' ? JSON.stringify(v) : String(v);
function table(host,headers,rows) {
  const wrap=el('div',''); wrap.className='tableWrap';
  const t=el('table',''),head=t.createTHead().insertRow();
  headers.forEach(v=>head.append(el('th',v)));
  const body=t.createTBody();
  for (const row of rows) {const tr=body.insertRow();row.forEach(v=>{tr.insertCell().textContent=value(v);});}
  wrap.append(t);host.append(wrap);
}
const cameraLabels={label:'镜头名称',facingMode:'方向',cameras:'可选镜头',preview:'轨道预览',widthRange:'宽度范围',heightRange:'高度范围',
  frameRate:'帧率',zoom:'浏览器变焦',zoomRange:'变焦范围',focusMode:'对焦模式',focusModes:'可选对焦',focusDistance:'对焦距离（米）',focusDistanceRange:'对焦距离范围',
  focalLength:'浏览器焦距',fieldOfView:'视场角',principalPoint:'光学中心',distortion:'畸变参数'};
export class Gallery {
  constructor({all,persist,open,msg}) {
    this.all=all;this.persist=persist;this.open=open;this.msg=msg;
    $('backAlbum').onclick=()=>this.show();
    $('zoomView').onclick=()=>{this.enlarged=!this.enlarged;this.layout();};
    $('mark').onclick=()=>{this.marking=!this.marking;this.layout();};
    $('undoMark').onclick=()=>{this.points.pop();this.draw();};
    $('imageWrap').onclick=e=>{
      if (!this.marking) return;
      const r=$('photoView').getBoundingClientRect();if(!r.width || !r.height) return;
      if (this.points.length>=300) return this.msg('最多可点 300 个点');
      this.points.push({x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))});
      this.draw();
    };
    $('saveReview').onclick=()=>this.save().catch(e=>this.msg(e.message));
    $('exportShot').onclick=()=>this.export().catch(e=>this.msg(e.message));
    $('photoView').onload=()=>{if (this.current) {$('imageTools').hidden=false;this.layout();}};
    $('photoView').onerror=()=>{if(this.current){$('imageTools').hidden=true;this.msg('手机无法预览这个格式，仍可保存原文件和数据');}};
  }
  async show() {
    this.release();this.open('albumPage','本机相册');
    const shots=await this.all();
    const list=$('shotList'), compare=$('compare');list.replaceChildren();compare.replaceChildren();
    if (!shots.length) {list.append(el('p','这里还没有照片。拍一张或导入一张，就会出现在这里。'));return;}
    const groups=[['A',s=>['image-capture-still','video-frame-png'].includes(s.metadata.method)],
      ['B',s=>s.metadata.method==='system-confirmed'],['C',s=>s.metadata.method==='native-import']];
    compare.append(el('h3','最近一次三种方式对照'));
    const latest=groups.map(([label,fn])=>[label,shots.find(fn)?.metadata]);
    table(compare,['实读项目',...latest.map(([label])=>label)],[
      ['成片像素',...latest.map(([,m])=>m?sizeText(dims(m)):null)],
      ['甲面约像素²',...latest.map(([,m])=>m?.review.estimatedNailPixels)],
      ...['lensModel','focalLengthMm','equivalent35mm','digitalZoomRatio'].map(k=>[photoLabels[k],...latest.map(([,m])=>m?.photo.exif[k].value)]),
      ['甲缘观察',...latest.map(([,m])=>m?.review.notes||null)]
    ]);
    for (const s of shots) {
      const b=el('button',methods[s.metadata.method]+' · '+sizeText(dims(s.metadata))+' · '+new Date(s.createdAt).toLocaleTimeString('zh-CN'));
      b.className='shot';b.onclick=()=>this.detail(s);list.append(b);
    }
  }
  release() {
    if (this.photoUrl) URL.revokeObjectURL(this.photoUrl);
    if (this.downloadUrl) URL.revokeObjectURL(this.downloadUrl);
    this.photoUrl=null;this.downloadUrl=null;this.current=null;$('manualDownload')?.remove();
  }
  detail(shot) {
    this.release();this.open('detailPage','照片详情');this.current=shot;
    const m=shot.metadata;
    $('detailName').textContent=methods[m.method];
    const summary=$('detailSummary');summary.replaceChildren();
    summary.append(el('div','成片 '+sizeText(dims(m))+' · '+(m.photo.bytes/1048576).toFixed(2)+' MiB · '+m.photo.exifStatus));
    if(m.camera) summary.append(el('div','预览初次请求 '+sizeText(m.camera.requestedPreview)+' · 实际 '+sizeText(m.camera.actualVideoDimensions)));
    const pose=m.posture.atRequest, a=pose?.angles;
    const angle=n=>(n>0?'+':'')+n.toFixed(1)+'°';
    summary.append(el('div',a ? '拍照请求时：左右 '+angle(a.roll)+'，前后 '+angle(a.pitch)+' · '+pose.reason : '拍照时的角度无法确定'));
    summary.append(el('div','曝光时刻未取得，照片与姿态的同步误差未知。'));
    $('imageTools').hidden=true;this.marking=false;this.enlarged=false;
    this.points=m.review.points.map(p=>({...p}));$('notes').value=m.review.notes;
    this.photoUrl=URL.createObjectURL(shot.photo);$('photoView').src=this.photoUrl;
    $('params').replaceChildren();
    const rows=Object.entries(m.photo.exif).map(([k,v])=>[photoLabels[k],v.detail ? value(v.value)+'（'+v.detail+'）' : v.value,v.source]);
    for(const [k,label] of Object.entries(cameraLabels)) {
      const p=m.camera?.parameters?.[k];rows.push([label,p?.value,p?.source||'无法获取']);
    }
    table($('params'),['参数','值','来源'],rows);
    $('jsonPreview').textContent=JSON.stringify(m,null,2);
  }
  layout() {
    const d=this.current?.metadata.photo.displayDimensions.value || {width:$('photoView').naturalWidth};
    const ratio=(window.devicePixelRatio||1)*(window.visualViewport?.scale||1);
    $('imageWrap').style.width=this.enlarged ? (d.width/ratio)+'px' : '100%';
    $('zoomView').textContent=this.enlarged ? '看整张' : '原图 1:1';
    $('mark').textContent=this.marking ? '圈好了' : '圈出甲面';$('undoMark').hidden=!this.marking;
    $('imageWrap').classList.toggle('marking',this.marking);this.draw();
  }
  draw() {
    if(!this.current) return;
    const img=$('photoView'), c=$('outline'), h=img.naturalHeight/Math.max(1,img.naturalWidth);
    c.width=750;c.height=Math.max(1,Math.min(2200,Math.round(750*h)));
    const ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);
    if (this.points.length) {
      ctx.strokeStyle='#6dffae';ctx.lineWidth=3;ctx.fillStyle='#62eda53d';ctx.beginPath();
      this.points.forEach((p,i)=>i ? ctx.lineTo(p.x*c.width,p.y*c.height) : ctx.moveTo(p.x*c.width,p.y*c.height));
      if(this.points.length>=3){ctx.closePath();ctx.fill();} ctx.stroke();ctx.fillStyle='#76ffad';
      for (const p of this.points) { ctx.beginPath();ctx.arc(p.x*c.width,p.y*c.height,4,0,2*Math.PI);ctx.fill(); }
    }
    const a=areaFromPoints(this.points,this.current.metadata.photo.displayDimensions.value);
    $('markInfo').textContent=(this.marking?'沿甲缘依次点一圈，避开交叉。':'')+(a!=null?'甲面约 '+a.toLocaleString()+' 平方像素。':'')+
      (this.enlarged?'可滑动查看甲根和两侧。':'');
  }
  async save() {
    const s=this.current;if (!s) return;
    s.metadata.review={source:'算法估计',method:'用户沿甲缘圈点；在 EXIF 正向原片网格上用多边形面积估算覆盖像素，不能量化光学清晰度',
      points:this.points.map(p=>({...p})),estimatedNailPixels:areaFromPoints(this.points,s.metadata.photo.displayDimensions.value),
      coordinates:'EXIF 正向显示，左上原点，归一化 0…1',notes:$('notes').value,updated:new Date().toISOString()};
    const stored=await this.persist(s);$('jsonPreview').textContent=JSON.stringify(s.metadata,null,2);
    this.msg(stored ? '观察已保存在本机' : '本机空间不足，本页仍可导出，请先保存文件');return s;
  }
  async export() {
    if(!this.current) return;
    $('exportShot').disabled=true;
    try {
      const s=await this.save(), zip=await shotZip(s);
      if(this.downloadUrl) URL.revokeObjectURL(this.downloadUrl);
      $('manualDownload')?.remove();
      const link=el('a','再次下载这份 ZIP');link.id='manualDownload';
      this.downloadUrl=URL.createObjectURL(zip);link.href=this.downloadUrl;link.download=s.id+'.zip';
      $('exportShot').parentElement.after(link);link.click();
      this.msg('请在手机的「下载」里找 ZIP。里面是一张照片和一个同编号的 JSON。');
    } finally {$('exportShot').disabled=false;}
  }
}
