const tags = new Map([
  [0x010f,'make'],[0x0110,'model'],[0x0112,'orientation'],[0xa434,'lensModel'],
  [0x920a,'focalLengthMm'],[0xa405,'equivalent35mm'],[0xa404,'digitalZoomRatio'],
  [0xa002,'exifWidth'],[0xa003,'exifHeight'],[0x9003,'dateTimeOriginal'],[0x9011,'offsetTimeOriginal'],
  [0x9291,'subSecTimeOriginal'],[0x829a,'exposureTimeSec'],[0x8827,'iso'],[0x8833,'isoSpeed'],
  [0x829d,'fNumber']
]);
export const photoLabels = {make:'品牌',model:'手机型号',lensModel:'镜头型号',focalLengthMm:'实际焦距（mm）',
  equivalent35mm:'35 mm 等效焦距（mm）',digitalZoomRatio:'数字变焦倍率',exifWidth:'EXIF 像素宽',exifHeight:'EXIF 像素高',
  dateTimeOriginal:'原拍摄时间',offsetTimeOriginal:'时区偏移',subSecTimeOriginal:'秒的小数位',exposureTimeSec:'曝光时长（秒）',
  iso:'ISO 感光度',isoSpeed:'ISO Speed',fNumber:'光圈值',orientation:'EXIF 方向'};
