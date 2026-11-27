import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crc32,shotZip,sha256} from '../docs/storage.js';
test('CRC32 matches published standard check vector', () => assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926));
test('photo and JSON share ID, ZIP stores exact original bytes and hash', async () => {
  const photo = new Blob([new Uint8Array([0xff,0xd8,0,5,8,0xff,0xd9])],{type:'image/jpeg'});
  const metadata = {id:'shot-test-1',photo:{filename:'shot-test-1.jpg',sha256:await sha256(photo)}};
  const bytes = new Uint8Array(await (await shotZip({id:metadata.id,photo,metadata})).arrayBuffer());
  const view = new DataView(bytes.buffer), entries=[]; let offset=0;
  while(view.getUint32(offset,true)===0x04034b50) {
    const length=view.getUint32(offset+18,true), n=view.getUint16(offset+26,true), start=offset+30+n;
    const name=new TextDecoder().decode(bytes.slice(offset+30,start));
    const data=bytes.slice(start,start+length);
    assert.equal(crc32(data),view.getUint32(offset+14,true)); entries.push({name,data}); offset=start+length;
  }
  assert.equal(entries.length,2); assert.equal(entries[0].name,'shot-test-1.jpg'); assert.equal(entries[1].name,'shot-test-1.json');
  assert.deepEqual(entries[0].data,new Uint8Array(await photo.arrayBuffer()));
  assert.equal(JSON.parse(new TextDecoder().decode(entries[1].data)).photo.sha256,await sha256(photo));
  assert.equal(view.getUint32(offset,true),0x02014b50); assert.equal(view.getUint32(bytes.length-22,true),0x06054b50);
});
