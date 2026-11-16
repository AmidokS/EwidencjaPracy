'use strict';
/* Учёт работы — PWA. Создатель: Artur Alimhulov.
   Все данные хранятся только на телефоне (localStorage). */

const VERSION = '1.8.1';
const STORE_KEY = 'uchet-raboty-v1';

/* ===================== Дни ===================== */
const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
const ymd = (e) => { const t = new Date(e * DAY_MS); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const todayDay = () => { const n = new Date(); return dayOf(n.getFullYear(), n.getMonth() + 1, n.getDate()); };
const weekday = (e) => (new Date(e * DAY_MS).getUTCDay() + 6) % 7; // 0 = понедельник
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const iso = (e) => { const { y, m, d } = ymd(e); return `${y}-${pad(m)}-${pad(d)}`; };
const fromIso = (s) => { const [y, m, d] = s.split('-').map(Number); return dayOf(y, m, d); };
const shortD = (e) => { const { m, d } = ymd(e); return `${pad(d)}.${pad(m)}`; };
const fullD = (e) => { const { y, m, d } = ymd(e); return `${pad(d)}.${pad(m)}.${y}`; };
const monthIndexOf = (e) => { const { y, m } = ymd(e); return y * 12 + m - 1; };
const monthFirst = (mi) => dayOf(Math.floor(mi / 12), (mi % 12) + 1, 1);

/* Периоды выплаты: 1–15 и 16–конец месяца */
function payPeriod(e) {
  const { y, m, d } = ymd(e);
  return d <= 15
    ? { start: dayOf(y, m, 1), end: dayOf(y, m, 15) }
    : { start: dayOf(y, m, 16), end: dayOf(y, m, daysInMonth(y, m)) };
}
const isSecondHalf = (p) => ymd(p.start).d === 16;
const periodIndex = (p) => monthIndexOf(p.start) * 2 + (isSecondHalf(p) ? 1 : 0);
function periodFromIndex(i) {
  const mi = Math.floor(i / 2);
  return payPeriod(dayOf(Math.floor(mi / 12), (mi % 12) + 1, i % 2 === 0 ? 1 : 16));
}
function monthPeriod(mi) {
  const y = Math.floor(mi / 12), m = (mi % 12) + 1;
  return { start: dayOf(y, m, 1), end: dayOf(y, m, daysInMonth(y, m)) };
}
function daysOf(p) { const a = []; for (let e = p.start; e <= p.end; e++) a.push(e); return a; }

/* ===================== Данные ===================== */
const DEFAULTS = {
  entries: {},
  rates: { point: 2.9, machine: 35 },
  report: { points: true, machines: true, hours: false, polish: false },
  settings: { lang: 'ru', palette: 0, theme: 'system', header: '', reminders: true, reminderMinute: 480, onboarded: false },
  dismissed: {},
  installHidden: false,
  auth: { code: '', device: '', ok: false, name: '', reason: '', checkedAt: 0, lastOk: 0, expires: null, cfg: null },
  cloud: { on: false, at: 0, dirty: false },
  msgHidden: 0,
  reportHidden: 0,
};

let S = load();

function load() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { raw = null; }
  const s = JSON.parse(JSON.stringify(DEFAULTS));
  if (raw && typeof raw === 'object') {
    Object.assign(s.entries, raw.entries || {});
    Object.assign(s.rates, raw.rates || {});
    Object.assign(s.report, raw.report || {});
    Object.assign(s.settings, raw.settings || {});
    Object.assign(s.dismissed, raw.dismissed || {});
    Object.assign(s.auth, raw.auth || {});
    Object.assign(s.cloud, raw.cloud || {});
    s.installHidden = !!raw.installHidden;
    s.msgHidden = raw.msgHidden || 0;
    s.reportHidden = raw.reportHidden || 0;
  }
  // Обновление со старой версии: считаем последнюю проверку успешной, чтобы не закрыть приложение сразу
  if (s.auth.ok && !s.auth.lastOk) s.auth.lastOk = s.auth.checkedAt || Date.now();
  return s;
}

function save() {
  const old = todayDay() - 40;
  for (const k of Object.keys(S.dismissed)) if (fromIso(k) < old) delete S.dismissed[k];
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { toast(t('Не удалось сохранить', 'Nie udało się zapisać')); }
}

const blank = () => ({ points: 0, machines: 0, start: null, end: null, note: '' });
const entry = (e) => S.entries[iso(e)] || blank();
const worked = (x) => { if (x.start == null || x.end == null) return 0; let d = x.end - x.start; if (d < 0) d += 1440; return d; };
const isEmptyEntry = (x) => !x.points && !x.machines && x.start == null && x.end == null && !(x.note || '').trim();
const isWork = (x) => x.points > 0 || x.machines > 0 || worked(x) > 0;
const dayMoney = (x) => x.points * S.rates.point + x.machines * S.rates.machine;

function update(e, fn) {
  const k = iso(e);
  const before = entry(e);
  const x = { ...before };
  fn(x);
  if (x.note !== before.note) delete S.dismissed[k];
  if (isEmptyEntry(x)) delete S.entries[k]; else S.entries[k] = x;
  save();
  touched();
}

function summarize(p) {
  const s = { points: 0, machines: 0, minutes: 0, workDays: 0 };
  for (let e = p.start; e <= p.end; e++) {
    const x = S.entries[iso(e)];
    if (!x) continue;
    s.points += x.points; s.machines += x.machines; s.minutes += worked(x);
    if (isWork(x)) s.workDays++;
  }
  return s;
}
const sumMoney = (s) => s.points * S.rates.point + s.machines * S.rates.machine;

/* Точки платят каждые 2 недели, Жабку — раз в месяц (в выплате за 16–конец) */
function payout(p) {
  const s = summarize(p);
  const second = isSecondHalf(p);
  const machines = second ? summarize({ start: monthFirst(monthIndexOf(p.start)), end: p.end }).machines : s.machines;
  const pointsMoney = s.points * S.rates.point;
  const machinesMoney = machines * S.rates.machine;
  return { points: s.points, pointsMoney, machines, machinesMoney, paidNow: second, total: pointsMoney + (second ? machinesMoney : 0) };
}

/* ===================== Язык и формат ===================== */
const isPl = () => S.settings.lang === 'pl';
const t = (ru, pl) => (isPl() ? pl : ru);
const locale = () => (isPl() ? 'pl-PL' : 'ru-RU');

