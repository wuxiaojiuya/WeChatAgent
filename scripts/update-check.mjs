import fs from 'node:fs';
import path from 'node:path';
export const UPDATE_REPOSITORY='wuxiaojiuya/WeChatAgent';
const releaseRoot='https://github.com/'+UPDATE_REPOSITORY+'/releases/';
const version=value=>{const match=/^(?:v)?(\d+)\.(\d+)\.(\d+)(-fix|\+)?$/.exec(String(value??''));return match?{parts:match.slice(1,4).map(Number),revision:match[4]==='+'?2:match[4]==='-fix'?1:0,label:match.slice(1,4).join('.')+(match[4]??'')}:null;};
// Public labels are ordered: base < -fix < +, before the next numeric release.
export function compareVersions(a,b){const left=version(a),right=version(b);if(!left||!right)throw Error('INVALID_VERSION');for(let i=0;i<3;i++)if(left.parts[i]!==right.parts[i])return left.parts[i]>right.parts[i]?1:-1;return left.revision-right.revision;}
function readMetadata(root,file){try{return JSON.parse(fs.readFileSync(path.join(root,file),'utf8').replace(/^\uFEFF/,''));}catch{return null;}}
function metadata(root){
  const installed=readMetadata(root,'config/distribution.json'),manifest=readMetadata(root,'deployment.json');
  // Installation metadata also drives the visible version. An old workspace
  // manifest must not make an already updated app offer the same release again.
  if(installed?.installed===true&&version(installed.version)){
    const matching=manifest?.version===installed.version&&manifest?.buildId===installed.buildId;
    return {...(matching?manifest:{}),...installed,version:version(installed.version).label};
  }
  for(const data of [manifest,readMetadata(root,'package.json')]){
    const publicVersion=version(data?.releaseVersion??data?.version);
    if(publicVersion)return {...data,version:publicVersion.label};
  }
  return {version:'0.3.6'};
}
function sameDownloadUrl(actual,expected){try{const a=new URL(actual),b=new URL(expected);return a.origin===b.origin&&!a.username&&!a.password&&!a.search&&!a.hash&&decodeURIComponent(a.pathname)===decodeURIComponent(b.pathname);}catch{return false;}}
async function jsonResponse(response){let size=0,text='';if(!response.body)return response.json();for await(const chunk of response.body){size+=chunk.length;if(size>128*1024){await response.body.cancel?.().catch(()=>{});throw Error('UPDATE_RESPONSE_TOO_LARGE');}text+=Buffer.from(chunk).toString('utf8');}return JSON.parse(text);}
export function createUpdateChecker({root,fetchImpl=fetch,now=Date.now}={}) {
  let cached,inflight,checkedAt=0,cachedIdentity='';
  const identity=local=>JSON.stringify([local.version,local.buildId,local.builtAt]);
  async function request(url,signal,local){const response=await fetchImpl(url,{headers:{Accept:'application/vnd.github+json','User-Agent':'WeChatAgent-UpdateCheck/'+local.version},signal});return {response,data:response.ok?await jsonResponse(response):null};}
  async function run(local){
    const base={currentVersion:local.version,repository:UPDATE_REPOSITORY,releaseUrl:releaseRoot+'latest'};
    const signal=AbortSignal.timeout(8000),stamp=new Date(now()).toISOString();
    try {
      const {response,data}=await request('https://api.github.com/repos/'+UPDATE_REPOSITORY+'/releases/latest',signal,local);
      if(response.status===404)return {...base,status:'not_published',checkedAt:stamp};
      if(!response.ok)throw Error('UPDATE_HTTP_'+response.status);
      if(data.draft||data.prerelease||!version(data.tag_name))throw Error('UPDATE_RELEASE_INVALID');
      const latestVersion=version(data.tag_name).label,tag=encodeURIComponent(data.tag_name);
      const file='WeChatAgent-Setup-'+latestVersion+'-x64.exe',downloadUrl=releaseRoot+'download/'+tag+'/'+encodeURIComponent(file);
      const installer=(data.assets??[]).find(asset=>asset.name===file&&asset.state==='uploaded'&&sameDownloadUrl(asset.browser_download_url,downloadUrl));
      const comparison=compareVersions(latestVersion,local.version);
      if(!installer||comparison<0)return {...base,status:'up_to_date',checkedAt:stamp};
      let sameVersionBuild=false;
      if(comparison===0){
        const infoUrl=releaseRoot+'download/'+tag+'/VERIFICATION.json';
        const info=(data.assets??[]).find(asset=>asset.name==='VERIFICATION.json'&&asset.state==='uploaded'&&sameDownloadUrl(asset.browser_download_url,infoUrl));
        if(info&&local.buildId&&local.builtAt){const result=await request(infoUrl,signal,local),remote=result.data;
          sameVersionBuild=result.response.ok&&remote?.version===local.version&&/^[a-f0-9]{16}$/.test(remote.buildId??'')&&remote.buildId!==local.buildId&&Number.isFinite(Date.parse(remote.builtAt))&&Date.parse(remote.builtAt)>Date.parse(local.builtAt);
        }
      }
      return {...base,status:comparison>0||sameVersionBuild?'available':'up_to_date',latestVersion,sameVersionBuild,checkedAt:stamp,releaseUrl:releaseRoot+'tag/'+tag,...(comparison>0||sameVersionBuild?{downloadUrl}:{})};
    }catch{return {...base,status:'unavailable',checkedAt:stamp};}
  }
  return {check({force=false}={}){
    const at=now(),local=metadata(root),key=identity(local);
    if(inflight?.key===key)return inflight.promise;
    if(cached&&cachedIdentity===key&&at-checkedAt<(force?15000:6*60*60*1000))return Promise.resolve(cached);
    const promise=run(local).then(result=>{if(identity(metadata(root))===key){cached=result;cachedIdentity=key;checkedAt=now();}return result;}).finally(()=>{if(inflight?.promise===promise)inflight=null;});
    inflight={key,promise};return promise;
  }};
}
