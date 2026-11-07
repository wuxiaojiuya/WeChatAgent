import test from 'node:test';
import assert from 'node:assert/strict';
import {startUpdateUI} from '../public/console/updates.js';

test('a successful current-version recheck clears the previous update banner and stale download link',async t=>{
 const elements=new Map();
 for(const id of ['check-updates','update-banner','update-message','update-download','update-notes','dismiss-update'])elements.set('#'+id,{hidden:true,textContent:'',listeners:{},addEventListener(event,callback){this.listeners[event]=callback;},removeAttribute(name){delete this[name];}});
 const previous=globalThis.document;globalThis.document={querySelector:selector=>elements.get(selector)};t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
 const responses=[{status:'available',latestVersion:'0.2.17',downloadUrl:'https://github.com/wuxiaojiuya/WeChatAgent/releases/download/v0.2.17/setup.exe',releaseUrl:'https://github.com/wuxiaojiuya/WeChatAgent/releases/tag/v0.2.17'},{status:'up_to_date',currentVersion:'0.2.17'}];
 startUpdateUI({api:async()=>responses.shift(),toast(){}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(elements.get('#update-banner').hidden,false);assert(elements.get('#update-download').href);
 await elements.get('#check-updates').listeners.click();
 assert.equal(elements.get('#update-banner').hidden,true);assert.equal(elements.get('#update-message').textContent,'');assert.equal(elements.get('#update-download').href,undefined);assert.equal(elements.get('#update-notes').href,undefined);
});
