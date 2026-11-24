'use strict';
// 剧场「找回删掉的剧情」
// ---------------------------------------------------------------
// 删除剧情是硬删，删完数据库里就没了。但 backup-worker 每天启动时会用
// VACUUM INTO 留一份一致性快照（data/users/<id>/backups/saudade-YYYYMMDD.db，
// 留最近 7 份），只要那份快照是在删除之前生成的，被删的会话就还在里面。
//
// 这个模块只做两件事：
//   GET  /api/theater/recover/list  列出「快照里有、现在库里没有」的会话
//   POST /api/theater/recover       从那份快照里把某个会话整段搬回来
// 快照一律以只读方式打开，绝不写回去。
const fs = require('fs');
const path = require('path');

module.exports = function theaterRecoverApi(app, db) {
  const SNAPSHOT_RE = /^(saudade-\d{8}\.db|before-restore-[\w.-]+\.db)$/;

  function snapshotFiles(userId) {
    const dir = db.backupsDir(userId);
    let names = [];

    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      return [];
    }

    return names
      .filter((name) => SNAPSHOT_RE.test(name))
      .map((name) => {
        const full = path.join(dir, name);
        let size = 0;
        let mtime = 0;

        try {
          const stat = fs.statSync(full);
          size = stat.size;
          mtime = stat.mtimeMs;
        } catch (error) {}

        return { name: name, path: full, size: size, mtime: mtime };
      })
      .filter((item) => item.size > 0)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 8);
  }

  function openSnapshot(file) {
    return db.openDatabase(file, { readOnly: true });
  }

  // 找回过的会话在快照里永远还在（快照是只读的），不记一笔的话列表会一直挂着它。
  // 用 app_settings 存「这份快照里的这个会话已经搬到新 id 了」，读的时候跳过。
  function recoveredMark(snapshot, sessionId) {
    return 'theater_recovered:' + snapshot + ':' + sessionId;
  }

  function findRecovered(snapshot, sessionId) {
    try {
      const row = db.prepare('SELECT value FROM app_settings WHERE key = ?')
        .get(recoveredMark(snapshot, sessionId));
      return row ? Number(row.value) || 0 : 0;
    } catch (error) {
      return 0;
    }
  }

  function markRecovered(snapshot, sessionId, newSessionId) {
    try {
      db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
        .run(recoveredMark(snapshot, sessionId), String(newSessionId));
    } catch (error) {}
  }

  function closeQuietly(conn) {
    try {
      if (conn && typeof conn.close === 'function') conn.close();
    } catch (error) {}
  }

  function safeAll(conn, sql, params) {
    try {
      const stmt = conn.prepare(sql);
      return params && params.length ? stmt.all.apply(stmt, params) : stmt.all();
    } catch (error) {
      return [];
    }
  }

  function safeGet(conn, sql, params) {
    try {
      const stmt = conn.prepare(sql);
      return params && params.length ? stmt.get.apply(stmt, params) : stmt.get();
    } catch (error) {
      return null;
    }
  }

  app.get('/api/theater/recover/list', (req, res) => {
    const userId = req.user.id;
    const live = new Set(
      safeAll(db, 'SELECT id FROM theater_sessions', []).map((row) => Number(row.id))
    );

    const seen = new Set();
    const items = [];

    snapshotFiles(userId).forEach((snap) => {
      const conn = openSnapshot(snap.path);

      try {
        const sessions = safeAll(conn, 'SELECT * FROM theater_sessions', []);

        sessions.forEach((session) => {
          const id = Number(session.id);

          // 还在库里的不算「删掉了」；同一份会话在多个快照里出现只留最新那份
          if (!id || live.has(id) || seen.has(id)) return;

          // 已经从这份快照找回过的，别再重复挂在列表里
          const recoveredId = findRecovered(snap.name, id);
          if (recoveredId && live.has(recoveredId)) return;

          seen.add(id);

          const count = safeGet(
            conn,
            'SELECT COUNT(*) AS n FROM theater_messages WHERE session_id = ?',
            [id]
          );

          items.push({
            snapshot: snap.name,
            saved_at: snap.mtime,
            session_id: id,
            title: String(session.title || '未命名剧情'),
            message_count: Number(count && count.n) || 0,
            created_at: session.created_at,
            updated_at: session.updated_at
          });
        });
      } catch (error) {
        // 单份快照读坏了不影响别的
      } finally {
        closeQuietly(conn);
      }
    });

    items.sort((a, b) => Number(b.updated_at > a.updated_at) - Number(a.updated_at > b.updated_at));

    res.json({ ok: true, items: items });
  });

  app.post('/api/theater/recover', (req, res) => {
    const userId = req.user.id;
    const body = req.body || {};
    const sessionId = Number(body.session_id) || 0;
    const name = String(body.snapshot || '');

    if (!sessionId) {
      return res.status(400).json({ error: '没有指明要找回哪一段剧情' });
    }

    const snap = snapshotFiles(userId).find((item) => item.name === name);

    if (!snap) {
      return res.status(404).json({ error: '那份自动备份已经不在了，只能找回最近几天的' });
    }

    const conn = openSnapshot(snap.path);

    try {
      const session = safeGet(
        conn,
        'SELECT * FROM theater_sessions WHERE id = ?',
        [sessionId]
      );

      if (!session) {
        return res.status(404).json({ error: '这份备份里没有那段剧情' });
      }

      const messages = safeAll(
        conn,
        'SELECT role, character_id, content, image_url, meta_json, created_at FROM theater_messages WHERE session_id = ? ORDER BY id ASC',
        [sessionId]
      );

      const corrections = safeAll(
        conn,
        'SELECT content, active, created_at FROM theater_corrections WHERE session_id = ? ORDER BY id ASC',
        [sessionId]
      );

      // 标题后面缀个标记，免得跟以后新建的重名分不清
      const title = String(session.title || '未命名剧情').slice(0, 120) + '（找回）';

      const inserted = db.prepare(`
        INSERT INTO theater_sessions
          (script_id, title, identity_name, identity_role,
           identity_desc, identity_avatar, status, world_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.script_id,
        title,
        session.identity_name || '',
        session.identity_role || '',
        session.identity_desc || '',
        session.identity_avatar || '',
        'active',
        Number(session.world_id) || 0
      );

      const newSessionId = Number(inserted.lastInsertRowid);

      const writeMessage = db.prepare(`
        INSERT INTO theater_messages
          (session_id, role, character_id, content, image_url, meta_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      db.exec('BEGIN');

      try {
        messages.forEach((row) => {
          writeMessage.run(
            newSessionId,
            row.role,
            row.character_id == null ? null : Number(row.character_id),
            row.content == null ? '' : row.content,
            row.image_url == null ? '' : row.image_url,
            row.meta_json == null ? '' : row.meta_json,
            row.created_at || null
          );
        });

        if (corrections.length) {
          const writeCorrection = db.prepare(`
            INSERT INTO theater_corrections
              (session_id, content, active, created_at)
            VALUES (?, ?, ?, ?)
          `);

          corrections.forEach((row) => {
            writeCorrection.run(
              newSessionId,
              row.content == null ? '' : row.content,
              Number(row.active) ? 1 : 0,
              row.created_at || null
            );
          });
        }

        db.exec('COMMIT');
      } catch (writeError) {
        db.exec('ROLLBACK');
        throw writeError;
      }

      markRecovered(snap.name, sessionId, newSessionId);

      res.json({
        ok: true,
        session_id: newSessionId,
        message_count: messages.length,
        snapshot: snap.name
      });
    } catch (error) {
      res.status(500).json({ error: '找回失败：' + (error.message || '未知错误') });
    } finally {
      closeQuietly(conn);
    }
  });
};
