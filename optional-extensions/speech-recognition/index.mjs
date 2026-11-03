import {recognize} from './lib/recognize.mjs';

export function setup(api) {
  api.registerAction({
    id: 'transcribe',
    description: '转写宿主核验过的当前微信语音；接口和密钥完全由本机配置。',
    parameters: {
      type: 'object', properties: {id: {type: 'string', minLength: 64, maxLength: 64}},
      required: ['id'], additionalProperties: false,
    },
    execute: recognize,
  });
}
