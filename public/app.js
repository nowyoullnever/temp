// Zero-dependency browser editor. Projects and media are persisted on local disk by server.mjs.
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const uid=()=>crypto.randomUUID().replaceAll('-','').slice(0,18);
const seconds=n=>`${String(Math.floor(n/60)).padStart(2,'0')}:${String(Math.floor(n%60)).padStart(2,'0')}.${Math.floor((n%1)*10)}`;
const assetUrl=id=>`/api/projects/${encodeURIComponent(project.id)}/assets/${encodeURIComponent(id)}`;
const sceneLabels={intro:'INTRO',original:'ORIGINAL',sample:'SAMPLED',outro:'OUTRO',custom:'CUSTOM'};
const presets=['type','editorial','minimal','center','split','side','record'];
const effects=['cut','fade','slide','wipe','zoom','blur'];
const presetLabels={type:'Type',editorial:'Editorial',minimal:'Minimal',center:'Center',split:'Split',side:'Side',record:'Record'};
const effectLabels={cut:'Cut',fade:'Fade',slide:'Slide',wipe:'Wipe',zoom:'Zoom',blur:'Blur'};
const fontMimeTypes=new Set(['application/font-sfnt','application/x-font-ttf','application/x-font-otf','application/font-woff','application/font-woff2']);
let project=null,selectedId=null,revision=0,dirty=false,changeSerial=0,saving=null,saveTimer=null,saveError=false,playhead=0,playing=false,clockStart=0,exporting=false,recorder=null,exportType='webm',exportChunks=[];
let audioContext=null,mediaSource=null,mixOutput=null;const audio=new Audio();audio.preload='auto';let playingAsset=null;
const stage=$('stage'),ctx=stage.getContext('2d',{alpha:false});const imageCache=new Map(),peakCache=new Map(),pendingPeaks=new Set(),fontCache=new Map();
let toastTimer=null;
function toast(msg){$('toast').textContent=msg;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),4200);}
function status(text,cls=''){$('saveStatus').className='save-status '+cls;$('saveStatus').innerHTML='<span class="status-dot"></span>'+esc(text);}
async function api(url,opts={}){const response=await fetch(url,opts);if(!response.ok){let info;try{info=await response.json();}catch{}throw Error(info?.error||`HTTP ${response.status}`);}return response.headers.get('content-type')?.includes('json')?response.json():response;}
function totalTime(){return (project?.scenes||[]).reduce((n,s)=>n+s.duration,0);}
function currentScene(){return project?.scenes.find(s=>s.id===selectedId)||project?.scenes[0];}
function locate(time){let elapsed=0;for(let i=0;i<(project?.scenes.length||0);i++){const s=project.scenes[i];if(time<elapsed+s.duration||i===project.scenes.length-1)return {scene:s,index:i,local:clamp(time-elapsed,0,s.duration),start:elapsed};elapsed+=s.duration;}return null;}
function previewTimeOf(id){const sc=project?.scenes.find(x=>x.id===id);return startTimeOf(id)+Math.min(.7,(sc?.duration||1)*.5);}
function startTimeOf(id){let t=0;for(const s of project.scenes){if(s.id===id)break;t+=s.duration;}return t;}
function assetBy(id){return project?.assets.find(a=>a.id===id);}
function updateDirty(){dirty=true;changeSerial++;status('저장 전 변경', 'dirty');clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveNow(),850);}
function mutate(key,value){if(!project)return;const s=currentScene();if(!s)return;s[key]=value;updateDirty();renderTimeline();drawFrame(playhead);updateTransport();}
async function saveNow(){clearTimeout(saveTimer);if(!project||!dirty)return saving||undefined;if(saving){await saving;return saveNow();}
  const snapshot=structuredClone(project);snapshot.revision=revision;const marker=changeSerial;
  status('저장 중…','dirty');saving=(async()=>{
    const result=await api(`/api/projects/${project.id}/save`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(snapshot)});
    revision=result.project.revision;project.revision=revision;dirty=changeSerial!==marker;saveError=false;status(dirty?'추가 변경 저장 대기':'저장 완료',dirty?'dirty':'');
  })();
  try{await saving;}catch(e){saveError=true;status('저장 실패', 'error');toast('저장 실패: '+e.message);throw e;}finally{saving=null;}
  if(dirty){clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveNow(),250);}
}
async function persistBeforeSwitch(){if(dirty||saving)await saveNow();if(saveError)throw Error('변경 사항이 저장되지 않아 전환을 취소했습니다.');}
async function getProjects(activeId){const data=await api('/api/projects');$('projectSelect').innerHTML=data.projects.map(p=>`<option value="${esc(p.id)}" ${p.id===activeId?'selected':''}>${esc(p.name)}</option>`).join('');}
async function load(id){stop();await persistBeforeSwitch();const data=await api(`/api/projects/${id}`);project=data.project;revision=project.revision;selectedId=project.scenes[0]?.id;dirty=false;saveError=false;playhead=0;imageCache.clear();peakCache.clear();pendingPeaks.clear();playingAsset=null;audio.pause();audio.removeAttribute('src');await getProjects(id);status('저장 완료');renderAll();}
async function createProject(){try{await persistBeforeSwitch();const name=prompt('새 프로젝트 이름','New Sample Breakdown');if(name===null)return;const response=await api('/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:name.trim()||'Untitled Breakdown'})});await load(response.project.id);}catch(e){toast(e.message);}}
async function duplicate(){try{await persistBeforeSwitch();const response=await api(`/api/projects/${project.id}/duplicate`,{method:'POST'});await load(response.project.id);toast('프로젝트를 복제했습니다.');}catch(e){toast(e.message);}}
function renderAll(){if(!project)return;$('formatSelect').value=project.format;$('previewResolution').textContent=project.format==='16:9'?'1920 × 1080':'1080 × 1920';
  if(project.format==='16:9'){stage.width=1920;stage.height=1080;stage.classList.remove('portrait');}else{stage.width=1080;stage.height=1920;stage.classList.add('portrait');}
  renderAssets();renderTimeline();renderInspector();updateTransport();drawFrame(playhead);
}
function renderAssets(){const list=$('assetList');$('assetCount').textContent=project.assets.length;
  if(!project.assets.length){list.innerHTML='<div class="empty-library">아직 업로드된 파일이 없습니다.</div>';return;}
  list.innerHTML=project.assets.map(a=>{const type=a.kind==='image'?'IMAGE':a.kind==='audio'?'AUDIO':'FONT',icon=a.kind==='image'?'▣':a.kind==='audio'?'♫':'𝐅';return `<div class="asset-item ${a.kind}" data-asset="${esc(a.id)}" title="클릭하여 선택한 장면에 적용"><div class="asset-symbol">${icon}</div><div class="asset-info"><strong>${esc(a.name)}</strong><small>${type} · ${(a.size/1024/1024).toFixed(1)}MB</small></div><span class="asset-add">＋</span></div>`;}).join('');
  list.querySelectorAll('[data-asset]').forEach(el=>el.addEventListener('click',()=>{
    const a=assetBy(el.dataset.asset),field=a.kind==='image'?'imageId':a.kind==='audio'?'audioId':'fontAssetId';mutate(field,a.id);renderInspector();toast(`${a.name} → 현재 장면에 적용`);if(a.kind==='audio')loadPeaks(a.id);if(a.kind==='font')loadFontAsset(a.id);
  }));
}
function renderTimeline(){if(!project)return;$('sceneCount').textContent=`${project.scenes.length} scenes`;
  $('timelineTrack').innerHTML=project.scenes.map((s,i)=>`<div class="clip ${esc(s.type)} ${s.id===selectedId?'selected':''}" data-scene="${esc(s.id)}" draggable="true" style="width:${Math.round(clamp(103+s.duration*9,117,300))}px"><div class="clip-type">${sceneLabels[s.type]} <span class="clip-index">${String(i+1).padStart(2,'0')}</span></div><div class="clip-name">${esc(s.title||'제목 없음')}</div><div class="clip-duration">${seconds(s.duration)} · ${s.audioId?'♫ audio':'no audio'}</div><div class="clip-accent"></div></div>`).join('');
  const tiles=$('timelineTrack').querySelectorAll('.clip');
  for(const el of tiles){el.addEventListener('click',()=>selectScene(el.dataset.scene));
    el.addEventListener('dragstart',e=>{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',el.dataset.scene);el.classList.add('dragging');});
    el.addEventListener('dragend',()=>{el.classList.remove('dragging');tiles.forEach(x=>x.classList.remove('drag-target'));});
    el.addEventListener('dragover',e=>{e.preventDefault();el.classList.add('drag-target');});
    el.addEventListener('dragleave',()=>el.classList.remove('drag-target'));
    el.addEventListener('drop',e=>{e.preventDefault();tiles.forEach(x=>x.classList.remove('drag-target'));const from=e.dataTransfer.getData('text/plain'),to=el.dataset.scene;if(from===to)return;
      const ix=project.scenes.findIndex(s=>s.id===from),jx=project.scenes.findIndex(s=>s.id===to);if(ix<0||jx<0)return;
      const [s]=project.scenes.splice(ix,1);project.scenes.splice(jx,0,s);stop();playhead=previewTimeOf(selectedId);updateDirty();renderTimeline();renderInspector();drawFrame(playhead);
    });
  }
}
function selectScene(id){if(!project.scenes.some(s=>s.id===id))return;stop();selectedId=id;playhead=previewTimeOf(id);renderTimeline();renderInspector();updateTransport();drawFrame(playhead);}
function renderInspector(){const s=currentScene();if(!s)return;
  const images=project.assets.filter(a=>a.kind==='image'),audios=project.assets.filter(a=>a.kind==='audio'),fonts=project.assets.filter(a=>a.kind==='font');
  const options=(list,current,none)=>`<option value="">${none}</option>`+list.map(a=>`<option value="${esc(a.id)}" ${a.id===current?'selected':''}>${esc(a.name)}</option>`).join('');
  $('inspector').innerHTML=`
    <div class="field-group"><label class="field-label">장면 유형</label><select class="field-input" data-field="type">${Object.keys(sceneLabels).map(k=>`<option value="${k}" ${s.type===k?'selected':''}>${sceneLabels[k]}</option>`).join('')}</select></div>
    <div class="field-group"><label class="field-label">제목</label><input class="field-input" type="text" maxlength="150" data-field="title" value="${esc(s.title)}"/></div>
    <div class="field-group"><label class="field-label">보조 문구 / 아티스트</label><input class="field-input" type="text" maxlength="250" data-field="subtitle" value="${esc(s.subtitle)}"/></div>
    <div class="field-group field-row"><div><label class="field-label">장면 길이 (초)</label><input class="field-input" type="number" step="0.1" min="0.5" max="180" data-field="duration" value="${s.duration}" /></div><div><label class="field-label">오디오 시작 (초)</label><input class="field-input" type="number" step="0.1" min="0" data-field="audioStart" value="${s.audioStart}" /></div></div>
    <div class="field-group"><label class="field-label">이미지 / 앨범 커버</label><select class="field-input" data-field="imageId">${options(images,s.imageId,'이미지 없음')}</select></div>
    <div class="field-group"><label class="field-label">배경 이미지</label><select class="field-input" data-field="backgroundImageId">${options(images,s.backgroundImageId,'배경 이미지 없음')}</select></div>
    <div class="field-group field-row"><div><label class="field-label">배경 이미지 불투명도 <span id="bgOpacityVal">${Math.round((s.backgroundImageOpacity??.22)*100)}%</span></label><input class="field-input" type="range" min="0" max="1" step="0.01" data-field="backgroundImageOpacity" value="${s.backgroundImageOpacity??.22}"/></div><div><label class="field-label">배경 이미지 맞춤</label><select class="field-input" data-field="backgroundImageFit"><option value="cover" ${(s.backgroundImageFit||'cover')==='cover'?'selected':''}>cover</option><option value="contain" ${(s.backgroundImageFit||'cover')==='contain'?'selected':''}>contain</option></select></div></div>
    <div class="field-group"><label class="field-label">커스텀 폰트 파일</label><select class="field-input" data-field="fontAssetId">${options(fonts,s.fontAssetId,'기본 폰트 사용')}</select><div class="mini-info">TTF · OTF · WOFF · WOFF2 업로드 가능</div></div>
    <div class="field-group"><label class="field-label">기본 / 보조 폰트 스택</label><input class="field-input" type="text" maxlength="160" data-field="fontFamily" value="${esc(s.fontFamily||'Inter, Segoe UI, Arial, sans-serif')}"/><div class="mini-info">커스텀 폰트를 선택하지 않았을 때 사용할 CSS 폰트 이름입니다.</div></div>
    <div class="field-group"><label class="field-label">이 장면에서 재생할 오디오</label><select class="field-input" data-field="audioId">${options(audios,s.audioId,'오디오 없음')}</select><div class="mini-info">파형은 오디오를 지정하면 자동 분석됩니다.</div></div>
    <div class="field-group"><label class="field-label">음량 <span id="volumeVal">${Math.round(s.volume*100)}%</span></label><input class="field-input" type="range" min="0" max="1" step="0.01" data-field="volume" value="${s.volume}"/></div>
    <div class="field-group field-row"><div><label class="field-label">오디오 페이드 인 (초)</label><input class="field-input" type="number" min="0" max="5" step="0.05" data-field="audioFadeIn" value="${s.audioFadeIn||0}" /></div><div><label class="field-label">오디오 페이드 아웃 (초)</label><input class="field-input" type="number" min="0" max="5" step="0.05" data-field="audioFadeOut" value="${s.audioFadeOut||0}" /></div></div>
    <div class="section-divider"></div><div class="inspector-section">01 / 화면 구성</div>
    <div class="field-group"><div class="preset-grid">${presets.map(p=>`<button class="preset ${s.preset===p?'active':''}" data-preset="${p}"><span class="shape"></span><span>${presetLabels[p]}</span></button>`).join('')}</div></div>
    <div class="field-group field-row"><div><label class="field-label">배경 색상</label><input class="field-input" type="color" data-field="bg" value="${s.bg}"/></div><div><label class="field-label">강조 색상</label><input class="field-input" type="color" data-field="accent" value="${s.accent}"/></div></div>
    <div class="field-group"><label class="checkbox-line"><input type="checkbox" data-field="showWaveform" ${s.showWaveform?'checked':''}/> 파형 시각화 표시</label></div>
    <div class="section-divider"></div><div class="inspector-section">02 / 장면 전환</div>
    <div class="transition-grid">${effects.map(e=>`<button class="effect ${s.transition===e?'active':''}" data-effect="${e}"><span class="effect-thumb"></span>${effectLabels[e]}</button>`).join('')}</div>
    <div class="field-group" style="margin-top:14px"><label class="field-label">전환 길이 <span id="transitionVal">${s.transitionDuration.toFixed(2)}초</span></label><input class="field-input" type="range" min="0.1" max="1.5" step="0.05" data-field="transitionDuration" value="${s.transitionDuration}" /></div>
    <div class="section-divider"></div><div class="inspector-section">03 / 장면 관리</div>
    <div class="scene-buttons"><button class="subtle" id="duplicateScene">⧉ 복제</button><button class="danger" id="deleteScene" ${project.scenes.length<=1?'disabled':''}>⌫ 삭제</button></div>
  `;
  const fields=$('inspector').querySelectorAll('[data-field]');
  fields.forEach(el=>el.addEventListener(el.type==='checkbox'?'change':'input',()=>{
    let value=el.type==='checkbox'?el.checked:el.type==='number'||el.type==='range'?Number(el.value):el.value;
    if(el.dataset.field==='duration')value=clamp(value||0.5,0.5,180);
    if(el.dataset.field==='audioStart')value=clamp(value||0,0,36000);
    if(['audioFadeIn','audioFadeOut'].includes(el.dataset.field))value=clamp(value||0,0,5);
    if(el.dataset.field==='backgroundImageOpacity')value=clamp(value||0,0,1);
    mutate(el.dataset.field,value);
    if(el.dataset.field==='volume')$('volumeVal').textContent=Math.round(value*100)+'%';
    if(el.dataset.field==='backgroundImageOpacity')$('bgOpacityVal').textContent=Math.round(value*100)+'%';
    if(el.dataset.field==='transitionDuration')$('transitionVal').textContent=value.toFixed(2)+'초';
    if(el.dataset.field==='audioId'&&value)loadPeaks(value);
    if(el.dataset.field==='fontAssetId'&&value)loadFontAsset(value);
  }));
  $('inspector').querySelectorAll('[data-preset]').forEach(el=>el.addEventListener('click',()=>{mutate('preset',el.dataset.preset);renderInspector();}));
  $('inspector').querySelectorAll('[data-effect]').forEach(el=>el.addEventListener('click',()=>{mutate('transition',el.dataset.effect);renderInspector();}));
  $('duplicateScene').onclick=()=>{
    const i=project.scenes.findIndex(x=>x.id===s.id),c={...structuredClone(s),id:uid(),title:s.title+' (copy)'};project.scenes.splice(i+1,0,c);
    selectedId=c.id;updateDirty();renderAll();};
  $('deleteScene').onclick=()=>{if(project.scenes.length<=1)return;const index=project.scenes.findIndex(x=>x.id===s.id);project.scenes.splice(index,1);
    selectedId=project.scenes[Math.max(0,index-1)].id;playhead=clamp(playhead,0,totalTime());updateDirty();renderAll();};
}
function updateTransport(){const dur=totalTime();$('seekSlider').max=dur.toFixed(2);$('seekSlider').value=clamp(playhead,0,dur).toFixed(2);
  $('timeDisplay').innerHTML=`${seconds(playhead)} <span>/ ${seconds(dur)}</span>`;$('playBtn').textContent=playing?'❚❚':'▶';}
function ensureAudioContext(){if(!audioContext){audioContext=new (window.AudioContext||window.webkitAudioContext)();mixOutput=audioContext.createMediaStreamDestination();mediaSource=audioContext.createMediaElementSource(audio);mediaSource.connect(audioContext.destination);mediaSource.connect(mixOutput);}audioContext.resume().catch(()=>{});}
function syncAudio(force=false){const info=locate(playhead);if(!info)return;const a=info.scene.audioId;
  if(!a){audio.pause();playingAsset=null;return;}
  if(playingAsset!==a){audio.pause();audio.src=assetUrl(a);audio.load();playingAsset=a;force=true;}
  const target=info.scene.audioStart+info.local;
  if(force||Math.abs((audio.currentTime||0)-target)>0.24){try{audio.currentTime=target;}catch{}}
  const fadeIn=info.scene.audioFadeIn||0,fadeOut=info.scene.audioFadeOut||0;
  const inGain=fadeIn?clamp(info.local/fadeIn,0,1):1,outGain=fadeOut?clamp((info.scene.duration-info.local)/fadeOut,0,1):1;
  audio.volume=clamp(info.scene.volume*Math.min(inGain,outGain),0,1);if(playing&&audio.paused)audio.play().catch(()=>{});
}
function seek(t){playhead=clamp(Number(t)||0,0,totalTime());if(playing)clockStart=performance.now()-playhead*1000;syncAudio(true);updateTransport();drawFrame(playhead);}
function play(){if(!project||!project.scenes.length)return;ensureAudioContext();if(playhead>=totalTime())playhead=0;playing=true;clockStart=performance.now()-playhead*1000;syncAudio(true);updateTransport();requestAnimationFrame(tick);}
function stop(){playing=false;audio.pause();updateTransport();}
function tick(){if(!playing)return;playhead=clamp((performance.now()-clockStart)/1000,0,totalTime());syncAudio();updateTransport();drawFrame(playhead);
  if(playhead>=totalTime()-0.025){playing=false;audio.pause();if(exporting&&recorder?.state==='recording')recorder.stop();updateTransport();return;}requestAnimationFrame(tick);
}
function imageFor(id){if(!id)return null;const k=project.id+':'+id;if(imageCache.has(k))return imageCache.get(k);
  const img=new Image();img.onload=()=>drawFrame(playhead);img.onerror=()=>imageCache.set(k,null);img.src=assetUrl(id);imageCache.set(k,img);return img;
}
async function loadFontAsset(assetId){
  if(!assetId)return null;const existing=fontCache.get(assetId);if(existing?.loaded)return existing.family;if(existing?.loading)return existing.promise;
  if(!assetBy(assetId))return null;const family=`SBSFont_${assetId}`;
  const record={family,loading:true,loaded:false};fontCache.set(assetId,record);
  record.promise=(async()=>{try{const face=new FontFace(family,`url(${assetUrl(assetId)})`);await face.load();document.fonts.add(face);record.loaded=true;drawFrame(playhead);return family;}
    catch(error){record.error=true;console.warn('Font load failed',error);return null;}
    finally{record.loading=false;}})();return record.promise;
}
function fontFamilyFor(scene){const fallback=scene?.fontFamily||'Inter, Segoe UI, Arial, sans-serif',assetId=scene?.fontAssetId,record=fontCache.get(assetId);
  if(assetId&&!record?.loaded)loadFontAsset(assetId);return record?.loaded?`${record.family}, ${fallback}`:fallback;
}
async function ensureProjectFonts(){const ids=[...new Set(project.scenes.map(s=>s.fontAssetId).filter(Boolean))],families=await Promise.all(ids.map(loadFontAsset));if(families.some(f=>!f))throw Error('선택한 커스텀 폰트를 로드할 수 없습니다. 폰트 파일을 확인하세요.');}
async function loadPeaks(id){if(!id||peakCache.has(id)||pendingPeaks.has(id))return;pendingPeaks.add(id);
  try{const response=await fetch(assetUrl(id));if(!response.ok)throw Error('미디어 접근 오류');const data=await response.arrayBuffer();
    const AC=window.AudioContext||window.webkitAudioContext;const temp=new AC();const audioBuf=await temp.decodeAudioData(data);await temp.close();
    const ch=audioBuf.getChannelData(0),peaks=[],num=1200,step=Math.max(1,Math.floor(ch.length/num));
    for(let i=0;i<num;i++){let max=0,start=i*step;for(let j=start;j<Math.min(start+step,ch.length);j+=Math.max(1,Math.floor(step/64)))max=Math.max(max,Math.abs(ch[j]));peaks.push(max);}
    peakCache.set(id,{peaks,duration:audioBuf.duration});drawFrame(playhead);
  }catch(e){console.warn('Waveform unavailable',e);peakCache.set(id,{peaks:[],duration:0});}
  finally{pendingPeaks.delete(id);}
}
function fill(color,x,y,w,h){ctx.fillStyle=color;ctx.fillRect(x,y,w,h);}
function rgba(hex,a){const v=hex.replace('#','');return `rgba(${parseInt(v.slice(0,2),16)},${parseInt(v.slice(2,4),16)},${parseInt(v.slice(4,6),16)},${a})`;}
function roundRect(x,y,w,h,r,color){ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fillStyle=color;ctx.fill();}
function centerText(txt,x,y,size,color,weight=600,maxWidth=Infinity,fontFamily='Inter, Segoe UI, Arial, sans-serif'){ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`${weight} ${size}px ${fontFamily}`;ctx.fillStyle=color;ctx.fillText(txt,x,y,maxWidth);}
function leftText(txt,x,y,size,color,weight=600,maxWidth=Infinity,fontFamily='Inter, Segoe UI, Arial, sans-serif'){ctx.textAlign='left';ctx.textBaseline='middle';ctx.font=`${weight} ${size}px ${fontFamily}`;ctx.fillStyle=color;ctx.fillText(txt,x,y,maxWidth);}
function cover(img,x,y,w,h,accent){ctx.save();roundRect(x-4,y-4,w+8,h+8,7,'#ffffff15');ctx.beginPath();ctx.roundRect(x,y,w,h,4);ctx.clip();
  if(img?.complete&&img.naturalWidth){const scale=Math.max(w/img.width,h/img.height);const dw=img.width*scale,dh=img.height*scale;ctx.drawImage(img,x+(w-dw)/2,y+(h-dh)/2,dw,dh);}else{
    const grad=ctx.createLinearGradient(x,y,x+w,y+h);grad.addColorStop(0,rgba(accent,.63));grad.addColorStop(1,'#282c38');fill(grad,x,y,w,h);
    ctx.strokeStyle='#ffffff30';ctx.lineWidth=3;for(let r=w*.12;r<w*.51;r+=w*.08){ctx.beginPath();ctx.arc(x+w/2,y+h/2,r,0,Math.PI*2);ctx.stroke();}
    ctx.beginPath();ctx.arc(x+w/2,y+h/2,w*.075,0,Math.PI*2);ctx.fillStyle='#d7d8cb';ctx.fill();}
  ctx.restore();}
function waveform(s,x,y,w,h,progress,accent){if(!s.audioId)return;loadPeaks(s.audioId);const info=peakCache.get(s.audioId),bars=88,gap=w/bars;
  ctx.save();for(let i=0;i<bars;i++){
    let strength=0.12;const t=s.audioStart+(i/bars)*s.duration;
    if(info?.peaks.length){const index=Math.floor(t/(info.duration||1)*info.peaks.length);strength=info.peaks[clamp(index,0,info.peaks.length-1)]||0.04;}
    const bh=4+Math.min(1,strength*1.8)*h*.45;fill(i/bars<=progress?accent:rgba(accent,.25),x+i*gap,y+h/2-bh/2,Math.max(1.4,gap*.55),bh);
  }
  fill('#e3e8df',x+w*clamp(progress,0,1)-1,y+2,2,h-4);
  ctx.restore();}
function renderScene(s,t){const W=stage.width,H=stage.height,cx=W/2,sy=W/960,land=W>H;
  const u=land?W/960:W/630,fontFamily=fontFamilyFor(s);ctx.save();fill(s.bg,0,0,W,H);
  const bgImage=imageFor(s.backgroundImageId);if(bgImage?.complete&&bgImage.naturalWidth){ctx.save();ctx.globalAlpha=clamp(s.backgroundImageOpacity??.22,0,1);const scale=(s.backgroundImageFit==='contain'?Math.min:Math.max)(W/bgImage.width,H/bgImage.height),dw=bgImage.width*scale,dh=bgImage.height*scale;ctx.drawImage(bgImage,(W-dw)/2,(H-dh)/2,dw,dh);ctx.restore();}
  const grad=ctx.createRadialGradient(W*.62,H*.42,0,W*.62,H*.42,Math.max(W,H)*.75);grad.addColorStop(0,rgba(s.accent,.12));grad.addColorStop(1,'#00000000');fill(grad,0,0,W,H);
  const pad=W*.06;leftText('001  /  SOURCE STUDY',pad,H*.93,9*u,'#879096',700,Infinity,fontFamily);
  const startEffect=clamp(t/.58,0,1),ease=1-Math.pow(1-startEffect,3);const image=imageFor(s.imageId);
  if(s.type==='intro'){
    ctx.globalAlpha=.5+.5*ease;
    if(s.preset==='record'){cover(image,cx-W*.17,H*.22,W*.34,Math.min(W*.34,H*.45),s.accent);centerText(s.title,cx,H*.76,38*u,'#f5f1e9',750,W*.9,fontFamily);}
    else if(s.preset==='editorial'){
      leftText(s.title,pad+W*.02,H*.42,65*u,'#f1f1eb',800,W*.86,fontFamily);fill(s.accent,pad+W*.02,H*.52,W*.48,2*u);leftText(s.subtitle,pad+W*.02,H*.58,20*u,s.accent,500,W*.85,fontFamily);
    }else{
      const printed=s.preset==='type'?s.title.slice(0,Math.ceil((.55+.45*ease)*s.title.length)):s.title;
      centerText(printed,cx,H*.46,59*u,'#f5f4ed',760,W*.87,fontFamily);fill(s.accent,cx-W*.16,H*.55,W*.32,2*u);centerText(s.subtitle,cx,H*.63,17*u,s.accent,550,W*.8,fontFamily);
    }
  }else if(s.type==='outro'){
    ctx.globalAlpha=ease;centerText('—',cx,H*.32,55*u,s.accent,350,Infinity,fontFamily);
    centerText(s.title,cx,H*.5,46*u,'#f0efec',800,W*.86,fontFamily);centerText(s.subtitle,cx,H*.62,19*u,s.accent,450,W*.82,fontFamily);
  }else if(s.preset==='split'||s.type==='sample'&&s.preset==='center'){
    const size=Math.min(W*.25,H*.49),source=project.scenes.find(x=>x.type==='original'&&x.imageId);const gap=W*.06;
    const leftX=cx-gap/2-size,rightX=cx+gap/2;
    cover(imageFor(source?.imageId),leftX,H*.23,size,size,source?.accent||s.accent);
    cover(image,rightX,H*.23,size,size,s.accent);
    centerText('ORIGINAL',leftX+size/2,H*.2,11*u,'#c6d7ce',700,Infinity,fontFamily);centerText('THE FLIP',rightX+size/2,H*.2,11*u,'#d7c6b8',700,Infinity,fontFamily);
    centerText(s.title,cx,H*.78,33*u,'#f2f1ee',750,W*.85,fontFamily);centerText(s.subtitle,cx,H*.84,15*u,s.accent,480,W*.87,fontFamily);
  }else if(s.preset==='side'||s.preset==='editorial'){
    const size=Math.min(W*.35,H*.58);cover(image,pad,H*.19,size,size,s.accent);
    const tx=pad+size+W*.06;leftText('ORIGINAL / SOURCE',tx,H*.34,11*u,s.accent,750,W-tx-pad,fontFamily);
    leftText(s.title,tx,H*.47,43*u,'#f1eee9',800,W-tx-pad,fontFamily);leftText(s.subtitle,tx,H*.57,19*u,'#c5cbcd',400,W-tx-pad,fontFamily);
  }else if(s.preset==='minimal'||s.preset==='type'){
    ctx.globalAlpha=ease;centerText(s.title,cx,H*.43,51*u,'#f0ede7',700,W*.86,fontFamily);
    centerText(s.subtitle,cx,H*.55,19*u,s.accent,450,W*.85,fontFamily);
  }else{
    const size=Math.min(W*.33,H*.52);cover(image,cx-size/2,H*.17,size,size,s.accent);
    centerText(s.title,cx,H*.76,31*u,'#f2f1ed',780,W*.88,fontFamily);centerText(s.subtitle,cx,H*.83,16*u,s.accent,480,W*.86,fontFamily);
  }
  ctx.globalAlpha=1;
  if(s.showWaveform && s.audioId){const w=W*.66;roundRect(cx-w/2,H*.86-H*.035,w,H*.082,4,'#0000004a');waveform(s,cx-w*.46,H*.858,w*.92,H*.064,clamp(t/s.duration,0,1),s.accent);}
  ctx.restore();
}
function drawFrame(at){if(!project||!project.scenes.length)return;const found=locate(clamp(at,0,totalTime()));if(!found)return;
  const {scene,index,local}=found,W=stage.width,H=stage.height;ctx.clearRect(0,0,W,H);const duration=Math.min(scene.transitionDuration,scene.duration*.7);
  if(index===0||scene.transition==='cut'||local>=duration){renderScene(scene,local);return;}
  const p=clamp(local/duration,0,1),prev=project.scenes[index-1];renderScene(prev,prev.duration);
  ctx.save();
  if(scene.transition==='fade'){ctx.globalAlpha=p;renderScene(scene,local);}
  else if(scene.transition==='slide'){ctx.translate(W*(1-p),0);renderScene(scene,local);}
  else if(scene.transition==='wipe'){ctx.beginPath();ctx.rect(0,0,W*p,H);ctx.clip();renderScene(scene,local);}
  else if(scene.transition==='zoom'){ctx.translate(W/2,H/2);ctx.scale(.78+.22*p,.78+.22*p);ctx.translate(-W/2,-H/2);ctx.globalAlpha=p;renderScene(scene,local);}
  else if(scene.transition==='blur'){ctx.globalAlpha=p;ctx.filter=`blur(${(1-p)*16}px)`;renderScene(scene,local);ctx.filter='none';}
  ctx.restore();
}
async function uploadMedia(files){if(!files?.length)return;
  try{await persistBeforeSwitch();for(const file of files){if(file.size>750*1024*1024)throw Error(`${file.name}: 파일 최대 750 MB`);
    const mime=file.type||({mp3:'audio/mpeg',wav:'audio/wav',flac:'audio/flac',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',ogg:'audio/ogg',m4a:'audio/mp4',ttf:'font/ttf',otf:'font/otf',woff:'font/woff',woff2:'font/woff2'}[file.name.split('.').pop().toLowerCase()]);
    if(!mime||(!mime.startsWith('audio/')&&!mime.startsWith('image/')&&!mime.startsWith('font/')&&!fontMimeTypes.has(mime)))throw Error(`지원하지 않는 파일: ${file.name}`);
    status(`업로드 중: ${file.name}`,'dirty');const url=`/api/projects/${project.id}/assets?name=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(mime)}`;
    const result=await api(url,{method:'POST',headers:{'content-type':'application/octet-stream'},body:file});project=result.project;revision=project.revision;
    const s=currentScene();if(s){s[result.asset.kind==='image'?'imageId':result.asset.kind==='audio'?'audioId':'fontAssetId']=result.asset.id;updateDirty();}
    if(result.asset.kind==='audio')loadPeaks(result.asset.id);
    if(result.asset.kind==='font')await loadFontAsset(result.asset.id);
  }
  renderAll();await saveNow();toast(`${files.length}개 미디어를 추가했습니다.`);
  }catch(e){status('확인이 필요합니다','error');toast('파일 추가 오류: '+e.message);}
}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
async function downloadZip(){try{await persistBeforeSwitch();status('ZIP 생성 중…');const response=await fetch(`/api/projects/${project.id}/download`);if(!response.ok){const j=await response.json();throw Error(j.error);}
  downloadBlob(await response.blob(),`${project.name.replace(/[^a-zA-Z0-9가-힣_-]+/g,'_')||'breakdown'}.zip`);status('저장 완료');toast('원본 미디어 포함 프로젝트 ZIP을 내려받았습니다.');
  }catch(e){toast('ZIP 내보내기 실패: '+e.message);status('확인이 필요합니다','error');}}
async function importZip(file){if(!file)return;try{await persistBeforeSwitch();status('ZIP 불러오는 중…','dirty');const result=await api('/api/import',{method:'POST',headers:{'content-type':'application/zip'},body:file});await load(result.project.id);toast('ZIP 프로젝트를 가져왔습니다.');}catch(e){toast('ZIP 불러오기 실패: '+e.message);}}
async function restoreBackup(){try{await persistBeforeSwitch();const j=await api(`/api/projects/${project.id}/backups`);if(!j.backups.length){toast('자동 백업이 아직 없습니다.');return;}
    const summary=j.backups.slice(0,12).map((n,i)=>`${i+1}. ${n}`).join('\n');const choice=prompt(`복구할 백업 번호를 입력해 주세요.\n현재 상태는 복구 직전 자동 백업됩니다.\n\n${summary}`,'1');if(choice===null)return;
    const number=Number(choice);if(!Number.isInteger(number)||number<1||number>Math.min(12,j.backups.length))return toast('잘못된 번호입니다.');
    const target=j.backups[number-1];if(!confirm(`${target} 백업으로 복구할까요?`))return;
    const result=await api(`/api/projects/${project.id}/backups/${encodeURIComponent(target)}/restore`,{method:'POST'});project=result.project;revision=project.revision;selectedId=project.scenes[0].id;stop();playhead=0;renderAll();status('백업 복구 완료');toast('백업에서 프로젝트를 복구했습니다.');
  }catch(e){toast('백업 복구 오류: '+e.message);}}
function openExport(){if(!project)return;$('exportModal').classList.remove('hidden');$('exportProgress').style.width='0%';$('exportStatus').textContent='출력 준비됨';$('cancelExport').disabled=false;$('closeExport').disabled=false;$('startExport').disabled=false;}
function closeExport(){if(exporting)return toast('출력 중에는 닫을 수 없습니다.');$('exportModal').classList.add('hidden');}
async function beginExport(){if(exporting)return;
  if(!window.MediaRecorder||!stage.captureStream)return toast('이 브라우저는 화면 녹화를 지원하지 않습니다.');
  try{await persistBeforeSwitch();await ensureProjectFonts();ensureAudioContext();await audioContext.resume();exportType=document.querySelector('input[name=exportType]:checked').value;
    const mime=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(v=>MediaRecorder.isTypeSupported(v));
    if(!mime)throw Error('이 브라우저에서 WebM 인코딩을 지원하지 않습니다.');
    stop();seek(0);exportChunks=[];const canvasStream=stage.captureStream(30);
    const tracks=[...canvasStream.getVideoTracks(),...mixOutput.stream.getAudioTracks()];recorder=new MediaRecorder(new MediaStream(tracks),{mimeType:mime,videoBitsPerSecond:5_000_000,audioBitsPerSecond:192_000});
    recorder.ondataavailable=e=>{if(e.data.size)exportChunks.push(e.data);};
    recorder.onerror=e=>{console.error(e);toast('영상 녹화 오류');};
    recorder.onstop=async()=>{
      const blob=new Blob(exportChunks,{type:'video/webm'});exportChunks=[];exporting=false;stop();canvasStream.getTracks().forEach(t=>t.stop());
      try{if(exportType==='mp4'){$('exportStatus').textContent='FFmpeg로 MP4 변환 중…';$('exportProgress').style.width='96%';const response=await fetch('/api/transcode',{method:'POST',headers:{'content-type':'video/webm'},body:blob});
          if(!response.ok){const e=await response.json();throw Error(e.error||'MP4 변환 실패');}downloadBlob(await response.blob(),'sample-breakdown.mp4');}
        else downloadBlob(blob,'sample-breakdown.webm');
        $('exportStatus').textContent='출력 완료. 다운로드 폴더를 확인하세요.';$('exportProgress').style.width='100%';toast('영상 내보내기를 완료했습니다.');
      }catch(e){$('exportStatus').textContent='변환 실패: '+e.message;toast(e.message+' (WebM은 별도로 저장 가능)');downloadBlob(blob,'sample-breakdown-backup.webm');}
      $('startExport').disabled=false;$('cancelExport').disabled=false;$('closeExport').disabled=false;
    };
    exporting=true;$('startExport').disabled=true;$('cancelExport').disabled=true;$('closeExport').disabled=true;
    $('exportStatus').textContent='영상 녹화 중. 다른 탭으로 이동하지 마세요.';
    recorder.start(500);play();const originalTick=tick;
    // Progress comes from the same playhead as the preview; no background worker needed.
    const progress=()=>{if(exporting){$('exportProgress').style.width=Math.min(95,100*playhead/Math.max(.1,totalTime()))+'%';requestAnimationFrame(progress);}};requestAnimationFrame(progress);
  }catch(e){exporting=false;toast('영상 출력 실패: '+e.message);$('exportStatus').textContent=e.message;}
}
async function init(){try{const health=await api('/api/health');$('dataPath').textContent='저장 위치: '+health.dataDir;
    const result=await api('/api/projects');if(result.projects.length){const first=await api(`/api/projects/${result.projects[0].id}`);project=first.project;}
    else{const first=await api('/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'My First Breakdown'})});project=first.project;}
    revision=project.revision;selectedId=project.scenes[0].id;await getProjects(project.id);status('저장 완료');renderAll();
  }catch(e){status('서버 오류','error');toast('프로젝트를 불러올 수 없습니다: '+e.message);}}
$('newProject').addEventListener('click',createProject);$('duplicateProject').addEventListener('click',duplicate);
$('renameProject').addEventListener('click',async()=>{const name=prompt('프로젝트 이름 변경',project.name);if(name===null||!name.trim())return;project.name=name.trim().slice(0,100);updateDirty();try{await saveNow();await getProjects(project.id);}catch(e){toast(e.message);}});
$('projectSelect').addEventListener('change',async e=>{try{await load(e.target.value);}catch(err){toast(err.message);e.target.value=project.id;}});
$('saveBtn').addEventListener('click',async()=>{try{await saveNow();toast('프로젝트 저장 완료');}catch{}});
$('backupBtn').addEventListener('click',restoreBackup);$('zipBtn').addEventListener('click',downloadZip);
$('zipImport').addEventListener('change',async e=>{await importZip(e.target.files[0]);e.target.value='';});
$('mediaUpload').addEventListener('change',async e=>{await uploadMedia([...e.target.files]);e.target.value='';});
$('formatSelect').addEventListener('change',e=>{project.format=e.target.value;updateDirty();renderAll();});
$('restartBtn').addEventListener('click',()=>seek(0));$('stopBtn').addEventListener('click',()=>{stop();seek(0);});$('playBtn').addEventListener('click',()=>playing?stop():play());
$('seekSlider').addEventListener('input',e=>seek(e.target.value));
$('addScene').addEventListener('click',()=>{const s={...structuredClone(currentScene()),id:uid(),type:'custom',title:'NEW SCENE',subtitle:'Add your notes',duration:5,transition:'fade',audioStart:0};
  const ix=project.scenes.findIndex(x=>x.id===selectedId);project.scenes.splice(ix+1,0,s);selectedId=s.id;stop();playhead=previewTimeOf(s.id);updateDirty();renderAll();});
const drop=$('dropTarget');drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('dragover');});drop.addEventListener('dragleave',()=>drop.classList.remove('dragover'));drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('dragover');uploadMedia([...e.dataTransfer.files]);});
$('exportBtn').addEventListener('click',openExport);$('closeExport').addEventListener('click',closeExport);$('cancelExport').addEventListener('click',closeExport);$('startExport').addEventListener('click',beginExport);
window.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();saveNow().catch(()=>{});return;}
  if(e.code==='Space'&&!['INPUT','TEXTAREA','SELECT','BUTTON'].includes(document.activeElement.tagName)){e.preventDefault();playing?stop():play();}});
window.addEventListener('beforeunload',e=>{if(dirty||saving){e.preventDefault();e.returnValue='';}});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&dirty)saveNow().catch(()=>{});});
window.addEventListener('pagehide',()=>{if(dirty)saveNow().catch(()=>{});});
init();
