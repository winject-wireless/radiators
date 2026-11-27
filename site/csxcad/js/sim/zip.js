// Small ZIP32 writer for browser-side result exports. Uses native raw DEFLATE
// when available, otherwise stores entries without compression.
const table = Uint32Array.from({length:256}, (_, n) => {
  for(let i=0;i<8;i++) n=(n>>>1)^((n&1)?0xedb88320:0);
  return n>>>0;
});
function crc32(bytes) {
  let c=0xffffffff;
  for(const b of bytes)c=(c>>>8)^table[(c^b)&255];
  return (c^0xffffffff)>>>0;
}
const limit=0xffffffff;
function check(n){if(n>=limit)throw Error("ZIP exceeds 4 GiB; export fewer cases.");}
function header(size){
  const bytes=new Uint8Array(size),v=new DataView(bytes.buffer);
  return {bytes,u16:(o,n)=>v.setUint16(o,n,true),u32:(o,n)=>v.setUint32(o,n,true)};
}
export async function makeZip(entries,count){
  if(count>=65535)throw Error("Too many ZIP entries.");
  const encoder=new TextEncoder(),local=[],central=[];
  let offset=0,centralSize=0;
  for(const {name,text} of entries){
    const filename=encoder.encode(name),raw=encoder.encode(text);
    if(filename.length>65535)throw Error("ZIP filename too long.");
    check(raw.length);
    let data=raw,method=0;
    if(typeof CompressionStream==="function"){
      try{
        const stream=new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"));
        const compressed=new Uint8Array(await new Response(stream).arrayBuffer());
        if(compressed.length<raw.length){data=compressed;method=8;}
      }catch{} // Older engines may not implement raw DEFLATE.
    }
    const crc=crc32(raw),l=header(30),c=header(46);
    l.u32(0,0x04034b50);l.u16(4,20);l.u16(6,0x800);l.u16(8,method);
    l.u16(12,33);l.u32(14,crc);l.u32(18,data.length);l.u32(22,raw.length);l.u16(26,filename.length);
    c.u32(0,0x02014b50);c.u16(4,20);c.u16(6,20);c.u16(8,0x800);c.u16(10,method);
    c.u16(14,33);c.u32(16,crc);c.u32(20,data.length);c.u32(24,raw.length);c.u16(28,filename.length);c.u32(42,offset);
    local.push(l.bytes,filename,data);central.push(c.bytes,filename);
    offset+=30+filename.length+data.length;centralSize+=46+filename.length;
    check(offset+centralSize+22);
  }
  const end=header(22);
  end.u32(0,0x06054b50);end.u16(8,count);end.u16(10,count);end.u32(12,centralSize);end.u32(16,offset);
  return new Blob([...local,...central,end.bytes],{type:"application/zip"});
}
