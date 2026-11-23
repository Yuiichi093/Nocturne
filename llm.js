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
    WHERE is_image = 0
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

// 不同服务商的返回长得不太一样：content 可能是字符串，也可能是
// [{type:'text', text:'…'}] 这种数组；有些老接口直接给 text 字段。
function extractContent(message, choice) {
  const raw = message.content ?? choice.text ?? '';

  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        if (part && typeof part.content === 'string') return part.content;
        return '';
      })
      .join('');
  }

  return String(raw || '');
}

function buildChatHeaders(modelRow) {
  const headers = {
    'Content-Type': 'application/json',
    ...parseExtraHeaders(modelRow.extra_headers)
  };

  if (!headers.Authorization && !headers.authorization) {
    headers.Authorization = 'Bearer ' + modelRow.api_key;
  }

  return headers;
}

function emptyContentError(choice, message, text) {
  const reasoning = String(
    message.reasoning_content || message.reasoning || ''
  ).trim();
  const finish = String(choice.finish_reason || '');

  if (reasoning && finish === 'length') {
    return new Error(
      '模型把输出额度都用在思考上了，没写出正文。换一个非推理模型，' +
      '或者在「模型设置」里把这个模型的输出上限调大一点'
    );
  }

  if (reasoning) {
    return new Error('模型只返回了思考过程，没给正文，再试一次或者换个模型');
  }

  if (!choice || (!choice.message && !choice.text)) {
    return new Error('模型返回的格式看不懂：' + String(text).slice(0, 120));
  }

  return new Error('模型返回了空内容');
}

// 出错时把模型名也带出来，报错截图一看就知道是哪个模型不听话
function withModelHint(error, modelRow) {
  const name = modelRow && (modelRow.name || modelRow.model || modelRow.model_name);
  if (!name || !error) return error;
  const hinted = new Error(String(error.message) + '（模型：' + name + '）');
  hinted.status = error.status;
  return hinted;
}

// 把上游的原始报错（常常是一大坨 JSON）翻成人话。
// 最常见的 401 就是 Key 填错/过期，用户看到「Authentication Fails」根本不知道怎么办。
function upstreamErrorText(statusCode, raw) {
  let detail = "";
  let type = "";

  try {
    const parsed = JSON.parse(raw);
    const inner = parsed && parsed.error && typeof parsed.error === "object" ? parsed.error : parsed;
    detail = String(
      (inner && (inner.message || inner.msg || inner.error)) || ""
    ).trim();
    type = String((inner && inner.type) || "").trim();
  } catch (e) {
    detail = String(raw || "").trim();
  }

  detail = detail.replace(/\s+/g, " ").slice(0, 180);

  if (statusCode === 401 || statusCode === 403 || /authentication|invalid.*key|unauthor/i.test(detail)) {
    return (
      "API Key 不对或者已经过期了：请去「模型设置」里把这个模型的 Key 重新填一次" +
      (detail ? "（接口说：" + detail + "）" : "")
    );
  }

  // 402 / Insufficient Balance：平台那边欠费了，跟 Key 对不对是两件事，要分开说
  if (
    statusCode === 402 ||
    /insufficient.*(balance|quota|credit)|余额不足|quota exceeded|no credit/i.test(detail)
  ) {
    return (
      "模型平台的余额不够了：去平台充值，或者在「模型设置」里换一个还有额度的 Key" +
      (detail ? "（接口说：" + detail + "）" : "")
    );
  }

  if (statusCode === 429) {
    return "模型服务被限流了，等一分钟再试" + (detail ? "（接口说：" + detail + "）" : "");
  }

  if (statusCode === 404) {
    return (
      "接口地址或者模型名不对（404）：检查「模型设置」里的 Base URL 和模型名" +
      (detail ? "（接口说：" + detail + "）" : "")
    );
  }

  if (statusCode === 400) {
    return (
      "模型服务说这个请求不对（400）" +
      (detail ? "：" + detail : "") +
      "，常见原因是模型名不认识、参数不被支持，或者这个模型不支持图片"
    );
  }

  if (statusCode >= 500) {
    return (
      "模型服务那边出错了（" + statusCode + "），不是手机上 App 的问题，过一会儿再试" +
      (detail ? "（接口说：" + detail + "）" : "")
    );
  }

  return "模型接口返回错误（" + statusCode + "）" + (detail ? "：" + detail : "");
}

