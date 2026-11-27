import {inspectPhoto} from './photo.js';
import {sha256} from './storage.js';
import {previewRelation} from './camera.js';
import {signGuide} from './pose.js';

export const methods={'image-capture-still':'A 网页静态照片','video-frame-png':'A 网页视频帧',
  'system-confirmed':'B 系统拍摄（本人确认）','system-unconfirmed':'B 系统入口（未确认）',
  'gallery-from-system':'C 已有照片（系统入口只开了相册）','native-import':'C 导入原图'};
export function areaFromPoints(points,dimensions) {
  if (!dimensions || points.length<3) return null;
  const area=points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p.x*q.y-q.x*p.y;},0);
  return Math.round(Math.abs(area)*dimensions.width*dimensions.height/2);
}
export async function formShot(data) {
  const {blob,id,method}=data, isWeb=['image-capture-still','video-frame-png'].includes(method);
  const [file,hash]=await Promise.all([inspectPhoto(blob),sha256(blob)]);
  const duration=data.complete.perfMs-data.begin.perfMs;
  const metadata={
    schema:'nail-camera/0.2',id,method,methodLabel:methods[method],
    photo:{filename:id+'.'+file.extension,bytes:blob.size,mime:blob.type || null,sha256:hash,...file},
    provenance:{exif:'照片EXIF实读',cameraAndRawSamples:'浏览器接口实读',anglesAndManualAreas:'算法估计',
      manufacturerSpecificationsUsed:false,unknown:'无法获取',motionAxes:signGuide},
    timing:{clock:'performance.now in ms, performance.timeOrigin for this page; independent system wall clock in ISO UTC',
      action:data.action,request:data.begin,complete:data.complete,
      requestMeaning:isWeb ? '实际成功的静态 API 请求或复制视频帧的起点' : '打开系统选择器/导入入口的时刻',
      completionMeaning:isWeb ? '浏览器返回照片文件/完成视频帧编码' : '页面收到文件的时刻',
      browserOperationMs:duration,exposureInstant:null,exposureClockSource:'无法获取',exifOriginalTime:file.originalDateTime,
      synchronized:false,uncertaintyMs:null,
      uncertainty:isWeb ? '软件请求和返回之间耗时已记录。曝光可能来自缓冲帧，API 未报告曝光事件与姿态时钟的关系，误差无可验证上界。' :
        '照片来自外部相机或已有文件。网页可能暂停，文件 EXIF 时间也未与页面时钟校准，无法确定曝光姿态。'},
    posture:{atExposure:null,atRequest:isWeb ? data.before?.pose || null : null,
      atReturn:isWeb ? data.returnPose || null : null,
      calibrationAtRequest:isWeb ? data.before?.pose?.calibration || null : null,
      calibrationAtContextStart:data.before?.pose?.calibration || null,
      externalLaunchContext:!isWeb && data.before ? data.before.pose : null,
      validity:isWeb ? (data.before?.pose?.status || 'no-data') : 'exposure-pose-unavailable',
      samples:{beforeRequest:data.before?.raw || [],nearCompletion:data.nearCompletion || [],afterCompletion:data.after || [],
        windows:data.windows || null,unit:'motion m/s², rotationRate deg/s, orientation angles deg, arrival and event times ms',
        note:'同一事件可能属于两个时间窗，以来源和 receivedPerfMs 去重。外部入口只记录页面实际收到的上下文。'},
      permissionStates:data.permissions || {},calibrationScope:'仅当前会话及数据来源'},
    camera:isWeb ? data.camera : null,cameraAvailability:isWeb && data.camera ? '浏览器接口实读' : '无法获取',photoRequests:data.tries || [],captureReason:data.reason,
    preview:previewRelation(method,isWeb ? data.geometry : null),frameCopy:data.frameInfo || null,
    external:data.external || null, review:{points:[],estimatedNailPixels:null,notes:'',source:'无法获取'}
  };
  return {id,createdAt:Date.parse(data.complete.wallIso),photo:blob,metadata};
}
