'use strict';
// 统一的"调用一次大模型"入口。
// 原来 chat-api / moment-api / theater-play-api 各自复制了一份请求代码，
// 新功能不再重复第四份。

const fs = require('fs');
const path = require('path');
const db = require('./db');

function buildChatUrl(baseUrl) {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (clean.endsWith('/chat/completions')) return clean;
  return clean + '/chat/completions';
}

function getDefaultModel() {
  return db.prepare(`
    SELECT * FROM model_profiles
    ORDER BY is_default DESC, id DESC
    LIMIT 1
  `).get();
}

function parseExtraHeaders(text) {
  try {
    return JSON.parse(text || '{}') || {};
  } catch (e) {
    return {};
  }
}

// 模型有时候会把 JSON 包在 ```json 里，这里统一剥掉
function stripCodeFence(text) {
  return String(text || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

function parseJsonLoose(text) {
  const raw = stripCodeFence(text);
  try {
    return JSON.parse(raw);
  } catch (e) {}

  // 退一步：截取第一个 { 到最后一个 } 之间的内容再试
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (e) {}
  }

  return null;
}

async function callModel(options) {
  const opts = options || {};
  const modelRow = opts.modelRow || getDefaultModel();

  if (!modelRow) {
    throw new Error('还没有配置模型 API');
  }

  const headers = {
    'Content-Type': 'application/json',
    ...parseExtraHeaders(modelRow.extra_headers)
  };

  if (!headers.Authorization && !headers.authorization) {
    headers.Authorization = 'Bearer ' + modelRow.api_key;
  }

  const payload = {
    model: modelRow.model,
    messages: [
      { role: 'system', content: String(opts.system || '') },
      { role: 'user', content: String(opts.user || '') }
    ],
    temperature: Number(opts.temperature ?? modelRow.temperature ?? 0.85),
    max_tokens: Number(opts.maxTokens ?? 400)
  };

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(opts.timeoutMs || 60000));

  try {
    const response = await fetch(buildChatUrl(modelRow.base_url), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error('模型接口返回错误：' + text.slice(0, 500));
    }

    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('模型返回的不是合法 JSON');
    }

    const content = String(data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content || '').trim();

    if (!content) {
      throw new Error('模型返回了空内容');
    }

    return {
      content,
      meta: {
        provider: modelRow.name,
        model: modelRow.model,
        usage: data.usage || null,
        latency_ms: Date.now() - started
      }
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('模型调用超时');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ---- 看图（视觉模型） ----
// 图片地址是我们自己的 /uploads/xxx，外部模型访问不到 127.0.0.1，
// 所以读成 data URL 直接塞进请求体里。

function getVisionModel() {
  return db.prepare(`
    SELECT * FROM model_profiles
    WHERE is_vision = 1
    ORDER BY is_default DESC, id DESC
    LIMIT 1
  `).get();
}

// 看图的候选模型：标了「看图」的排前面，剩下的有 Key 的也能试。
// 生图模型不参与（它是画图的，不是看图的）。
function visionCandidates() {
  return db.prepare(`
    SELECT * FROM model_profiles
    WHERE api_key <> '' AND is_image = 0
    ORDER BY is_vision DESC, is_default DESC, id DESC
  `).all();
}

function imageToDataUrl(imageUrl) {
  const clean = String(imageUrl || '').trim();

  if (!clean) return '';

  if (/^https?:\/\//i.test(clean) || clean.startsWith('data:')) {
    return clean;
  }

  if (!clean.startsWith('/uploads/')) return '';

  // 图片按账号分开存，data/uploads 里已经没有东西了，得看当前请求是谁在看图
  let baseDir;

  try {
    baseDir = db.uploadsDir();
  } catch (e) {
    // 取不到目录（不在请求上下文里）就当图片读不出来，让上层走原来的降级
    return '';
  }

  const file = path.join(baseDir, path.basename(clean));

  try {
    if (!fs.existsSync(file)) return '';

    // 太大就别硬塞了，接口会直接 413
    if (fs.statSync(file).size > 4 * 1024 * 1024) return '';

    const ext = path.extname(file).toLowerCase().replace('.', '') || 'jpeg';
    const mime = ext === 'jpg' ? 'jpeg' : ext;

    return 'data:image/' + mime + ';base64,' +
      fs.readFileSync(file).toString('base64');
  } catch (e) {
    return '';
  }
}

// 有些模型会先说「看不到图」；有些（带思考的）把答案全塞进推理里，正文是空的。
// 两种都得认出来，否则聊天里会塞进一句废话当图片内容。
const BLIND_PATTERN =
  /(无法查看图片|看不到图片|图片不受支持|不受支持的图片|unsupported image|没有提供图片|未提供图片|cannot see the image|无法识别图片|不能查看图片)/i;

// 用某个模型看一次图，返回纯文字描述；看不了就抛错
async function describeWith(modelRow, dataUrl, options) {
  const opts = options || {};

  const headers = {
    'Content-Type': 'application/json',
    ...parseExtraHeaders(modelRow.extra_headers)
  };

  if (!headers.Authorization && !headers.authorization) {
    headers.Authorization = 'Bearer ' + modelRow.api_key;
  }

  async function attempt(maxTokens, text, temperature) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Number(opts.timeoutMs || 90000)
    );

    try {
      const response = await fetch(buildChatUrl(modelRow.base_url), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelRow.model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          }],
          temperature,
          max_tokens: maxTokens
        }),
        signal: controller.signal
      });

      const raw = await response.text();

      if (!response.ok) {
        throw new Error('看图接口返回错误：' + raw.slice(0, 300));
      }

      let data = null;

      try {
        data = JSON.parse(raw);
      } catch (e) {
        throw new Error('看图接口返回的不是合法 JSON');
      }

      const message = (data && data.choices && data.choices[0] &&
        data.choices[0].message) || {};

      return {
        content: String(message.content || '').trim(),
        reasoning: String(message.reasoning_content || '').trim()
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('看图超时');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const first = await attempt(Number(opts.maxTokens ?? 1200), opts.prompt ||
    ('请用中文客观描述这张图片：画面里有什么、人物或物体、场景、' +
     '光线氛围、有没有文字。200 字以内，直接描述，不要评论。'), 0.3);

  // 先看它是不是在说"我看不到"——这句话不能当成图片内容存起来
  if (BLIND_PATTERN.test(first.content) || BLIND_PATTERN.test(first.reasoning)) {
    const blind = new Error('blind');
    blind.blind = true;
    throw blind;
  }

  if (first.content) return first.content;

  // 正文空但推理里有东西：多半是最大 token 被思考过程吃掉了，加额度再来一次
  if (first.reasoning) {
    const second = await attempt(
      Number(opts.maxTokens ?? 1200) * 2,
      '不要分析，直接一句话描述这张图片里有什么。',
      0.2
    );

    if (BLIND_PATTERN.test(second.content) || BLIND_PATTERN.test(second.reasoning)) {
      const blind = new Error('blind');
      blind.blind = true;
      throw blind;
    }

    if (second.content) return second.content;
    if (second.reasoning) return second.reasoning.slice(0, 500);
  }

  throw new Error('看图模型返回了空内容');
}

