/**
 * Gravity-based, stationary inclinometer. No gyro integration; no startup zero.
 * W3C DeviceMotion proper acceleration is +Z at rest with the screen facing up.
 * Browser event values are the most raw values the web API exposes, not ADC data.
 */
export const SENSOR_CONFIG = Object.freeze({
  gravity: 9.80665,
  filterTimeConstantMs: 100,
  staleAfterMs: 500,
  stableWindowMs: 700,
  calibrationWindowMs: 1500,
  historyMs: 5000,
  gravityTolerance: 0.8,
  maxLinearAcceleration: 0.35,
  maxRotationRate: 0.8,
  maxDirectionChangeSpeedDegPerSec: 0.6,
  maxVectorRms: 0.12,
  maxVectorDeviation: 0.3,
  maxCalibrationTiltDeg: 5,
});
const RAD = Math.PI / 180;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const vector = v => v && ['x', 'y', 'z'].every(k => finite(v[k]));
const length = v => Math.hypot(v.x, v.y, v.z);
const copy = v => typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
const dot = (a, b) => a.x*b.x + a.y*b.y + a.z*b.z;
const cross = (a,b) => ({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
const normalize = v => { const n=length(v); return {x:v.x/n,y:v.y/n,z:v.z/n}; };
const mean = values => {
  const sum = values.reduce((a,v)=>({x:a.x+v.x,y:a.y+v.y,z:a.z+v.z}),{x:0,y:0,z:0});
  return {x:sum.x/values.length,y:sum.y/values.length,z:sum.z/values.length};
};

export function normalizedScreenAngle(value) {
  if (!finite(value)) return null;
  const n=((value%360)+360)%360;
  return [0,90,180,270].find(a=>Math.abs(a-n)<0.001) ?? null;
}

export function toScreenVector(v, screenAngle) {
  switch (normalizedScreenAngle(screenAngle)) {
    case 0: return {...v};
    case 90: return {x:-v.y,y:v.x,z:v.z};
    case 180: return {x:-v.x,y:-v.y,z:v.z};
    case 270: return {x:v.y,y:-v.x,z:v.z};
    default: return null;
  }
}

/** Independent angle of each screen edge to the horizontal plane, not Euler angles. */
export function anglesFromGravity(v, screenAngle=0) {
  if (!vector(v) || length(v)<1 || v.z<=0) return null;
  const s=toScreenVector(v,screenAngle);
  if (!s) return null;
  const clean = value => Math.abs(value)<1e-12 ? 0 : value;
  return {
    roll:clean(-Math.atan2(s.x,Math.hypot(s.y,s.z))/RAD),
    pitch:clean(-Math.atan2(s.y,Math.hypot(s.x,s.z))/RAD),
  };
}

// Rodrigues: minimal rotation from the measured reference unit vector to +Z.
// Calibration operates in DEVICE coordinates, before the screen rotation.
function correct(v, calibration) {
  if (!calibration) return {...v};
  const from=calibration.referenceUnitVector;
  const axis={x:from.y,y:-from.x,z:0};
  const k1=cross(axis,v), k2=cross(axis,k1), denominator=1+from.z;
  return {x:v.x+k1.x+k2.x/denominator,y:v.y+k1.y+k2.y/denominator,z:v.z+k1.z+k2.z/denominator};
}

function motionFlags(sample) {
  const a=sample.accelerationIncludingGravity;
  const g=length(a);
  const linearAvailable=vector(sample.acceleration);
  const rotationAvailable=sample.rotationRate && ['alpha','beta','gamma'].every(k=>finite(sample.rotationRate[k]));
  const linear=linearAvailable ? length(sample.acceleration) : null;
  const rotation=rotationAvailable ? Math.hypot(sample.rotationRate.alpha,sample.rotationRate.beta,sample.rotationRate.gamma) : null;
  return {
    gravityMagnitude:g,
    linearAccelerationMagnitude:linear,
    rotationRateMagnitude:rotation,
    linearAccelerationAvailable:!!linearAvailable,
    rotationRateAvailable:!!rotationAvailable,
    moving:Math.abs(g-SENSOR_CONFIG.gravity)>SENSOR_CONFIG.gravityTolerance ||
      (linear!==null && linear>SENSOR_CONFIG.maxLinearAcceleration) ||
      (rotation!==null && rotation>SENSOR_CONFIG.maxRotationRate),
  };
}

function windowQuality(samples, expectedMs) {
  const vectors=samples.map(s=>s.accelerationIncludingGravity);
  const average=mean(vectors);
  const deviations=vectors.map(v=>Math.hypot(v.x-average.x,v.y-average.y,v.z-average.z));
  const rms=Math.sqrt(deviations.reduce((s,v)=>s+v*v,0)/deviations.length);
  const max=Math.max(...deviations);
  const flags=samples.map(motionFlags);
  const duration=samples[samples.length-1].receivedPerfMs-samples[0].receivedPerfMs;
  const maxGap=Math.max(0,...samples.slice(1).map((s,i)=>s.receivedPerfMs-samples[i].receivedPerfMs));
  // Averaged end segments suppress sample jitter while detecting continuous slow
  // tilts which can pass both magnitude and whole-window dispersion thresholds.
  // This remains a motion heuristic, not proof that all translation is absent.
  let directionChangeSpeedDegPerSec=null;
  if (samples.length>=6 && duration>=250) {
    const third=Math.floor(samples.length/3);
    const first=samples.slice(0,third),last=samples.slice(-third);
    const firstVector=mean(first.map(s=>s.accelerationIncludingGravity));
    const lastVector=mean(last.map(s=>s.accelerationIncludingGravity));
    const meanTime=segment=>segment.reduce((sum,s)=>sum+s.receivedPerfMs,0)/segment.length;
    const elapsedSeconds=(meanTime(last)-meanTime(first))/1000;
    if (length(firstVector)>0.1 && length(lastVector)>0.1 && elapsedSeconds>0) {
      const a=normalize(firstVector),b=normalize(lastVector);
      directionChangeSpeedDegPerSec=Math.atan2(length(cross(a,b)),dot(a,b))/RAD/elapsedSeconds;
    }
  }
  return {
    average,
    sampleCount:samples.length,
    durationMs:duration,
    maxGapMs:maxGap,
    vectorRms:rms,
    maxVectorDeviation:max,
    directionChangeSpeedDegPerSec,
    enough:duration>=expectedMs-80 && samples.length>=Math.max(8,Math.floor(expectedMs/100)) && maxGap<=250,
    moving:flags.some(f=>f.moving) || rms>SENSOR_CONFIG.maxVectorRms || max>SENSOR_CONFIG.maxVectorDeviation ||
      (directionChangeSpeedDegPerSec!==null && directionChangeSpeedDegPerSec>SENSOR_CONFIG.maxDirectionChangeSpeedDegPerSec),
  };
}

export class SensorEngine {
  constructor() {
    this.calibration=null;
    this.history=[];
    this.recent=[];
    this.lastSample=null;
    this.filtered=null;
    this.invalidReason=null;
  }

  ingest(sample) {
    if (!sample || !finite(sample.receivedPerfMs)) {
      this.invalidReason='传感器接收时间无效'; this.filtered=null; this.recent=[];
      return;
    }
    const s=copy(sample);
    const previous=this.lastSample;
    this.lastSample=s;
    this.history.push(s);
    this.history=this.history.filter(v=>v.receivedPerfMs>=s.receivedPerfMs-SENSOR_CONFIG.historyMs).slice(-1500);
    if (previous && s.receivedPerfMs<=previous.receivedPerfMs) {
      this.invalidReason='传感器时间未递增'; this.filtered=null; this.recent=[]; return;
    }
    if (!vector(s.accelerationIncludingGravity) || length(s.accelerationIncludingGravity)<1) {
      this.invalidReason='重力加速度缺失、非有限值或幅值无效'; this.filtered=null; this.recent=[]; return;
    }
    if (normalizedScreenAngle(s.screenAngle)===null) {
      this.invalidReason='无法读取可靠的屏幕旋转方向'; this.filtered=null; this.recent=[]; return;
    }
    this.invalidReason=null;
    const dt=previous ? s.receivedPerfMs-previous.receivedPerfMs : 0;
    if (dt>SENSOR_CONFIG.staleAfterMs) { this.filtered=null; this.recent=[]; }
    const a=s.accelerationIncludingGravity;
    if (!this.filtered) this.filtered={...a};
    else {
      const weight=1-Math.exp(-dt/SENSOR_CONFIG.filterTimeConstantMs);
      for (const k of ['x','y','z']) this.filtered[k]+=weight*(a[k]-this.filtered[k]);
    }
    this.recent.push(s);
    this.recent=this.recent.filter(v=>v.receivedPerfMs>=s.receivedPerfMs-SENSOR_CONFIG.calibrationWindowMs);
  }

  snapshot(nowPerfMs, screenAngle=this.lastSample?.screenAngle) {
    const age=this.lastSample && finite(nowPerfMs) ? nowPerfMs-this.lastSample.receivedPerfMs : null;
    const result={
      status:'no-data', valid:false, reason:'尚未收到传感器数据', angles:null,
      uncalibratedAngles:null, screenAngle:normalizedScreenAngle(screenAngle),
      sampleAgeMs:age, calibration:this.calibration ? copy(this.calibration) : null,
      lastSample:this.lastSample ? copy(this.lastSample) : null, quality:null,
      method:'low-pass-filtered-acceleration-including-gravity',
    };
    const fail=(status,reason)=>({...result,status,reason});
    if (this.invalidReason) return fail('invalid',this.invalidReason);
    if (!this.lastSample) return result;
    if (age===null || age<0 || age>SENSOR_CONFIG.staleAfterMs) return fail('stale','传感器数据已过期，请保持页面前台并检查授权');
    if (result.screenAngle===null) return fail('orientation-unavailable','无法读取可靠的屏幕旋转方向');
    if (!this.filtered || !this.recent.length) return fail('invalid','有效传感器数据不足');
    const samples=this.recent.filter(s=>s.receivedPerfMs>=this.lastSample.receivedPerfMs-SENSOR_CONFIG.stableWindowMs);
    const quality=windowQuality(samples,SENSOR_CONFIG.stableWindowMs);
    result.quality={...motionFlags(this.lastSample),...quality,
      filterTimeConstantMs:SENSOR_CONFIG.filterTimeConstantMs,
      limitation:'稳定性仅为启发式判据；单一加速度无法区分所有持续平移加速度与重力，需静置测量。'};
    if (this.lastSample.accelerationIncludingGravity.z<=0 || this.filtered.z<=0) return fail('face-down','请让屏幕朝上；翻面或竖直临界状态不作为水平读数');
    result.angles=anglesFromGravity(correct(this.filtered,this.calibration),result.screenAngle);
    if (!result.angles) return fail('face-down','当前姿态超出屏幕朝上的有效范围');
    result.uncalibratedAngles=anglesFromGravity(this.filtered,result.screenAngle);
    if (quality.moving) return fail('moving','调整中 · 实时估计');
    if (!quality.enough) return fail('settling','正在采样 · 实时估计');
    // Reject residual filter lag after a move, even after the short raw window is stable.
    if (Math.hypot(this.filtered.x-quality.average.x,this.filtered.y-quality.average.y,this.filtered.z-quality.average.z)>0.06)
      return fail('settling','正在等待滤波收敛，请继续静置');
    return {...result,status:'ready',valid:true,reason:'已放稳'};
  }

  calibrate(nowPerfMs) {
    const state=this.snapshot(nowPerfMs);
    if (!state.valid) throw new Error('当前数据不稳定或无效，不能校准');
    const q=windowQuality(this.recent,SENSOR_CONFIG.calibrationWindowMs);
    if (!q.enough || q.moving) throw new Error('请在可靠水平参照面上静置至少 1.5 秒后重试');
    const unit=normalize(q.average);
    const tilt=Math.acos(Math.max(-1,Math.min(1,unit.z)))/RAD;
    if (tilt>SENSOR_CONFIG.maxCalibrationTiltDeg) throw new Error('与物理水平偏差超过 5°，拒绝将该姿态设为零点');
    this.calibration={
      method:'minimal-device-frame-rotation-to-positive-z',
      referenceUnitVector:unit,
      referenceMeanAcceleration:q.average,
      uncalibratedTotalTiltDeg:tilt,
      sampleCount:q.sampleCount,
      sampleWindowStartPerfMs:this.recent[0].receivedPerfMs,
      sampleWindowEndPerfMs:this.recent[this.recent.length-1].receivedPerfMs,
      calibratedAtPerfMs:nowPerfMs,
      calibratedAtIso:new Date().toISOString(),
      referenceRequirement:'用户确认可靠的水平参照面；软件不能验证参照面本身是否水平。',
      sessionOnly:true,
    };
    return copy(this.calibration);
  }

  clearCalibration() { this.calibration=null; }
  getRawSamples(startPerfMs=-Infinity,endPerfMs=Infinity) {
    return this.history.filter(s=>s.receivedPerfMs>=startPerfMs && s.receivedPerfMs<=endPerfMs).map(copy);
  }
}
