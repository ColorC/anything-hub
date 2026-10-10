import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readProvenance} from '../src/repository.mjs';
import {prepareRepositoryBatch} from './repository-fixture.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const batch=path.join(root,'.omni','tmp','windows-trial','repository-tests');
const fixture=path.join(batch,'metadata');
const owner='anything-hub-repository-metadata';
const names=['setext-equals','setext-hyphens'];
const allowed=new Set(['fixture-owner.json',...names.flatMap(name=>[name,`${name}/README.md`,`${name}/LICENSE`,`${name}/package.json`])]);

function inspect(file,relative=''){
  const stat=fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(),false,`Do not follow fixture links: ${file}`);
  if(stat.isFile())assert.equal(stat.nlink,1,`Do not overwrite hard links: ${file}`);
  if(relative)assert.ok(allowed.has(relative),`Preserve unknown content: ${file}`);
  if(stat.isDirectory())for(const name of fs.readdirSync(file))inspect(path.join(file,name),relative?`${relative}/${name}`:name);
}
async function prepare(){
  for(let current=fixture;;current=path.dirname(current)){
    if(fs.existsSync(current))assert.equal(fs.lstatSync(current).isSymbolicLink(),false,`Linked ancestor: ${current}`);
    if(current===root)break;
    assert.ok(current.startsWith(root+path.sep));
  }
  await prepareRepositoryBatch(root,batch);
  const ownerFile=path.join(fixture,'fixture-owner.json');
  if(fs.existsSync(fixture)){
    inspect(fixture);assert.equal(JSON.parse(fs.readFileSync(ownerFile,'utf8')).owner,owner);
  }else{
    fs.mkdirSync(fixture);
    fs.writeFileSync(ownerFile,JSON.stringify({owner,fixture,batch,role:'README metadata regression fixtures',files:[...allowed]},null,2),{flag:'wx'});
  }
}

test('Setext title blocks do not replace a normal description or GNU license title',{timeout:10000},async()=>{
  await prepare();
  for(const [index,underline] of ['========','--------'].entries()){
    const source=path.join(fixture,names[index]);fs.mkdirSync(source,{recursive:true});
    const readme=`Hextris\r\n${underline}\r\n\r\nRotate a hexagon and match falling blocks.\r\n\r\nUse the arrow keys to play.\r\n`;
    const license='GNU GENERAL PUBLIC LICENSE\n==========================\n\nVersion 3, 29 June 2007\n\nSection 13 discusses the GNU AFFERO GENERAL PUBLIC LICENSE.\n';
    fs.writeFileSync(path.join(source,'README.md'),readme);
    fs.writeFileSync(path.join(source,'LICENSE'),license);
    fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({name:'metadata-fixture',version:'1.2.3',author:'Fixture author'}));
    const metadata=readProvenance(source);
    assert.equal(metadata.description,'Rotate a hexagon and match falling blocks.');
    assert.equal(metadata.title,'metadata-fixture');
    assert.equal(metadata.provenance.readme,readme);
    assert.equal(metadata.provenance.readmeFile,'README.md');
    assert.equal(metadata.provenance.license,'GPL-3.0');
    assert.equal(metadata.provenance.licenseFile,'LICENSE');
    assert.equal(metadata.provenance.licenseText,license);
    assert.equal(metadata.provenance.packageName,'metadata-fixture');
    assert.equal(metadata.provenance.version,'1.2.3');
    assert.equal(metadata.provenance.author,'Fixture author');
  }
});
