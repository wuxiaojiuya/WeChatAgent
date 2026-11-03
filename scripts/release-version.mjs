// Public release labels may differ from the valid SemVer required by npm/Electron.
export function releaseIdentity(pkg){
  const packageVersion=pkg?.version,version=pkg?.releaseVersion??packageVersion;
  const base=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if(typeof packageVersion!=='string'||typeof version!=='string')throw Error('RELEASE_VERSION_INVALID');
  let buildVersion;
  if(version.endsWith('+')){
    const numeric=version.slice(0,-1);
    if(!base.test(numeric)||packageVersion!==numeric+'+plus')throw Error('RELEASE_VERSION_ALIAS_INVALID');
    buildVersion=numeric+'.2';
  }else if(version.endsWith('-fix')){
    const numeric=version.slice(0,-4);
    if(!base.test(numeric)||packageVersion!==version)throw Error('RELEASE_VERSION_ALIAS_INVALID');
    buildVersion=numeric+'.1';
  }else if(!base.test(version)||packageVersion!==version)throw Error('RELEASE_VERSION_INVALID');
  return {version,packageVersion,buildVersion,tag:'v'+version};
}
