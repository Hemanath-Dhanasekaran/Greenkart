/*
 * Asia/Kolkata (IST) date helpers and relative-date interpretation.
 *
 * IST is a fixed UTC+05:30 offset with no daylight saving, so all calendar
 * arithmetic is done on a shifted UTC clock rather than with Intl time zones.
 * Shared by the Node CLI and the browser dashboard (UMD wrapper, no deps).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QATime = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TZ_NAME = 'Asia/Kolkata';
  const OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const NUMBER_WORDS = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, couple: 2,
  };

  function toDate(value) {
    return value instanceof Date ? value : new Date(value);
  }

  /** Calendar parts of an instant as seen on an IST wall clock. */
  function istParts(value) {
    const shifted = new Date(toDate(value).getTime() + OFFSET_MS);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
      weekday: shifted.getUTCDay(),
    };
  }

  /** UTC instant of 00:00 IST on the given IST calendar date (month is 1-12, overflow allowed). */
  function istMidnight(year, month, day) {
    return new Date(Date.UTC(year, month - 1, day) - OFFSET_MS);
  }

  function startOfIstDay(value) {
    const p = istParts(value);
    return istMidnight(p.year, p.month, p.day);
  }

  const pad = (n) => String(n).padStart(2, '0');

  /** "Tue 13 Oct 2026, 16:51 IST" */
  function formatIst(value, { withTime = true, withWeekday = true } = {}) {
    if (value === undefined || value === null || value === '') return 'unknown time';
    const d = toDate(value);
    if (Number.isNaN(d.getTime())) return 'unknown time';
    const p = istParts(d);
    const date = `${withWeekday ? `${DAY_NAMES[p.weekday]} ` : ''}${p.day} ${MONTH_NAMES[p.month - 1]} ${p.year}`;
    return withTime ? `${date}, ${pad(p.hour)}:${pad(p.minute)} IST` : date;
  }

  /** "2026-10-13" (IST calendar date). */
  function istDateKey(value) {
    const p = istParts(value);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  }

  /** ISO-8601 string with the +05:30 offset, e.g. 2026-10-13T16:51:13+05:30. */
  function toIstIso(value) {
    const p = istParts(value);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}+05:30`;
  }

  function makeRange(start, end, label, kind) {
    const last = new Date(end.getTime() - 1);
    const sameDay = istDateKey(start) === istDateKey(last);
    const description = sameDay
      ? `${formatIst(start, { withTime: false })} (00:00–23:59 IST)`
      : `${formatIst(start, { withTime: false })} 00:00 IST to ${formatIst(last, { withTime: false })} 23:59 IST`;
    return {
      label,
      kind,
      start: start.toISOString(),
      end: end.toISOString(),
      description,
      timezone: TZ_NAME,
    };
  }

  function dayRange(now, offsetDays, label) {
    const p = istParts(now);
    const start = istMidnight(p.year, p.month, p.day - offsetDays);
    return makeRange(start, new Date(start.getTime() + DAY_MS), label, 'day');
  }

  /** Weeks start on Monday (ISO-8601, the usual convention in India). */
  function weekRange(now, offsetWeeks, label) {
    const p = istParts(now);
    const sinceMonday = (p.weekday + 6) % 7;
    const start = istMidnight(p.year, p.month, p.day - sinceMonday - 7 * offsetWeeks);
    return makeRange(start, new Date(start.getTime() + 7 * DAY_MS), label, 'week');
  }

  function monthRange(now, offsetMonths, label) {
    const p = istParts(now);
    const start = istMidnight(p.year, p.month - offsetMonths, 1);
    const end = istMidnight(p.year, p.month - offsetMonths + 1, 1);
    return makeRange(start, end, label, 'month');
  }

  /** Rolling window of N calendar days that includes today. */
  function lastNDays(now, n, label) {
    const p = istParts(now);
    const start = istMidnight(p.year, p.month, p.day - (n - 1));
    const end = istMidnight(p.year, p.month, p.day + 1);
    return makeRange(start, end, label, 'rolling-days');
  }

  function parseNumber(token) {
    if (/^\d+$/.test(token)) return Number(token);
    return NUMBER_WORDS[token.toLowerCase()];
  }

  const NUM = '(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|couple(?: of)?)';
  const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

  /** Parses one absolute date expression into an IST midnight, or null. */
  function parseAbsoluteDate(text, now) {
    const t = text.trim().toLowerCase();
    const nowYear = istParts(now).year;
    let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return istMidnight(+m[1], +m[2], +m[3]);
    // Day-first numeric dates (Indian convention): 13/10/2026, 13-10-2026, 13.10.2026
    m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (m) return istMidnight(+m[3], +m[2], +m[1]);
    m = t.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE},?(?:\\s+(\\d{4}))?$`));
    if (m) return istMidnight(m[3] ? +m[3] : nowYear, MONTHS.indexOf(m[2].slice(0, 3)) + 1, +m[1]);
    m = t.match(new RegExp(`^${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?(?:\\s+(\\d{4}))?$`));
    if (m) return istMidnight(m[3] ? +m[3] : nowYear, MONTHS.indexOf(m[1].slice(0, 3)) + 1, +m[2]);
    return null;
  }

  const DATE_TOKEN = `(\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE},?(?:\\s+\\d{4})?|${MONTH_RE}\\s+\\d{1,2}(?:st|nd|rd|th)?,?(?:\\s+\\d{4})?)`;

  /**
   * Finds a relative or absolute date expression in free text and returns
   * { range, matched } where range has UTC ISO start (inclusive) / end
   * (exclusive) plus a human description in IST, or null if none is present.
   */
  function resolveDateRange(text, nowValue) {
    const now = nowValue ? toDate(nowValue) : new Date();
    const q = ` ${String(text).toLowerCase().replace(/[?!]/g, ' ').replace(/\s+/g, ' ')} `;
    const tryMatch = (re) => q.match(re);
    let m;

    if ((m = tryMatch(new RegExp(`\\bbetween ${DATE_TOKEN} and ${DATE_TOKEN}`)))
      || (m = tryMatch(new RegExp(`\\bfrom ${DATE_TOKEN} (?:to|until|till) ${DATE_TOKEN}`)))) {
      const tokens = m[0].match(new RegExp(DATE_TOKEN, 'g'));
      const a = parseAbsoluteDate(tokens[0], now);
      const b = parseAbsoluteDate(tokens[1], now);
      if (a && b) {
        const [s, e] = a <= b ? [a, b] : [b, a];
        return { matched: m[0].trim(), range: makeRange(s, new Date(e.getTime() + DAY_MS), m[0].trim(), 'explicit') };
      }
    }
    if ((m = tryMatch(new RegExp(`\\bsince ${DATE_TOKEN}`)))) {
      const s = parseAbsoluteDate(m[0].replace(/^\s*since /, ''), now);
      if (s) return { matched: m[0].trim(), range: makeRange(s, istMidnight(istParts(now).year, istParts(now).month, istParts(now).day + 1), m[0].trim(), 'since') };
    }
    if ((m = tryMatch(/\bday before yesterday\b/))) return { matched: m[0], range: dayRange(now, 2, 'day before yesterday') };
    if ((m = tryMatch(/\byesterday\b/))) return { matched: m[0], range: dayRange(now, 1, 'yesterday') };
    if ((m = tryMatch(/\btoday\b|\bso far today\b/))) return { matched: m[0], range: dayRange(now, 0, 'today') };
    if ((m = tryMatch(/\b(?:last|past|previous) 24 hours\b/))) {
      return { matched: m[0], range: Object.assign(makeRange(new Date(now.getTime() - DAY_MS), now, 'last 24 hours', 'rolling-hours'), { description: `${formatIst(new Date(now.getTime() - DAY_MS))} to ${formatIst(now)}` }) };
    }
    if ((m = tryMatch(new RegExp(`\\b(?:in |during |over |within )?(?:the )?(?:last|past|previous) ${NUM} (day|week|month)s?\\b`)))) {
      const n = parseNumber(m[1].replace(/ of$/, ''));
      const unit = m[2];
      if (n) {
        const label = `last ${n} ${unit}${n === 1 ? '' : 's'}`;
        if (unit === 'day') return { matched: m[0].trim(), range: lastNDays(now, n, label) };
        if (unit === 'week') return { matched: m[0].trim(), range: lastNDays(now, n * 7, label) };
        const p = istParts(now);
        const start = istMidnight(p.year, p.month - n, p.day + 1);
        return { matched: m[0].trim(), range: makeRange(start, istMidnight(p.year, p.month, p.day + 1), label, 'rolling-months') };
      }
    }
    if ((m = tryMatch(new RegExp(`\\b${NUM} (day|week|month)s? ago\\b`)))) {
      const n = parseNumber(m[1].replace(/ of$/, ''));
      if (n !== undefined) {
        const label = `${n} ${m[2]}${n === 1 ? '' : 's'} ago`;
        if (m[2] === 'day') return { matched: m[0], range: dayRange(now, n, label) };
        if (m[2] === 'week') return { matched: m[0], range: weekRange(now, n, label) };
        return { matched: m[0], range: monthRange(now, n, label) };
      }
    }
    if ((m = tryMatch(/\b(this|current) week\b/))) return { matched: m[0], range: weekRange(now, 0, 'this week') };
    if ((m = tryMatch(/\b(last|previous|past) week\b/))) return { matched: m[0], range: weekRange(now, 1, 'last week') };
    if ((m = tryMatch(/\b(this|current) month\b/))) return { matched: m[0], range: monthRange(now, 0, 'this month') };
    if ((m = tryMatch(/\b(last|previous|past) month\b/))) return { matched: m[0], range: monthRange(now, 1, 'last month') };
    if ((m = tryMatch(/\b(this|current) year\b/))) {
      const p = istParts(now);
      return { matched: m[0], range: makeRange(istMidnight(p.year, 1, 1), istMidnight(p.year + 1, 1, 1), 'this year', 'year') };
    }
    if ((m = tryMatch(/\b(?:on |last )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) {
      const target = DAYS.indexOf(m[1]);
      const back = (istParts(now).weekday - target + 7) % 7 || (m[0].startsWith('last') ? 7 : 0);
      return { matched: m[0].trim(), range: dayRange(now, back, m[0].trim()) };
    }
    if ((m = tryMatch(new RegExp(`\\b(?:on )?${DATE_TOKEN}`)))) {
      const token = m[0].replace(/^\s*on /, '');
      const d = parseAbsoluteDate(token, now);
      if (d) return { matched: m[0].trim(), range: makeRange(d, new Date(d.getTime() + DAY_MS), token.trim(), 'explicit') };
    }
    return null;
  }

  function inRange(value, range) {
    if (!range) return true;
    if (!value) return false;
    const t = toDate(value).getTime();
    return t >= Date.parse(range.start) && t < Date.parse(range.end);
  }

  function formatDuration(seconds) {
    if (seconds === undefined || seconds === null || Number.isNaN(seconds)) return 'unknown';
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  return {
    TZ_NAME,
    OFFSET_MS,
    istParts,
    istMidnight,
    startOfIstDay,
    formatIst,
    istDateKey,
    toIstIso,
    resolveDateRange,
    parseAbsoluteDate,
    inRange,
    formatDuration,
    dayRange,
    weekRange,
    monthRange,
    lastNDays,
  };
});