const MONTHS = { ru: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'],
  pl: ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień'] };
const MONTHS_GEN = { ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  pl: ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'] };
const DAYS = { ru: ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'],
  pl: ['Poniedziałek', 'Wtorek', 'Środa', 'Czwartek', 'Piątek', 'Sobota', 'Niedziela'] };
const DAYS_SHORT = { ru: ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'], pl: ['pn', 'wt', 'śr', 'czw', 'pt', 'sob', 'nd'] };

const L = (lang) => lang || S.settings.lang;
const num = (v, digits) => new Intl.NumberFormat(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
const money = (v) => `${num(v, 2)} zł`;
const rate = (v) => num(v, 2);
const clock = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const hoursShort = (m) => `${Math.floor(m / 60)}:${pad(m % 60)}`;
function hours(m) {
  const hu = t('ч', 'h'), mu = t('мин', 'min');
  const h = Math.floor(m / 60), r = m % 60;
  if (m <= 0) return `0 ${hu}`;
  if (r === 0) return `${h} ${hu}`;
  if (h === 0) return `${r} ${mu}`;
  return `${h} ${hu} ${r} ${mu}`;
}
const weekdayName = (e) => DAYS[L()][weekday(e)];
const weekdayShort = (e, lang) => DAYS_SHORT[L(lang)][weekday(e)];
const dayMonth = (e) => { const { m, d } = ymd(e); return `${d} ${MONTHS_GEN[L()][m - 1]}`; };
const monthTitle = (mi) => `${MONTHS[L()][mi % 12]} ${Math.floor(mi / 12)}`;
const periodTitle = (p) => `${ymd(p.start).d}–${ymd(p.end).d} ${MONTHS_GEN[L()][ymd(p.end).m - 1]}`;
const parseClock = (v) => { if (!v) return null; const [h, m] = v.split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ===================== Отчёт ===================== */
function buildReport(p) {
  const o = S.report, pl = o.polish, lang = pl ? 'pl' : 'ru';
  const lines = [];
  const head = (S.settings.header || '').trim();
  if (head) { lines.push(head, ''); }
  lines.push(`${pl ? 'Raport za' : 'Отчёт за'} ${shortD(p.start)}–${fullD(p.end)}`, '');
  for (const e of daysOf(p)) {
    const x = entry(e);
    const parts = [];
    if (o.points) parts.push(`${pl ? 'punkty' : 'точки'}: ${x.points}`);
    if (o.machines) parts.push(`${pl ? 'Żabka' : 'Жабка'}: ${x.machines}`);
    if (o.hours) parts.push(`${pl ? 'godziny' : 'часы'}: ${hoursShort(worked(x))}`);
    const w = (o.points && x.points > 0) || (o.machines && x.machines > 0) || (o.hours && worked(x) > 0);
    lines.push(`${shortD(e)} ${weekdayShort(e, lang)} — ${w ? parts.join(', ') : (pl ? 'wolne' : 'выходной')}`);
  }
  const s = summarize(p);
  lines.push('');
  if (o.points) lines.push(`${pl ? 'Razem punktów' : 'Итого точек'}: ${s.points}`);
  if (o.machines) {
    if (isSecondHalf(p)) {
      // Жабку платят раз в месяц — во втором отчёте считаем и первую половину
      const { y, m } = ymd(p.start);
      const endD = ymd(p.end).d;
      const first = summarize({ start: dayOf(y, m, 1), end: dayOf(y, m, 15) }).machines;
      const zh = pl ? 'Razem Żabka' : 'Итого Жабка';
      lines.push(`${zh} (1–15): ${first}`);
      lines.push(`${zh} (16–${endD}): ${s.machines}`);
      lines.push(`${pl ? 'Razem Żabka za miesiąc' : 'Итого Жабка за месяц'} (1–${endD}): ${first + s.machines}`);
    } else {
      lines.push(`${pl ? 'Razem Żabka' : 'Итого Жабка'}: ${s.machines}`);
    }
  }
  if (o.hours) lines.push(`${pl ? 'Razem godzin' : 'Итого часов'}: ${hoursShort(s.minutes)}`);
  return lines.join('\n').trim();
}

function buildCsv() {
  const head = t('Дата;Точки;Жабка;Начало;Конец;Часы;Сумма zł;Заметка', 'Data;Punkty;Żabka;Początek;Koniec;Godziny;Kwota zł;Notatka');
  const rows = Object.keys(S.entries).sort().map((k) => {
    const x = S.entries[k], e = fromIso(k);
    return [fullD(e), x.points, x.machines, x.start == null ? '' : clock(x.start), x.end == null ? '' : clock(x.end),
      hoursShort(worked(x)), rate(dayMoney(x)), `"${(x.note || '').replace(/"/g, '""')}"`].join(';');
  });
  return [head, ...rows].join('\n') + '\n';
}

/* ===================== Напоминания о заметках ===================== */
/* В PWA на iPhone нельзя запланировать уведомление без сервера,
   поэтому напоминание показывается баннером при открытии приложения после нужного времени. */
function reminderTime(e) {
  const { y, m, d } = ymd(e + 1);
  const mm = S.settings.reminderMinute;
  return new Date(y, m - 1, d, Math.floor(mm / 60), mm % 60).getTime();
}
function dueReminders() {
  if (!S.settings.reminders) return [];
  const now = Date.now(), from = todayDay() - 7;
  return Object.keys(S.entries)
    .filter((k) => {
      const e = fromIso(k), x = S.entries[k];
      return e >= from && (x.note || '').trim() && !S.dismissed[k] && reminderTime(e) <= now;
    })
    .sort()
    .map(fromIso);
}

/* ===================== Код доступа ===================== */
/* Каждый пользователь вводит свой личный код. Код привязывается к одному телефону.
   Владелец может отключить код — тогда при следующем запуске с интернетом приложение закроется. */
const AUTH_API = (window.AUTH_API || '').replace(/\/+$/, '');
const CHECK_EVERY = 10 * 60 * 1000;
const locked = () => !!AUTH_API && !S.auth.ok;
const prettyCode = (c) => (c && c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c || '');

function deviceId() {
  if (!S.auth.device) {
    S.auth.device = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    save();
  }
  return S.auth.device;
}

const platform = () => (isIOS() ? 'ios' : /Android/i.test(navigator.userAgent) ? 'web-android' : 'web');

async function api(path, data) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(AUTH_API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: platform(), version: VERSION, ...data }),
      signal: ctrl.signal,
      cache: 'no-store',
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function authMessage(reason) {
  switch (reason) {
    case 'invalid': return t('Неверный код. Проверь и попробуй ещё раз.', 'Nieprawidłowy kod. Sprawdź i spróbuj ponownie.');
    case 'disabled': return t('Доступ по этому коду отключён.', 'Dostęp dla tego kodu został wyłączony.');
    case 'other_device': return t('Этот код уже используется на другом телефоне.', 'Ten kod jest już używany na innym telefonie.');
    case 'unbound': return t('Код отвязан от этого телефона. Введи код ещё раз.', 'Kod został odłączony od tego telefonu. Wpisz kod ponownie.');
    case 'revoked': return t('Твой код больше не действует. Введи новый код.', 'Twój kod już nie działa. Wpisz nowy kod.');
    case 'expired': return t('Срок действия кода закончился.', 'Kod stracił ważność.');
    case 'too_many': return t('Слишком много неверных попыток. Попробуй через час.', 'Zbyt wiele błędnych prób. Spróbuj za godzinę.');
    case 'network': return t('Нет связи с сервером. Проверь интернет и попробуй ещё раз.', 'Brak połączenia z serwerem. Sprawdź internet i spróbuj ponownie.');
    case 'empty': return t('Введи код доступа.', 'Wpisz kod dostępu.');
    default: return '';
  }
}

/* Тихая проверка при запуске: если код отключили — закрываем приложение. Без интернета ничего не делаем. */
async function checkAccess(force) {
  if (!AUTH_API || !S.auth.ok || !S.auth.code) return;
  if (!force && Date.now() - (S.auth.checkedAt || 0) < CHECK_EVERY) return;
  try {
    const wasOffline = offlineLocked();
    const r = await api('/check', { code: S.auth.code, device: deviceId() });
    S.auth.checkedAt = Date.now();
    if (r && r.ok === false && ['invalid', 'disabled', 'other_device', 'unbound', 'expired'].includes(r.reason)) {
      S.auth.ok = false;
      S.auth.reason = r.reason === 'invalid' ? 'revoked' : r.reason;
      save();
      render();
    } else if (r && r.ok) {
      acceptServer(r);
      save();
      if (wasOffline) $sheet.innerHTML = '';
      render();
      cloudSync();
    }
  } catch (e) { /* нет интернета — работаем как обычно */ }
}

/** Запомнить ответ сервера: имя, срок кода, общие настройки (объявление, лимит без интернета). */
function acceptServer(r) {
  S.auth.lastOk = Date.now();
  if (r.name) S.auth.name = r.name;
  S.auth.expires = r.expires || null;
  if (r.cfg) S.auth.cfg = r.cfg;
}

/* Без связи с сервером дольше, чем разрешил владелец, — просим подключиться к интернету */
function offlineLocked() {
  if (!AUTH_API || !S.auth.ok) return false;
  const days = S.auth.cfg && S.auth.cfg.offlineDays;
  return !!days && !!S.auth.lastOk && Date.now() - S.auth.lastOk > days * DAY_MS;
}

/* ===================== Копия на сервере ===================== */
/* Включает сам пользователь в Настройках. Копия нужна, чтобы не потерять записи при смене телефона. */
function backupData() {
  const entries = Object.keys(S.entries).sort().map((date) => {
    const x = S.entries[date];
    const o = { date, points: x.points || 0, machines: x.machines || 0 };
    if (x.start != null) o.start = x.start;
    if (x.end != null) o.end = x.end;
    if ((x.note || '').trim()) o.note = x.note;
    return o;
  });
  return JSON.stringify({ v: 1, app: 'ewidencja', at: Date.now(), entries, rates: S.rates, header: S.settings.header || '' });
}

function restoreData(text) {
  const d = JSON.parse(text);
  if (!d || !Array.isArray(d.entries)) throw new Error('bad');
  for (const o of d.entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) continue;
    const x = { ...blank(), points: o.points || 0, machines: o.machines || 0, start: o.start ?? null, end: o.end ?? null, note: o.note || '' };
    if (isEmptyEntry(x)) delete S.entries[o.date]; else S.entries[o.date] = x;
  }
  if (d.rates && Number.isFinite(d.rates.point) && Number.isFinite(d.rates.machine)) S.rates = { point: d.rates.point, machine: d.rates.machine };
  if (d.header && !S.settings.header) S.settings.header = d.header;
  return d.entries.length;
}

let cloudTimer = null;
function touched() {
  if (!S.cloud.on) return;
  S.cloud.dirty = true;
  save();
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => cloudSync(), 60000);
}

async function cloudSync(force) {
  if (!AUTH_API || !S.auth.ok || !S.cloud.on || (!S.cloud.dirty && !force)) return false;
  if (cloudSync.busy) return false;
  cloudSync.busy = true;
  try {
    const r = await api('/backup/put', { code: S.auth.code, device: deviceId(), data: backupData() });
    if (r && r.ok && !r.skipped) { S.cloud.at = r.at; S.cloud.dirty = false; save(); if (ui.tab === 4) render(); return true; }
    if (r && r.skipped) { clearTimeout(cloudTimer); cloudTimer = setTimeout(() => cloudSync(), 70000); }
  } catch (e) { /* нет интернета — отправим позже */ } finally { cloudSync.busy = false; }
  return false;
}

async function cloudRestore(ask) {
  try {
    const r = await api('/backup/get', { code: S.auth.code, device: deviceId() });
    if (!r || !r.ok) { toast(t('На сервере нет копии', 'Brak kopii na serwerze')); return; }
    if (ask && !confirm(t(`Восстановить записи из копии от ${fullDate(r.at)}? Совпадающие дни будут заменены.`,
      `Przywrócić wpisy z kopii z ${fullDate(r.at)}? Pasujące dni zostaną zastąpione.`))) return;
    const n = restoreData(r.data);
    S.cloud = { on: true, at: r.at || Date.now(), dirty: false };
    save();
    render();
    toast(t(`Восстановлено дней: ${n}`, `Przywrócono dni: ${n}`));
  } catch (e) {
    toast(t('Нет связи с сервером', 'Brak połączenia z serwerem'));
  }
}

const fullDate = (ms) => { if (!ms) return '—'; const d = new Date(ms); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/* ===================== Тема ===================== */
const PALETTES = [
  { ru: 'Зелёный', pl: 'Zielony', h: 151, k: 1 },
  { ru: 'Бирюзовый', pl: 'Turkusowy', h: 178, k: 1 },
  { ru: 'Синий', pl: 'Niebieski', h: 214, k: 1 },
  { ru: 'Фиолетовый', pl: 'Fioletowy', h: 265, k: 1 },
  { ru: 'Розовый', pl: 'Różowy', h: 330, k: 1 },
  { ru: 'Красный', pl: 'Czerwony', h: 356, k: 1 },
  { ru: 'Оранжевый', pl: 'Pomarańczowy', h: 24, k: 1 },
  { ru: 'Графит', pl: 'Grafitowy', h: 220, k: 0.12 },
];
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');

function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

function applyTheme() {
  const p = PALETTES[S.settings.palette] || PALETTES[0];
  const root = document.documentElement;
  root.style.setProperty('--h', p.h);
  root.style.setProperty('--k', p.k);
  const dark = S.settings.theme === 'dark' || (S.settings.theme === 'system' && darkMq.matches);
  root.dataset.dark = dark ? '1' : '0';
  root.lang = S.settings.lang;
  const bg = dark ? hslHex(p.h, 12 * p.k, 7) : hslHex(p.h, 25 * p.k, 97.5);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', bg);
}

/* ===================== Иконки ===================== */
const ICONS = {
  chevL: '<path d="M15 18l-6-6 6-6"/>',
  chevR: '<path d="M9 18l6-6-6-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  chart: '<path d="M3 20h18M6 16v-5M11 16V6M16 16v-8"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  truck: '<path d="M2 7h12v9H2zM14 10h4l3 3v3h-7"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  store: '<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9h16v1.5a2.7 2.7 0 0 1-5.3 0 2.7 2.7 0 0 1-5.4 0A2.7 2.7 0 0 1 4 10.5z"/><path d="M5.5 13v7h13v-7M10 20v-4h4v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  note: '<path d="M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M9 10h6M9 14h6M9 18h3"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  money: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10.5" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  share: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  upload: '<path d="M12 15V3M7 8l5-5 5 5M5 21h14"/>',
  back: '<path d="M9 14l-5-5 5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
};
const ic = (name, size = 20) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

/* ===================== Общие куски разметки ===================== */
function navHead(title, sub, withDate) {
  const inner = `<div class="t1">${esc(title)}</div><div class="t2">${esc(sub)}</div>`;
  const label = withDate
    ? `<label class="nav-label">${inner}<input type="date" data-date value="${iso(ui.day)}" aria-label="${t('Выбрать дату', 'Wybierz datę')}"></label>`
    : `<div class="nav-label">${inner}</div>`;
  return `<div class="navhead">
    <button class="round" data-act="prev" aria-label="${t('Назад', 'Wstecz')}">${ic('chevL')}</button>
    ${label}
    <button class="round" data-act="next" aria-label="${t('Вперёд', 'Dalej')}">${ic('chevR')}</button>
  </div>`;
}

function card(icon, title, trailing, body) {
  const head = title
    ? `<div class="card-head">${icon ? `<span class="badge">${ic(icon, 18)}</span>` : ''}<h3>${title}</h3>${trailing || ''}</div>`
    : '';
  return `<section class="card">${head}${body}</section>`;
}

const tile = (label, value, sub) =>
  `<div class="tile"><div class="l">${label}</div><div class="v">${value}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;

/* ===================== Состояние экрана ===================== */
const ui = {
  tab: 0,
  day: todayDay(),
  month: monthIndexOf(todayDay()),
  period: periodIndex(payPeriod(todayDay())),
  stats: monthIndexOf(todayDay()),
  showReport: false,
};

const $screen = document.getElementById('screen');
const $tabs = document.getElementById('tabs');
const $top = document.getElementById('topbar');
const $sheet = document.getElementById('sheet-root');

/* ===================== Экран «День» ===================== */
function renderDay() {
  const d = ui.day, x = entry(d), td = todayDay();
  const rel = d === td ? t('Сегодня', 'Dziś') : d === td - 1 ? t('Вчера', 'Wczoraj') : d === td + 1 ? t('Завтра', 'Jutro') : String(ymd(d).y);
  const timeTile = (which, label, v) => `
    <label class="time-tile">
      <span class="lbl">${label}</span>
      <span class="tval ${v == null ? 'empty' : ''}" id="tv-${which}">${v == null ? '--:--' : clock(v)}</span>
      <input type="time" data-time="${which}" value="${v == null ? '' : clock(v)}" aria-label="${label}">
    </label>`;

  return `
    ${navHead(weekdayName(d), `${dayMonth(d)} · ${rel}`, true)}
    ${d !== td ? `<button class="chip-btn" data-act="today">${ic('back', 16)} ${t('Вернуться к сегодня', 'Wróć do dziś')}</button>` : ''}

    ${card('truck', t('Точки катеринга', 'Punkty cateringu'), `<span class="hint">× ${rate(S.rates.point)} zł</span>`,
      `<input class="num" data-field="points" inputmode="numeric" pattern="[0-9]*" placeholder="0" autocomplete="off" value="${x.points || ''}" aria-label="${t('Точки', 'Punkty')}">`)}

    ${card('store', t('Автоматы Жабки', 'Automaty Żabki'), `<span class="hint">× ${rate(S.rates.machine)} zł</span>`,
      `<div class="stepper">
        <button class="step" data-act="m-minus" aria-label="${t('Меньше', 'Mniej')}">${ic('minus', 22)}</button>
        <input class="num" data-field="machines" inputmode="numeric" pattern="[0-9]*" placeholder="0" autocomplete="off" value="${x.machines || ''}" aria-label="${t('Автоматы', 'Automaty')}">
        <button class="step" data-act="m-plus" aria-label="${t('Больше', 'Więcej')}">${ic('plus', 22)}</button>
      </div>`)}

    ${card('clock', t('Часы работы', 'Godziny pracy'), `<span id="hours-pill">${hoursPill(x)}</span>`,
      `<div class="times">${timeTile('start', t('Начало', 'Początek'), x.start)}${timeTile('end', t('Конец', 'Koniec'), x.end)}</div>
       <div class="right" id="clear-time" ${x.start == null && x.end == null ? 'hidden' : ''}>
         <button class="link" data-act="clear-time">${t('Сбросить время', 'Wyczyść godziny')}</button>
       </div>`)}

    ${card('note', t('Заметка', 'Notatka'), '',
      `<textarea class="field" data-field="note" rows="2" placeholder="${t('Например: не хватило пачки — написать мейл', 'Np. zabrakło paczki — wysłać maila')}">${esc(x.note)}</textarea>
       <div id="note-hint">${noteHint(d, x)}</div>`)}

    <div id="earn">${earnHtml(d)}</div>`;
}

const hoursPill = (x) => (worked(x) > 0 ? `<span class="pill">${hours(worked(x))}</span>` : '');

function noteHint(d, x) {
  if (!S.settings.reminders || !(x.note || '').trim()) return '';
  const at = reminderTime(d);
  if (at <= Date.now()) return '';
  return `<div class="remind-hint">${ic('bell', 18)}<span>${t('Напомню', 'Przypomnę')} ${shortD(d + 1)} ${t('после', 'po')} ${clock(S.settings.reminderMinute)}</span></div>`;
}

function earnHtml(d) {
  const x = entry(d), p = payPeriod(d), s = summarize(p), pay = payout(p);
  const zabka = pay.paidNow
    ? `${pay.machines} Ż ${t('за месяц', 'za miesiąc')}`
    : `${s.machines} Ż ${t('— в конце месяца', '— na koniec miesiąca')}`;
  return `<div class="hero">
    <div class="lbl2">${t('Заработок за день', 'Zarobek za dzień')}</div>
    <div class="big">${money(dayMoney(x))}</div>
    <div class="small">${x.points} × ${rate(S.rates.point)} + ${x.machines} × ${rate(S.rates.machine)}</div>
    <hr>
    <div class="row-between">
      <div><div class="small" style="font-weight:600">${t('К выплате за', 'Do wypłaty za')} ${periodTitle(p)}</div>
        <div class="small">${s.points} ${t('точек', 'pkt')} · ${zabka}</div></div>
      <div style="font-weight:700;font-size:17px;white-space:nowrap">${money(pay.total)}</div>
    </div>
  </div>`;
}

function refreshDay() {
  const x = entry(ui.day);
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  set('hours-pill', hoursPill(x));
  set('note-hint', noteHint(ui.day, x));
  set('earn', earnHtml(ui.day));
  const ct = document.getElementById('clear-time');
  if (ct) ct.hidden = x.start == null && x.end == null;
  for (const w of ['start', 'end']) {
    const v = x[w], tv = document.getElementById(`tv-${w}`);
    if (tv) { tv.textContent = v == null ? '--:--' : clock(v); tv.classList.toggle('empty', v == null); }
    const inp = document.querySelector(`[data-time="${w}"]`);
    if (inp && document.activeElement !== inp) inp.value = v == null ? '' : clock(v);
  }
}

/* ===================== Экран «Календарь» ===================== */
function renderCalendar() {
  const mi = ui.month, first = monthFirst(mi), { y, m } = ymd(first), n = daysInMonth(y, m), off = weekday(first), td = todayDay();
  const heads = DAYS_SHORT[L()].map((w, i) => `<span class="${i >= 5 ? 'we' : ''}">${w[0].toUpperCase() + w.slice(1)}</span>`).join('');
  let cells = '<span></span>'.repeat(off);
  for (let k = 0; k < n; k++) {
    const d = first + k, x = S.entries[iso(d)];
    const cls = ['cell'];
    if (x && isWork(x)) cls.push('work');
    if (d === td) cls.push('today');
    cells += `<button class="${cls.join(' ')}" data-act="open-day" data-day="${d}">
      <b>${k + 1}</b>
      ${x && x.points ? `<span class="cp">${x.points}</span>` : ''}
      ${x && x.machines ? `<span class="cm">Ż${x.machines}</span>` : ''}
      ${x && (x.note || '').trim() ? '<i class="dot"></i>' : ''}
    </button>`;
  }
  const halves = [{ start: first, end: dayOf(y, m, 15) }, { start: dayOf(y, m, 16), end: dayOf(y, m, n) }];
  const halfCards = halves.map((p) => {
    const s = summarize(p);
    return card('calendar', periodTitle(p), `<b style="color:var(--primary);white-space:nowrap">${money(sumMoney(s))}</b>`,
      `<p class="muted">${s.points} ${t('точек', 'punktów')} · ${s.machines} ${t('автоматов', 'automatów')} · ${hours(s.minutes)}</p>`);
  }).join('');

  return `
    ${navHead(monthTitle(mi), t('Нажми на день, чтобы изменить', 'Dotknij dnia, aby edytować'))}
    <div class="cal-wrap"><div class="cal-head">${heads}</div><div class="cal">${cells}</div></div>
    <div class="legend">
      <span><i style="background:var(--primary)"></i>${t('точки', 'punkty')}</span>
      <span><i style="background:var(--tertiary)"></i>${t('Жабка', 'Żabka')}</span>
      <span><i style="background:var(--error)"></i>${t('заметка', 'notatka')}</span>
    </div>
    ${halfCards}`;
}

/* ===================== Экран «Отчёт» ===================== */
function renderReport() {
  const p = periodFromIndex(ui.period), s = summarize(p), pay = payout(p), td = todayDay(), o = S.report;
  const report = buildReport(p);
  let progress = '';
  if (td >= p.start && td <= p.end) {
    const dayN = td - p.start + 1, size = p.end - p.start + 1, last = td === p.end;
    progress = `<div class="hero">
      <div style="font-size:20px;font-weight:700">${last ? t('Сегодня день отчёта', 'Dziś dzień raportu') : t(`День ${dayN} из ${size}`, `Dzień ${dayN} z ${size}`)}</div>
      <div style="height:8px;border-radius:4px;background:color-mix(in srgb, var(--on-pc) 15%, transparent);margin:6px 0 4px;overflow:hidden">
        <div style="height:100%;width:${(dayN / size) * 100}%;background:var(--primary);border-radius:4px"></div></div>
      <div class="small">${last ? t('Не забудь отправить отчёт ниже', 'Nie zapomnij wysłać raportu poniżej') : t(`До отчёта ${size - dayN} дн.`, `Do raportu ${size - dayN} dni`)}</div>
    </div>`;
  }
  const monthMachines = isSecondHalf(p) ? summarize({ start: monthFirst(monthIndexOf(p.start)), end: p.end }).machines : null;
  const endDay = daysInMonth(ymd(p.start).y, ymd(p.start).m);

  const payBody = `
    <div class="money-row"><span>${t('Точки', 'Punkty')} ${pay.points} × ${rate(S.rates.point)}</span><span>${money(pay.pointsMoney)}</span></div>
    ${pay.paidNow ? `<div class="money-row"><span>${t('Жабка за месяц', 'Żabka za miesiąc')} ${pay.machines} × ${rate(S.rates.machine)}</span><span>${money(pay.machinesMoney)}</span></div>` : ''}
    <div class="total"><span style="font-weight:650">${t('Всего', 'Razem')}</span><b>${money(pay.total)}</b></div>
    ${!pay.paidNow ? `<p class="muted small">${t(`Жабка оплачивается раз в месяц — войдёт в выплату за 16–${endDay}. Сейчас: ${pay.machines} авт. = ${money(pay.machinesMoney)}`,
      `Żabka jest płatna raz w miesiącu — wejdzie do wypłaty za 16–${endDay}. Teraz: ${pay.machines} aut. = ${money(pay.machinesMoney)}`)}</p>` : ''}
    ${s.minutes > 0 ? `<p class="muted small">${t('Заработано в час', 'Zarobek na godzinę')}: ≈ ${money(sumMoney(s) / (s.minutes / 60))}</p>` : ''}`;

  const chip = (act, k, label, on) => `<button class="chip ${on ? 'on' : ''}" data-act="${act}" data-k="${k}">${on ? ic('check', 14) : ''}${label}</button>`;
  const repBody = `
    <p class="muted">${t('Что включить', 'Co uwzględnić')}</p>
    <div class="chips">
      ${chip('rep', 'points', t('Точки', 'Punkty'), o.points)}
      ${chip('rep', 'machines', t('Жабка', 'Żabka'), o.machines)}
      ${chip('rep', 'hours', t('Часы', 'Godziny'), o.hours)}
    </div>
    <p class="muted">${t('Язык отчёта', 'Język raportu')}</p>
    <div class="chips">
      ${chip('rep-lang', 'ru', 'Русский', !o.polish)}
      ${chip('rep-lang', 'pl', 'Polski', o.polish)}
    </div>
    <div class="btn-row">
      <button class="btn primary" data-act="share-report">${ic('share', 18)} ${t('Отправить', 'Wyślij')}</button>
      <button class="btn tonal" data-act="copy-report">${ic('copy', 18)} ${t('Копировать', 'Kopiuj')}</button>
    </div>
    ${!(S.settings.header || '').trim() ? `<p class="muted small">${t('Шапка отчёта пустая — впиши её в Настройках.', 'Nagłówek raportu jest pusty — uzupełnij go w Ustawieniach.')}</p>` : ''}
    <div><button class="link" data-act="toggle-report">${ui.showReport ? t('Скрыть текст отчёта', 'Ukryj tekst raportu') : t('Показать текст отчёта', 'Pokaż tekst raportu')}</button></div>
    ${ui.showReport ? `<pre class="mono">${esc(report)}</pre>` : ''}`;

  const rows = daysOf(p).map((e) => {
    const x = entry(e), dash = '<span class="dash">—</span>';
    return `<button class="trow ${e === td ? 'today' : ''}" data-act="open-day" data-day="${e}">
      <span>${shortD(e)} ${weekdayShort(e)}</span>
      <span>${x.points || dash}</span><span>${x.machines || dash}</span><span>${worked(x) ? hoursShort(worked(x)) : dash}</span>
    </button>`;
  }).join('');
  const daysBody = `
    <div>
      <div class="trow head"><span>${t('Дата', 'Data')}</span><span>${t('Точки', 'Punkty')}</span><span>${t('Жабка', 'Żabka')}</span><span>${t('Часы', 'Godziny')}</span></div>
      ${rows}
    </div>
    <p style="margin:0;font-weight:650;font-size:15px">${t('Итого', 'Razem')}: ${s.points} ${t('точек', 'punktów')}, ${s.machines} ${t('автоматов', 'automatów')}, ${hours(s.minutes)}</p>`;

  return `
    ${navHead(periodTitle(p), `${t('Период выплаты', 'Okres rozliczeniowy')} · ${ymd(p.end).y}`)}
    ${progress}
    <div class="tiles">
      ${tile(t('Точек', 'Punktów'), s.points)}
      ${tile(t('Автоматов', 'Automatów'), s.machines, monthMachines != null ? `${t('за месяц', 'za miesiąc')}: ${monthMachines}` : '')}
      ${tile(t('Часов', 'Godzin'), hoursShort(s.minutes))}
      ${tile(t('Рабочих дней', 'Dni pracy'), s.workDays)}
    </div>
    ${card('money', t('К оплате', 'Do wypłaty'), '', payBody)}
    ${card('doc', t('Отчёт', 'Raport'), '', repBody)}
    ${card('list', t('По дням', 'Dzień po dniu'), '', daysBody)}`;
}

/* ===================== Экран «Итоги» ===================== */
function bars(vals, color, h) {
  const n = vals.length, max = Math.max(1, ...vals), W = 310, slot = W / n, bw = slot * 0.62;
  let s = '';
  vals.forEach((v, i) => {
    const x = (i * slot + (slot - bw) / 2).toFixed(2);
    s += `<rect x="${x}" y="0" width="${bw.toFixed(2)}" height="${h}" rx="${(bw / 2).toFixed(2)}" fill="var(--card-hi)"/>`;
    if (v > 0) {
      const bh = Math.max(bw, (h * v) / max);
      s += `<rect x="${x}" y="${(h - bh).toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" rx="${(bw / 2).toFixed(2)}" fill="${color}"/>`;
    }
  });
  return `<svg class="bars" viewBox="0 0 ${W} ${h}" role="img">${s}</svg>
    <div class="axis"><span>1</span><span>15</span><span>${n}</span></div>`;
}

function renderStats() {
  const mi = ui.stats, p = monthPeriod(mi), s = summarize(p), prev = summarize(monthPeriod(mi - 1));
  const m = sumMoney(s), pm = sumMoney(prev);
  const days = daysOf(p);
  const pts = days.map((e) => entry(e).points), mach = days.map((e) => entry(e).machines);
  const avgP = s.workDays ? s.points / s.workDays : 0, avgMin = s.workDays ? Math.round(s.minutes / s.workDays) : 0;
  const bestV = Math.max(0, ...pts), bestI = pts.indexOf(bestV);
  const pct = pm > 0 ? Math.round(((m - pm) / pm) * 100) : null;

  return `
    ${navHead(monthTitle(mi), t('Итоги месяца', 'Podsumowanie miesiąca'))}
    <div class="hero">
      <div class="lbl2">${t('Доход за месяц', 'Dochód za miesiąc')}</div>
      <div class="big">${money(m)}</div>
      ${pct != null ? `<div class="small">${t('Прошлый месяц', 'Poprzedni miesiąc')}: ${money(pm)} (${pct >= 0 ? '+' : ''}${pct}%)</div>` : ''}
    </div>
    <div class="tiles">
      ${tile(t('Точек', 'Punktów'), s.points, money(s.points * S.rates.point))}
      ${tile(t('Автоматов', 'Automatów'), s.machines, money(s.machines * S.rates.machine))}
      ${tile(t('Рабочих дней', 'Dni pracy'), s.workDays)}
      ${tile(t('Точек в день', 'Punktów dziennie'), num(avgP, 1))}
      ${tile(t('Часов', 'Godzin'), hours(s.minutes), avgMin ? `≈ ${hours(avgMin)} ${t('в день', 'dziennie')}` : '')}
      ${tile(t('В час', 'Na godzinę'), s.minutes ? money(m / (s.minutes / 60)) : '—')}
    </div>
    ${card('chart', t('Точки по дням', 'Punkty dziennie'), '',
      bars(pts, 'var(--primary)', 130) +
      (bestV > 0 ? `<p class="muted">${t('Лучший день', 'Najlepszy dzień')}: ${shortD(days[bestI])} — ${bestV}</p>` : ''))}
    ${card('store', t('Жабка по дням', 'Żabka dziennie'), '', bars(mach, 'var(--tertiary)', 90))}`;
}

/* ===================== Экран «Настройки» ===================== */
function renderSettings() {
  const st = S.settings, pal = PALETTES[st.palette] || PALETTES[0];
  const seg = (act, val, label, on) => `<button class="${on ? 'on' : ''}" data-act="${act}" data-v="${val}">${label}</button>`;
  const swatches = PALETTES.map((p, i) =>
    `<button class="swatch ${i === st.palette ? 'on' : ''}" data-act="palette" data-v="${i}" style="background:${hslHex(p.h, 62 * p.k, 42)}" aria-label="${isPl() ? p.pl : p.ru}">${i === st.palette ? ic('check', 22) : ''}</button>`).join('');

  return `
    <h1 class="page-title">${t('Настройки', 'Ustawienia')}</h1>
    ${installCard()}
    ${card('globe', t('Язык приложения', 'Język aplikacji'), '',
      `<div class="seg">${seg('lang', 'ru', 'Русский', st.lang === 'ru')}${seg('lang', 'pl', 'Polski', st.lang === 'pl')}</div>`)}
    ${card('palette', t('Оформление', 'Wygląd'), '',
      `<p class="muted">${t('Цвет', 'Kolor')}: ${isPl() ? pal.pl : pal.ru}</p>
       <div class="swatches">${swatches}</div>
       <p class="muted">${t('Тема', 'Motyw')}</p>
       <div class="seg">${seg('theme', 'system', t('Как в системе', 'Systemowy'), st.theme === 'system')}${seg('theme', 'light', t('Светлая', 'Jasny'), st.theme === 'light')}${seg('theme', 'dark', t('Тёмная', 'Ciemny'), st.theme === 'dark')}</div>`)}
    ${card('doc', t('Шапка отчёта', 'Nagłówek raportu'), '',
      `<textarea class="field" data-field="header" rows="3" placeholder="${t('Имя Фамилия&#10;Код&#10;Номер', 'Imię Nazwisko&#10;Kod&#10;Numer')}">${esc(st.header)}</textarea>
       <p class="muted small">${t('Эти строки стоят в начале каждого отчёта.', 'Te linie są na początku każdego raportu.')}</p>`)}
    ${card('bell', t('Напоминание о заметках', 'Przypomnienie o notatkach'),
      `<label class="switch"><input type="checkbox" data-check="reminders" ${st.reminders ? 'checked' : ''} aria-label="${t('Напоминания', 'Przypomnienia')}"><span></span></label>`,
      `<p class="muted">${t('Если в заметке за день что-то записано, на следующий день после выбранного времени при открытии приложения появится напоминание с её текстом.',
        'Jeśli w notatce z danego dnia coś jest, następnego dnia po wybranej godzinie po otwarciu aplikacji pojawi się przypomnienie z jej treścią.')}</p>
       <div class="row-between"><span>${t('Время напоминания', 'Godzina przypomnienia')}</span>
         <label class="time-btn">${clock(st.reminderMinute)}<input type="time" data-reminder-time value="${clock(st.reminderMinute)}" ${st.reminders ? '' : 'disabled'}></label></div>`)}
    ${card('money', t('Ставки', 'Stawki'), '',
      `<label class="lbl">${t('За 1 точку, zł', 'Za 1 punkt, zł')}</label>
       <input class="field" data-field="rate-point" inputmode="decimal" value="${rate(S.rates.point)}">
       <label class="lbl">${t('За 1 автомат Жабки, zł', 'Za 1 automat Żabki, zł')}</label>
       <input class="field" data-field="rate-machine" inputmode="decimal" value="${rate(S.rates.machine)}">`)}
    <div class="footer">
      <div class="c1">${t('Создатель', 'Twórca')}</div>
      <div class="c2">Artur Alimhulov</div>
      <div class="c3">${t('Версия', 'Wersja')} ${VERSION}</div>
      ${AUTH_API && S.auth.code ? `<div class="c3">${t('Код доступа', 'Kod dostępu')}: ${prettyCode(S.auth.code)}${S.auth.name ? ` · ${esc(S.auth.name)}` : ''}</div>` : ''}
      ${AUTH_API && S.auth.expires ? `<div class="c3">${t('Код действует до', 'Kod ważny do')} ${fullDate(S.auth.expires).slice(0, 10)}</div>` : ''}
    </div>`;
}

/* ===================== Установка на экран ===================== */
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; renderTop(); if (ui.tab === 4) render(); });

function installText() {
  if (isIOS()) return t('В Safari нажми «•••» (или значок «Поделиться») → «Поделиться» → пролистай вниз → «На экран „Домой“» → «Добавить». Появится иконка, и приложение будет работать как обычное.',
    'W Safari stuknij „•••” (lub ikonę „Udostępnij”) → „Udostępnij” → przewiń w dół → „Do ekranu początkowego” → „Dodaj”. Pojawi się ikona i aplikacja będzie działać jak zwykła.');
  if (installEvent) return t('Установи приложение на главный экран — оно будет работать без интернета.', 'Zainstaluj aplikację na ekranie głównym — będzie działać bez internetu.');
  return t('Меню браузера (⋮) → «Установить приложение» или «Добавить на главный экран».', 'Menu przeglądarki (⋮) → „Zainstaluj aplikację” lub „Dodaj do ekranu głównego”.');
}

function installCard() {
  if (isStandalone()) return '';
  return card('download', t('Установить на телефон', 'Zainstaluj na telefonie'), '',
    `<p class="muted">${installText()}</p>${installEvent ? `<button class="btn primary" data-act="install">${t('Установить', 'Zainstaluj')}</button>` : ''}`);
}

/* ===================== Верхние баннеры ===================== */
function renderTop() {
  let html = '';
  if (!isStandalone() && !S.installHidden && ui.tab !== 4) {
    html += `<div class="banner install">${ic('download', 20)}<div class="bt"><b>${t('Установи приложение', 'Zainstaluj aplikację')}</b><p>${installText()}</p></div>
      ${installEvent ? `<button data-act="install">${t('Установить', 'Zainstaluj')}</button>` : ''}
      <button class="x" data-act="hide-install" aria-label="${t('Закрыть', 'Zamknij')}">${ic('x', 18)}</button></div>`;
  }
  const msg = AUTH_API && S.auth.ok && S.auth.cfg && S.auth.cfg.msg;
  if (msg && msg.text && msg.id !== S.msgHidden) {
    html += `<div class="banner">${ic('bell', 20)}<div class="bt"><b>${t('Объявление', 'Ogłoszenie')}</b><p>${esc(msg.text)}</p></div>
      <button class="x" data-act="hide-msg" data-id="${msg.id}" aria-label="${t('Закрыть', 'Zamknij')}">${ic('x', 18)}</button></div>`;
  }
  if (AUTH_API && S.auth.ok && S.auth.expires) {
    const left = Math.ceil((S.auth.expires - Date.now()) / DAY_MS);
    if (left >= 0 && left <= 3) {
      html += `<div class="banner">${ic('bell', 20)}<div class="bt"><b>${t('Код скоро закончится', 'Kod wkrótce wygaśnie')}</b><p>${t('Действует до', 'Ważny do')} ${fullDate(S.auth.expires).slice(0, 10)}</p></div></div>`;
    }
  }
  // 15-го и в последний день месяца — напоминание отправить отчёт
  const td = todayDay(), cur = payPeriod(td);
  if (cur.end === td && S.reportHidden !== td) {
    html += `<div class="banner">${ic('bell', 20)}<div class="bt"><b>${t('Сегодня конец периода', 'Dziś koniec okresu')} ${periodTitle(cur)}</b><p>${t('Не забудь отправить отчёт.', 'Nie zapomnij wysłać raportu.')}</p></div>
      <button data-act="open-report">${t('Отчёт', 'Raport')}</button>
      <button class="x" data-act="hide-report" aria-label="${t('Закрыть', 'Zamknij')}">${ic('x', 18)}</button></div>`;
  }
  for (const d of dueReminders()) {
    const x = entry(d);
    html += `<div class="banner">${ic('bell', 20)}<div class="bt"><b>${t('Заметка за', 'Notatka z')} ${shortD(d)}</b><p>${esc(x.note)}</p></div>
      <button data-act="dismiss" data-day="${d}">${t('Готово', 'Gotowe')}</button></div>`;
  }
  $top.innerHTML = html;
  const count = dueReminders().length;
  try {
    if (count && navigator.setAppBadge) navigator.setAppBadge(count);
    else if (navigator.clearAppBadge) navigator.clearAppBadge();
  } catch (e) { /* не поддерживается */ }
}

/* ===================== Окно приветствия ===================== */
function renderLock() {
  const st = S.settings;
  const hasData = Object.keys(S.entries).length > 0;
  const msg = authMessage(S.auth.reason);
  $sheet.innerHTML = `<div class="lock"><div class="lock-box">
    <img class="logo" src="icons/icon-192.png" alt="">
    <h2>${t('Учёт работы', 'Ewidencja pracy')}</h2>
    <p class="muted">${t('Приложение работает по личному коду доступа. Введи код, который тебе дали.',
      'Aplikacja działa na osobisty kod dostępu. Wpisz kod, który otrzymałeś.')}</p>
    <div class="seg"><button class="${st.lang === 'ru' ? 'on' : ''}" data-act="lang" data-v="ru">Русский</button><button class="${st.lang === 'pl' ? 'on' : ''}" data-act="lang" data-v="pl">Polski</button></div>
    <input class="field code-input" id="lock-code" placeholder="••••" inputmode="numeric" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="9" aria-label="${t('Код доступа', 'Kod dostępu')}">
    <p class="lock-err" id="lock-err">${esc(msg)}</p>
    <button class="btn primary" data-act="activate" id="lock-btn">${t('Войти', 'Wejdź')}</button>
    ${hasData ? `<button class="link" data-act="backup">${ic('download', 16)} ${t('Сохранить мои записи', 'Zapisz moje wpisy')}</button>` : ''}
    <div class="footer"><div class="c1">${t('Создатель', 'Twórca')}</div><div class="c2">Artur Alimhulov</div></div>
  </div></div>`;
}

function renderSheet() {
  if (locked()) {
    // Не перерисовываем экран кода, пока человек печатает
    if (!document.getElementById('lock-code')) renderLock();
    return;
  }
  if (offlineLocked()) {
    if (document.getElementById('offline-box')) return;
    $sheet.innerHTML = `<div class="lock"><div class="lock-box" id="offline-box">
      <img class="logo" src="icons/icon-192.png" alt="">
      <h2>${t('Нужен интернет', 'Potrzebny internet')}</h2>
      <p class="muted">${t('Приложение давно не связывалось с сервером. Включи интернет и нажми «Проверить» — все записи на месте.',
        'Aplikacja dawno nie łączyła się z serwerem. Włącz internet i naciśnij „Sprawdź” — wszystkie wpisy są na miejscu.')}</p>
      <button class="btn primary" data-act="offline-retry">${t('Проверить', 'Sprawdź')}</button>
      <button class="link" data-act="backup">${ic('download', 16)} ${t('Сохранить мои записи', 'Zapisz moje wpisy')}</button>
    </div></div>`;
    return;
  }
  if (S.settings.onboarded) { $sheet.innerHTML = ''; return; }
  const st = S.settings;
  $sheet.innerHTML = `<div class="sheet-bg"><div class="sheet">
    <img class="logo" src="icons/icon-192.png" alt="">
    <h2>${t('Учёт работы', 'Ewidencja pracy')}</h2>
    <p class="muted">${t('Точки катеринга, автоматы Жабки, часы и готовый отчёт за 15 дней. Все данные хранятся только на твоём телефоне.',
      'Punkty cateringu, automaty Żabki, godziny i gotowy raport za 15 dni. Wszystkie dane są tylko w Twoim telefonie.')}</p>
    <div class="seg"><button class="${st.lang === 'ru' ? 'on' : ''}" data-act="lang" data-v="ru">Русский</button><button class="${st.lang === 'pl' ? 'on' : ''}" data-act="lang" data-v="pl">Polski</button></div>
    <label class="lbl">${t('Шапка отчёта — будет в начале каждого отчёта', 'Nagłówek raportu — będzie na początku każdego raportu')}</label>
    <textarea class="field" data-field="header" rows="3" placeholder="${t('Имя Фамилия&#10;Код&#10;Номер', 'Imię Nazwisko&#10;Kod&#10;Numer')}">${esc(st.header)}</textarea>
    <p class="muted small">${t('Можно заполнить позже в Настройках.', 'Możesz uzupełnić później w Ustawieniach.')}</p>
    <button class="btn primary" data-act="start">${t('Начать', 'Zaczynamy')}</button>
  </div></div>`;
}

/* ===================== Рендер ===================== */
const TABS = [
  { icon: 'sun', ru: 'День', pl: 'Dzień', render: renderDay },
  { icon: 'calendar', ru: 'Календарь', pl: 'Kalendarz', render: renderCalendar },
  { icon: 'doc', ru: 'Отчёт', pl: 'Raport', render: renderReport },
  { icon: 'chart', ru: 'Итоги', pl: 'Wyniki', render: renderStats },
  { icon: 'sliders', ru: 'Настройки', pl: 'Ustawienia', render: renderSettings },
];

function renderTabs() {
  $tabs.innerHTML = TABS.map((tb, i) =>
    `<button class="tab ${i === ui.tab ? 'on' : ''}" data-act="tab" data-v="${i}"><span class="ib">${ic(tb.icon, 22)}</span><span>${t(tb.ru, tb.pl)}</span></button>`).join('');
}

function render(resetScroll) {
  applyTheme();
  renderTabs();
  renderTop();
  const scroll = $screen.scrollTop;
  $screen.innerHTML = `<div class="page">${TABS[ui.tab].render()}</div>`;
  $screen.scrollTop = resetScroll ? 0 : scroll;
  renderSheet();
}

/* Листание: анимация ухода старой страницы и прихода новой */
function shift(delta) {
  if (ui.tab === 0) ui.day += delta;
  else if (ui.tab === 1) ui.month += delta;
  else if (ui.tab === 2) ui.period += delta;
  else if (ui.tab === 3) ui.stats += delta;
}

let animating = false;
function navigate(delta) {
  if (animating) return;
  animating = true;
  const w = $screen.clientWidth;
  const pg = $screen.firstElementChild;
  pg.style.transition = 'transform .15s ease-in, opacity .15s';
  pg.style.transform = `translateX(${-delta * w * 0.3}px)`;
  pg.style.opacity = '0';
  setTimeout(() => {
    shift(delta);
    render(true);
    const np = $screen.firstElementChild;
    np.style.transition = 'none';
    np.style.transform = `translateX(${delta * w * 0.3}px)`;
    np.style.opacity = '0';
    np.getBoundingClientRect();
    np.style.transition = 'transform .2s ease-out, opacity .2s';
    np.style.transform = 'none';
    np.style.opacity = '1';
    setTimeout(() => { animating = false; }, 200);
  }, 140);
}

/* ===================== Свайпы ===================== */
let drag = null;
$screen.addEventListener('touchstart', (ev) => {
  if (ui.tab > 3 || ev.touches.length !== 1 || animating) return;
  const tch = ev.touches[0];
  drag = { x: tch.clientX, y: tch.clientY, dx: 0, lock: null };
}, { passive: true });

$screen.addEventListener('touchmove', (ev) => {
  if (!drag) return;
  const tch = ev.touches[0];
  const dx = tch.clientX - drag.x, dy = tch.clientY - drag.y;
  if (!drag.lock && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
    drag.lock = Math.abs(dx) > Math.abs(dy) * 1.3 ? 'x' : 'y';
    if (drag.lock === 'x' && document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }
  if (drag.lock === 'x') {
    ev.preventDefault();
    drag.dx = dx;
    const pg = $screen.firstElementChild;
    pg.style.transition = 'none';
    pg.style.transform = `translateX(${dx}px)`;
    pg.style.opacity = String(1 - Math.min(Math.abs(dx) / 700, 0.35));
  }
}, { passive: false });

function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.lock !== 'x') return;
  if (Math.abs(d.dx) > 70) {
    navigate(d.dx < 0 ? 1 : -1);
  } else {
    const pg = $screen.firstElementChild;
    pg.style.transition = 'transform .2s ease-out, opacity .2s';
    pg.style.transform = 'none';
    pg.style.opacity = '1';
  }
}
$screen.addEventListener('touchend', endDrag);
$screen.addEventListener('touchcancel', endDrag);

/* ===================== Действия ===================== */
let toastTimer = null;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
    return ok;
  }
}

async function shareText(text) {
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  if (await copyText(text)) toast(t('Отчёт скопирован', 'Raport skopiowany'));
}

async function shareFile(name, content, type) {
  const file = new File([content], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

const stamp = () => iso(todayDay());

const actions = {
  tab(el) { const v = Number(el.dataset.v); if (v !== ui.tab) { ui.tab = v; if (v === 0) ui.day = ui.day; render(true); } else if (v === 0 && ui.day !== todayDay()) { ui.day = todayDay(); render(true); } },
  prev() { navigate(-1); },
  next() { navigate(1); },
  today() { ui.day = todayDay(); render(true); },
  'open-day'(el) { ui.day = Number(el.dataset.day); ui.tab = 0; render(true); },
  'm-minus'() { update(ui.day, (x) => { x.machines = Math.max(0, x.machines - 1); }); syncNum('machines'); refreshDay(); },
  'm-plus'() { update(ui.day, (x) => { x.machines += 1; }); syncNum('machines'); refreshDay(); },
  'clear-time'() { update(ui.day, (x) => { x.start = null; x.end = null; }); refreshDay(); },
  rep(el) {
    const k = el.dataset.k, o = S.report;
    const others = ['points', 'machines', 'hours'].filter((n) => n !== k).some((n) => o[n]);
    if (o[k] && !others) return; // хотя бы один пункт должен остаться
    o[k] = !o[k]; save(); render();
  },
  'rep-lang'(el) { S.report.polish = el.dataset.k === 'pl'; save(); render(); },
  'share-report'() { shareText(buildReport(periodFromIndex(ui.period))); },
  async 'copy-report'() { if (await copyText(buildReport(periodFromIndex(ui.period)))) toast(t('Отчёт скопирован', 'Raport skopiowany')); },
  'toggle-report'() { ui.showReport = !ui.showReport; render(); },
  lang(el) { S.settings.lang = el.dataset.v; save(); if (locked()) $sheet.innerHTML = ''; render(); },
  async activate() {
    const inp = document.getElementById('lock-code');
    const err = document.getElementById('lock-err');
    const btn = document.getElementById('lock-btn');
    if (btn.disabled) return; // уже проверяем
    const code = (inp.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) { err.textContent = authMessage('empty'); return; }
    btn.disabled = true;
    err.textContent = '';
    try {
      const r = await api('/activate', { code, device: deviceId() });
      if (r && r.ok) {
        S.auth = { ...S.auth, code, ok: true, name: r.name || '', reason: '', checkedAt: Date.now() };
        acceptServer(r);
        save();
        $sheet.innerHTML = '';
        render();
        toast(`${t('Добро пожаловать', 'Witaj')}${r.name ? `, ${r.name}` : ''}!`);
        return;
      }
      err.textContent = authMessage((r && r.reason) || 'invalid');
    } catch (e) {
      err.textContent = authMessage('network');
    }
    btn.disabled = false;
  },
  palette(el) { S.settings.palette = Number(el.dataset.v); save(); render(); },
  theme(el) { S.settings.theme = el.dataset.v; save(); render(); },
  start() { S.settings.onboarded = true; save(); render(); },
  dismiss(el) { S.dismissed[iso(Number(el.dataset.day))] = true; save(); renderTop(); },
  'hide-install'() { S.installHidden = true; save(); renderTop(); },
  async install() { if (!installEvent) return; installEvent.prompt(); try { await installEvent.userChoice; } catch (e) { /* ignore */ } installEvent = null; render(); },
  'open-report'() { ui.tab = 2; ui.period = periodIndex(payPeriod(todayDay())); render(true); },
  'hide-report'() { S.reportHidden = todayDay(); save(); renderTop(); },
  'hide-msg'(el) { S.msgHidden = Number(el.dataset.id); save(); renderTop(); },
  async 'offline-retry'(el) {
    el.disabled = true;
    await checkAccess(true);
    if (offlineLocked()) { el.disabled = false; toast(t('Нет связи с сервером', 'Brak połączenia z serwerem')); }
  },
  async 'cloud-now'() { if (await cloudSync(true)) toast(t('Копия сохранена', 'Kopia zapisana')); else toast(t('Не получилось. Проверь интернет или попробуй через минуту.', 'Nie udało się. Sprawdź internet lub spróbuj za minutę.')); },
  'cloud-restore'() { cloudRestore(true); },
  backup() { shareFile(`uchet-raboty-${stamp()}.json`, JSON.stringify({ app: 'uchet-raboty', version: VERSION, ...S }, null, 1), 'application/json'); },
  'export-csv'() { shareFile(`uchet-raboty-${stamp()}.csv`, '﻿' + buildCsv(), 'text/csv'); },
};

function syncNum(field) {
  const inp = document.querySelector(`[data-field="${field}"]`);
  if (inp) { const v = entry(ui.day)[field]; inp.value = v || ''; }
}

const fields = {
  points(el) { const v = el.value.replace(/\D/g, '').slice(0, 4); if (v !== el.value) el.value = v; update(ui.day, (x) => { x.points = Number(v) || 0; }); refreshDay(); },
  machines(el) { const v = el.value.replace(/\D/g, '').slice(0, 3); if (v !== el.value) el.value = v; update(ui.day, (x) => { x.machines = Number(v) || 0; }); refreshDay(); },
  note(el) { update(ui.day, (x) => { x.note = el.value; }); refreshDay(); renderTop(); },
  header(el) { S.settings.header = el.value; save(); touched(); },
  'rate-point'(el) { const v = parseFloat(el.value.replace(',', '.')); if (Number.isFinite(v) && v >= 0) { S.rates.point = v; save(); touched(); } },
  'rate-machine'(el) { const v = parseFloat(el.value.replace(',', '.')); if (Number.isFinite(v) && v >= 0) { S.rates.machine = v; save(); touched(); } },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) { ev.preventDefault(); fn(el); }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.id === 'lock-code') { ev.preventDefault(); actions.activate(); }
});

document.addEventListener('input', (ev) => {
  if (ev.target.id === 'lock-code') {
    // Новые коды — 4 цифры; старые 8-символьные тоже принимаются (формат XXXX-XXXX)
    const raw = ev.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    ev.target.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
    // 4 цифры введены — входим сразу
    if (/^\d{4}$/.test(raw) && ev.inputType !== 'deleteContentBackward') actions.activate();
    return;
  }
});

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.dataset.field && fields[el.dataset.field]) fields[el.dataset.field](el);
  if (el.dataset.time !== undefined) onTime(el);
});

document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset.time !== undefined) onTime(el);
  if (el.dataset.date !== undefined && el.value) { ui.day = fromIso(el.value); render(true); }
  if (el.dataset.check === 'reminders') { S.settings.reminders = el.checked; save(); render(); }
  if (el.dataset.check === 'cloud') {
    if (el.checked) {
      S.cloud.on = true; S.cloud.dirty = true; save(); render();
      cloudSync(true).then((ok) => { if (ok) toast(t('Копия сохранена', 'Kopia zapisana')); });
    } else {
      if (!confirm(t('Выключить копию на сервере? Копия с сервера будет удалена.', 'Wyłączyć kopię na serwerze? Kopia zostanie usunięta z serwera.'))) { el.checked = true; return; }
      S.cloud = { on: false, at: 0, dirty: false }; save(); render();
      api('/backup/delete', { code: S.auth.code, device: deviceId() }).catch(() => {});
    }
  }
  if (el.dataset.reminderTime !== undefined) {
    const m = parseClock(el.value);
    if (m != null) { S.settings.reminderMinute = m; save(); render(); }
  }
  if (el.dataset.import !== undefined && el.files && el.files[0]) importFile(el.files[0]).finally(() => { el.value = ''; });
  if (el.dataset.field === 'rate-point' || el.dataset.field === 'rate-machine') render();
});

function onTime(el) {
  const which = el.dataset.time;
  const m = parseClock(el.value);
  update(ui.day, (x) => { x[which] = m; });
  refreshDay();
}

/* ===================== Импорт ===================== */
function parseCsv(text) {
  const out = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  for (const line of lines.slice(1)) {
    const cols = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
      } else if (c === '"') q = true;
      else if (c === ';') { cols.push(cur); cur = ''; } else cur += c;
    }
    cols.push(cur);
    const dm = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec((cols[0] || '').trim());
    if (!dm) continue;
    out.push({
      key: iso(dayOf(+dm[3], +dm[2], +dm[1])),
      x: { points: parseInt(cols[1], 10) || 0, machines: parseInt(cols[2], 10) || 0, start: parseClock((cols[3] || '').trim()), end: parseClock((cols[4] || '').trim()), note: cols[7] || '' },
    });
  }
  return out;
}

async function importFile(file) {
  const text = await file.text();
  let list = [], full = null;
  try {
    if (text.trim().startsWith('{')) {
      full = JSON.parse(text);
      list = Object.entries(full.entries || {}).map(([key, x]) => ({ key, x: { ...blank(), ...x } }));
    } else {
      list = parseCsv(text);
    }
  } catch (e) { list = []; }
  if (!list.length) { toast(t('В файле нет записей', 'Brak wpisów w pliku')); return; }
  if (!confirm(t(`Загрузить ${list.length} дн. из файла? Совпадающие дни будут заменены.`, `Wczytać ${list.length} dni z pliku? Pasujące dni zostaną zastąpione.`))) return;
  for (const { key, x } of list) { if (isEmptyEntry(x)) delete S.entries[key]; else S.entries[key] = x; }
  if (full) {
    if (full.rates) Object.assign(S.rates, full.rates);
    if (full.settings && full.settings.header && !S.settings.header) S.settings.header = full.settings.header;
  }
  save();
  touched();
  render();
  toast(t('Записи загружены', 'Wpisy wczytane'));
}

/* ===================== Запуск ===================== */
darkMq.addEventListener('change', () => { if (S.settings.theme === 'system') applyTheme(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { renderTop(); checkAccess(); if (offlineLocked()) renderSheet(); }
  // Уходим из приложения — сразу отправляем несохранённую копию
  if (document.visibilityState === 'hidden' && S.cloud.dirty) cloudSync();
});
setInterval(renderTop, 60000);

// Обновление. iPhone часто не перезапускает ярлык, а просто «будит» его из фона,
// поэтому при каждом возврате в приложение сами проверяем, нет ли новой версии,
// и как только она скачалась — перезагружаемся (если человек ничего не печатает).
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  let swReg = null, reloadPending = false;
  const reloadNow = () => {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) { reloadPending = true; return; }
    location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) reloadNow(); });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((r) => { swReg = r; }).catch(() => {});
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (reloadPending) { location.reload(); return; }
    if (swReg) swReg.update().catch(() => {});
  });
}
if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(() => {}); }

// Копия на сервере больше не используется. У кого она была включена —
// удаляем её с сервера (флаг снимаем только после успешного удаления).
if (S.cloud.on && AUTH_API && S.auth.code) {
  api('/backup/delete', { code: S.auth.code, device: deviceId() })
    .then(() => { S.cloud = { on: false, at: 0, dirty: false }; save(); })
    .catch(() => {});
}

render(true);
checkAccess(true);
