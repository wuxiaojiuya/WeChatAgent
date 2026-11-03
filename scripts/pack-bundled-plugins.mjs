import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {BUNDLED_PLUGINS} from '../packages/plugin-api/bundled.mjs';
import {inspectPackage,packageFiles} from '../packages/plugin-api/catalog.mjs';
import {packZip,unpackZip} from '../packages/plugin-api/zip.mjs';
const root=path.resolve(import.meta.dirname,'..');
for(const bundle of BUNDLED_PLUGINS.filter(item=>item.zip)){
  const source=path.join(root,bundle.source),item=inspectPackage(source);
  if(item.id!==bundle.id||item.version!==bundle.version)throw Error('PLUGIN_BUNDLE_IDENTITY_MISMATCH');
  const zip=packZip(packageFiles(source));unpackZip(zip);
  const target=path.join(root,bundle.zip);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,zip);
  const digest=crypto.createHash('sha256').update(zip).digest('hex');fs.writeFileSync(target+'.sha256',digest+'  '+path.basename(target)+'\n');
  console.log(JSON.stringify({id:item.id,version:item.version,bytes:zip.length,sha256:digest}));
}
