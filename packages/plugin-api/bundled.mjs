// Only these reviewed first-party packages belong in source/installer releases.
export const BUNDLED_PLUGINS = Object.freeze([
  Object.freeze({id: 'chat-notes', version: '1.0.0', source: 'examples/plugins/chat-notes', files:['README.md','index.mjs','plugin.json']}),
  Object.freeze({id: 'fish-notebook', version: '1.0.0', source: 'optional-extensions/fish-notebook', zip: 'optional-extensions/packages/fish-notebook-1.0.0.zip', files:['README.md','index.mjs','lib/notebook.mjs','plugin.json']}),
  Object.freeze({id: 'speech-recognition', version: '1.2.0', source: 'optional-extensions/speech-recognition', zip: 'optional-extensions/packages/speech-recognition-1.2.0.zip', files:['README.md','index.mjs','lib/recognize.mjs','lib/diagnostics.mjs','plugin.json','assets/config-test.wav']}),
]);
