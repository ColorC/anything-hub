import test from 'node:test';
import assert from 'node:assert/strict';
import {GAME_CSP,localGameHtml} from '../src/game-policy.mjs';
test('served game keeps its local core and removes third-party automatic resources',()=>{
 const source='<!doctype html><html><head><script async data-goatcounter="https://example.goatcounter.com/count" src="//gc.zgo.at/count.js"></script><script src="./static/game.js"></script><link rel="stylesheet" href="./game.css"></head><body><a href="https://github.com/lynn/hello">Source</a><div id="game">Ready</div></body></html>';
 const adapted=localGameHtml(source,'http://127.0.0.1:42100');
 assert(!adapted.html.includes('gc.zgo.at'));assert(adapted.html.includes('./static/game.js'));assert(adapted.html.includes('./game.css'));assert(adapted.html.includes('https://github.com/lynn/hello'));assert(adapted.html.includes('Ready'));
 assert.deepEqual(adapted.removed,[{element:'script',host:'gc.zgo.at'}]);assert(source.includes('gc.zgo.at'));
 assert(GAME_CSP.includes("connect-src 'self'"));assert(GAME_CSP.includes("script-src 'self'"));assert(!GAME_CSP.includes('https:'));
});
