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

// Read the central directory rather than trusting local headers (data
// descriptors are common in third-party ZIPs). Only JSON entries are exposed.
export async function openZip(blob){
  const endSize=Math.min(blob.size,65557);
  const tail=new Uint8Array(await blob.slice(blob.size-endSize).arrayBuffer());
  const v=new DataView(tail.buffer);
  let end=-1;
  for(let i=tail.length-22;i>=0;i--){
    if(v.getUint32(i,true)===0x06054b50&&i+22+v.getUint16(i+20,true)===tail.length){end=i;break;}
  }
  if(end<0)throw Error("Invalid ZIP end directory");
  const count=v.getUint16(end+10,true), size=v.getUint32(end+12,true), offset=v.getUint32(end+16,true);
  if(v.getUint16(end+4,true)||v.getUint16(end+6,true)||count!==v.getUint16(end+8,true)||count===65535||size===limit||offset===limit)
    throw Error("Multi-disk and ZIP64 archives are unsupported");
  if(count>4096||size>16*1024*1024||offset+size>blob.size-endSize+end)throw Error("Invalid or oversized ZIP directory");
  const bytes=new Uint8Array(await blob.slice(offset,offset+size).arrayBuffer()), d=new DataView(bytes.buffer);
  const files=new Map(), decoder=new TextDecoder("utf-8",{fatal:true});
  let pos=0,total=0;
  for(let i=0;i<count;i++){
    if(pos+46>bytes.length||d.getUint32(pos,true)!==0x02014b50)throw Error("Invalid ZIP directory entry");
    const flags=d.getUint16(pos+8,true),method=d.getUint16(pos+10,true),crc=d.getUint32(pos+16,true),
      compressed=d.getUint32(pos+20,true),raw=d.getUint32(pos+24,true),nl=d.getUint16(pos+28,true),
      xl=d.getUint16(pos+30,true),cl=d.getUint16(pos+32,true),local=d.getUint32(pos+42,true);
    const next=pos+46+nl+xl+cl;
    if(next>bytes.length)throw Error("Truncated ZIP directory entry");
    const name=decoder.decode(bytes.subarray(pos+46,pos+46+nl));
    pos=next;
    if(!name.toLowerCase().endsWith(".json"))continue;
    if(flags&1||![0,8].includes(method)||raw>256*1024*1024||compressed>256*1024*1024||local+30>offset)throw Error("Unsupported or oversized ZIP entry: "+name);
    total+=raw;if(total>1024*1024*1024)throw Error("ZIP JSON content exceeds 1 GiB");
    if(files.has(name))throw Error("Duplicate ZIP entry: "+name);
    files.set(name,async()=>{
      const h=new DataView(await blob.slice(local,local+30).arrayBuffer());
      if(h.getUint32(0,true)!==0x04034b50||h.getUint16(8,true)!==method)throw Error("Invalid ZIP local header: "+name);
      const start=local+30+h.getUint16(26,true)+h.getUint16(28,true);
      if(start+compressed>offset)throw Error("Truncated ZIP entry: "+name);
      let data;
      if(method===0)data=new Uint8Array(await blob.slice(start,start+compressed).arrayBuffer());
      else{
        if(typeof DecompressionStream!=="function")throw Error("This browser cannot decompress ZIP archives");
        const reader=blob.slice(start,start+compressed).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
        data=new Uint8Array(raw);let n=0;
        try{for(;;){const {done,value}=await reader.read();if(done)break;if(n+value.length>raw)throw Error("ZIP entry exceeds declared size");data.set(value,n);n+=value.length;}}
        finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
        if(n!==raw)throw Error("Incorrect decompressed ZIP size");
      }
      if(data.length!==raw||crc32(data)!==crc)throw Error("ZIP checksum mismatch: "+name);
      return JSON.parse(decoder.decode(data));
    });
  }
  return files;
}
