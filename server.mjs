import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {pipeline} from 'node:stream/promises';
import {spawn} from 'node:child_process';
import {makeZip,extractZip} from './zip.mjs';

const PORT=Number(process.env.PORT||4321);
const HOST=process.env.HOST||'127.0.0.1';
const BASE=path.resolve(process.env.SBS_DATA_DIR||path.join(os.homedir(),'Documents','SampleBreakdownStudio'));
const PROJECTS=path.join(BASE,'projects');
const PUBLIC=path.join(path.dirname(fileURLToPath(import.meta.url)),'public');
const CONTENT_TYPES={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon'};
const JSON_LIMIT=3*1024*1024, MEDIA_LIMIT=750*1024*1024, ZIP_LIMIT=1024*1024*1024;
const ID_RE=/^[a-zA-Z0-9_-]{6,60}$/;
const safeId=id=>ID_RE.test(id||'');
const newId=()=>crypto.randomBytes(9).toString('hex');
const now=()=>new Date().toISOString();
const projDir=id=>path.join(PROJECTS,id);
const jsonPath=id=>path.join(projDir(id),'project.json');
const send=(res,code,data)=>{const body=Buffer.from(JSON.stringify(data));res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-length':body.length});res.end(body);};
function fail(status,message){const e=new Error(message);e.status=status;return e;}
async function exists(file){try{await fsp.access(file);return true;}catch{return false;}}
async function writeAtomic(file,data){await fsp.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+newId()+'.tmp';let fh;
  try{fh=await fsp.open(temp,'wx');await fh.writeFile(data);await fh.sync();await fh.close();fh=null;await fsp.rename(temp,file);
    // Sync the directory metadata where supported. Windows sometimes refuses directory handles.
    let dh;try{dh=await fsp.open(path.dirname(file),'r');await dh.sync();}catch{}finally{if(dh)await dh.close().catch(()=>{});}
  }finally{if(fh)await fh.close().catch(()=>{});await fsp.rm(temp,{force:true}).catch(()=>{});}
}
async function loadProject(id){
  if(!safeId(id))throw fail(400,'잘못된 프로젝트 ID');
  try {const p=JSON.parse(await fsp.readFile(jsonPath(id),'utf8'));if(p.id!==id)throw Error('ID mismatch');return withSceneDefaults(p);}
  catch(e){
    // The canonical JSON is atomically replaced, but if it was manually damaged or
    // disappeared after a crash, recover a valid recent snapshot without touching media.
    const backupDir=path.join(projDir(id),'backups');
    const files=(await fsp.readdir(backupDir).catch(()=>[])).filter(n=>/^\d{4}-.*\.json$/.test(n)).sort().reverse();
    for(const name of files){try{const p=JSON.parse(await fsp.readFile(path.join(backupDir,name),'utf8'));
      if(p.id!==id || !Array.isArray(p.scenes) || !Array.isArray(p.assets))continue;
       await writeAtomic(jsonPath(id),JSON.stringify(p,null,2));
       console.warn(`Recovered ${id} from ${name}`);return withSceneDefaults(p);
    }catch{}}
    if(e.code==='ENOENT')throw fail(404,'프로젝트가 없습니다. 자동 복구할 백업도 없습니다.');
    throw fail(500,'프로젝트 파일을 읽을 수 없고 복구 가능한 백업도 없습니다.');
  }
}
function makeDefault(name='Untitled Breakdown'){
  const ids=Array.from({length:4},()=>newId());return withSceneDefaults({version:1,id:newId(),name:String(name).slice(0,100),format:'16:9',createdAt:now(),updatedAt:now(),revision:0,assets:[],scenes:[
    {id:ids[0],type:'intro',title:'SAMPLE BREAKDOWN',subtitle:'VOL. 001',duration:2.5,preset:'type',transition:'cut',transitionDuration:0.5,bg:'#13151b',accent:'#dfddcf',imageId:null,backgroundImageId:null,backgroundImageOpacity:0.22,backgroundImageFit:'cover',fontAssetId:null,fontFamily:'Inter, Segoe UI, Arial, sans-serif',audioId:null,audioStart:0,volume:1,audioFadeIn:0.15,audioFadeOut:0.2,showWaveform:false},
    {id:ids[1],type:'original',title:'ORIGINAL SAMPLE',subtitle:'Artist · Track',duration:8,preset:'center',transition:'fade',transitionDuration:0.5,bg:'#171b21',accent:'#a3c6b7',imageId:null,backgroundImageId:null,backgroundImageOpacity:0.22,backgroundImageFit:'cover',fontAssetId:null,fontFamily:'Inter, Segoe UI, Arial, sans-serif',audioId:null,audioStart:0,volume:1,audioFadeIn:0.15,audioFadeOut:0.2,showWaveform:true},
    {id:ids[2],type:'sample',title:'THE FLIP',subtitle:'Your track',duration:8,preset:'split',transition:'wipe',transitionDuration:0.45,bg:'#181820',accent:'#d9bba5',imageId:null,backgroundImageId:null,backgroundImageOpacity:0.22,backgroundImageFit:'cover',fontAssetId:null,fontFamily:'Inter, Segoe UI, Arial, sans-serif',audioId:null,audioStart:0,volume:1,audioFadeIn:0.15,audioFadeOut:0.2,showWaveform:true},
    {id:ids[3],type:'outro',title:'END OF BREAKDOWN',subtitle:'Thank you for listening',duration:2.5,preset:'minimal',transition:'fade',transitionDuration:0.5,bg:'#13151b',accent:'#dfddcf',imageId:null,backgroundImageId:null,backgroundImageOpacity:0.22,backgroundImageFit:'cover',fontAssetId:null,fontFamily:'Inter, Segoe UI, Arial, sans-serif',audioId:null,audioStart:0,volume:1,audioFadeIn:0.15,audioFadeOut:0.2,showWaveform:false}
  ]});
}
function validateProject(input,expectedId){
  if(!input||typeof input!=='object'||!Array.isArray(input.scenes)||!Array.isArray(input.assets))throw fail(400,'프로젝트 형식이 올바르지 않습니다.');
  if(input.scenes.length<1||input.scenes.length>100||input.assets.length>500)throw fail(400,'장면 또는 에셋 개수 제한 초과');
  const str=(x,max=200)=>typeof x==='string'?x.slice(0,max):'';
  const bounded=(n,min,max,def)=>Number.isFinite(Number(n))?Math.min(max,Math.max(min,Number(n))):def;
  const assets=input.assets.map(a=>({id:str(a.id,60),name:str(a.name,180),kind:['image','audio','font'].includes(a.kind)?a.kind:'audio',mime:str(a.mime,90),path:str(a.path,220),size:bounded(a.size,0,MEDIA_LIMIT,0)}));
  const set=new Set();for(const a of assets){if(!safeId(a.id)||set.has(a.id)||!/^media\/[a-zA-Z0-9._-]+$/.test(a.path))throw fail(400,'에셋 경로 또는 ID가 올바르지 않습니다.');set.add(a.id);}
  const assetById=new Map(assets.map(a=>[a.id,a]));
  const overlays=(items,assetById)=>Array.isArray(items)?items.slice(0,32).map(o=>({id:safeId(o?.id)?o.id:newId(),text:str(o?.text,300),x:bounded(o?.x,0,1,.5),y:bounded(o?.y,0,1,.5),size:bounded(o?.size,8,240,32),color:/^#[0-9a-fA-F]{6}$/.test(o?.color)?o.color:'#f5f4ed',fontAssetId:assetById.get(o?.fontAssetId)?.kind==='font'?o.fontAssetId:null,fontFamily:str(o?.fontFamily,160)||'Inter, Segoe UI, Arial, sans-serif',align:['left','center','right'].includes(o?.align)?o.align:'center'})):[];
  const steps=(items,assetById)=>Array.isArray(items)?items.slice(0,8).map(step=>({id:safeId(step?.id)?step.id:newId(),label:str(step?.label,100),audioId:assetById.get(step?.audioId)?.kind==='audio'?step.audioId:null,audioStart:bounded(step?.audioStart,0,36000,0),audioDuration:bounded(step?.audioDuration,.1,180,2)})):[];
  const scenes=input.scenes.map(s=>({id:safeId(s.id)?s.id:newId(),type:['intro','original','sample','outro','compare','process','custom'].includes(s.type)?s.type:'custom',
    title:str(s.title,150),subtitle:str(s.subtitle,250),duration:bounded(s.duration,0.5,180,5),
    preset:['type','editorial','minimal','center','split','side','record'].includes(s.preset)?s.preset:'center',
    transition:['cut','fade','slide','wipe','zoom','blur'].includes(s.transition)?s.transition:'fade',
    transitionDuration:bounded(s.transitionDuration,0.1,1.5,0.5),
    bg:/^#[0-9a-fA-F]{6}$/.test(s.bg)?s.bg:'#171b21',accent:/^#[0-9a-fA-F]{6}$/.test(s.accent)?s.accent:'#dfddcf',
    imageId:assetById.get(s.imageId)?.kind==='image'?s.imageId:null,backgroundImageId:assetById.get(s.backgroundImageId)?.kind==='image'?s.backgroundImageId:null,
    backgroundImageOpacity:bounded(s.backgroundImageOpacity,0,1,0.22),backgroundImageFit:['cover','contain'].includes(s.backgroundImageFit)?s.backgroundImageFit:'cover',
    fontAssetId:assetById.get(s.fontAssetId)?.kind==='font'?s.fontAssetId:null,fontFamily:str(s.fontFamily,160)||'Inter, Segoe UI, Arial, sans-serif',
    audioId:assetById.get(s.audioId)?.kind==='audio'?s.audioId:null,
    leftImageId:assetById.get(s.leftImageId)?.kind==='image'?s.leftImageId:null,rightImageId:assetById.get(s.rightImageId)?.kind==='image'?s.rightImageId:null,
    leftLabel:str(s.leftLabel,100)||'ORIGINAL',rightLabel:str(s.rightLabel,100)||'SAMPLED',leftAudioId:assetById.get(s.leftAudioId)?.kind==='audio'?s.leftAudioId:null,rightAudioId:assetById.get(s.rightAudioId)?.kind==='audio'?s.rightAudioId:null,leftAudioStart:bounded(s.leftAudioStart,0,36000,0),rightAudioStart:bounded(s.rightAudioStart,0,36000,0),
    textOverlays:overlays(s.textOverlays,assetById),processSteps:steps(s.processSteps,assetById),
    audioStart:bounded(s.audioStart,0,36000,0),volume:bounded(s.volume,0,1,1),audioFadeIn:bounded(s.audioFadeIn,0,5,0),audioFadeOut:bounded(s.audioFadeOut,0,5,0),showWaveform:!!s.showWaveform}));
  if(new Set(scenes.map(s=>s.id)).size!==scenes.length)throw fail(400,'장면 ID가 중복됩니다.');
  return {version:1,id:expectedId,name:str(input.name,100)||'Untitled Breakdown',format:input.format==='9:16'?'9:16':'16:9',createdAt:str(input.createdAt,40)||now(),updatedAt:now(),revision:bounded(input.revision,0,100000000,0),assets,scenes};
}
function withSceneDefaults(project){
  // Reading old v0.1 JSON must be non-destructive, while exposing v0.2 defaults immediately.
  for(const scene of project.scenes||[]){
    if(!Object.hasOwn(scene,'backgroundImageId'))scene.backgroundImageId=null;
    if(!Object.hasOwn(scene,'backgroundImageOpacity'))scene.backgroundImageOpacity=0.22;
    if(!Object.hasOwn(scene,'backgroundImageFit'))scene.backgroundImageFit='cover';
    if(!Object.hasOwn(scene,'fontAssetId'))scene.fontAssetId=null;
    if(!Object.hasOwn(scene,'fontFamily'))scene.fontFamily='Inter, Segoe UI, Arial, sans-serif';
    if(!Object.hasOwn(scene,'leftImageId'))scene.leftImageId=null;
    if(!Object.hasOwn(scene,'rightImageId'))scene.rightImageId=null;
    if(!Object.hasOwn(scene,'leftLabel'))scene.leftLabel='ORIGINAL';
    if(!Object.hasOwn(scene,'rightLabel'))scene.rightLabel='SAMPLED';
    if(!Object.hasOwn(scene,'leftAudioId'))scene.leftAudioId=null;
    if(!Object.hasOwn(scene,'rightAudioId'))scene.rightAudioId=null;
    if(!Object.hasOwn(scene,'leftAudioStart'))scene.leftAudioStart=0;
    if(!Object.hasOwn(scene,'rightAudioStart'))scene.rightAudioStart=0;
    if(!Array.isArray(scene.textOverlays))scene.textOverlays=[];
    if(!Array.isArray(scene.processSteps))scene.processSteps=[];
  }
  return project;
}
const lastBackup=new Map();
async function backupSnapshot(id,p,{force=false}={}){
  const ms=Date.now();if(!force && ms-(lastBackup.get(id)||0)<120000 && p.revision%10!==0)return;
  const folder=path.join(projDir(id),'backups');await fsp.mkdir(folder,{recursive:true});
  const stamp=now().replace(/[:.]/g,'-');await writeAtomic(path.join(folder,`${stamp}-r${p.revision}.json`),JSON.stringify(p,null,2));
  lastBackup.set(id,ms);
  const all=(await fsp.readdir(folder)).filter(n=>/^\d{4}-.*\.json$/.test(n)).sort().reverse();
  for(const old of all.slice(30))await fsp.rm(path.join(folder,old),{force:true});
}
async function persist(id, next, {forceBackup=false}={}){
  const old=await loadProject(id);
  if(next.revision!==old.revision)throw fail(409,`다른 탭에서 수정되었습니다. 현재 저장 버전: ${old.revision}`);
  const p=validateProject(next,id);
  const oldAssetById=new Map(old.assets.map(a=>[a.id,a]));
  // Browser cannot invent asset metadata or point to local files through Save.
  if(p.assets.length!==old.assets.length || p.assets.some(a=>JSON.stringify(a)!==JSON.stringify(oldAssetById.get(a.id))))throw fail(400,'에셋 목록은 업로드 API를 통해서만 변경할 수 있습니다.');
  p.createdAt=old.createdAt;p.revision=old.revision+1;
  await backupSnapshot(id,old,{force:forceBackup});
  await writeAtomic(jsonPath(id),JSON.stringify(p,null,2));return p;
}
async function parseJSON(req,limit=JSON_LIMIT){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw fail(413,'요청 용량 제한 초과');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(400,'JSON 파싱 실패');}}
async function streamToFile(req,target,limit){const f=await fsp.open(target,'wx');let size=0;try{for await(const chunk of req){size+=chunk.length;if(size>limit)throw fail(413,'미디어 파일 크기 제한 초과');await f.write(chunk);}await f.sync();return size;}finally{await f.close();if(size>limit)await fsp.rm(target,{force:true}).catch(()=>{});}}
function contentType(mime){const good=['audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/wave','audio/ogg','audio/mp4','audio/flac','audio/x-flac','image/jpeg','image/png','image/webp','image/gif','font/ttf','font/otf','font/woff','font/woff2','application/font-sfnt','application/x-font-ttf','application/x-font-otf','application/font-woff','application/font-woff2'];return good.includes(mime)?mime:'application/octet-stream';}
async function serveMedia(req,res,id,assetId){const p=await loadProject(id);const a=p.assets.find(a=>a.id===assetId);if(!a)throw fail(404,'파일이 없습니다.');
  const file=path.join(projDir(id),a.path);const stat=await fsp.stat(file).catch(()=>null);if(!stat)throw fail(404,'원본 파일이 없어졌습니다.');
  const mime=contentType(a.mime);let start=0,end=stat.size-1,status=200;const range=req.headers.range;
  if(range){const match=range.match(/^bytes=(\d*)-(\d*)$/);if(match){start=match[1]?Number(match[1]):0;end=match[2]?Number(match[2]):end;
    if(!match[1]&&match[2]){start=Math.max(0,stat.size-Number(match[2]));end=stat.size-1;}
    if(start> end||start>=stat.size) {res.writeHead(416,{'content-range':`bytes */${stat.size}`});res.end();return;}
    end=Math.min(end,stat.size-1);status=206;}}
  const headers={'content-type':mime,'accept-ranges':'bytes','content-length':end-start+1,'cache-control':'private, max-age=60','x-content-type-options':'nosniff'};
  if(status===206)headers['content-range']=`bytes ${start}-${end}/${stat.size}`;
  res.writeHead(status,headers);if(req.method==='HEAD'){res.end();return;}fs.createReadStream(file,{start,end}).pipe(res);
}
async function sendFile(res,file,mime,downloadName){const st=await fsp.stat(file);res.writeHead(200,{'content-type':mime,'content-length':st.size,'content-disposition':`attachment; filename="${downloadName.replace(/[^a-zA-Z0-9_.-]/g,'_')}"`,'cache-control':'no-store'});
  await pipeline(fs.createReadStream(file),res);
}
async function serveStatic(res,url){const name=url==='/'?'index.html':url.slice(1);
  if(!['index.html','app.js','style.css'].includes(name))throw fail(404,'찾을 수 없습니다.');
  const file=path.join(PUBLIC,name);const bytes=await fsp.readFile(file);res.writeHead(200,{'content-type':CONTENT_TYPES[path.extname(name)],'content-length':bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(bytes);
}
async function transcode(req,res){const work=path.join(BASE,'tmp');await fsp.mkdir(work,{recursive:true});const stem=newId(),webm=path.join(work,stem+'.webm'),mp4=path.join(work,stem+'.mp4');
  try{await streamToFile(req,webm,ZIP_LIMIT);await new Promise((resolve,reject)=>{
    const p=spawn('ffmpeg',['-y','-i',webm,'-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',mp4],{windowsHide:true});
    let err='';p.stderr.on('data',d=>{err=(err+d.toString()).slice(-2000);});p.on('error',e=>reject(fail(503,'FFmpeg가 설치되어 있지 않거나 실행할 수 없습니다.')));
    p.on('close',code=>code===0?resolve():reject(fail(500,`MP4 변환 실패: ${err.slice(-500)}`)));
  });await sendFile(res,mp4,'video/mp4','sample-breakdown.mp4');}
  finally{await Promise.all([fsp.rm(webm,{force:true}),fsp.rm(mp4,{force:true})]);}
}
const queues=new Map();
async function serialized(id,work){const prev=queues.get(id)||Promise.resolve();let done;const chain=new Promise(r=>done=r);queues.set(id,chain);
  await prev;try{return await work();}finally{done();if(queues.get(id)===chain)queues.delete(id);}
}
async function request(req,res){
  const u=new URL(req.url,`http://${req.headers.host||'127.0.0.1'}`);const seg=u.pathname.split('/').filter(Boolean);
  if(!['GET','HEAD'].includes(req.method)){
    const origin=req.headers.origin;
    if(origin && ![`http://${HOST}:${PORT}`,`http://localhost:${PORT}`,`http://127.0.0.1:${PORT}`].includes(origin))throw fail(403,'외부 사이트에서 API를 호출할 수 없습니다.');
  }
  if(!u.pathname.startsWith('/api/'))return await serveStatic(res,u.pathname);
  if(u.pathname==='/api/health'&&req.method==='GET')return send(res,200,{ok:true,dataDir:BASE,ffmpeg:'Optional: ffmpeg in PATH for MP4'});
  if(u.pathname==='/api/projects'&&req.method==='GET'){
    await fsp.mkdir(PROJECTS,{recursive:true});const dirs=await fsp.readdir(PROJECTS,{withFileTypes:true});const items=[];
    for(const d of dirs){if(!d.isDirectory()||!safeId(d.name))continue;try{const p=await loadProject(d.name);items.push({id:p.id,name:p.name,updatedAt:p.updatedAt,revision:p.revision,format:p.format,scenes:p.scenes.length});}catch{}}
    items.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));return send(res,200,{projects:items});
  }
  if(u.pathname==='/api/projects'&&req.method==='POST'){
    const body=await parseJSON(req);const p=makeDefault(body.name);await fsp.mkdir(path.join(projDir(p.id),'media'),{recursive:true});
    await writeAtomic(jsonPath(p.id),JSON.stringify(p,null,2));return send(res,201,{project:p});
  }
  if(u.pathname==='/api/import'&&req.method==='POST'){
    const tmp=path.join(BASE,'tmp',newId()+'.zip');await fsp.mkdir(path.dirname(tmp),{recursive:true});
    const id=newId(),dir=projDir(id);await fsp.mkdir(dir,{recursive:true});
    try{await streamToFile(req,tmp,ZIP_LIMIT);const names=await extractZip(tmp,dir);
      if(!names.includes('project.json'))throw fail(400,'project.json이 없습니다.');
      const imported=JSON.parse(await fsp.readFile(jsonPath(id),'utf8'));const p=validateProject(imported,id);
      for(const a of p.assets)if(!names.includes(a.path)||!await exists(path.join(dir,a.path)))throw fail(400,`누락된 미디어: ${a.name}`);
      p.id=id;p.name+=' (imported)';p.createdAt=now();p.updatedAt=now();p.revision=0;
      await writeAtomic(jsonPath(id),JSON.stringify(p,null,2));return send(res,201,{project:p});
    }catch(e){await fsp.rm(dir,{recursive:true,force:true});throw e;}finally{await fsp.rm(tmp,{force:true});}
  }
  if(u.pathname==='/api/transcode'&&req.method==='POST')return await transcode(req,res);
  if(seg[0]!=='api'||seg[1]!=='projects'||!safeId(seg[2]))throw fail(404,'알 수 없는 API입니다.');
  const id=seg[2];
  if(seg.length===3&&req.method==='GET')return send(res,200,{project:await loadProject(id)});
  if(seg[3]==='save'&&seg.length===4&&req.method==='PUT'){
    const p=await parseJSON(req);return send(res,200,{project:await serialized(id,()=>persist(id,p))});
  }
  if(seg[3]==='duplicate'&&req.method==='POST'){
    return await serialized(id,async()=>{const p=await loadProject(id);const c=structuredClone(p), newid=newId();c.id=newid;c.name+=' (copy)';c.revision=0;c.createdAt=now();c.updatedAt=now();
      await fsp.mkdir(path.join(projDir(newid),'media'),{recursive:true});for(const a of c.assets){await fsp.copyFile(path.join(projDir(id),a.path),path.join(projDir(newid),a.path));}
      await writeAtomic(jsonPath(newid),JSON.stringify(c,null,2));send(res,201,{project:c});});
  }
  if(seg[3]==='assets'&&seg.length===4&&req.method==='POST'){
    return await serialized(id,async()=>{
      const mime=(u.searchParams.get('mime')||'').slice(0,90),kind=mime.startsWith('image/')?'image':mime.startsWith('audio/')?'audio':(mime.startsWith('font/')||['application/font-sfnt','application/x-font-ttf','application/x-font-otf','application/font-woff','application/font-woff2'].includes(mime))?'font':null;
      if(!kind||contentType(mime)==='application/octet-stream')throw fail(415,'지원하지 않는 오디오/이미지/폰트 형식입니다.');
      const name=(u.searchParams.get('name')||'media').replace(/[\\/\0\r\n]/g,'_').slice(0,130);
      const aid=newId(),extension=path.extname(name).replace(/[^.a-zA-Z0-9]/g,'').slice(0,10)|| (kind==='image'?'.png':kind==='font'?'.woff2':'.wav');
      const rel=`media/${aid}${extension}`;const full=path.join(projDir(id),rel);await fsp.mkdir(path.dirname(full),{recursive:true});
      let bytes=0;try{bytes=await streamToFile(req,full,MEDIA_LIMIT);}catch(e){await fsp.rm(full,{force:true});throw e;}
      if(!bytes){await fsp.rm(full,{force:true});throw fail(400,'빈 파일입니다.');}
      const p=await loadProject(id);await backupSnapshot(id,p);
      p.assets.push({id:aid,name,kind,mime,path:rel,size:bytes});p.revision++;p.updatedAt=now();
      await writeAtomic(jsonPath(id),JSON.stringify(p,null,2));send(res,201,{project:p,asset:p.assets.at(-1)});
    });
  }
  if(seg[3]==='assets'&&seg[4]&&['GET','HEAD'].includes(req.method))return serveMedia(req,res,id,seg[4]);
  if(seg[3]==='download'&&req.method==='GET'){
    const p=await loadProject(id);const tmp=path.join(BASE,'tmp',newId()+'.zip');await fsp.mkdir(path.dirname(tmp),{recursive:true});
    try{const entries=[{name:'project.json',data:Buffer.from(JSON.stringify(p,null,2))}];
      for(const a of p.assets){const file=path.join(projDir(id),a.path);if(!await exists(file))throw fail(404,`누락된 미디어: ${a.name}`);entries.push({name:a.path,file});}
      await makeZip(entries,tmp);await sendFile(res,tmp,'application/zip','sample-breakdown-project.zip');
    }finally{await fsp.rm(tmp,{force:true});}return;
  }
  if(seg[3]==='backups'&&seg.length===4&&req.method==='GET'){
    const folder=path.join(projDir(id),'backups');const names=await fsp.readdir(folder).catch(()=>[]);return send(res,200,{backups:names.filter(n=>/^\d{4}-.*\.json$/.test(n)).sort().reverse()});
  }
  if(seg[3]==='backups'&&seg[4]&&seg[5]==='restore'&&req.method==='POST'){
    return await serialized(id,async()=>{
      const name=seg[4];if(!/^\d{4}-[\w-]+\.json$/.test(name))throw fail(400,'백업 파일 이름이 잘못되었습니다.');
      const old=await loadProject(id);const backup=JSON.parse(await fsp.readFile(path.join(projDir(id),'backups',name),'utf8'));
      const p=validateProject(backup,id);const known=new Set(old.assets.map(a=>a.id));
      if(p.assets.some(a=>!known.has(a.id)))throw fail(400,'백업에 있는 미디어 파일이 누락되었습니다.');
      await backupSnapshot(id,old,{force:true});p.revision=old.revision+1;p.updatedAt=now();p.createdAt=old.createdAt;
      await writeAtomic(jsonPath(id),JSON.stringify(p,null,2));send(res,200,{project:p});
    });
  }
  throw fail(404,'알 수 없는 API입니다.');
}
await fsp.mkdir(PROJECTS,{recursive:true});
const server=http.createServer((req,res)=>{request(req,res).catch(e=>{if(res.headersSent){res.destroy();return;}console.error(`[${req.method} ${req.url}]`,e);send(res,e.status||500,{error:e.message||'서버 오류'});});});
server.listen(PORT,HOST,()=>{console.log(`\nSample Breakdown Studio: http://${HOST}:${PORT}\nProject data: ${BASE}\n`);});
