'use strict';
// 生图：接 OpenAI 兼容的 /images/generations。
// 生成完的图存进 data/uploads，和普通上传的图一样能长期用。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function register(app, db) {
  // 每个账号的图片目录不一样，只能在请求上下文里现取；
  // db.uploadsDir() 不带参数时会按当前请求的账号解析
  function uploadDir() {
    const dir = db.uploadsDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function cleanText(value) {
    return String(value == null ? '' : value).trim();
  }

  function parseHeaders(text) {
    try {
      return JSON.parse(text || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function imageModel(id) {
    if (id) {
      return db.prepare('SELECT * FROM model_profiles WHERE id = ?').get(id);
    }

    return db.prepare(`
      SELECT * FROM model_profiles
      WHERE is_image = 1
      ORDER BY is_default DESC, id DESC
      LIMIT 1
    `).get();
  }

  // 各家的 base_url 写法不一：有的带 /v1，有的不带，有的直接给到接口
  function buildUrls(baseUrl, endpoint) {
    const clean = cleanText(baseUrl).replace(/\/+$/, '');
    const tail = '/' + endpoint;

    if (clean.endsWith(tail)) return [clean];

    if (/\/v\d+$/.test(clean)) return [clean + tail];

    return [clean + '/v1' + tail, clean + tail];
  }

  function saveImage(buffer, ext) {
    const safeExt = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext)
      ? ext
      : '.png';
    const name = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + safeExt;
    fs.writeFileSync(path.join(uploadDir(), name), buffer);
    return '/uploads/' + name;
  }

  // 把一个参考图地址变成可上传的文件；不认识 / 不存在 / 重复的都丢掉
  function refEntry(url, existing) {
    let clean = cleanText(url);

    if (!clean) return null;

    const original = clean;

    // 老数据里可能存的是 http 开头的完整地址，取 pathname 再判断
    if (/^https?:\/\//i.test(clean)) {
      try {
        clean = new URL(clean).pathname || '';
      } catch (e) {
        return null;
      }
    }

    if (!clean.startsWith('/uploads/')) return null;

    const file = path.join(uploadDir(), path.basename(clean));

    if (!fs.existsSync(file)) return null;

    if (existing.some((item) => item.file === file)) return null;

    return {
      file,
      name: path.basename(file),
      url: original,
      mime: 'image/' + (path.extname(file).slice(1).toLowerCase() || 'png')
        .replace('jpg', 'jpeg')
    };
  }

  // 参考图：角色自己的（可以多张）+ 它的用户人设的（也可以多张）
  function referenceImages(characterId) {
    const files = [];

    function push(url) {
      const entry = refEntry(url, files);
      if (entry) files.push(entry);
    }

    function pushOwner(ownerType, ownerId, legacyUrl) {
      const rows = db.prepare(`
        SELECT image_url FROM ref_images
        WHERE owner_type = ? AND owner_id = ?
        ORDER BY sort ASC, id ASC
      `).all(ownerType, ownerId);

      if (rows.length) {
        rows.forEach((row) => push(row.image_url));
      } else {
        push(legacyUrl);
      }
    }

    if (characterId) {
      const character = db.prepare('SELECT * FROM characters WHERE id = ?')
        .get(characterId);

      if (character) {
        pushOwner('character', character.id, character.ref_image);

        let persona = null;

        if (Number(character.user_persona_id || 0) > 0) {
          persona = db.prepare('SELECT * FROM user_personas WHERE id = ?')
            .get(character.user_persona_id);
        }

        if (!persona) {
          persona = db.prepare(`
            SELECT * FROM user_personas
            ORDER BY is_default DESC, id DESC
            LIMIT 1
          `).get();
        }

        if (persona) pushOwner('persona', persona.id, persona.ref_image);
      }
    }

    // 一下子塞太多参考图有的家会拒，最多四张
    return files.slice(0, 4);
  }

  // 显式指定参考图（剧场身份卡 + 角色设定图拼好的列表）：有就优先用它
  function referenceImagesFromUrls(urls) {
    const files = [];

    if (!Array.isArray(urls)) return files;

    urls.forEach((url) => {
      const entry = refEntry(url, files);
      if (entry) files.push(entry);
    });

    return files.slice(0, 4);
  }

  // 有的平台 HTTP 200 但 body 里是错误（魔搭就是 errors.message），别当成「返回格式不认识」
  function imageApiError(data) {
    if (!data) return '';

    const errors = data.errors || data.error;

    if (!errors) return '';

    const message = typeof errors === 'string'
      ? errors
      : (errors.message || errors.code || '');

    const text = cleanText(message);

    if (/authentication|unauthorized|invalid.*token|api[ _]key/i.test(text)) {
      return 'API Key 不对或者没权限：' + text.slice(0, 120);
    }

    if (/balance|quota|insufficient/i.test(text)) {
      return '平台说额度不够：' + text.slice(0, 120);
    }

    return text ? '生图接口报错：' + text.slice(0, 160) : '';
  }

  // 魔搭这类平台：提交后不直接给图，只回一个 task_id，得再轮询任务接口。
  // 轮询时带上 X-ModelScope-Task-Type: image_generation，否则拿不到结果。
  async function pollAsyncImage(modelRow, headers, taskId) {
    const base = cleanText(modelRow.base_url).replace(/\/+$/, '');
    const root = base.replace(/\/v\d+$/, '');
    const candidates = [base + '/tasks/' + encodeURIComponent(taskId)];
    if (root !== base) candidates.push(root + '/v1/tasks/' + encodeURIComponent(taskId));

    const pollHeaders = { ...headers, 'X-ModelScope-Task-Type': 'image_generation' };
    const deadline = Date.now() + 170000;
    let lastStatus = '';

    while (Date.now() < deadline) {
      for (const url of candidates) {
        try {
          const response = await fetch(url, { method: 'GET', headers: pollHeaders });
          const text = await response.text();

          if (!response.ok) {
            lastStatus = text.slice(0, 160);
            continue;
          }

          let data = null;
          try { data = JSON.parse(text); } catch (e) {}

          const status = cleanText(data && data.task_status).toUpperCase();
          lastStatus = status || lastStatus;

          if (status === 'SUCCEED') {
            // 各家的成功响应长得不一样：output 可能是链接、数组、对象，
            // 也可能直接把 data[0].url / data[0].b64_json 放在顶层
            const links = collectImageLinks(data);

            if (!links.length) {
              throw new Error('生图任务成功，但返回里没找到图片：' +
                cleanText(text).slice(0, 160));
            }

            const link = links[0];

            // base64 直返的不用再去下载
            if (link.startsWith('data:')) {
              return saveImage(
                Buffer.from(link.slice(link.indexOf(',') + 1), 'base64'),
                '.png'
              );
            }

            const imageResponse = await fetch(link);
            const buffer = Buffer.from(await imageResponse.arrayBuffer());
            return saveImage(buffer, '.png');
          }

          if (status === 'FAILED') {
            const detail = describeTaskError(data);
            throw new Error('生图任务失败：' + (detail || '平台没给原因').slice(0, 120));
          }

          break; // 这个地址通了但还在跑，直接等下一轮
        } catch (error) {
          // 任务已经结束的结论直接抛；网络抖动只是记一下接着试
          if (/任务/.test(error.message || '')) throw error;
          lastStatus = error.message || lastStatus;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 2500));
    }

    throw new Error('生图任务等待超时（' + (lastStatus || '还在跑') + '），稍后去任务里看结果');
  }

  // 没有 /images/edits 的平台（魔搭这类）：参考图可以走异步任务 + image_url 参数。
  // 先提交一个任务，再轮询拿结果；这条路不通就老实退回纯文字生成。
  // 从任务结果里翻出图片链接：output 是链接/数组/对象，或者顶层 data[0].url
  function collectImageLinks(data) {
    const links = [];
    const push = (value) => {
      const text = cleanText(value);
      if (text && /^https?:\/\//i.test(text)) links.push(text);
    };

    const output = data && data.output;

    if (Array.isArray(output)) {
      output.forEach(push);
    } else if (output && typeof output === 'object') {
      push(output.image_url);
      push(output.url);
      if (Array.isArray(output.images)) output.images.forEach(push);
    } else {
      push(output);
    }

    push(data && data.image_url);
    push(data && data.url);

    // 魔搭实际返回：output_images: ["https://..."]，input.outputs 是空对象
    if (Array.isArray(data && data.output_images)) {
      data.output_images.forEach(push);
    }

    push(data && data.output_image);

    const rows = data && data.data;

    if (Array.isArray(rows)) {
      rows.forEach((row) => {
        push(row && row.url);
        push(row && row.image_url);
      });
    }

    // 也接受 base64 直返：落盘后给个本地地址
    const b64 = (Array.isArray(rows) && rows[0] && rows[0].b64_json) ||
      (data && data.b64_json);

    if (!links.length && b64) {
      links.push('data:image/png;base64,' + cleanText(b64));
    }

    return links;
  }

  // 任务失败时把平台的原话压成一句
  function describeTaskError(data) {
    const raw = data && (data.message || data.error || data.errors);

    if (!raw) return '';

    if (typeof raw === 'string') return raw;

    if (Array.isArray(raw)) return raw.map((item) => item && (item.message || item)).join('；');

    return cleanText(raw.message || raw.code || JSON.stringify(raw));
  }

  // 参考图优先走「内嵌 base64」：图只出现在这一次请求里，不会变成任何公开地址。
  // 平台不认 base64 时才退回公网链接（手机本地的 /uploads 平台本来就取不到）。
  function refToImageUrl(ref) {
    const direct = cleanText(ref.url);

    if (/^https?:\/\//i.test(direct) && !/\/uploads\//.test(direct)) {
      return direct;
    }

    try {
      const buffer = fs.readFileSync(ref.file);
      const mime = cleanText(ref.mime) || 'image/png';
      return 'data:' + mime + ';base64,' + buffer.toString('base64');
    } catch (e) {
      return '';
    }
  }

  // 一层参考图 = 一组 image_url（要么全是 base64，要么全是链接）
  function referenceCandidates(refs) {
    const embedded = refs.map(refToImageUrl).filter((url) => url.startsWith('data:'));

    if (embedded.length) return [embedded];

    const linked = refs
      .map((ref) => cleanText(ref.url))
      .filter((url) => /^https?:\/\//i.test(url));

    return linked.length ? [linked] : [];
  }

  async function requestImageWithReferenceTask(modelRow, headers, prompt, size, refs) {
    const sets = referenceCandidates(refs);

    if (!sets.length) {
      throw new Error('参考图读不出来，没法带图生成');
    }

    let lastError = '';

    for (const imageUrls of sets) {
      const payload = {
        model: modelRow.model,
        prompt,
        n: 1,
        size: size || '1024x1024',
        image_url: imageUrls.length === 1 ? imageUrls[0] : imageUrls
      };

      // base64 的那份要报错时别把整串贴回界面
      const isEmbedded = imageUrls[0].startsWith('data:');

      for (const url of buildUrls(modelRow.base_url, 'images/generations')) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
          });

          const text = await response.text();

          if (!response.ok) {
            if (response.status === 404 || response.status === 405) continue;
            lastError = text.slice(0, 160);
            break;
          }

          let data = null;
          try { data = JSON.parse(text); } catch (e) {}

          const first = data && data.data && data.data[0];

          if (first && first.url) {
            const imageResponse = await fetch(first.url);
            const buffer = Buffer.from(await imageResponse.arrayBuffer());
            return { url: saveImage(buffer, '.png') };
          }

          const taskId = cleanText(data && (data.task_id || (data.data && data.data.task_id)));

          if (taskId) {
            return { url: await pollAsyncImage(modelRow, headers, taskId) };
          }

          const apiError = imageApiError(data);

          if (apiError) {
            lastError = isEmbedded ? '平台不认内嵌图片：' + apiError : apiError;
          }
        } catch (error) {
          if (error.name === 'AbortError') {
            lastError = '参考图提交超时';
            break;
          }

          // 任务已经跑完的结论不用再换别的形式重试
          if (/任务/.test(error.message || '')) throw error;

          lastError = error.message || lastError;
          break;
        } finally {
          clearTimeout(timer);
        }
      }

      // base64 不行就换链接试一次；两种都不行就传最后一次的错
    }

    throw new Error(lastError || '参考图这条路没走通');
  }

  // 带参考图的请求：OpenAI 的 /images/edits 走 multipart
  async function requestImageWithReference(modelRow, prompt, size, refs) {
    const headers = { ...parseHeaders(modelRow.extra_headers) };

    if (!headers.Authorization && !headers.authorization) {
      headers.Authorization = 'Bearer ' + modelRow.api_key;
    }

    const referencePrompt =
      '参考图里是人物外貌参考（发型、瞳色、服装、气质）。' +
      '按这些特征来画，不要照抄姿势：' + prompt;

    const urls = buildUrls(modelRow.base_url, 'images/edits');
    const truncated = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);

    // 有的家只认 image，有的只认 image[]。以前同一张图两个字段一起给，
    // 有些中转会当成重复参数直接 400，所以改成两次尝试：
    // 第一次所有参考图都用 image，失败再全部用 image[]。
    const fieldVariants = ['image', 'image[]'];
    let lastError = '';

    for (const url of urls) {
      const attemptErrors = [];

      for (const field of fieldVariants) {
        const form = new FormData();
        form.append('model', modelRow.model);
        form.append('prompt', referencePrompt);
        form.append('n', '1');
        form.append('size', size || '1024x1024');

        refs.forEach((ref) => {
          const buffer = fs.readFileSync(ref.file);
          const blob = new Blob([buffer], { type: ref.mime });
          form.append(field, blob, ref.name);
        });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 180000);

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers,
            body: form,
            signal: controller.signal
          });

          const text = await response.text();

          if (response.ok) {
            let data = null;
            try {
              data = JSON.parse(text);
            } catch (e) {}

            const first = data && data.data && data.data[0];

            if (first && first.b64_json) {
              return { url: saveImage(Buffer.from(first.b64_json, 'base64'), '.png') };
            }

            if (first && first.url) {
              const imageResponse = await fetch(first.url);
              const buffer = Buffer.from(await imageResponse.arrayBuffer());
              return { url: saveImage(buffer, '.png') };
            }

            const taskId = cleanText(data && (data.task_id || (data.data && data.data.task_id)));

            if (taskId) {
              try {
                return { url: await pollAsyncImage(modelRow, headers, taskId) };
              } catch (error) {
                attemptErrors.push(field + '：' + truncated(error.message));
                continue;
              }
            }

            attemptErrors.push(field + '：参考图接口返回格式不认识');
          } else {
            attemptErrors.push(field + '：' + (truncated(text) || ('HTTP ' + response.status)));
          }
        } catch (error) {
          if (error.name === 'AbortError') throw new Error('生图超时');
          attemptErrors.push(field + '：' + truncated(error.message));
        } finally {
          clearTimeout(timer);
        }
      }

      // 这个地址的两种字段都失败，拼起来留着；再换下一个地址
      lastError = attemptErrors.filter(Boolean).join('；');
    }

    throw new Error(lastError || '参考图接口不可用');
  }

  // 1x1 的小图，用来探「能不能吃参考图」
  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  // 探一遍：文生图 / 参考图（edits）两条路各自通不通
  async function probeImage(modelRow) {
    const headers = { ...parseHeaders(modelRow.extra_headers) };

    if (!headers.Authorization && !headers.authorization) {
      headers.Authorization = 'Bearer ' + modelRow.api_key;
    }

    const lines = [];
    let generationOk = false;

    // --- 一条：纯文字生图 ---
    const genUrls = buildUrls(modelRow.base_url, 'images/generations');
    let genError = '';

    for (const url of genUrls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelRow.model,
            prompt: '一颗放在白桌上的红苹果，简单背景',
            n: 1,
            size: '1024x1024'
          }),
          signal: controller.signal
        });

        const text = await response.text();

        if (!response.ok) {
          genError = text.slice(0, 400);

          if (response.status === 404 || response.status === 405) continue;

          throw new Error(genError);
        }

        let data = null;
        try {
          data = JSON.parse(text);
        } catch (e) {}

        const first = data && data.data && data.data[0];
        const taskId = cleanText(data && (data.task_id || (data.data && data.data.task_id)));
        const apiError = first ? '' : imageApiError(data);

        if (apiError) {
          throw new Error(apiError);
        }

        if (!first && !taskId) {
          throw new Error('返回里没有图片数据：' + text.slice(0, 200));
        }

        generationOk = true;

        if (!first && taskId) {
          // 异步平台：能拿到任务号就说明这条链路通了
          lines.push('生图：可用（异步任务，提交后返回 task_id）' + '\n　　第一次出图要等一两分钟，之后每次也会慢一点');
        }

        if (first) {
          lines.push('生图：可用（' + (first.url ? '返回图片链接' : '返回 base64') + '）');
        }
        break;
      } catch (error) {
        genError = error.name === 'AbortError' ? '请求超时' : (error.message || genError);
      } finally {
        clearTimeout(timer);
      }
    }

    if (!generationOk) {
      throw new Error(genError || '生图接口不可用');
    }

    // --- 另一条：带参考图（/images/edits） ---
    const editUrls = buildUrls(modelRow.base_url, 'images/edits');
    let editAnswer = '';
    let editError = '';

    for (const url of editUrls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);

      try {
        const form = new FormData();
        form.append('model', modelRow.model);
        form.append('prompt', '把这张图的背景改成浅蓝色');
        form.append('n', '1');
        form.append('size', '1024x1024');
        const blob = new Blob([TINY_PNG], { type: 'image/png' });
        form.append('image', blob, 'ref.png');
        form.append('image[]', blob, 'ref.png');

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: form,
          signal: controller.signal
        });

        const text = await response.text();

        if (response.ok) {
          let data = null;
          try {
            data = JSON.parse(text);
          } catch (e) {}

          const first = data && data.data && data.data[0];

          if (first) {
            editAnswer = '参考图：可用（/images/edits 能接图改图）';
            break;
          }

          editError = '接口通了但没返回图：' + text.slice(0, 200);
          continue;
        }

        editError = text.slice(0, 300);

        if (response.status === 404 || response.status === 405) {
          editError = '这家没有 /images/edits 接口';
          continue;
        }

        if (response.status === 400) {
          editError = '这家不支持带图改图（400）：' + text.slice(0, 200);
          break;
        }

        break;
      } catch (error) {
        editError = error.name === 'AbortError' ? '请求超时' : error.message;
      } finally {
        clearTimeout(timer);
      }
    }

    if (editAnswer) {
      lines.push(editAnswer);
    } else if (generationOk && /没有 \/images\/edits|不支持带图改图|400/.test(editError)) {
      // 魔搭这类：没有 edits 接口，但接受 image_url 参数，走异步任务一样能吃到参考图
      lines.push('参考图：没走 /images/edits（' + editError.slice(0, 60) + '）');
      lines.push('　　不过它接受 image_url 参数：参考图是公网链接时，会改走异步任务带图生成，仍然用得上');
    } else {
      lines.push('参考图：用不了（' + (editError || '未知原因') + '）');
    }

    return { ok: true, reply: lines.join('\n') };
  }

  register.probe = probeImage;

  async function requestImage(modelRow, prompt, size) {
    const headers = {
      'Content-Type': 'application/json',
      ...parseHeaders(modelRow.extra_headers)
    };

    if (!headers.Authorization && !headers.authorization) {
      headers.Authorization = 'Bearer ' + modelRow.api_key;
    }

    const payload = {
      model: modelRow.model,
      prompt,
      n: 1,
      size: size || '1024x1024'
    };

    let lastError = '';

    for (const url of buildUrls(modelRow.base_url, 'images/generations')) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180000);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        const text = await response.text();

        if (response.ok) {
          let data = null;

          try {
            data = JSON.parse(text);
          } catch (e) {}

          const first = data && data.data && data.data[0];

          // 魔搭这类平台即使失败也回 200，错误写在 errors.message 里
          const apiError = first ? '' : imageApiError(data);

          if (apiError) {
            throw new Error(apiError);
          }

          const taskId = cleanText(data && (data.task_id || (data.data && data.data.task_id)));

          if (!first && taskId) {
            return await pollAsyncImage(modelRow, headers, taskId);
          }

          if (!first) {
            throw new Error('生图接口返回里没有图片');
          }

          if (first.b64_json) {
            return saveImage(
              Buffer.from(first.b64_json, 'base64'),
              '.png'
            );
          }

          if (first.url) {
            const imageResponse = await fetch(first.url);
            const buffer = Buffer.from(await imageResponse.arrayBuffer());
            return saveImage(buffer, '.png');
          }

          throw new Error('生图接口返回格式不认识');
        }

        lastError = text.slice(0, 300);

        // 404 / 405 多半是路径不对，换下一个候选地址
        if (response.status !== 404 && response.status !== 405) {
          throw new Error(lastError);
        }
      } catch (error) {
        if (error.name === 'AbortError') {
          throw new Error('生图超时');
        }

        if (error.message && error.message !== lastError) {
          // 网络错误也值得再试下一个地址，但只在没拿到过响应时
          lastError = error.message;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error('生图失败：' + (lastError || '没有可用的接口地址'));
  }

  app.get('/api/image-model', (req, res) => {
    const row = imageModel();

    res.json(row ? {
      id: row.id,
      name: row.name,
      model: row.model
    } : null);
  });

  app.post('/api/generate-image', async (req, res) => {
    const prompt = cleanText(req.body && req.body.prompt);

    if (!prompt) {
      return res.status(400).json({ error: '先写一句画面描述' });
    }

    const modelRow = imageModel(Number(req.body && req.body.model_id || 0));

    if (!modelRow) {
      return res.status(400).json({
        error: '还没有设置生图模型。去「模型设置」里选一个支持生图的模型。'
      });
    }

    const size = cleanText(req.body && req.body.size);

    // 剧场会把「身份卡参考图 + 角色设定图」拼好显式传过来，有就用它；
    // 没传才按 character_id 走原来的兜底
    const explicitRefs = Array.isArray(req.body && req.body.ref_images)
      ? req.body.ref_images
      : [];

    const refs = explicitRefs.length
      ? referenceImagesFromUrls(explicitRefs)
      : referenceImages(Number(req.body && req.body.character_id || 0));

    try {
      // 有参考图就先试着带参考图生成；这条路不通再退回纯文字生成
      let referenceError = '';

      const headers = (() => {
        const base = { ...parseHeaders(modelRow.extra_headers) };

        if (!base.Authorization && !base.authorization) {
          base.Authorization = 'Bearer ' + modelRow.api_key;
        }

        return base;
      })();

      if (refs.length) {
        try {
          const result = await requestImageWithReference(
            modelRow,
            prompt,
            size,
            refs
          );

          return res.json({ ok: true, url: result.url, with_reference: true });
        } catch (e) {
          // 记住为什么没套上参考图，退回纯文字生成时告诉用户
          referenceError = String((e && e.message) || '').slice(0, 200);
        }

        // 没有 /images/edits 的平台（魔搭）：改走「异步任务 + image_url」
        // 这条路只在参考图本身是公网链接时才有意义
        try {
          const taskResult = await requestImageWithReferenceTask(
            modelRow,
            headers,
            prompt,
            size,
            refs
          );

          return res.json({ ok: true, url: taskResult.url, with_reference: true });
        } catch (e) {
          const text = String((e && e.message) || '').slice(0, 200);
          referenceError = referenceError ? referenceError + '；' + text : text;
        }
      }

      const url = await requestImage(modelRow, prompt, size);

      // 只有「有参考图但没套上」才带 reference_error；
      // 本来就没有参考图的，不要凭空多这个字段
      if (referenceError) {
        return res.json({
          ok: true,
          url,
          with_reference: false,
          reference_error: referenceError
        });
      }

      res.json({ ok: true, url, with_reference: false });
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });
}

module.exports = register;
