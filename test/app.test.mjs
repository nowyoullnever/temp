import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {makeZip,extractZip,crc32} from '../zip.mjs';

const wav=()=>{
  const b=Buffer.alloc(44+44100*2);b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(44100,24);b.writeUInt32LE(88200,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(88200,40);
  for(let i=0;i<44100;i++)b.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/44100)*3000),44+i*2);return b;
};

test('ZIP creation/extraction CRC and exact bytes',async()=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'sbs-zip-'));
  try{const payload=wav();const archive=path.join(tmp,'test.zip');
    await makeZip([{name:'project.json',data:JSON.stringify({ok:true})},{name:'media/test.wav',data:payload}],archive);
    const folder=path.join(tmp,'extracted');await extractZip(archive,folder);
    assert.equal(JSON.parse(await readFile(path.join(folder,'project.json'),'utf8')).ok,true);
    assert.equal(Buffer.compare(payload,await readFile(path.join(folder,'media/test.wav'))),0);
    assert.equal(crc32(Buffer.from('123456789')),0xcbf43926);
  }finally{await rm(tmp,{recursive:true,force:true});}
});

test('Local server: creates, persists, locks revisions, backs up, handles media and ZIP round trip',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'sbs-server-'));
  const port=45000+Math.floor(Math.random()*15000);const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,PORT:String(port),SBS_DATA_DIR:root},stdio:['ignore','pipe','pipe']});
  let err='';child.stderr.on('data',d=>err+=d);
  async function request(url,method='GET',body,headers={}){
    const r=await fetch(base+url,{method,body,headers});const ct=r.headers.get('content-type')||'';
    const data=ct.includes('json')?await r.json():Buffer.from(await r.arrayBuffer());return {status:r.status,data,headers:r.headers};
  }
  try{
    let ok=false;for(let i=0;i<100;i++){try{if((await request('/api/health')).data.ok){ok=true;break;}}catch{}await new Promise(r=>setTimeout(r,60));}
    assert.ok(ok,'Server failed to start: '+err);
    let out=await request('/api/projects','POST',JSON.stringify({name:'Test Session'}),{'content-type':'application/json'});assert.equal(out.status,201);
    let p=out.data.project;const id=p.id;assert.equal(p.scenes.length,4);
    assert.deepEqual(Object.fromEntries(['backgroundImageId','backgroundImageOpacity','backgroundImageFit','fontAssetId','fontFamily'].map(k=>[k,p.scenes[0][k]])),{backgroundImageId:null,backgroundImageOpacity:0.22,backgroundImageFit:'cover',fontAssetId:null,fontFamily:'Inter, Segoe UI, Arial, sans-serif'});
    p.scenes[0].title='Intro survives restart';
    out=await request(`/api/projects/${id}/save`,'PUT',JSON.stringify(p),{'content-type':'application/json'});assert.equal(out.status,200);p=out.data.project;assert.equal(p.revision,1);
    out=await request(`/api/projects/${id}/save`,'PUT',JSON.stringify({...p,revision:0}),{'content-type':'application/json'});assert.equal(out.status,409);
    out=await request(`/api/projects/${id}/assets?name=original.wav&mime=audio%2Fwav`,'POST',wav(),{'content-type':'application/octet-stream'});assert.equal(out.status,201);p=out.data.project;
    const asset=out.data.asset;assert.equal(asset.kind,'audio');
    const png=Buffer.from('89504e470d0a1a0a','hex');out=await request(`/api/projects/${id}/assets?name=background.png&mime=image%2Fpng`,'POST',png,{'content-type':'application/octet-stream'});assert.equal(out.status,201);const background=out.data.asset;assert.equal(background.kind,'image');p=out.data.project;
    const fontBytes=Buffer.from('wOFFtest');let font;
    for(const [name,mime] of [['display.ttf','font/ttf'],['display.otf','font/otf'],['display.woff','font/woff'],['display.woff2','font/woff2']]){out=await request(`/api/projects/${id}/assets?name=${name}&mime=${encodeURIComponent(mime)}`,'POST',fontBytes,{'content-type':'application/octet-stream'});assert.equal(out.status,201);assert.equal(out.data.asset.kind,'font');font=out.data.asset;p=out.data.project;}
    p.scenes[1].audioId=asset.id;p.scenes[1].audioStart=0.3;p.scenes[0].backgroundImageId=background.id;p.scenes[0].backgroundImageOpacity=.67;p.scenes[0].backgroundImageFit='contain';p.scenes[0].fontAssetId=font.id;p.scenes[0].fontFamily='Custom Fallback, serif';
    out=await request(`/api/projects/${id}/save`,'PUT',JSON.stringify(p),{'content-type':'application/json'});assert.equal(out.status,200);p=out.data.project;
    out=await request(`/api/projects/${id}/assets/${asset.id}`,'GET',undefined,{'range':'bytes=0-3'});assert.equal(out.status,206);assert.equal(out.data.toString(),'RIFF');
    out=await request(`/api/projects/${id}/download`);assert.equal(out.status,200);assert.equal(out.data.subarray(0,4).toString('hex'),'504b0304');
    const zipped=out.data;
    out=await request('/api/import','POST',zipped,{'content-type':'application/zip'});assert.equal(out.status,201);const copy=out.data.project;assert.notEqual(copy.id,id);
    assert.equal(copy.scenes[1].audioId,asset.id);assert.equal(copy.scenes[0].title,'Intro survives restart');
    assert.equal(copy.scenes[0].backgroundImageId,background.id);assert.equal(copy.scenes[0].backgroundImageOpacity,.67);assert.equal(copy.scenes[0].backgroundImageFit,'contain');assert.equal(copy.scenes[0].fontAssetId,font.id);assert.equal(copy.scenes[0].fontFamily,'Custom Fallback, serif');
    out=await request(`/api/projects/${copy.id}/assets/${asset.id}`);assert.equal(out.status,200);assert.equal(out.data.length,wav().length);
    out=await request(`/api/projects/${copy.id}/assets/${font.id}`);assert.equal(out.status,200);assert.equal(Buffer.compare(out.data,fontBytes),0);
    out=await request(`/api/projects/${id}/backups`);assert.equal(out.status,200);assert.ok(out.data.backups.length>0);const backups=out.data.backups;
    const original=await request(`/api/projects/${id}`);assert.equal(original.data.project.scenes[1].audioStart,0.3);
    const json=JSON.parse(await readFile(path.join(root,'projects',id,'project.json'),'utf8'));
    assert.equal(json.scenes[0].title,'Intro survives restart');assert.ok((await readdir(path.join(root,'projects',id,'backups'))).length>0);
    // v0.1 projects lacking visual/font fields are opened with v0.2 defaults without deleting media.
    delete json.scenes[0].backgroundImageId;delete json.scenes[0].backgroundImageOpacity;delete json.scenes[0].backgroundImageFit;delete json.scenes[0].fontAssetId;delete json.scenes[0].fontFamily;await writeFile(path.join(root,'projects',id,'project.json'),JSON.stringify(json));
    out=await request(`/api/projects/${id}`);assert.equal(out.status,200);assert.equal(out.data.project.scenes[0].backgroundImageOpacity,.22);assert.equal(out.data.project.scenes[0].backgroundImageFit,'cover');assert.equal(out.data.project.scenes[0].fontFamily,'Inter, Segoe UI, Arial, sans-serif');
    // Restore snapshot and check user-facing backup cycle works.
    out=await request(`/api/projects/${id}/backups/${backups[0]}/restore`,'POST');assert.equal(out.status,200);
    assert.ok(out.data.project.revision>p.revision);
    // Even if the main JSON is corrupted, the server can recover its last valid snapshot.
    await writeFile(path.join(root,'projects',id,'project.json'),'{BROKEN JSON');
    out=await request(`/api/projects/${id}`);assert.equal(out.status,200);
    assert.equal(out.data.project.id,id);
  }finally{child.kill();await rm(root,{recursive:true,force:true});}
});
