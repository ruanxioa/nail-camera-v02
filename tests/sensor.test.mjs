import test from 'node:test';
import assert from 'node:assert/strict';
import {SensorEngine,anglesFromGravity,toScreenVector,SENSOR_CONFIG} from '../docs/sensor.js';

const g=SENSOR_CONFIG.gravity, r=Math.PI/180;
const near=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<t,`${a} differs from ${b}`);
function gravity(roll,pitch) {
  // Construct vectors from physically defined edge-to-plane inclinations.
  const x=-Math.sin(roll*r),y=-Math.sin(pitch*r);
  return {x:g*x,y:g*y,z:g*Math.sqrt(1-x*x-y*y)};
}
function sample(t,a=gravity(0,0),extra={}) {
  return {receivedPerfMs:t,eventTimeStamp:t-2,receivedWallTimeIso:'2026-11-27T00:00:00.000Z',screenAngle:0,
    accelerationIncludingGravity:a,acceleration:{x:0,y:0,z:0},rotationRate:{alpha:0,beta:0,gamma:0},...extra};
}
function feed(engine,a,from=0,to=2000,extra={}) { for(let t=from;t<=to;t+=20) engine.ingest(sample(t,a,extra)); }

test('flat device has physical zero, no calibration set',()=>{
  const e=new SensorEngine();feed(e,gravity(0,0)); const s=e.snapshot(2000);
  assert.equal(s.status,'ready'); assert.deepEqual(s.angles,{roll:0,pitch:0});assert.equal(s.calibration,null);
});
for(const [name,roll,pitch] of [['forward',0,20],['backward',0,-20],['left',-20,0],['right',20,0],['combined',15,-25]]) {
  test(`${name}: known angle simulated gravity`,()=>{
    const e=new SensorEngine();feed(e,gravity(roll,pitch));const s=e.snapshot(2000);
    assert.equal(s.status,'ready');near(s.angles.roll,roll);near(s.angles.pitch,pitch);
    assert.equal(s.calibration,null,'arbitrary initial tilt must never become zero');
  });
}
test('screen rotations remap physical device axes and their signs',()=>{
  const v=gravity(10,20);
  for(const [screen,roll,pitch] of [[0,10,20],[90,-20,10],[180,-10,-20],[270,20,-10],[-90,20,-10]]) {
    const a=anglesFromGravity(v,screen);near(a.roll,roll);near(a.pitch,pitch);
  }
  assert.equal(toScreenVector(v,null),null);
});
test('all display directions at all quarter rotations',()=>{
  for (const angle of [0,90,180,270]) for(const [roll,pitch] of [[20,0],[-20,0],[0,20],[0,-20],[10,15]]) {
    const deviceVector=toScreenVector(gravity(roll,pitch),360-angle);
    const e=new SensorEngine();feed(e,deviceVector,0,2000,{screenAngle:angle});const s=e.snapshot(2000);
    assert.equal(s.status,'ready');near(s.angles.roll,roll);near(s.angles.pitch,pitch);
  }
});
test('no samples, invalid, stale and missing screen angle never yield zero angles',()=>{
  const e=new SensorEngine();assert.equal(e.snapshot(0).angles,null);
  e.ingest(sample(0,{x:null,y:0,z:g}));assert.equal(e.snapshot(0).status,'invalid');assert.equal(e.snapshot(0).angles,null);
  feed(e,gravity(0,0),20,2000);assert.equal(e.snapshot(2600).status,'stale');assert.equal(e.snapshot(2600).angles,null);
  e.ingest(sample(2020,gravity(0,0),{screenAngle:null}));assert.equal(e.snapshot(2020).angles,null);
});
test('face down, free fall and nonfinite values are unavailable',()=>{
  for(const a of [{x:0,y:0,z:-g},{x:0,y:0,z:0},{x:NaN,y:0,z:g},{x:0,y:Infinity,z:g}]) {
    const e=new SensorEngine();feed(e,a);assert.equal(e.snapshot(2000).angles,null);
  }
});
test('movement retains a live angle and gyro is only a stability gate',()=>{
  const e=new SensorEngine();feed(e,gravity(10,0));assert.equal(e.snapshot(2000).status,'ready');
  e.ingest(sample(2020,gravity(10,0),{rotationRate:{alpha:0,beta:12,gamma:0}}));
  assert.equal(e.snapshot(2020).status,'moving');assert.ok(e.snapshot(2020).angles);assert.equal(e.snapshot(2020).valid,false);
  feed(e,gravity(10,0),2040,3000);near(e.snapshot(3000).angles.roll,10);
});
test('linear acceleration, gravity magnitude and varying gravity reject movement',()=>{
  const variants=[{a:{x:2,y:0,z:g},extra:{}},{a:gravity(0,0),extra:{acceleration:{x:1,y:0,z:0}}},{a:{x:0,y:0,z:12},extra:{}}];
  for(const v of variants) {
    const e=new SensorEngine();feed(e,gravity(0,0));e.ingest(sample(2020,v.a,v.extra));
    assert.equal(e.snapshot(2020).status,'moving');assert.ok(e.snapshot(2020).angles);assert.equal(e.snapshot(2020).valid,false);
  }
});
test('slow direction drift detected by window dispersion even without optional sensors',()=>{
  const e=new SensorEngine();
  for(let t=0;t<=2000;t+=20) e.ingest(sample(t,gravity(t/100,0),{acceleration:null,rotationRate:null}));
  assert.equal(e.snapshot(2000).status,'moving');assert.ok(e.snapshot(2000).angles);assert.equal(e.snapshot(2000).valid,false);
});
for(const gyroAvailable of [true,false]) {
  test(`1 degree/second continuous tilt remains visible and unconfirmed ${gyroAvailable?'with':'without'} gyro`,()=>{
    const e=new SensorEngine();
    for(let t=0;t<=2400;t+=20) {
      e.ingest(sample(t,gravity(t/1000,0),{
        acceleration:null,
        rotationRate:gyroAvailable?{alpha:0,beta:0,gamma:1}:null,
      }));
      if(t>=800) {
        const state=e.snapshot(t);
        assert.equal(state.status,'moving');assert.ok(state.angles);assert.equal(state.valid,false);
        near(state.quality.directionChangeSpeedDegPerSec,1,0.001);
      }
    }
    feed(e,gravity(2.4,0),2420,4000,{acceleration:null,rotationRate:gyroAvailable?{alpha:0,beta:0,gamma:0}:null});
    const stopped=e.snapshot(4000);assert.equal(stopped.status,'ready');near(stopped.angles.roll,2.4,0.01);
  });
}
test('small sensor noise is filtered and optional channels are explicitly absent',()=>{
  const e=new SensorEngine();for(let t=0;t<=2000;t+=20) e.ingest(sample(t,{x:0.015*Math.sin(t),y:0.01*Math.cos(t),z:g},{acceleration:null,rotationRate:null}));
  const s=e.snapshot(2000);assert.equal(s.status,'ready');near(s.angles.roll,0,0.05);
  assert.equal(s.quality.linearAccelerationAvailable,false);assert.equal(s.quality.rotationRateAvailable,false);
  assert.ok(s.quality.directionChangeSpeedDegPerSec<SENSOR_CONFIG.maxDirectionChangeSpeedDegPerSec);
});
test('stationary bounded sensor noise stays readable under conservative motion gates',()=>{
  const e=new SensorEngine();
  for(let t=0;t<=3000;t+=20) {
    const base=gravity(8,-12);
    e.ingest(sample(t,{x:base.x+0.025*Math.sin(t*0.17),y:base.y+0.025*Math.cos(t*0.13),z:base.z+0.015*Math.sin(t*0.11)},
      {acceleration:{x:0.04*Math.sin(t),y:0.03*Math.cos(t),z:0.02},rotationRate:{alpha:0.1*Math.sin(t),beta:0.1*Math.cos(t),gamma:0.1}}));
  }
  const s=e.snapshot(3000);assert.equal(s.status,'ready');near(s.angles.roll,8,0.05);near(s.angles.pitch,-12,0.05);
  assert.ok(s.quality.directionChangeSpeedDegPerSec<SENSOR_CONFIG.maxDirectionChangeSpeedDegPerSec);
});
test('dropout recovery must settle again and timestamps cannot go backwards',()=>{
  const e=new SensorEngine();feed(e,gravity(0,0));e.ingest(sample(3000));
  assert.equal(e.snapshot(3000).status,'settling');e.ingest(sample(2990));assert.equal(e.snapshot(3000).status,'invalid');
});
test('manual calibration rejects short, moving, tilted and stale references',()=>{
  const e=new SensorEngine();feed(e,gravity(0,0),0,800);assert.throws(()=>e.calibrate(800),/1.5/);
  feed(e,gravity(12,0),820,3000);assert.throws(()=>e.calibrate(3000),/5°/);
  assert.throws(()=>e.calibrate(4000),/不稳定/);
});
test('calibration removes a small reference offset in every screen rotation and is reversible',()=>{
  const e=new SensorEngine();feed(e,gravity(2,-1));const calibration=e.calibrate(2000);
  assert.equal(calibration.method,'minimal-device-frame-rotation-to-positive-z');
  for(const angle of [0,90,180,270]) {
    const s=e.snapshot(2000,angle);near(s.angles.roll,0);near(s.angles.pitch,0);
  }
  e.clearCalibration();near(e.snapshot(2000).angles.roll,2);near(e.snapshot(2000).angles.pitch,-1);
});
test('calibration cannot mask later movement or face-down readings',()=>{
  const e=new SensorEngine();feed(e,gravity(1,0));e.calibrate(2000);
  e.ingest(sample(2020,{x:1,y:0,z:13}));assert.ok(e.snapshot(2020).angles);assert.equal(e.snapshot(2020).valid,false);
  feed(e,{x:0,y:0,z:-g},2040,4000);assert.equal(e.snapshot(4000).angles,null);
});
test('history preserves browser raw data and timestamps with defensive copies',()=>{
  const e=new SensorEngine();feed(e,gravity(0,0),0,7000);
  const h=e.getRawSamples(6900,7000);assert.equal(h.length,6);assert.equal(h[0].eventTimeStamp,6898);
  h[0].accelerationIncludingGravity.z=0;assert.equal(e.getRawSamples(6900,6900)[0].accelerationIncludingGravity.z,g);
  assert.ok(e.getRawSamples()[0].receivedPerfMs>=2000);
});
