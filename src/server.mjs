import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {GAME_CSP,localGameHtml} from './game-policy.mjs';
import {normalizeRepository,validateRef,validateOutput,sourcePath,readProvenance,detectRepository,discoverOutput} from './repository.mjs';

const entryDirectory=path.dirname(fileURLToPath(import.meta.url));
const projectRoot=path.resolve(process.env.HUB_PROJECT_ROOT || path.join(entryDirectory,entryDirectory.endsWith(path.join('publish','core'))?'../..':'..'));
const runtime=path.resolve(process.env.HUB_HOME || path.join(projectRoot,'runtime'));
const webRoot=path.join(projectRoot,'src','web');
const curated=JSON.parse(fs.readFileSync(path.join(projectRoot,'src','catalog.json'),'utf8').replace(/^\uFEFF/,''));
const catalogPath=path.join(runtime,'catalog.json');
const dynamic=fs.existsSync(catalogPath)?JSON.parse(fs.readFileSync(catalogPath,'utf8').replace(/^\uFEFF/,'')):[];
if(!Array.isArray(dynamic))throw new Error('runtime/catalog.json 必须是作品数组。');
const catalog=[...curated];
for(const game of dynamic){normalizeRepository(game.repo);validateRef(game.ref);if(game.output!=null)validateOutput(game.output);if(!catalog.some(existing=>existing.id===game.id))catalog.push({...game,imported:true});}
for(const game of catalog){if(!/^[a-z0-9-]+$/.test(game.id))throw new Error('Invalid catalog id');}
for(const dir of ['games','logs','reports'])fs.mkdirSync(path.join(runtime,dir),{recursive:true});
const statePath=path.join(runtime,'state.json');
let state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{};
for(const id of Object.keys(state))if(state[id].status==='installing')state[id]={...state[id],status:'failed',error:'安装被中断，可以重新尝试。'};
const listeners=new Set();
const tasks=new Map();
const port=Number(process.env.HUB_PORT || 42100);
const mount='/anything-hub/';
const versionPath=path.join(projectRoot,'publish','version.json');
const loadedCommit=fs.existsSync(versionPath)?JSON.parse(fs.readFileSync(versionPath,'utf8').replace(/^\uFEFF/,'')).commit:null;
const loadedPackageVersion=JSON.parse(fs.readFileSync(path.join(projectRoot,'package.json'),'utf8').replace(/^\uFEFF/,'')).version;
function sourceVersion(){return loadedCommit;}
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function persist(){fs.writeFileSync(statePath,JSON.stringify(state,null,2));}
function games(){return catalog.map(g=>{const normalized=normalizeRepository(g.repo);return {...g,source:{repository:normalized.repository,provider:normalized.provider,ref:g.ref||null,commit:state[g.id]?.commit||null},compatibility:{kind:'unknown',label:'安装后检测网页规范',output:g.output??null,entry:'index.html',detected:false,reason:null},...state[g.id],status:state[g.id]?.status||'available',playUrl:`games/${g.id}/index.html`,logUrl:`api/games/${g.id}/log.txt`};});}
function emit(event){const data=`data: ${JSON.stringify(event)}\n\n`;for(const res of listeners)res.write(data);}
function changed(){persist();emit({type:'state',games:games()});}
function gameById(id){const game=catalog.find(g=>g.id===id);if(!game)throw Object.assign(new Error('找不到这款作品'),{status:404});return game;}
function gamePaths(game){const root=sourcePath(runtime,path.join('games',game.id));const source=sourcePath(runtime,path.join('games',game.id,'source'));const output=sourcePath(source,validateOutput(state[game.id]?.output??game.output));return {root,source,output};}
function logPath(id){return path.join(runtime,'logs',`${id}-install.log`);}
function reportList(){return fs.readdirSync(path.join(runtime,'reports')).filter(n=>n.endsWith('.json')).map(n=>{const r=JSON.parse(fs.readFileSync(path.join(runtime,'reports',n),'utf8'));return {id:r.id,gameId:r.gameId,summary:r.summary,createdAt:r.createdAt,url:`reports/${r.id}.html`,downloadUrl:`reports/${r.id}.json`};}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
function stopTree(child){if(!child.pid)return;if(process.platform==='win32')spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else{try{process.kill(-child.pid,'SIGTERM');}catch{child.kill('SIGTERM');}}}
function command(exe,args,{cwd,env={},timeout=120000,onLine}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{cwd,env:{...process.env,...env,GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'',SSH_ASKPASS:''},windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    let output='';let settled=false;
    const done=(err)=>{if(settled)return;settled=true;clearTimeout(timer);err?reject(err):resolve(output.trim());};
    const timer=setTimeout(()=>{stopTree(child);done(new Error(`步骤超过 ${Math.round(timeout/1000)} 秒，已停止。`));},timeout);
    const collect=chunk=>{const text=chunk.toString();output=(output+text).slice(-50000);onLine?.(text);};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    child.on('error',done);child.on('exit',code=>{onLine?.(`\n[exit ${code}] ${exe} ${args.join(' ')}\n`);done(code===0?null:new Error(`命令退出码 ${code}\n${output.slice(-2500)}`));});
  });
}
function npmCommand(args){
  const cli=process.env.HUB_NPM_CLI || path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
  if(!fs.existsSync(cli))throw new Error(`缺少 npm CLI: ${cli}`);
  return {exe:process.execPath,args:[cli,...args]};
}
async function install(game){
  if(tasks.has(game.id))return tasks.get(game.id);
  const task={id:`${game.id}-${Date.now()}`,state:'running',startedAt:new Date().toISOString()};tasks.set(game.id,task);
  state[game.id]={...state[game.id],status:'installing',task,error:null};changed();
  const log=logPath(game.id);fs.appendFileSync(log,`\n=== ${task.startedAt} ${game.repo} ===\n`);
  const onLine=line=>{fs.appendFileSync(log,line);emit({type:'log',gameId:game.id,line});};
  (async()=>{
    let p;
    try{
      p=gamePaths(game);fs.mkdirSync(p.root,{recursive:true});
      const normalized=normalizeRepository(game.repo);const ref=validateRef(game.ref);
      state[game.id]={...state[game.id],sourcePath:p.source,outputPath:null};changed();
      if(!fs.existsSync(p.source))await command('git',['-c','credential.helper=','-c','http.extraHeader=','clone','--depth','1',...(ref?['--branch',ref]:[]),'--',normalized.repository,p.source],{cwd:p.root,timeout:120000,onLine});
      else{
        const top=await command('git',['-C',p.source,'rev-parse','--show-toplevel']);
        if(path.resolve(top)!==path.resolve(p.source))throw new Error('源码目录不属于预期仓库；保留目录，请检查日志。');
        const remote=await command('git',['-C',p.source,'config','--get','remote.origin.url']);
        if(normalizeRepository(remote).repository!==normalized.repository)throw new Error('源码仓库来源不同，已保留现有内容。');
      }
      const origin=await command('git',['-C',p.source,'config','--get','remote.origin.url']);
      const commit=await command('git',['-C',p.source,'rev-parse','HEAD']);
      if(!/^[a-f0-9]{40}$/i.test(commit))throw new Error('无法确认原生 Git commit。');
      state[game.id]={...state[game.id],commit,source:{repository:normalized.repository,provider:normalized.provider,ref,commit}};changed();onLine(`\nGit origin: ${origin}\nGit commit: ${commit}\n`);
      const metadata=readProvenance(p.source);
      state[game.id]={...state[game.id],provenance:metadata.provenance,license:metadata.provenance.license,...(game.imported?{title:game.requestedTitle||metadata.title||normalized.name,description:metadata.description||''}:{})};changed();
      const recipe=detectRepository(p.source,game.output);
      state[game.id]={...state[game.id],mode:recipe.mode,compatibility:{kind:recipe.kind,label:recipe.label,output:recipe.outputOverride,entry:'index.html',detected:true,reason:null,profile:recipe.profile}};changed();onLine(`\n检测规范：${recipe.label} (${recipe.profile})\n`);
      if(recipe.kind==='npm'){
        onLine('\n安装构建依赖…\n');const npm=npmCommand(['ci','--no-audit','--no-fund']);
        await command(npm.exe,npm.args,{cwd:p.source,env:{npm_config_cache:path.join(runtime,'cache','npm'),npm_config_fetch_retries:'1',npm_config_fetch_timeout:'45000'},timeout:300000,onLine});
        onLine('\n构建游戏…\n');const build=npmCommand(recipe.buildArguments);
        await command(build.exe,build.args,{cwd:p.source,env:{PUBLIC_URL:'.',CI:'false'},timeout:150000,onLine});
      }
      const output=discoverOutput(p.source,recipe);
      if(output.missingOptional.length)onLine(`\n缺少可选图标，打开网页时不请求：${output.missingOptional.join(', ')}\n`);
      task.state='succeeded';task.finishedAt=new Date().toISOString();state[game.id]={...state[game.id],status:'ready',installedAt:task.finishedAt,task,sourcePath:p.source,outputPath:output.directory,output:output.output,compatibility:{...state[game.id].compatibility,output:output.output,entry:output.entry,removedExternal:output.removedExternal,missingOptional:output.missingOptional},error:null};onLine('\n可以开始游戏。\n');
    }catch(error){task.state='failed';task.finishedAt=new Date().toISOString();state[game.id]={...state[game.id],status:'failed',error:error.message,task,compatibility:{...state[game.id]?.compatibility,kind:'unsupported',label:'暂不符合网页运行规范',detected:true,reason:error.message}};onLine(`\n失败：${error.message}\n`);}
    finally{tasks.delete(game.id);changed();}
  })();return task;
}
async function importRepository(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Object.assign(new Error('导入参数必须是对象。'),{status:400});
  const normalized=normalizeRepository(input.repo),ref=validateRef(input.ref);
  const output=input.output==null?undefined:validateOutput(input.output);
  if(input.title!=null&&(typeof input.title!=='string'||!input.title.trim()||input.title.length>160))throw Object.assign(new Error('作品标题必须是非空文本，且不超过 160 字。'),{status:400});
  let game=catalog.find(existing=>normalizeRepository(existing.repo).repository.toLowerCase()===normalized.repository.toLowerCase());
  if(game){if(ref&&ref!==validateRef(game.ref))throw Object.assign(new Error('该仓库已登记其他引用；保留现有源码，不自动切换分支。'),{status:409});}
  else{
    if(catalog.some(existing=>existing.id===normalized.id))throw Object.assign(new Error('仓库名称与现有作品标识冲突；未覆盖已有内容。'),{status:409});
    game={id:normalized.id,title:input.title?.trim()||normalized.name,requestedTitle:input.title?.trim()||null,description:'',genre:'网页游戏',repo:normalized.repository,license:'未声明',ref,imported:true,...(output!==undefined?{output}:{})};
    catalog.push(game);dynamic.push(game);fs.writeFileSync(catalogPath,JSON.stringify(dynamic,null,2));changed();
  }
  return {gameId:game.id,task:await install(game)};
}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>6*1024*1024)throw Object.assign(new Error('请求内容太大'),{status:413});}try{return JSON.parse(text||'{}');}catch{throw Object.assign(new Error('请求必须包含有效 JSON。'),{status:400});}}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.map':'application/json'};
function file(res,root,relative,gameOrigin,gamePolicy){
  const name=path.resolve(root,relative||'index.html');const relation=path.relative(root,name);
  if(relation.startsWith('..')||path.isAbsolute(relation)||relative.split(/[\\/]/).some(v=>v.startsWith('.'))){json(res,403,{error:'不可访问的路径'});return;}
  try{sourcePath(root,relation);}catch{json(res,403,{error:'不可访问链接目录或资源'});return;}
  if(!fs.existsSync(name)||!fs.statSync(name).isFile()){json(res,404,{error:'没有找到文件'});return;}
  const headers={'Content-Type':mime[path.extname(name)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'};
  if(gameOrigin)headers['Content-Security-Policy']=GAME_CSP;
  if(gameOrigin&&path.extname(name)==='.html'){
    const adapted=localGameHtml(fs.readFileSync(name,'utf8'),gameOrigin,gamePolicy);
    if(adapted.removed.length)fs.appendFileSync(path.join(runtime,'logs','game-network-policy.log'),JSON.stringify({at:new Date().toISOString(),path:relative,removed:adapted.removed})+'\n');
    res.writeHead(200,headers);res.end(adapted.html);return;
  }
  headers['Content-Length']=fs.statSync(name).size;res.writeHead(200,headers);const stream=fs.createReadStream(name);res.on('close',()=>stream.destroy());stream.pipe(res);
}
async function saveReport(data){
  const game=gameById(data.gameId);const id=`${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const screenshot=typeof data.screenshot==='string'&&/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.screenshot)&&data.screenshot.length<5500000?data.screenshot:null;
  const log=fs.existsSync(logPath(game.id))?fs.readFileSync(logPath(game.id),'utf8').slice(-60000):'';
  const report={id,createdAt:new Date().toISOString(),gameId:game.id,title:game.title,repo:game.repo,commit:state[game.id]?.commit||null,summary:String(data.summary||'游戏问题').slice(0,300),details:String(data.details||'').slice(0,15000),selector:String(data.selector||'').slice(0,2000),selection:data.selection||null,screenshot,diagnostics:data.diagnostics||{},machine:{hostname:os.hostname(),platform:process.platform,node:process.version},install:{status:state[game.id]?.status||'available',error:state[game.id]?.error||null,log},sourcePath:state[game.id]?.sourcePath||null};
  const rroot=path.join(runtime,'reports');const jsonFile=path.join(rroot,`${id}.json`);const htmlFile=path.join(rroot,`${id}.html`);
  fs.writeFileSync(jsonFile,JSON.stringify(report,null,2));
  const html=`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(report.summary)}</title><style>body{font:16px/1.6 system-ui;max-width:980px;margin:40px auto;padding:0 24px;color:#223d33;background:#f7f7f0}h1{font-size:28px}a{color:#1c6750}img{max-width:100%;border-radius:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;padding:18px;border-radius:12px}summary{cursor:pointer}button{font:inherit;padding:8px 14px}</style><h1>${esc(report.summary)}</h1><p>${esc(game.title)} · ${esc(report.createdAt)}</p><a href="${id}.json" download>下载完整报告</a> · <a href="../?game=${esc(game.id)}">回到作品</a><p>${esc(report.details).replace(/\n/g,'<br>')}</p>${screenshot?`<img alt="问题截图" src="${screenshot}">`:''}<p>选中位置：${esc(report.selector||'未圈选')}</p><details><summary>环境、操作与错误</summary><pre>${esc(JSON.stringify({...report, screenshot:undefined,install:undefined},null,2))}</pre></details><details><summary>安装和构建日志</summary><pre>${esc(log||'没有安装日志')}</pre></details></html>`;
  fs.writeFileSync(htmlFile,html);emit({type:'report',report:{id,gameId:game.id,summary:report.summary,createdAt:report.createdAt}});
  return {id,createdAt:report.createdAt,url:`reports/${id}.html`,downloadUrl:`reports/${id}.json`};
}
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');let route=decodeURIComponent(url.pathname);if(route.startsWith(mount))route='/'+route.slice(mount.length);
    if(req.method!=='GET'&&req.method!=='HEAD'&&req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host){json(res,403,{error:'请求来自其他网站'});return;}
    if(req.method==='GET'&&route==='/api/health'){json(res,200,{ok:true,hostname:os.hostname(),port,runtime,pid:process.pid,version:loadedPackageVersion,sourceCommit:sourceVersion()});return;}
    if(req.method==='GET'&&route==='/api/catalog'){json(res,200,{games:games(),machine:{hostname:os.hostname()},reports:reportList()});return;}
    if(req.method==='POST'&&route==='/api/catalog/import'){json(res,202,await importRepository(await body(req)));return;}
    if(req.method==='GET'&&route==='/api/events'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(`data: ${JSON.stringify({type:'state',games:games()})}\n\n`);listeners.add(res);
      const pulse=setInterval(()=>res.write(': alive\n\n'),20000);req.on('close',()=>{clearInterval(pulse);listeners.delete(res);});return;
    }
    const action=route.match(/^\/api\/games\/([a-z0-9-]+)\/(install|log|log\.txt)$/);
    if(action){const game=gameById(action[1]);if(action[2]==='install'&&req.method==='POST'){json(res,202,{task:await install(game)});return;}if(req.method==='GET'&&action[2].startsWith('log')){const text=fs.existsSync(logPath(game.id))?fs.readFileSync(logPath(game.id),'utf8').slice(-120000):'';if(action[2]==='log.txt'){res.writeHead(200,{'Content-Type':mime['.txt']});res.end(text);}else json(res,200,{gameId:game.id,text,url:`api/games/${game.id}/log.txt`});return;}}
    if(route==='/api/reports'&&req.method==='GET'){json(res,200,{reports:reportList()});return;}
    if(route==='/api/reports'&&req.method==='POST'){json(res,201,{report:await saveReport(await body(req))});return;}
    if(req.method!=='GET'&&req.method!=='HEAD'){json(res,405,{error:'此操作不支持'});return;}
    if(route.startsWith('/reports/')){file(res,path.join(runtime,'reports'),route.slice(9));return;}
    if(route.startsWith('/evidence/')){file(res,path.join(projectRoot,'publish','evidence'),route.slice(10));return;}
    if(route==='/downloads/creative-workshop-windows-x64.zip'){file(res,path.join(projectRoot,'publish','windows'),'AnythingHub-windows-x64.zip');return;}
    const play=route.match(/^\/games\/([a-z0-9-]+)\/(.*)$/);if(play){const game=gameById(play[1]);if(state[game.id]?.status!=='ready'){json(res,409,{error:'请先下载游戏'});return;}const scheme=String(req.headers['x-forwarded-proto']||'http').split(',')[0].trim();const policy={missingOptional:!play[2]||play[2]===(state[game.id].compatibility?.entry||'index.html')?state[game.id].compatibility?.missingOptional||[]:[]};file(res,gamePaths(game).output,play[2],`${scheme}://${req.headers.host}`,policy);return;}
    if(route==='/dist/app.js'){file(res,path.join(projectRoot,'publish','web'),'app.js');return;}
    file(res,webRoot,route.slice(1));
  }catch(error){if(!res.headersSent)json(res,error.status||500,{error:error.message});else res.end();}
});
server.listen(port,'127.0.0.1',()=>{const receipt={ready:true,url:`http://127.0.0.1:${port}/`,hostname:os.hostname(),runtime,pid:process.pid,statePath,sourceCommit:sourceVersion()};fs.writeFileSync(path.join(runtime,'server.pid'),String(process.pid));fs.appendFileSync(path.join(runtime,'logs','server-events.log'),JSON.stringify({...receipt,startedAt:new Date().toISOString()})+'\n');console.log(JSON.stringify(receipt));});
process.on('SIGTERM',()=>{for(const res of listeners)res.end();server.close(()=>process.exit(0));});
