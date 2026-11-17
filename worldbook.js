const db = require('./db');

function splitKeys(keys) {
  return String(keys || '')
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getWorldbookContext(worldId, text, limit = 3000) {
  const id = Number(worldId || 0);

  if (!id) {
    return { text: '', count: 0, hits: [] };
  }

  const rows = db.prepare(`
    SELECT * FROM worldbook_entries
    WHERE world_id = ? AND enabled = 1
    ORDER BY priority DESC, id DESC
  `).all(id);

  const haystack = String(text || '').toLowerCase();

  const hits = rows.filter((row) => {
    if (!String(row.content || '').trim()) return false;

    if (Number(row.constant) === 1) return true;

    const keys = splitKeys(row.keys);
    if (!keys.length) return false;

    return keys.some((key) => {
      return haystack.includes(key.toLowerCase());
    });
  });

  const selected = [];
  let total = 0;

  for (const row of hits) {
    const block = '【' + row.title + '】\n' + row.content;

    if (total + block.length > limit) continue;

    selected.push(block);
    total += block.length;
  }

  return {
    text: selected.join('\n\n'),
    count: selected.length,
    hits: hits.map((row) => row.title)
  };
}

// 生成朋友圈/评论时，用户会在世界书里写「角色之间的关系」这类条目，
// 关键词通常就是角色名。把相关角色名一起塞进检索文本，
// 才能保证这些关系条目被命中，而不是只靠最近的聊天记录碰运气。
function getWorldbookContextByNames(worldId, text, names, limit) {
  const nameText = (names || []).filter(Boolean).join(' ');
  const haystack = [text, nameText].filter(Boolean).join('\n');
  return getWorldbookContext(worldId, haystack, limit);
}

module.exports = {
  getWorldbookContext,
  getWorldbookContextByNames
};
