import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = new Uint32Array(256);
for(let n=0;n<256;n++) { let c=n; for(let k=0;k<8;k++) c=c&1 ? 0xedb88320^(c>>>1) : c>>>1; CRC_TABLE[n]=c>>>0; }
function crcStep(crc, buf){for(let i=0;i<buf.length;i++) crc=CRC_TABLE[(crc^buf[i])&0xff]^(crc>>>8);return crc>>>0;}
export function crc32(buf){return (crcStep(0xffffffff,buf)^0xffffffff)>>>0;}
function validName(name){return typeof name==='string' && !name.includes('\\') && !name.startsWith('/') && !name.split('/').some(p=>p==='..'||p===''||p==='.') && !name.includes('\0');}
async function crcFile(file) { const s=fs.createReadStream(file);let crc=0xffffffff,size=0;for await (const chunk of s){size+=chunk.length;crc=crcStep(crc,chunk);}return {size,crc:(crc^0xffffffff)>>>0}; }
function dateFields(){return {time:0,date:0};}
export async function makeZip(files, destination){
  // files: [{name, file? , data?}]; stored entries only, intentionally no RAM-intensive compression
  const fh=await fsp.open(destination,'w'); let position=0;const central=[];
  async function write(buf){await fh.write(buf,0,buf.length,position);position+=buf.length;}
  try {
    for(const ent of files){
      if(!validName(ent.name)) throw Error('Invalid ZIP filename');
      const nameBuf=Buffer.from(ent.name,'utf8');
      const data=ent.file?null:Buffer.from(ent.data||'');
      const info=ent.file?await crcFile(ent.file):{size:data.length,crc:crc32(data)};
      if(info.size>0xffffffff)throw Error('Single file exceeds ZIP32 limit');
      const offset=position;const head=Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50,0);head.writeUInt16LE(20,4);head.writeUInt16LE(0x0800,6);
      head.writeUInt16LE(0,8);head.writeUInt16LE(0,10);head.writeUInt16LE(0,12);
      head.writeUInt32LE(info.crc,14);head.writeUInt32LE(info.size,18);head.writeUInt32LE(info.size,22);head.writeUInt16LE(nameBuf.length,26);
      await write(head);await write(nameBuf);
      if(ent.file){for await(const chunk of fs.createReadStream(ent.file))await write(chunk);} else await write(data);
      central.push({nameBuf,info,offset});
    }
    const centralStart=position;
    for(const ent of central){const h=Buffer.alloc(46);h.writeUInt32LE(0x02014b50,0);h.writeUInt16LE(20,4);
      h.writeUInt16LE(20,6);h.writeUInt16LE(0x0800,8);h.writeUInt16LE(0,10);
      h.writeUInt32LE(ent.info.crc,16);h.writeUInt32LE(ent.info.size,20);h.writeUInt32LE(ent.info.size,24);
      h.writeUInt16LE(ent.nameBuf.length,28);h.writeUInt32LE(ent.offset,42);
      await write(h);await write(ent.nameBuf);
    }
    const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(central.length,8);
    end.writeUInt16LE(central.length,10);end.writeUInt32LE(position-centralStart,12);end.writeUInt32LE(centralStart,16);await write(end);
    await fh.sync();
  } finally {await fh.close();}
}
export async function extractZip(file,dest,{maxBytes=1024*1024*1024,maxEntries=300}={}){
  const fh=await fsp.open(file,'r');const stat=await fh.stat();const size=stat.size;
  try {
    if(size>maxBytes || size<22)throw Error('ZIP size invalid or exceeds limit');
    const tailSize=Math.min(size,65557);const tail=Buffer.alloc(tailSize);await fh.read(tail,0,tailSize,size-tailSize);
    let end=-1;for(let i=tailSize-22;i>=0;i--){if(tail.readUInt32LE(i)===0x06054b50){end=i;break;}}
    if(end<0)throw Error('ZIP central directory not found');
    const count=tail.readUInt16LE(end+10),cdSize=tail.readUInt32LE(end+12),cdStart=tail.readUInt32LE(end+16);
    if(count>maxEntries||cdStart+cdSize>size)throw Error('ZIP entries invalid');
    const cd=Buffer.alloc(cdSize);await fh.read(cd,0,cdSize,cdStart);let pos=0,total=0;const entries=[];
    for(let i=0;i<count;i++){
      if(pos+46>cd.length||cd.readUInt32LE(pos)!==0x02014b50)throw Error('Invalid central directory');
      const method=cd.readUInt16LE(pos+10),flags=cd.readUInt16LE(pos+8);
      const crc=cd.readUInt32LE(pos+16),compressed=cd.readUInt32LE(pos+20),original=cd.readUInt32LE(pos+24);
      const nameLen=cd.readUInt16LE(pos+28),extraLen=cd.readUInt16LE(pos+30),commentLen=cd.readUInt16LE(pos+32),offset=cd.readUInt32LE(pos+42);
      if(pos+46+nameLen+extraLen+commentLen>cd.length)throw Error('Truncated central directory');
      const name=cd.subarray(pos+46,pos+46+nameLen).toString('utf8');pos+=46+nameLen+extraLen+commentLen;
      if(!validName(name)||!([0,8].includes(method))||(flags&1)||original>maxBytes)throw Error('Unsupported or unsafe ZIP entry');
      total+=original;if(total>maxBytes)throw Error('Extracted ZIP too large');
      if(name!=='project.json' && !/^media\/[a-zA-Z0-9._-]+$/.test(name))throw Error('Unexpected file in ZIP');
      entries.push({name,method,compressed,original,crc,offset});
    }
    for(const e of entries){const head=Buffer.alloc(30);await fh.read(head,0,30,e.offset);
      if(head.readUInt32LE(0)!==0x04034b50)throw Error('Invalid local ZIP entry');
      const datapos=e.offset+30+head.readUInt16LE(26)+head.readUInt16LE(28);
      if(datapos+e.compressed>size)throw Error('Invalid ZIP offsets');
      const data=Buffer.alloc(e.compressed);await fh.read(data,0,e.compressed,datapos);
      const decoded=e.method===0?data:zlib.inflateRawSync(data,{maxOutputLength:Math.min(maxBytes,e.original+1)});
      if(decoded.length!==e.original||crc32(decoded)!==e.crc)throw Error('ZIP checksum mismatch');
      const target=path.join(dest,...e.name.split('/'));await fsp.mkdir(path.dirname(target),{recursive:true});await fsp.writeFile(target,decoded);
    }
    return entries.map(e=>e.name);
  } finally {await fh.close();}
}
