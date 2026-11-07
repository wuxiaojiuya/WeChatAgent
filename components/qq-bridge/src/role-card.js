// 人格卡（roles/<名称>.md）的解析与按模式取用。
// 兼容已有卡片的一代、二代小节标记，桥接只取当前模式适用的小节。
//   ## 表情包体系 〔二代〕      → 只在 reserved2 注入
//   ## 分条方式 〔一代〕        → 只在 reserved/chat 注入
//   ## 你是谁                   → 两种模式都注入
// 标记会在注入前从标题里去掉，模型看到的始终是干净的小节标题。
// 模式标记：`〔二代〕` / `[v2]` / `（reserved2）` 等写法都认。
const MODE_TAGS = [
  { mode: 'v2', re: /[\[〔（(]\s*(?:二代|2\s*代|v2|reserved2)\s*[\]〕）)]/gi },
  { mode: 'v1', re: /[\[〔（(]\s*(?:一代|1\s*代|v1|reserved)\s*[\]〕）)]/gi },
];

function detectMode(heading) {
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    if (tag.re.test(heading)) return tag.mode;
  }
  return 'all';
}

function stripModeTags(heading) {
  let out = String(heading);
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    out = out.replace(tag.re, '');
  }
  return out.replace(/[ \t]+$/, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 按标题把人格卡拆成小节。
 * @returns {{mode: 'all'|'v1'|'v2', heading: string|null, lines: string[]}[]}
 */
export function parseRoleSections(text) {
  const sections = [];
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) {
      if (!current) {
        current = { mode: 'all', heading: null, lines: [] };
        sections.push(current);
      }
      current.lines.push(line);
      continue;
    }
    const title = stripModeTags(heading[2]);
    current = { mode: detectMode(heading[2]), heading: title, lines: [`${heading[1]} ${title}`] };
    sections.push(current);
  }
  return sections;
}

/**
 * 取出某次仿真真正要注入的人格文本（已去掉模式标记）。
 * @param {'v1'|'v2'} mode
 */
export function selectRoleText(text, mode) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  return parseRoleSections(text)
    .filter((section) => section.mode === 'all' || section.mode === want)
    .map((section) => section.lines.join('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
