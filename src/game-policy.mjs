import {parse,serialize} from 'parse5';

export const GAME_CSP="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'";

// The original checkout stays untouched. Only the served document is adapted.
export function isOptionalIconLink(node){
  const rel=node.attrs?.find(attribute=>attribute.name==='rel')?.value.trim().toLowerCase().replace(/\s+/g,' ');
  return node.tagName==='link'&&['icon','shortcut icon','apple-touch-icon','apple-touch-icon-precomposed','mask-icon'].includes(rel);
}
export function localGameHtml(html,requestOrigin,{missingOptional=[]}={}){
  const document=parse(html);const removed=[],removedOptional=[];
  const missing=new Set(Array.isArray(missingOptional)?missingOptional.filter(value=>typeof value==='string'):[]);
  const automaticAttributes={script:'src',iframe:'src',frame:'src',embed:'src',object:'data',img:'src',audio:'src',video:'src',source:'src',track:'src',link:'href'};
  const walk=parent=>{
    for(const node of [...(parent.childNodes||[])]){
      const attribute=automaticAttributes[node.tagName];
      const value=node.attrs?.find(attr=>attr.name===attribute)?.value;
      if(attribute&&value){
        if(isOptionalIconLink(node)&&missing.has(value)){
          removedOptional.push(value);parent.childNodes.splice(parent.childNodes.indexOf(node),1);continue;
        }
        let address;try{address=new URL(value,requestOrigin);}catch{}
        if(!address||(['http:','https:'].includes(address.protocol)&&address.origin!==requestOrigin)){
          removed.push({element:node.tagName,host:address?.hostname||'invalid'});
          parent.childNodes.splice(parent.childNodes.indexOf(node),1);continue;
        }
      }
      walk(node);if(node.content)walk(node.content);
    }
  };
  walk(document);return {html:serialize(document),removed,removedOptional};
}