// 让视觉模型描述一张图，返回纯文字。
// 不给 modelRow 就自己挑：先试标了「看图」的，试不通再试其他有 Key 的模型，
// 谁先看懂就用谁，并且把结果记回 is_vision，下次直接从它开始。
async function describeImage(options) {
  const opts = options || {};

  const dataUrl = imageToDataUrl(opts.imageUrl);

  if (!dataUrl) {
    throw new Error('图片读不出来（可能太大或文件丢了）');
  }

  const list = opts.modelRow
    ? [opts.modelRow]
    : visionCandidates().slice(0, 4);

  if (!list.length) {
    throw new Error('还没有能看图的模型：去「模型设置」填一个模型的 API Key');
  }

  const problems = [];

  for (const row of list) {
    try {
      const text = await describeWith(row, dataUrl, opts);

      if (!text) continue;

      if (Number(row.is_vision || 0) !== 1) {
        db.prepare('UPDATE model_profiles SET is_vision = 1 WHERE id = ?')
          .run(row.id);
      }

      return text;
    } catch (error) {
      problems.push(row.name + '：' + (error.blind ? '看不到图片' : error.message));

      // 网络/额度这类错误换一个模型也没用，但看图能力不同，继续试
      continue;
    }
  }

  const hasBlind = problems.some((item) => item.includes('看不到图片'));
  const hint = hasBlind
    ? '这些模型都看不了图。去「模型设置」给一个能看图的模型打个「看图」标记，' +
      '或者换个支持视觉的模型（比如 DeepSeek 的 flash）。'
    : '看图失败了，可能是网络或者额度问题，可以稍后再发一次。';

  throw new Error(hint + '（' + problems.join('；') + '）');
}

module.exports = {
  callModel,
  getVisionModel,
  describeImage,
  imageToDataUrl,
  getDefaultModel,
  buildChatUrl,
  parseJsonLoose,
  stripCodeFence
};