/* ========== 用量账本 ========== */
// 各家上游的 usage 字段名不太一样，能取到哪个算哪个，取不到就 0
function pickTokens(usage, keys) {
  if (!usage || typeof usage !== 'object') return 0;

  for (const key of keys) {
    const value = Number(usage[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }

  return 0;
}

/**
 * 记一笔用量。成功且上游给了 usage 才写行，没给就跳过（不写脏行）。
 * 记账本身失败只打一行日志，绝不能让正在进行的请求失败。
 */
function recordUsage(payload, data, options) {
  try {
    const usage = data && data.usage;

    if (!usage || typeof usage !== 'object') return false;

    const opts = options || {};
    const inputTokens = pickTokens(usage, ['prompt_tokens', 'input_tokens']);
    const outputTokens = pickTokens(usage, ['completion_tokens', 'output_tokens']);
    const cacheHitTokens =
      pickTokens(usage, ['prompt_cache_hit_tokens', 'cache_read_input_tokens']) ||
      pickTokens(usage.prompt_tokens_details, ['cached_tokens']);
    const totalTokens =
      pickTokens(usage, ['total_tokens']) || inputTokens + outputTokens;

    const character = opts.character || {};
    const characterId =
      Number(character.id || (payload && payload.character_id) || 0) || 0;
    const characterName = String(
      character.name || (payload && payload.character_name) || ''
    ).slice(0, 60);

    // created_at 存本地时间：汇总按本地自然日切，和单条明细显示一致
    db.prepare(`
      INSERT INTO usage_logs
        (created_at, source, model, input_tokens, output_tokens,
         cache_hit_tokens, total_tokens, character_id, character_name)
      VALUES (datetime('now','localtime'), ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(opts.usageSource || 'chat'),
      String((payload && payload.model) || ''),
      inputTokens,
      outputTokens,
      cacheHitTokens,
      totalTokens,
      characterId,
      characterName
    );

    return true;
  } catch (error) {
    console.log('[用量账本] 记一笔失败：' +
      (error && error.message ? error.message : String(error)));
    return false;
  }
}

/**
 * 统一发一次 chat/completions，返回 { data, text, content, started }。
 *
 * 各调用方（聊天、剧场旁白、自动写画面描述）原来各写一份 fetch，
 * 遇到推理模型把 max_tokens 花在思考上、正文为空时全都只会报「空内容」。
 * 这里集中处理：正文空就把额度翻三倍重试（最多三次），还是空再报人话。
 */
async function requestChat(modelRow, payload, options) {
  const opts = options || {};
  const retries = opts.retries === undefined ? 2 : Number(opts.retries);
  let maxTokens = Number(payload.max_tokens) || 400;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const body = { ...payload, max_tokens: maxTokens };
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Number(opts.timeoutMs || 60000)
    );
    let text = '';

    try {
      const response = await fetch(buildChatUrl(modelRow.base_url), {
        method: 'POST',
        headers: buildChatHeaders(modelRow),
        body: JSON.stringify(body),
        signal: controller.signal
      });

      text = await response.text();

      if (!response.ok) {
        const error = new Error(upstreamErrorText(response.status, text));
        error.status = 502;
        error.raw = text;
        error.upstreamStatus = response.status;
        throw error;
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        const timeout = new Error('模型调用超时，等一会儿再试');
        timeout.status = 504;
        throw timeout;
      }

      // 网络层直接挂掉（DNS、连不上、连接被重置）也归到「上游不可用」，
      // 别让调用方把 500 当成自己的 bug
      if (!error.status) {
        const failed = new Error(
          '连不上模型服务：' + (error.message || '网络错误')
        );
        failed.status = 502;
        throw failed;
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }

    let data = null;

    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('模型返回的不是合法 JSON：' + String(text).slice(0, 120));
    }

    const choice = (data && data.choices && data.choices[0]) || {};
    const message = choice.message || {};
    const content = extractContent(message, choice).trim();

    if (content) {
      // 成功拿到正文才记账：失败/重试中的空回复不占账本
      recordUsage(payload, data, options);

      return { data, text, content, choice, started };
    }

    lastError = emptyContentError(choice, message, text);

    const finish = String(choice.finish_reason || '');
    const hasReasoning = Boolean(
      message.reasoning_content || message.reasoning
    );

    // 额度被思考吃光：翻倍再来，正文通常就有了
    if ((finish === 'length' || hasReasoning) && attempt < retries) {
      maxTokens = Math.min(12000, Math.max(1200, maxTokens * 3));
      continue;
    }

    throw withModelHint(lastError, modelRow);
  }

  throw withModelHint(lastError || new Error('模型返回了空内容'), modelRow);
}

async function callModel(options) {
  const opts = options || {};
  const modelRow = opts.modelRow || getDefaultModel();

  if (!modelRow) {
    throw new Error('还没有配置模型 API');
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

  const result = await requestChat(modelRow, payload, {
    timeoutMs: opts.timeoutMs,
    usageSource: opts.usageSource,
    character: opts.character
  });

  return {
    content: result.content,
    meta: {
      provider: modelRow.name,
      model: modelRow.model,
      usage: (result.data && result.data.usage) || null,
      latency_ms: Date.now() - result.started
    }
  };
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
  requestChat,
  recordUsage,
  buildChatHeaders,
  extractContent,
  getVisionModel,
  describeImage,
  imageToDataUrl,
  getDefaultModel,
  buildChatUrl,
  parseJsonLoose,
  stripCodeFence
};
