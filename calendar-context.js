const db = require('./db');

let lunarLib = null;

try {
  lunarLib = require('lunar-javascript');
} catch (e) {
  lunarLib = null;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function sameDate(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function solarFromLunar(lunarYear, lunarMonth, lunarDay) {
  if (!lunarLib) return null;

  try {
    const solar = lunarLib.Lunar
      .fromYmd(lunarYear, lunarMonth, lunarDay)
      .getSolar();

    return new Date(
      solar.getYear(),
      solar.getMonth() - 1,
      solar.getDay()
    );
  } catch (e) {
    return null;
  }
}

function chuxiFromLunarYear(lunarYear) {
  if (!lunarLib) return null;

  try {
    const month = lunarLib.LunarMonth.fromYm(lunarYear, 12);
    const dayCount = month.getDayCount();

    const solar = lunarLib.Lunar
      .fromYmd(lunarYear, 12, dayCount)
      .getSolar();

    return new Date(
      solar.getYear(),
      solar.getMonth() - 1,
      solar.getDay()
    );
  } catch (e) {
    return null;
  }
}

function solarDate(year, month, day) {
  return new Date(year, month - 1, day);
}

function holidayCandidates(row, today) {
  const year = today.getFullYear();
  const list = [];

  if (row.rule_type === 'solar') {
    list.push(solarDate(year, row.month, row.day));
    list.push(solarDate(year + 1, row.month, row.day));
    return list;
  }

  if (row.rule_type === 'lunar') {
    if (Number(row.day) === 0) {
      [year - 1, year, year + 1].forEach((lunarYear) => {
        const date = chuxiFromLunarYear(lunarYear);
        if (date) list.push(date);
      });
      return list;
    }

    [year - 1, year, year + 1].forEach((lunarYear) => {
      const date = solarFromLunar(lunarYear, row.month, row.day);
      if (date) list.push(date);
    });

    return list;
  }

  return list;
}

function parseLunarBirthday(text, today) {
  const match = String(text || '').match(/农历\s*(\d{1,2})\s*月\s*(\d{1,2})/);

  if (!match || !lunarLib) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = today.getFullYear();

  for (const lunarYear of [year - 1, year, year + 1]) {
    const date = solarFromLunar(lunarYear, month, day);
    if (!date) continue;
    if (Math.abs(date.getFullYear() - year) <= 1) return date;
  }

  return null;
}

function parseBirthday(text, today) {
  if (!text) return null;

  if (String(text).includes('农历')) {
    return parseLunarBirthday(text, today);
  }

  const rawText = String(text);

  // 先认 yyyy-mm-dd 这种完整日期，否则 1990-05-01 会被切成「90 月 5 日」
  const isoMatch = rawText.match(/(\d{4})\s*[-/]\s*(\d{1,2})\s*[-/]\s*(\d{1,2})/);

  if (isoMatch) {
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    const year = today.getFullYear();
    const thisYear = solarDate(year, month, day);

    if (thisYear >= today) return thisYear;
    return solarDate(year + 1, month, day);
  }

  // 前后不能紧挨着别的数字，避免又把年份的后两位当成月份
  const match = rawText.match(/(?:^|\D)(\d{1,2})\s*[月/-]\s*(\d{1,2})(?!\d)/);
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = today.getFullYear();

  const thisYear = solarDate(year, month, day);
  if (thisYear >= today) return thisYear;

  return solarDate(year + 1, month, day);
}

function parseWorldEventRule(text, today) {
  const raw = String(text || '');
  const match = raw.match(/(\d{1,2})\s*[月/-]\s*(\d{1,2})/);

  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = today.getFullYear();

  if (raw.includes('农历')) {
    for (const lunarYear of [year - 1, year, year + 1]) {
      const date = solarFromLunar(lunarYear, month, day);
      if (!date) continue;
      if (date >= today) return date;
    }
    return null;
  }

  const thisYear = solarDate(year, month, day);
  if (thisYear >= today) return thisYear;

  return solarDate(year + 1, month, day);
}

function formatMonthDay(date) {
  return (date.getMonth() + 1) + '月' + date.getDate() + '日';
}

function formatLine(name, date, today) {
  if (sameDate(date, today)) {
    return '今天是' + name;
  }

  const diff = Math.round(
    (startOfDay(date) - startOfDay(today)) / 86400000
  );

  if (diff > 0 && diff <= 7) {
    return diff + '天后是' + name + '（' + formatMonthDay(date) + '）';
  }

  return '';
}

function getCalendarContext(worldId, options) {
  const id = Number(worldId || 0);
  if (!id) return '';

  const days = Number(options && options.days || 7);
  const birthdayDays = Number(options && options.birthdayDays || 30);

  const now = new Date();
  const today = startOfDay(now);
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const lines = [];
  lines.push('【时间与节日】');
  lines.push(
    '当前时间：' +
    now.getFullYear() + '年' +
    (now.getMonth() + 1) + '月' +
    now.getDate() + '日 ' +
    weekdays[now.getDay()] + ' ' +
    String(now.getHours()).padStart(2, '0') + ':' +
    String(now.getMinutes()).padStart(2, '0')
  );

  const holidayRows = db.prepare(`
    SELECT h.*, COALESCE(s.enabled, 1) AS enabled
    FROM holidays h
    LEFT JOIN world_holiday_settings s
      ON s.holiday_id = h.id AND s.world_id = ?
    WHERE COALESCE(s.enabled, 1) = 1
  `).all(id);

  const holidayEvents = [];

  holidayRows.forEach((row) => {
    holidayCandidates(row, today).forEach((date) => {
      if (!date) return;

      const diff = Math.round(
        (startOfDay(date) - today) / 86400000
      );

      if (diff >= 0 && diff <= days) {
        holidayEvents.push({
          name: row.name,
          date
        });
      }
    });
  });

  const worldEvents = db.prepare(`
    SELECT * FROM world_events
    WHERE world_id = ? AND enabled = 1
  `).all(id);

  worldEvents.forEach((row) => {
    const date = parseWorldEventRule(row.rule_text, today);
    if (!date) return;

    const diff = Math.round(
      (startOfDay(date) - today) / 86400000
    );

    if (diff >= 0 && diff <= days) {
      holidayEvents.push({
        name: '世界节日「' + row.name + '」',
        date
      });
    }
  });

  if (holidayEvents.length) {
    holidayEvents
      .sort((a, b) => a.date - b.date)
      .forEach((event) => {
        const line = formatLine(event.name, event.date, today);
        if (line) lines.push(line);
      });
  } else {
    lines.push('未来' + days + '天暂无节日。');
  }

  const characters = db.prepare(`
    SELECT id, name, birthday
    FROM characters
    WHERE world_id = ? AND birthday <> ''
    ORDER BY id ASC
  `).all(id);

  const birthdayEvents = [];

  const userBirthdayRow = db.prepare(`
    SELECT value FROM app_settings
    WHERE key = 'user_birthday'
  `).get();

  if (userBirthdayRow && userBirthdayRow.value) {
    const userDate = parseBirthday(userBirthdayRow.value, today);

    if (userDate) {
      const userDiff = Math.round(
        (startOfDay(userDate) - today) / 86400000
      );

      if (userDiff >= 0 && userDiff <= birthdayDays) {
        birthdayEvents.push({
          name: '你的生日',
          date: userDate
        });
      }
    }
  }

  characters.forEach((character) => {
    const date = parseBirthday(character.birthday, today);
    if (!date) return;

    const diff = Math.round(
      (startOfDay(date) - today) / 86400000
    );

    if (diff >= 0 && diff <= birthdayDays) {
      birthdayEvents.push({
        name: character.name + '的生日',
        date
      });
    }
  });

  if (birthdayEvents.length) {
    lines.push('近期生日：');
    birthdayEvents
      .sort((a, b) => a.date - b.date)
      .forEach((event) => {
        const diff = Math.round(
          (startOfDay(event.date) - today) / 86400000
        );

        if (diff === 0) {
          lines.push('- 今天是' + event.name);
        } else {
          lines.push(
            '-' + event.name + '：' +
            diff + '天后（' + formatMonthDay(event.date) + '）'
          );
        }
      });
  }

  return lines.join('\n');
}

module.exports = {
  getCalendarContext
};
