import { SensorEngine, SENSOR_CONFIG, normalizedScreenAngle } from './sensor.js';

const axes = ['x', 'y', 'z'];
const rotations = ['alpha', 'beta', 'gamma'];
const finite = Number.isFinite;
const number = v => finite(v) ? v : null;
const fields = (value, keys) => value ? Object.fromEntries(keys.map(k => [k, number(value[k])])) : null;
const round = n => Math.round(n * 10) / 10;
export const poseNames = {gravity:'系统重力向量',motion:'含重力加速度',absolute:'地球参考融合姿态',orientation:'系统融合姿态'};
export const signGuide = '从看屏幕的人算起：右边压低为左右正，左边压低为负；上边（远端）压低为前后正，下边压低为负。';
export function screenRotation() {
  return normalizedScreenAngle(globalThis.screen?.orientation?.angle ?? globalThis.orientation);
}
export function clock() {
  const perfMs = performance.now();
  return {perfMs, wallIso: new Date().toISOString(), timeOriginMs: performance.timeOrigin};
}
export function orientationGravity(beta, gamma) {
  if (!finite(beta) || !finite(gamma) || Math.abs(beta) > 180 || Math.abs(gamma) > 90) return null;
  const b = beta * Math.PI / 180, c = gamma * Math.PI / 180, g = SENSOR_CONFIG.gravity;
  return {x: -Math.cos(b) * Math.sin(c) * g, y: Math.sin(b) * g, z: Math.cos(b) * Math.cos(c) * g};
}
export class PoseFeed {
  constructor() {
    this.engines = Object.fromEntries(Object.keys(poseNames).map(k=>[k,new SensorEngine()]));
    this.stats = Object.fromEntries(Object.keys(poseNames).map(k => [k, {count:0, usable:0, times:[], last:null}]));
    this.permissions = {};
    this.listenersOn = false;
    this.started = false;
    this.preferred = 'auto';
  }
  ingest(kind, event, at = clock(), angle = screenRotation()) {
    const stats = this.stats[kind];
    const sample = {source:kind, screenAngle:angle, receivedPerfMs:at.perfMs, receivedWallTimeIso:at.wallIso,
      eventTimeStamp:number(event.timeStamp), intervalMs:number(event.interval)};
    if (kind === 'gravity') {
      sample.accelerationIncludingGravity = fields(event,axes);
      sample.sensorTimestamp = number(event.timestamp);
    } else if (kind === 'motion') {
      sample.accelerationIncludingGravity = fields(event.accelerationIncludingGravity, axes);
      sample.acceleration = fields(event.acceleration, axes);
      sample.rotationRate = fields(event.rotationRate, rotations);
    } else {
      sample.orientation = fields(event, rotations);
      sample.absolute = typeof event.absolute === 'boolean' ? event.absolute : null;
      sample.accelerationIncludingGravity = orientationGravity(event.beta, event.gamma);
      sample.vectorIsDerivedFromOrientation = true;
    }
    stats.count++;
    const v = sample.accelerationIncludingGravity;
    if (v && axes.every(k => finite(v[k])) && Math.hypot(v.x,v.y,v.z) >= 1) stats.usable++;
    stats.last = sample;
    stats.times.push(at.perfMs);
    stats.times = stats.times.filter(t => t >= at.perfMs - 2000).slice(-500);
    this.engines[kind].ingest(sample);
  }
  start() {
    this.started = true;
    if (!this.listenersOn) {
      for (const [kind,eventName] of [['motion','devicemotion'],['absolute','deviceorientationabsolute'],['orientation','deviceorientation']])
        window.addEventListener(eventName, e => this.ingest(kind,e), {passive:true});
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) return;
        for (const engine of Object.values(this.engines)) {
          engine.lastSample = null; engine.recent = []; engine.filtered = null; engine.invalidReason = null;
        }
      });
      this.listenersOn = true;
    }
    // Invoke both prompts on the original button gesture, before the first await.
    const requests = [['motion',window.DeviceMotionEvent],['orientation',window.DeviceOrientationEvent]].map(([k,api]) => {
      if (!api?.requestPermission) {
        this.permissions[k] = api ? '无单独授权弹窗；以实收事件为准' : '浏览器未提供构造器；等候事件';
        return Promise.resolve();
      }
      try {
        return Promise.resolve(api.requestPermission()).then(result => { this.permissions[k] = result; },
          error => {this.permissions[k] = error.name + ' ' + error.message;});
      } catch (error) { this.permissions[k] = error.message; return Promise.resolve(); }
    });
    if (!this.gravitySensor && typeof window.GravitySensor==='function') {
      try {
        const sensor=new window.GravitySensor({frequency:30,referenceFrame:'device'});
        sensor.onreading=()=>this.ingest('gravity',sensor);
        sensor.onerror=e=>{this.permissions.gravity=e.error.name+' '+e.error.message;sensor.stop();this.gravitySensor=null;};
        this.gravitySensor=sensor;sensor.start();this.permissions.gravity='已请求，等候实收事件';
      } catch(e){this.permissions.gravity=e.name+' '+e.message;}
    } else if (!this.gravitySensor) this.permissions.gravity='未提供独立重力接口';
    this.refreshPermissions();
    return Promise.all(requests);
  }
  async refreshPermissions() {
    for (const name of ['camera','accelerometer','gyroscope']) {
      try {
        const permission = await navigator.permissions.query({name});
        this.permissions[name] = permission.state;
        permission.onchange = () => { this.permissions[name] = permission.state; };
      } catch { this.permissions[name] = '浏览器未报告权限状态'; }
    }
  }
  state(now = performance.now(), angle = screenRotation()) {
    const states=Object.fromEntries(Object.entries(this.engines).map(([k,e])=>[k,e.snapshot(now,angle)]));
    const keys=Object.keys(states);
    let kind=keys.find(k=>states[k].angles) || keys.find(k=>states[k].lastSample) || 'motion';
    if (keys.includes(this.preferred)) kind=this.preferred;
    if (this.preferred==='auto' && kind==='orientation' && !states[kind].lastSample?.absolute) {
      const inverted=keys.find(k=>k!=='orientation' && states[k].status==='face-down');
      if (inverted) kind=inverted;
    }
    const selected=states[kind];
    if (selected.status === 'no-data') {
      if (!this.started) selected.reason = '尚未开启水平仪';
      else if (Object.values(this.permissions).some(v => /denied|NotAllowed/.test(v))) selected.reason = '未收到姿态数据，请查看权限';
      else selected.reason = '尚未收到姿态事件；查看诊断或换浏览器试试';
    }
    // A still-looking stream on one channel can coexist with movement on the other.
    const otherMoves=keys.some(k=>k!==kind && states[k].status==='moving');
    const relative=kind==='orientation' && !selected.lastSample?.absolute;
    const disagreement=selected.uncalibratedAngles && keys.some(k=>{
      const a=states[k].uncalibratedAngles,b=selected.uncalibratedAngles;
      return k!==kind && a && (k!=='orientation'||states[k].lastSample?.absolute) && Math.hypot(a.roll-b.roll,a.pitch-b.pitch)>5;
    });
    if (selected.angles && disagreement) {
      selected.status='disagreement';selected.valid=false;selected.reason='来源不一致 · 角度待核实';
    } else if (selected.angles && relative && !selected.calibration) {
      selected.status='relative-estimate';selected.valid=false;selected.reason='相对估计 · 请在水平面校准';
    } else if (selected.valid && otherMoves) {
      selected.status = 'moving'; selected.valid = false; selected.reason = '调整中 · 实时估计';
    }
    return {...selected, source:selected.lastSample ? kind : null, sourceLabel:selected.lastSample ? poseNames[kind] : '无法获取',
      requestedSource:this.preferred,reference:!selected.angles ? '无法获取' : relative ? (selected.calibration ? '用户水平面核对的融合参考' : '相对参考，物理零位未核对') : '设备重力或绝对姿态参考',
      method:['orientation','absolute'].includes(kind) ? 'W3C Z-X-Y attitude to gravity, low-pass, screen rotation' : selected.method,
      angleSource:selected.angles ? '算法估计' : '无法获取', rawSource:'浏览器接口实读'};
  }
  raw(from,to) {
    return Object.values(this.engines).flatMap(e => e.getRawSamples(from,to)).sort((a,b) => a.receivedPerfMs-b.receivedPerfMs);
  }
  diagnostics(now = performance.now()) {
    return Object.fromEntries(Object.entries(this.stats).map(([k,s]) => {
      const times = s.times.filter(t => t >= now-2000);
      const span = times.length > 1 ? times[times.length-1]-times[0] : 0;
      return [k, {count:s.count, usable:s.usable, hz:span>0 ? round((times.length-1)*1000/span) : 0,
        ageMs:s.last ? Math.round(now-s.last.receivedPerfMs) : null, lastRaw:s.last,
        status:this.engines[k].snapshot(now,screenRotation()).reason}];
    }));
  }
  calibrate() {
    const now = performance.now(), state = this.state(now);
    if (!state.valid && state.status!=='relative-estimate') throw new Error('请让手机在水平面上放稳后再校准');
    return this.engines[state.source].calibrate(now);
  }
  reset() { for (const e of Object.values(this.engines)) e.clearCalibration(); }
}