export function evidence(value, source, detail) {
  return {value:value ?? null, source:value == null ? '无法获取' : source, detail:detail || null};
}
// Read only whitelisted fields in IFD0 and ExifIFD. Never follow GPS, MakerNote or thumbnail pointers.
function tiff(bytes) {
  const d = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if (d.byteLength < 8) throw new Error('EXIF 头不完整');
  const little = d.getUint16(0) === 0x4949;
  if ((!little && d.getUint16(0) !== 0x4d4d) || d.getUint16(2,little) !== 42) throw new Error('不支持的 TIFF 头');
  const u16 = pos => d.getUint16(pos,little), u32 = pos => d.getUint32(pos,little);
  const values = {};
  function readIFD(base, primary) {
    if (base < 8 || base+2 > d.byteLength) return;
    const count = u16(base);
    if (base+2+12*count > d.byteLength) return;
    let sub = null;
    for (let i=0; i<count; i++) {
      const p = base+2+12*i, id = u16(p), type = u16(p+2), n = u32(p+4);
      if (primary && id === 0x8769 && type === 4 && n === 1) { sub = u32(p+8); continue; }
      if (!tags.has(id) || n === 0 || n > 2048) continue;
      const size = ({1:1,2:1,3:2,4:4,5:8,7:1,9:4,10:8})[type];
      if (!size) continue;
      const start = n*size <= 4 ? p+8 : u32(p+8);
      if (start+n*size > d.byteLength) continue;
      let value;
      if (type === 2) {
        value = new TextDecoder().decode(bytes.subarray(start,start+n)).split('\0')[0].trim();
      } else if (type === 3) value = u16(start);
      else if (type === 4) value = u32(start);
      else if (type === 9) value = d.getInt32(start,little);
      else if (type === 5 || type === 10) {
        const word = at => type === 5 ? u32(at) : d.getInt32(at,little), divisor = word(start+4);
        if (divisor) value = word(start) / divisor;
      } else if (type === 1) value = d.getUint8(start);
      if (value !== undefined && value !== '' && (typeof value !== 'number' || Number.isFinite(value))) values[tags.get(id)] = value;
    }
    if (primary && sub !== null && sub !== base) readIFD(sub,false);
  }
  readIFD(u32(4),true);
  return values;
}
export function readHeaders(bytes) {
  const d = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let format = null, dimensions = null, values = {}, status = '此格式未解析 EXIF；保留原文件';
  if (bytes.length >= 24 && d.getUint32(0)===0x89504e47 && d.getUint32(4)===0x0d0a1a0a && d.getUint32(12)===0x49484452) {
    format='png'; dimensions={width:d.getUint32(16),height:d.getUint32(20)};
  } else if (bytes.length>=2 && d.getUint16(0)===0xffd8) {
    format='jpeg'; status='未找到可读取的 JPEG EXIF';
    const sof = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
    let p=2;
    while (p+4<=bytes.length && bytes[p]===0xff) {
      while (bytes[p]===0xff) p++;
      const marker=bytes[p++];
      if (marker===0xda || marker===0xd9 || p+2>bytes.length) break;
      if (marker===1 || (marker>=0xd0 && marker<=0xd7)) continue;
      const size=d.getUint16(p), start=p+2, end=p+size;
      if (size<2 || end>bytes.length) { if (!Object.keys(values).length) status='文件头不完整或超过读取范围'; break; }
      if (sof.has(marker) && size>=8) dimensions={height:d.getUint16(start+1),width:d.getUint16(start+3)};
      if (marker===0xe1 && end-start>=6 && d.getUint32(start)===0x45786966 && d.getUint16(start+4)===0) {
        try { values={...values,...tiff(bytes.subarray(start+6,end))}; status=Object.keys(values).length ? '已读取列出的 EXIF 字段' : 'EXIF 没有可用的目标字段'; }
        catch (ex) { status=ex.message; }
      }
      p=end;
    }
  }
  const exif=Object.fromEntries([...tags.values()].map(k=>[k,evidence(values[k],'照片EXIF实读',k==='digitalZoomRatio' && values[k]===0 ? 'EXIF 的 0 表示未使用数字变焦' :
    k==='equivalent35mm' && values[k]===0 ? 'EXIF 的 0 表示等效焦距未知' : null)]));
  if (!dimensions?.width || !dimensions?.height) dimensions=null;
  return {format,dimensions,exif,status};
}
async function decodeSize(blob) {
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap=await createImageBitmap(blob);
      const dimensions={width:bitmap.width,height:bitmap.height}; bitmap.close(); return dimensions;
    }
  } catch { /* Try the browser image decoder. */ }
  if (typeof Image==='undefined') return null;
  const url=URL.createObjectURL(blob);
  try {
    const img=new Image(); img.src=url; await img.decode();
    return img.naturalWidth && img.naturalHeight ? {width:img.naturalWidth,height:img.naturalHeight} : null;
  } catch {return null;} finally {URL.revokeObjectURL(url);}
}
export async function inspectPhoto(blob) {
  const header=readHeaders(new Uint8Array(await blob.slice(0,8*1024*1024).arrayBuffer()));
  let display=header.dimensions;
  const orientation=header.exif.orientation.value;
  if (display && [5,6,7,8].includes(orientation)) display={width:display.height,height:display.width};
  if (!display) display=await decodeSize(blob);
  const ext=header.format==='jpeg' ? 'jpg' : header.format || (blob.name||'').match(/\.(jpe?g|heic|heif|avif|webp|png|tiff?|gif|bmp|dng)$/i)?.[1].toLowerCase()
    || ({'image/jpeg':'jpg','image/heic':'heic','image/heif':'heif','image/webp':'webp','image/avif':'avif','image/png':'png'})[blob.type] || 'bin';
  return {extension:ext,format:header.format || blob.type || ext, exifStatus:header.status, exif:header.exif,
    encodedDimensions:evidence(header.dimensions,'浏览器接口实读',header.format==='jpeg' ? '原文件 JPEG SOF' : header.format==='png' ? '原文件 PNG IHDR' : '未解析编码像素矩阵'),
    displayDimensions:evidence(display,header.dimensions ? (orientation>=5 && orientation<=8 ? '算法估计' : '浏览器接口实读') : '浏览器接口实读',
      header.dimensions ? '文件尺寸，按 EXIF 方向显示' : '浏览器实际解码，可含方向变换'),
    originalDateTime:{dateTimeOriginal:header.exif.dateTimeOriginal.value, subSecond:header.exif.subSecTimeOriginal.value,
      utcOffset:header.exif.offsetTimeOriginal.value, synchronizedExposureInstant:null}};
}
