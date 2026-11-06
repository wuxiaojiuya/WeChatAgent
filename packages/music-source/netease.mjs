import crypto from 'node:crypto';

const fault=(message,status=502)=>Object.assign(new Error(message),{status});
const origin='https://music.163.com';
const routes=new Set(['/api/search/get/web','/api/song/enhance/player/url','/api/w/nuser/account/get']);
const publicKey=`-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

export function neteaseCookie(value='') {
  if(typeof value!=='string'||value.length>32768||/[^\x20-\x7e]/.test(value))throw fault('网易云登录凭证请填写单行 Cookie 内容，或留空保留。',400);
  const cookie=value.trim();
  if(cookie&&cookie.split(';').some(part=>part.trim()&&!/^[!#$%&'*+\-.^_`|~\da-zA-Z]+=[^;]*$/.test(part.trim())))throw fault('网易云登录凭证格式无效，请只复制 Cookie 的值，不要包含“Cookie:”或请求头。',400);
  return cookie;
}

function webBody(data,cookie) {
  const csrf=cookie.split(';').map(part=>part.trim()).find(part=>part.startsWith('__csrf='))?.slice(7)??'';
  const secret=crypto.randomBytes(12).toString('base64'),iv=Buffer.from('0102030405060708');
  const encrypt=(text,key)=>{const cipher=crypto.createCipheriv('aes-128-cbc',Buffer.from(key),iv);return Buffer.concat([cipher.update(text,'utf8'),cipher.final()]).toString('base64');};
  const padded=Buffer.alloc(128);Buffer.from([...secret].reverse().join('')).copy(padded,112);
  return new URLSearchParams({params:encrypt(encrypt(JSON.stringify({...data,csrf_token:csrf}),'0CoJUm6Qyw8W8jud'),secret),
    encSecKey:crypto.publicEncrypt({key:publicKey,padding:crypto.constants.RSA_NO_PADDING},padded).toString('hex')}).toString();
}

// Credentials only go to these fixed official metadata endpoints, never to a CDN or redirect.
export async function neteaseRequest(route,{params,data,neteaseCookie:credential='',fetchImpl=fetch,signal}={}) {
  if(!routes.has(route))throw fault('网易云接口无效。',400);
  const cookie=neteaseCookie(credential),url=new URL(data?route.replace('/api/','/weapi/'):route,origin);
  if(params)url.search=new URLSearchParams(params);
  const requestSignal=AbortSignal.any([AbortSignal.timeout(12000),...(signal?[signal]:[])]);
  try {
    const response=await fetchImpl(url,{method:data?'POST':'GET',redirect:'error',signal:requestSignal,
      headers:{'User-Agent':'Mozilla/5.0',Referer:origin+'/',...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/x-www-form-urlencoded'}:{})},
      ...(data?{body:webBody(data,cookie)}:{})});
    if([401,403].includes(response.status))throw fault(cookie?'网易云登录凭证已失效或访问被拒绝，请重新登录后更新凭证。':'网易云暂时拒绝访问，请稍后重试。',422);
    if(!response.ok)throw fault('网易云音乐暂时无法访问，请稍后重试。');
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>2*1024*1024){throw fault('网易云返回的数据过大。');}chunks.push(chunk);}
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!result||typeof result!=='object')throw fault('网易云接口返回格式无效，请稍后重试。');
    if([301,302,401,403].includes(result.code))throw fault(cookie?'网易云登录凭证已失效或访问被拒绝，请重新登录后更新凭证。':'网易云需要有效登录凭证，请在歌曲来源下方配置。',422);
    return result;
  } catch(error) {
    if(signal?.aborted)throw signal.reason;
    if(error.status)throw error;
    throw fault(requestSignal.aborted?'网易云音乐请求超时，请稍后重试。':'网易云音乐连接失败或返回格式无效，请稍后重试。');
  }
}

export async function checkNeteaseLogin(options={}) {
  if(!neteaseCookie(options.neteaseCookie))return {authenticated:false,code:'NETEASE_COOKIE_REQUIRED',message:'请先填写网易云网页登录后的 Cookie。'};
  try {
    const data=await neteaseRequest('/api/w/nuser/account/get',{...options,data:{}});
    const authenticated=data.code===200&&(Number(data.account?.id)>0||Number(data.profile?.userId)>0);
    return {authenticated,code:authenticated?'NETEASE_LOGIN_OK':'NETEASE_LOGIN_INVALID',message:authenticated?
      '网易云账号登录有效。后续取源会使用此账号；具体歌曲以平台返回的可用音源和账号权限为准。':'网易云没有确认账号登录，请重新登录网页版后更新 Cookie。'};
  } catch(error) {
    if(options.signal?.aborted)throw error;
    return {authenticated:false,code:error.status===422?'NETEASE_LOGIN_INVALID':'NETEASE_CHECK_FAILED',message:error.message};
  }
}
