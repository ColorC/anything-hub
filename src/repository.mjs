import fs from 'node:fs';
import path from 'node:path';
import {parse} from 'parse5';
import {localGameHtml,isOptionalIconLink} from './game-policy.mjs';

const providers=new Map([['github.com','github'],['gitee.com','gitee'],['gitlab.com','gitlab'],['codeberg.org','codeberg']]);
const invalid=message=>Object.assign(new Error(message),{status:400});
export function validateRef(value){
  if(value==null||value==='')return null;
  if(typeof value!=='string'||value.length>160||!/[A-Za-z0-9]/.test(value)||!(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).test(value)||value.includes('..')||value.includes('//')||value.endsWith('/')||value.endsWith('.')||value.split('/').some(part=>part.startsWith('.')||part.endsWith('.lock')))throw invalid('ref 必须是正常的分支或标签名称。');
  return value;
}
export function validateOutput(value){
  if(value==null||value===''||value==='.')return '';
  if(typeof value!=='string'||value.length>240)throw invalid('output 必须是源码内的相对入口目录。');
  let normalized=value.replaceAll('\\','/');if(normalized.startsWith('./'))normalized=normalized.slice(2);normalized=normalized.replace(/\/$/,'');
  if(!normalized||normalized.startsWith('/')||/^[A-Za-z]:/.test(normalized)||normalized.split('/').some(part=>!part||part.startsWith('.')||/[<>:"|?*\x00-\x1f]/.test(part)))throw invalid('output 不得包含绝对路径、隐藏目录或目录穿越。');
  return normalized;
}
export function normalizeRepository(value){
  if(typeof value!=='string'||value.length>1000)throw invalid('请粘贴公开仓库的 HTTPS 主页地址。');
  let url;try{url=new URL(value.trim());}catch{throw invalid('仓库地址不是有效 URL。');}
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)throw invalid('仓库地址必须使用 HTTPS，且不含凭据、端口、查询参数或片段。');
  const provider=providers.get(url.hostname.toLowerCase());if(!provider)throw invalid('仅支持 GitHub、Gitee、GitLab 和 Codeberg 的公开 HTTPS 仓库。');
  const pathname=url.pathname.replace(/\/$/,'').replace(/\.git$/i,'');
  const segments=pathname.slice(1).split('/');
  if(segments.length<2||(provider!=='gitlab'&&segments.length!==2)||segments.some(segment=>!(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/).test(segment)||segment==='.'||segment==='..'||segment.endsWith('.lock')))throw invalid('请使用仓库主页地址，不要粘贴文件、分支或下载页面。');
  const namespace=segments.slice(0,-1).join('/'),name=segments.at(-1);
  const repository=`https://${url.hostname.toLowerCase()}/${segments.join('/')}.git`;
  const id=[provider,...segments].join('-').toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
  if(!id||id.length>180)throw invalid('仓库名称过长，无法建立作品标识。');
  return {repository,provider,namespace,name,id};
}
export function sourcePath(source,relative='',mustExist=false){
  const root=path.resolve(source),target=path.resolve(root,relative),relation=path.relative(root,target);
  if(relation.startsWith('..')||path.isAbsolute(relation))throw invalid('入口或资源超出源码目录。');
  for(let cursor=target;;cursor=path.dirname(cursor)){
    let stat;try{stat=fs.lstatSync(cursor);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(stat){
      if(stat.isSymbolicLink())throw invalid('入口或资源包含目录链接，不能对外提供。');
      if(cursor===target&&stat.isFile()&&stat.nlink>1)throw invalid('入口或资源是硬链接，不能对外提供。');
    }
    if(cursor===root)break;
    if(cursor===path.dirname(cursor))throw invalid('入口路径不在源码内。');
  }
  if(mustExist&&!fs.existsSync(target))throw new Error(`缺少本地入口或资源：${relative||'index.html'}`);
  return target;
}
function readText(source,name,limit=2*1024*1024){
  const file=sourcePath(source,name,true);const stat=fs.statSync(file);
  if(!stat.isFile()||stat.size>limit)throw new Error(`${name} 不是可读取的文本文件或超过当前文本读取上限。`);
  return fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');
}
function rootFile(source,expression){return fs.readdirSync(source).find(name=>expression.test(name))||null;}
function identifiedLicense(text){
  if(!text)return null;
  if(/Permission is hereby granted, free of charge/i.test(text)&&/THE SOFTWARE IS PROVIDED ["“]AS IS/i.test(text))return 'MIT';
  if(/Apache License/i.test(text)&&/Version 2\.0/i.test(text))return 'Apache-2.0';
  const headingLines=text.split(/\r?\n/).slice(0,12);
  const gnuIndex=headingLines.findIndex(line=>/^\s*(?:#{1,6}\s*)?GNU (?:AFFERO )?GENERAL PUBLIC LICENSE\s*$/i.test(line));
  if(gnuIndex!==-1){
    const version=headingLines.slice(gnuIndex+1,gnuIndex+7).map(line=>line.match(/^\s*Version\s+(\d+)\b/i)?.[1]).find(Boolean);
    const affero=/^\s*(?:#{1,6}\s*)?GNU AFFERO /i.test(headingLines[gnuIndex]);
    if(affero&&version==='3')return 'AGPL-3.0';
    if(!affero&&['2','3'].includes(version))return `GPL-${version}.0`;
  }
  if(/Mozilla Public License/i.test(text)&&/2\.0/.test(text))return 'MPL-2.0';
  if(/Redistribution and use in source and binary forms/i.test(text))return /Neither the name/i.test(text)?'BSD-3-Clause':'BSD-2-Clause';
  if(/Permission to use, copy, modify, and(?:\/or)? distribute/i.test(text)&&/with or without fee/i.test(text))return 'ISC';
  return null;
}
export function readProvenance(source){
  const packageFile=fs.existsSync(sourcePath(source,'package.json'))?'package.json':null;
  let pkg=null;if(packageFile){try{pkg=JSON.parse(readText(source,packageFile));}catch(error){throw new Error(`package.json 无法解析：${error.message}`);}}
  const readmeFile=rootFile(source,/^readme(?:\.(?:md|markdown|txt|rst))?$/i);
  const licenseFile=rootFile(source,/^(?:licen[cs]e|copying)(?:\.(?:md|txt|rst))?$/i);
  const readme=readmeFile?readText(source,readmeFile):null,licenseText=licenseFile?readText(source,licenseFile):null;
  const packageLicense=typeof pkg?.license==='string'?pkg.license:typeof pkg?.license?.type==='string'?pkg.license.type:null;
  const physical=identifiedLicense(licenseText);
  const license=physical||(licenseFile?'未识别许可文本':packageLicense||'未声明');
  const heading=readme?.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const setext=/(?:^|\n)[^\r\n]+\r?\n[ \t]*(?:=+|-+)[ \t]*(?:\r?\n|$)/;
  const paragraph=readme?.split(/\n\s*\n/).map(line=>line.trim()).find(line=>line&&!/^#|^!|^\[|^```|^</.test(line)&&!setext.test(line));
  return {pkg,title:typeof pkg?.name==='string'?pkg.name:heading||null,description:typeof pkg?.description==='string'?pkg.description:paragraph?.replace(/\s+/g,' ').slice(0,600)||null,provenance:{license,licenseSource:licenseFile?'file':packageLicense?'package':'undeclared',licenseFile,licenseText,readme,readmeFile,packageName:typeof pkg?.name==='string'?pkg.name:null,version:typeof pkg?.version==='string'?pkg.version:null,author:typeof pkg?.author==='string'?pkg.author:typeof pkg?.author?.name==='string'?pkg.author.name:null,packageLicense}};
}
export function detectRepository(source,outputOverride){
  const metadata=readProvenance(source),pkg=metadata.pkg;
  const hasBuild=typeof pkg?.scripts?.build==='string'&&pkg.scripts.build.trim();
  if(hasBuild){
    if(!fs.existsSync(sourcePath(source,'package-lock.json')))throw new Error('npm 构建规范要求根目录同时有 scripts.build 和 package-lock.json；当前缺少锁文件。');
    JSON.parse(readText(source,'package-lock.json',8*1024*1024));
    const vite=Boolean(pkg.dependencies?.vite||pkg.devDependencies?.vite)&&/(?:^|[\s;&])vite\s+build(?:\s|$)/.test(pkg.scripts.build);
    return {kind:'npm',label:'npm 源码构建',mode:'build',metadata,outputOverride:outputOverride==null?null:validateOutput(outputOverride),profile:vite?'vite-relative':'npm-relative',buildArguments:vite?['run','build','--','--base=./']:['run','build']};
  }
  const output=validateOutput(outputOverride);sourcePath(source,path.posix.join(output,'index.html'),true);
  return {kind:'static',label:'HTML5 静态网页',mode:'static',metadata,outputOverride:output,profile:'static-relative',buildArguments:null};
}
export function discoverOutput(source,recipe){
  const candidates=recipe.outputOverride!==null?[recipe.outputOverride]:['dist','build'];
  for(const output of candidates){const directory=sourcePath(source,validateOutput(output));const entry=sourcePath(source,path.posix.join(output,'index.html'));
    if(fs.existsSync(entry)&&fs.statSync(entry).isFile()){const policy=validateWebOutput(source,output);return {directory,output,entry:'index.html',removedExternal:policy.removedExternal,missingOptional:policy.missingOptional};}}
  throw new Error(`没有发现网页入口。${recipe.kind==='npm'?'npm 规范要求 dist/index.html 或 build/index.html，也可明确指定相对 output 目录。':'HTML5 规范要求 index.html。'}`);
}
export function validateWebOutput(source,output){
  const directory=sourcePath(source,validateOutput(output),true);
  const html=readText(source,path.posix.join(output,'index.html'));
  const adapted=localGameHtml(html,'http://127.0.0.1');
  const document=parse(adapted.html),references=[];
  const automatic={script:'src',img:'src',iframe:'src',audio:'src',video:'src',source:'src',track:'src',object:'data',embed:'src',link:'href'};
  function visit(node){
    if(node.tagName==='base'&&node.attrs?.some(attribute=>attribute.name==='href'))throw new Error('网页入口包含 base href；当前要求所有资源保持相对本地路径。');
    const name=automatic[node.tagName];const attribute=node.attrs?.find(item=>item.name===name);
    if(attribute&&!(node.tagName==='link'&&node.attrs?.some(item=>item.name==='rel'&&/canonical|alternate|preconnect|dns-prefetch/i.test(item.value))))references.push({value:attribute.value,optional:isOptionalIconLink(node)});
    for(const attribute of node.attrs||[])if(attribute.name==='srcset')for(const candidate of attribute.value.split(','))references.push({value:candidate.trim().split(/\s+/)[0],optional:false});
    for(const child of node.childNodes||[])visit(child);if(node.content)visit(node.content);
  }visit(document);
  const missingOptional=[];
  for(const {value,optional} of references){
    if(!value||value.startsWith('#')||/^(?:data|blob):/i.test(value))continue;
    if(value.startsWith('/')||/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value))throw new Error(`网页入口资源不是相对本地地址：${value.slice(0,200)}。请按网页游戏规范使用相对资源；Vite 项目支持通用相对 base 构建。`);
    let relative;try{relative=decodeURIComponent(value.split(/[?#]/)[0]);}catch{throw new Error('网页资源地址编码无效。');}
    if(relative.split(/[\\/]/).some(part=>part.startsWith('.')&&part!=='.'&&part!=='..'))throw new Error('网页入口引用隐藏资源，不能对外提供。');
    const target=path.resolve(directory,relative);const within=path.relative(directory,target);
    if(within.startsWith('..')||path.isAbsolute(within))throw new Error(`网页资源超出入口目录：${value.slice(0,160)}`);
    const safe=sourcePath(source,path.relative(source,target));
    if(/\.(?:tsx?|jsx)$/i.test(relative))throw new Error('入口仍引用未经构建的 TypeScript/JSX 源码，不能作为静态网页运行。');
    if(!fs.existsSync(safe)){
      if(optional){missingOptional.push(value);continue;}
      throw new Error(`缺少本地入口或资源：${path.relative(source,target)}`);
    }
    if(!fs.statSync(safe).isFile())throw new Error(`网页资源不是文件：${value.slice(0,160)}`);
  }
  return {removedExternal:adapted.removed,missingOptional:[...new Set(missingOptional)]};
}
