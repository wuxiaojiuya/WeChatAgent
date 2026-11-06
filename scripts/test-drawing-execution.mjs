import test from 'node:test';
import assert from 'node:assert/strict';
import {createDrawingExecution} from '../packages/dsh-capabilities-plugin/drawing.mjs';

const image='iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==';
const settings={endpoint:'https://api.example/v1',apiKey:'fixture-private-key',model:'gpt-image-2',size:'1024x1024',quality:'auto'};
const payload=()=>({settings:{...settings},prompt:'水彩猫咪'});

test('DSH drawing executor owns the single provider generation call and returns only image bytes and dimensions',async()=>{
  let calls=0;
  const execution=createDrawingExecution({fetchImpl:async(url,request)=>{calls++;assert.equal(url,'https://api.example/v1/images/generations');assert.equal(request.method,'POST');assert.equal(request.redirect,'error');assert.equal(request.headers.Authorization,'Bearer '+settings.apiKey);
    assert.deepEqual(JSON.parse(request.body),{model:settings.model,prompt:'水彩猫咪',n:1,size:settings.size,quality:settings.quality,output_format:'png'});return Response.json({data:[{b64_json:image}],private:settings.apiKey});}});
  assert.deepEqual(await execution('drawing.generate',payload()),{image,width:2,height:2});assert.equal(calls,1);
});

test('DSH drawing check confirms the exact model without attempting image generation',async()=>{
  let calls=0;
  const execution=createDrawingExecution({fetchImpl:async(url,request)=>{calls++;assert.equal(url,'https://api.example/v1/models/gpt-image-2');assert.equal(request.method,undefined);return Response.json({id:settings.model});}});
  assert.deepEqual(await execution('drawing.check',{settings}),{model:settings.model});assert.equal(calls,1);
  await assert.rejects(createDrawingExecution({fetchImpl:async()=>Response.json({id:'wrong-model'})})('drawing.check',{settings}),{code:'DRAWING_MODEL_UNCONFIRMED'});
});

test('strict private execution settings reject unsafe endpoints and extra task or identity fields before network',async()=>{
  const execution=createDrawingExecution({fetchImpl:async()=>assert.fail('invalid payload must not use network')});
  const authenticatedEndpoint=new URL(settings.endpoint);authenticatedEndpoint.username='user';authenticatedEndpoint.password='fixture';
  for(const value of [null,{...payload(),conversationKey:'wechat:private:123'},{settings:{...settings,chats:[]},prompt:'cat'},...['http://remote.invalid/v1',authenticatedEndpoint.href,'https://api.example/v1?key=secret','https://api.example/v1/images/generations'].map(endpoint=>({settings:{...settings,endpoint},prompt:'cat'})),...['',null,'x'.repeat(4001),'cat\0dog'].map(prompt=>({settings,prompt})),{settings:{...settings,apiKey:'bad\nkey'},prompt:'cat'},{settings:{...settings,size:'invalid'},prompt:'cat'}])await assert.rejects(execution('drawing.generate',value),{code:'DRAWING_CONFIG_INVALID'});
  await assert.rejects(execution('shell.exec',payload()),{code:'DRAWING_OPERATION_INVALID'});
});

test('provider rejection, network failures and forged error messages are safe fixed codes without retry',async()=>{
  for(const [status,code]of [[401,'DRAWING_KEY_INVALID'],[403,'DRAWING_FORBIDDEN'],[429,'DRAWING_RATE_LIMIT'],[400,'DRAWING_REQUEST_REJECTED'],[404,'DRAWING_NOT_FOUND'],[503,'DRAWING_PROVIDER_UNAVAILABLE']]){
    let calls=0;const execution=createDrawingExecution({fetchImpl:async()=>{calls++;return new Response('private provider body '+settings.apiKey,{status});}});
    await assert.rejects(execution('drawing.generate',payload()),error=>error.code===code&&error.message===code&&!JSON.stringify(error).includes(settings.apiKey));assert.equal(calls,1);
  }
  const execution=createDrawingExecution({fetchImpl:async()=>{throw Object.assign(Error(settings.apiKey),{code:'DRAWING_KEY_INVALID'});}});
  await assert.rejects(execution('drawing.generate',payload()),{message:'DRAWING_KEY_INVALID',code:'DRAWING_KEY_INVALID'});
});

test('malformed and URL-only results never trigger URL downloads or return untrusted image data',async()=>{
  for(const body of ['not-json',JSON.stringify({data:[{url:'http://localhost/private'}]}),JSON.stringify({data:[{b64_json:'not base64'}]}),JSON.stringify({data:[{b64_json:Buffer.from('not png').toString('base64')}]}),JSON.stringify({data:[{b64_json:image},{b64_json:image}]})]){
    let calls=0;const execution=createDrawingExecution({fetchImpl:async()=>{calls++;return new Response(body);}});await assert.rejects(execution('drawing.generate',payload()),error=>['DRAWING_RESPONSE_INVALID','DRAWING_IMAGE_INVALID'].includes(error.code));assert.equal(calls,1);
  }
});

test('response size limits stop a provider body and abort never exposes the caller reason or submits late work',async()=>{
  const tooLarge=createDrawingExecution({fetchImpl:async()=>new Response('x'.repeat(1024*1024+1))});
  await assert.rejects(tooLarge('drawing.check',{settings}),{code:'DRAWING_RESPONSE_TOO_LARGE'});
  const controller=new AbortController();controller.abort(Error(settings.apiKey));const never=createDrawingExecution({fetchImpl:async()=>assert.fail('already aborted')});
  await assert.rejects(never('drawing.generate',payload(),{signal:controller.signal}),{message:'DRAWING_ABORTED',code:'DRAWING_ABORTED'});
  let release,calls=0;const gate=new Promise(resolve=>release=resolve),running=new AbortController(),execution=createDrawingExecution({fetchImpl:async()=>{calls++;return gate;}});
  const pending=execution('drawing.generate',payload(),{signal:running.signal});running.abort(Error(settings.apiKey));await assert.rejects(pending,{code:'DRAWING_ABORTED'});release(Response.json({data:[{b64_json:image}]}));await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
});
