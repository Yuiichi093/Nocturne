// 用量账本：每次调模型的 token 和估算花费（今天 / 最近 7 天 / 最近 30 天）
// 路由：GET /api/usage/summary?days=1|7|30、GET /api/usage/logs?limit=20
module.exports = function (app, db) {
  // 默认单价按 DeepSeek V3.2 标价：每百万 token 多少元
  const DEFAULT_PRICE = { input: 2, output: 3, cache_hit: 0.2 };

  const PRICE_KEYS = {
    input: 'usage_price_input',
    output: 'usage_price_output',
    cache_hit: 'usage_price_cache'
  };

  const DAY_CHOICES = [1, 7, 30];

  function readPrice() {
    const rows = db.prepare(`
      SELECT key, value FROM app_settings
      WHERE key IN ('usage_price_input', 'usage_price_output', 'usage_price_cache')
    `).all();

    const saved = {};

    for (const row of rows) {
      saved[row.key] = String(row.value == null ? '' : row.value).trim();
    }

    const pick = (key, fallback) => {
      const value = Number(saved[key]);
      return Number.isFinite(value) && value >= 0 ? value : fallback;
    };

    // 允许在 app_settings 里覆盖单价（每百万 token 元数），脏值回默认
    return {
      input: pick(PRICE_KEYS.input, DEFAULT_PRICE.input),
      output: pick(PRICE_KEYS.output, DEFAULT_PRICE.output),
      cache_hit: pick(PRICE_KEYS.cache_hit, DEFAULT_PRICE.cache_hit)
    };
  }

  // 输入分两档计价：缓存命中便宜，未命中按原价
  function costOf(price, inputTokens, outputTokens, cacheHitTokens) {
    const input = Math.max(0, Number(inputTokens) || 0);
    const output = Math.max(0, Number(outputTokens) || 0);
    const hit = Math.min(Math.max(0, Number(cacheHitTokens) || 0), input);
    const miss = Math.max(0, input - hit);

    const yuan =
      (miss * price.input + hit * price.cache_hit + output * price.output) / 1e6;

    // 金额是估算，留 4 位小数就够看
    return Number(yuan.toFixed(4));
  }

  // 本地自然日：今天是本地 00:00 起，7 天/30 天往前推
  function localDayStartSql(days) {
    const offset = '-' + Math.max(0, days - 1) + ' days';
    const row = db.prepare(`
      SELECT datetime('now', 'localtime', 'start of day', ?) AS start
    `).get(offset);

    return row && row.start;
  }

  function parseDays(req) {
    const query = req.query || {};

    if (String(query.today || '') === '1') return 1;

    const days = Number(query.days);

    return DAY_CHOICES.includes(days) ? days : 1;
  }

  function parseLimit(req) {
    const limit = Number((req.query || {}).limit);
    if (!Number.isFinite(limit) || limit <= 0) return 20;
    return Math.min(Math.floor(limit), 100);
  }

  app.get('/api/usage/summary', (req, res) => {
    const days = parseDays(req);
    const price = readPrice();
    const start = localDayStartSql(days);

    const rowOf = (item) => ({
      calls: Number(item.calls) || 0,
      input_tokens: Number(item.input_tokens) || 0,
      output_tokens: Number(item.output_tokens) || 0,
      total_tokens: Number(item.total_tokens) || 0,
      cache_hit_tokens: Number(item.cache_hit_tokens) || 0
    });

    const totalRow = rowOf(db.prepare(`
      SELECT
        COUNT(*) AS calls,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit_tokens
      FROM usage_logs
      WHERE created_at >= ?
    `).get(start));

    const bySource = db.prepare(`
      SELECT
        source,
        COUNT(*) AS calls,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit_tokens
      FROM usage_logs
      WHERE created_at >= ?
      GROUP BY source
      ORDER BY input_tokens DESC
    `).all(start).map((item) => {
      const base = rowOf(item);

      return {
        source: String(item.source || 'chat'),
        calls: base.calls,
        input_tokens: base.input_tokens,
        output_tokens: base.output_tokens,
        total_tokens: base.total_tokens,
        cost_yuan: costOf(price, base.input_tokens, base.output_tokens, base.cache_hit_tokens)
      };
    });

    const byDay = db.prepare(`
      SELECT
        substr(created_at, 1, 10) AS day,
        COUNT(*) AS calls,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit_tokens
      FROM usage_logs
      WHERE created_at >= ?
      GROUP BY day
      ORDER BY day ASC
    `).all(start).map((item) => {
      const base = rowOf(item);

      return {
        day: String(item.day || ''),
        calls: base.calls,
        input_tokens: base.input_tokens,
        output_tokens: base.output_tokens,
        cost_yuan: costOf(price, base.input_tokens, base.output_tokens, base.cache_hit_tokens)
      };
    });

    res.json({
      ok: true,
      days,
      total: {
        ...totalRow,
        cost_yuan: costOf(
          price, totalRow.input_tokens, totalRow.output_tokens, totalRow.cache_hit_tokens
        )
      },
      by_source: bySource,
      by_day: byDay,
      price
    });
  });

  app.get('/api/usage/logs', (req, res) => {
    const price = readPrice();
    const limit = parseLimit(req);

    const rows = db.prepare(`
      SELECT
        id, created_at, source, model,
        input_tokens, output_tokens, cache_hit_tokens, total_tokens,
        character_id, character_name
      FROM usage_logs
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);

    res.json({
      ok: true,
      logs: rows.map((row) => ({
        id: Number(row.id),
        created_at: String(row.created_at || ''),
        source: String(row.source || 'chat'),
        model: String(row.model || ''),
        input_tokens: Number(row.input_tokens) || 0,
        output_tokens: Number(row.output_tokens) || 0,
        cache_hit_tokens: Number(row.cache_hit_tokens) || 0,
        total_tokens: Number(row.total_tokens) || 0,
        character_id: Number(row.character_id) || 0,
        character_name: String(row.character_name || ''),
        cost_yuan: costOf(
          price,
          Number(row.input_tokens) || 0,
          Number(row.output_tokens) || 0,
          Number(row.cache_hit_tokens) || 0
        )
      }))
    });
  });
};
