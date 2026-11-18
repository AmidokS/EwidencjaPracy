'use strict';
/* Учёт работы — PWA. Создатель: Artur Alimhulov.
   Данные хранятся на телефоне (localStorage) и копией на сервере под кодом доступа (см. «Записи на сервере»). */

const VERSION = '3.1';
const STORE_KEY = 'uchet-raboty-v1';

/* ==== calc:begin ====
   Даты и деньги — без экрана и без S. Этот кусок целиком загружают тесты (tests/calc.test.js)
   и сверяют с tests/payout-cases.json — те же примеры проверяет Android. Здесь не трогать DOM и S. */

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

/* ===================== Деньги ===================== */
/** Отработанные минуты; если конец раньше начала — смена через полночь. */
const worked = (x) => { if (x.start == null || x.end == null) return 0; let d = x.end - x.start; if (d < 0) d += 1440; return d; };
const isWorkDay = (x, zabka) => x.points > 0 || (zabka && x.machines > 0) || worked(x) > 0;

/** Итоги за диапазон дней. zabka выключена — автоматы не считаются. */
function summarizeIn(entries, p, zabka) {
  const s = { points: 0, machines: 0, minutes: 0, workDays: 0 };
  for (let e = p.start; e <= p.end; e++) {
    const x = entries[iso(e)];
    if (!x) continue;
    s.points += x.points || 0; s.machines += zabka ? x.machines || 0 : 0; s.minutes += worked(x);
    if (isWorkDay(x, zabka)) s.workDays++;
  }
  return s;
}

/* Точки платят каждые 2 недели, Жабку — раз в месяц (в выплате за 16–конец, за весь месяц) */
function payoutIn(entries, p, rates, zabka) {
  const s = summarizeIn(entries, p, zabka);
  const second = isSecondHalf(p);
  const machines = second ? summarizeIn(entries, { start: monthFirst(monthIndexOf(p.start)), end: p.end }, zabka).machines : s.machines;
  const pointsMoney = s.points * rates.point;
  const machinesMoney = machines * rates.machine;
  return { points: s.points, pointsMoney, machines, machinesMoney, paidNow: second, total: pointsMoney + (second ? machinesMoney : 0) };
}

/** Сверка выплаты: сколько пришло по сравнению с расчётом (до копеек). */
function reconcile(expected, paid) {
  const diff = Math.round((paid - expected) * 100) / 100 || 0;
  return { diff, status: diff === 0 ? 'ok' : diff < 0 ? 'less' : 'more' };
}
/* ==== calc:end ==== */

/* ===================== Данные ===================== */
const DEFAULTS = {
  entries: {},
  rates: { point: 2.9, machine: 35 },
  report: { points: true, machines: true, hours: false, polish: false },
  // zabka — раздел «Автоматы Жабки»: у новых пользователей выключен (Жабки делают немногие)
  settings: { lang: 'ru', palette: 0, theme: 'system', header: '', onboarded: false, zabka: false, zlist: [] },
  installHidden: false,
  auth: { code: '', device: '', ok: false, name: '', reason: '', checkedAt: 0, lastOk: 0, expires: null, cfg: null },
  cloud: { on: false, at: 0, dirty: false },
  msgHidden: 0,
  reportHidden: 0,
  // Синхронизация между устройствами (только у владельца). since — метка сервера с прошлого раза,
  // dirty — дни, изменённые здесь и ещё не отправленные, deleted — когда день был очищен.
  // dataCode — чьи записи сейчас на этом устройстве (код доступа); при вводе другого кода записи меняются.
  sync: { since: 0, dirty: {}, deleted: {}, metaU: 0, metaDirty: false, at: 0, paidDirty: {}, dataCode: '' },
  // Сверка выплаты: сколько реально пришло за период. Ключ — первый день периода, v: null — стёрто.
  paid: {},
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
    // Обновление со старой версии: у кого уже записаны Жабки — раздел остаётся включённым
    if (!raw.settings || raw.settings.zabka === undefined) {
      s.settings.zabka = Object.values(raw.entries || {}).some((x) => x && x.machines > 0);
    }
    Object.assign(s.auth, raw.auth || {});
    Object.assign(s.cloud, raw.cloud || {});
    Object.assign(s.sync, raw.sync || {});
    if (!s.sync.paidDirty) s.sync.paidDirty = {};
    Object.assign(s.paid, raw.paid || {});
    s.installHidden = !!raw.installHidden;
    s.msgHidden = raw.msgHidden || 0;
    s.reportHidden = raw.reportHidden || 0;
  }
  // Обновление со старой версии: считаем последнюю проверку успешной, чтобы не закрыть приложение сразу
  if (s.auth.ok && !s.auth.lastOk) s.auth.lastOk = s.auth.checkedAt || Date.now();
  return s;
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { toast(t('Не удалось сохранить', 'Nie udało się zapisać')); }
}

/* z — план Жабок на день: [{ t: строка Жабки, a: отчёт «przed» отправлен, b: «po» отправлен }] */
const blank = () => ({ points: 0, machines: 0, start: null, end: null, note: '', z: [] });
const entry = (e) => S.entries[iso(e)] || blank();
const isEmptyEntry = (x) => !x.points && !x.machines && x.start == null && x.end == null && !(x.note || '').trim() && !(x.z && x.z.length);
const sameZ = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
/** Включён ли раздел «Автоматы Жабки» (Настройки). Выключен — Жабки нигде не видны и не считаются. */
const Z = () => !!S.settings.zabka;
const isWork = (x) => isWorkDay(x, Z());
const dayMoney = (x) => x.points * S.rates.point + (Z() ? x.machines * S.rates.machine : 0);

const sameEntry = (a, b) => a.points === b.points && a.machines === b.machines && a.start === b.start && a.end === b.end && (a.note || '') === (b.note || '') && sameZ(a.z, b.z);

function update(e, fn) {
  const k = iso(e);
  const before = entry(e);
  const x = { ...before };
  fn(x);
  if (sameEntry(x, before)) return;
  const now = Date.now();
  if (isEmptyEntry(x)) {
    delete S.entries[k];
    S.sync.deleted[k] = now;
  } else {
    x.u = now; // когда изменено — чтобы при синхронизации победило более позднее
    S.entries[k] = x;
    delete S.sync.deleted[k];
  }
  S.sync.dirty[k] = 1;
  syncSoon();
  save();
}

/** Ставки, шапка или раздел Жабки изменились — отправим на сервер. */
function metaChanged() {
  S.sync.metaU = Date.now();
  S.sync.metaDirty = true;
  syncSoon();
}

/** Записать, сколько пришло за период (null — стереть). Уйдёт на сервер. */
function setPaid(key, v) {
  const cur = S.paid[key];
  if ((cur ? cur.v : null) === v) return;
  S.paid[key] = { v, u: Date.now() };
  S.sync.paidDirty[key] = 1;
  syncSoon();
  save();
}
const paidOf = (p) => { const x = S.paid[iso(p.start)]; return x && x.v != null ? x.v : null; };

const summarize = (p) => summarizeIn(S.entries, p, Z());
const sumMoney = (s) => s.points * S.rates.point + s.machines * S.rates.machine;
const payout = (p) => payoutIn(S.entries, p, S.rates, Z());

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

/* ===================== WhatsApp ===================== */
// Строки шапки отчёта: «Имя Фамилия», «BEM1», «WE1GS69»
const headLines = () => (S.settings.header || '').split('\n').map((s) => s.trim()).filter(Boolean);
/** Код бригады для «BEM1 Start» — вторая строка шапки. */
const teamCode = () => { const h = headLines(); return h[1] || ''; };
const waStatus = (word) => (teamCode() ? `${teamCode()} ${word}` : word);
const miniReport = (d) => [fullD(d), ...headLines(), String(entry(d).points || 0)].join('\n');
/** Открыть WhatsApp с готовым текстом — человек сам выбирает группу и жмёт «Отправить». */
function openWhatsApp(text) {
  const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
  const w = window.open(url, '_blank');
  if (!w) location.href = url;
}
const nowMinutes = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
/**
 * «BEM1 Start» / «BEM1 Koniec»: ставим время начала/конца на сейчас и открываем WhatsApp.
 * Время идёт в тот день, который открыт: сегодня или завтра (смена с 22:00 считается за следующий день —
 * вечером открываешь завтрашний день и жмёшь Start там).
 * Смена через полночь: если на сегодня до полудня начала нет, а вчера смена начата и не закончена — «Koniec» идёт во вчерашний день.
 * Если время уже стоит — спрашиваем, заменить ли (чтобы случайное повторное нажатие его не испортило).
 */
function waStartEnd(which, word) {
  if (!teamCode()) { toast(t('Сначала заполни «Шапку отчёта» в Настройках', 'Najpierw uzupełnij «Nagłówek raportu» w Ustawieniach')); return; }
  const m = nowMinutes();
  const td = todayDay();
  let day = ui.day === td + 1 ? td + 1 : td;
  if (day === td && which === 'end' && m < 12 * 60 && entry(day).start == null) {
    const y = entry(day - 1);
    if (y.start != null && y.end == null) day -= 1;
  }
  const cur = entry(day)[which];
  const label = which === 'start' ? t('Начало', 'Początek') : t('Конец', 'Koniec');
  if (cur != null && cur !== m && !confirm(t(`${label} уже стоит: ${clock(cur)}. Заменить на ${clock(m)}?`, `${label} już jest: ${clock(cur)}. Zamienić na ${clock(m)}?`))) {
    openWhatsApp(waStatus(word));
    return;
  }
  update(day, (x) => { x[which] = m; });
  if (ui.day === day) refreshDay();
  toast(`${label}${day !== td ? ` (${shortD(day)})` : ''}: ${clock(m)}`);
  openWhatsApp(waStatus(word));
}

/* ===================== Письмо о проблеме ===================== */
/* Форма: тема (фирма), причина, текст, адрес, фото → открываем почту телефона с готовым письмом.
   Получатели — из настроек владельца (страница управления). Фото на сервер не уходят. */
const MAIL_REASONS = [
  ['uszk', 'Повреждение', 'Uszkodzenie', 'Dzień dobry,\n\ninformuję, że posiłek uległ uszkodzeniu w magazynie i został wyrzucony. Reszta zawartości została przepakowana do nowej torby.'],
  ['brak', 'Нет пачки', 'Brak paczki', 'Dzień dobry,\n\ninformuję, że na magazynie brakowało paczki dla poniższego adresu.'],
  ['inne', 'Другое', 'Inne', 'Dzień dobry,\n\n'],
];
const mailTo = () => ((S.auth.cfg && S.auth.cfg.mailTo) || []).filter(Boolean);
let mail = null; // открытая форма: { subject, reason, text, address, photos: [{ file, url }] }

function mailBody() {
  const a = (mail.address || '').trim();
  return mail.text.trim() + (a ? `\n\nadres ${a}` : '');
}

function renderMail() {
  let root = document.getElementById('mail-root');
  if (!root) { root = document.createElement('div'); root.id = 'mail-root'; document.body.appendChild(root); }
  if (!mail) { root.innerHTML = ''; return; }
  const subjects = S.settings.mailSubjects || [];
  const to = mailTo();
  root.innerHTML = `<div class="sheet-bg" data-mail="bg"><div class="sheet mail-sheet" role="dialog" aria-modal="true">
    <div class="row-between"><h2>${t('Письмо о проблеме', 'Zgłoszenie mailem')}</h2>
      <button class="round" data-mail="close" aria-label="${t('Закрыть', 'Zamknij')}">${ic('x', 20)}</button></div>
    <p class="muted small">${t('Кому', 'Do')}: ${to.length ? esc(to.join(', ')) : `<b style="color:var(--error)">${t('адреса не настроены — попроси владельца приложения', 'adresy nie są ustawione — poproś właściciela aplikacji')}</b>`}</p>
    <label class="lbl">${t('Тема (фирма)', 'Temat (firma)')}</label>
    <input class="field" id="mail-subject" value="${esc(mail.subject)}" placeholder="Robinfood" maxlength="80" autocomplete="off">
    ${subjects.length ? `<div class="chips">${subjects.map((s) => `<button class="chip ${s === mail.subject ? 'on' : ''}" data-mail-subj="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
    <label class="lbl">${t('Причина', 'Powód')}</label>
    <div class="seg">${MAIL_REASONS.map(([k, ru, pl]) => `<button class="${mail.reason === k ? 'on' : ''}" data-mail-reason="${k}">${t(ru, pl)}</button>`).join('')}</div>
    <label class="lbl">${t('Текст письма (можно поправить)', 'Treść (można poprawić)')}</label>
    <textarea class="field" id="mail-text" rows="5">${esc(mail.text)}</textarea>
    <label class="lbl">${t('Адрес клиента', 'Adres klienta')}</label>
    <input class="field" id="mail-address" value="${esc(mail.address)}" placeholder="ul. …, Warszawa" maxlength="160" autocomplete="off">
    <label class="lbl">${t('Фото', 'Zdjęcia')} · ${mail.photos.length}</label>
    <div class="mail-photos">
      ${mail.photos.map((p, i) => `<div class="ph"><img src="${p.url}" alt=""><button data-mail-del="${i}" aria-label="${t('Убрать', 'Usuń')}">${ic('x', 14)}</button></div>`).join('')}
      <label class="ph add">${ic('camera', 22)}<span>${t('Добавить', 'Dodaj')}</span><input type="file" accept="image/*" multiple hidden data-mail-files></label>
    </div>
    <button class="btn primary" data-mail="send">${ic('send', 18)} ${t('Открыть в почте', 'Otwórz w poczcie')}</button>
    <p class="muted small">${t('Откроется почта с готовым письмом — проверь и нажми «Отправить».', 'Otworzy się poczta z gotowym mailem — sprawdź i naciśnij «Wyślij».')}</p>
  </div></div>`;
}

function mailOpen() {
  const subjects = S.settings.mailSubjects || [];
  mail = { subject: subjects[0] || '', reason: 'uszk', text: MAIL_REASONS[0][3], address: '', photos: [] };
  renderMail();
}
function mailClose() {
  if (mail) mail.photos.forEach((p) => URL.revokeObjectURL(p.url));
  mail = null;
  renderMail();
}
const mailRead = () => {
  const g = (id) => document.getElementById(id);
  if (!mail || !g('mail-subject')) return;
  mail.subject = g('mail-subject').value; mail.text = g('mail-text').value; mail.address = g('mail-address').value;
};

/** Уменьшаем фото (до 1600 px по большей стороне, JPEG), чтобы письмо не было огромным. */
async function shrinkPhoto(file, n) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    return new File([blob], `zdjecie-${n}.jpg`, { type: 'image/jpeg' });
  } catch (e) {
    return file; // не получилось уменьшить — отправим как есть
  }
}

async function mailAddFiles(list) {
  mailRead();
  for (const f of [...list].slice(0, 10 - mail.photos.length)) {
    const file = await shrinkPhoto(f, mail.photos.length + 1);
    mail.photos.push({ file, url: URL.createObjectURL(file) });
  }
  renderMail();
}

async function mailSend() {
  mailRead();
  const subject = mail.subject.trim(), body = mailBody(), to = mailTo();
  if (!subject) { toast(t('Впиши тему — название фирмы', 'Wpisz temat — nazwę firmy')); return; }
  // Запоминаем тему (последние 5)
  S.settings.mailSubjects = [subject, ...(S.settings.mailSubjects || []).filter((s) => s !== subject)].slice(0, 5);
  save();
  const files = mail.photos.map((p) => p.file);
  if (files.length && navigator.canShare && navigator.canShare({ files })) {
    // Через «Поделиться» адресатов передать нельзя — копируем их, человек вставляет в «Кому»
    if (to.length) await copyText(to.join(', '));
    try {
      await navigator.share({ files, title: subject, text: body });
      toast(to.length ? t('Адреса скопированы — вставь их в «Кому»', 'Adresy skopiowane — wklej je w «Do»') : t('Готово', 'Gotowe'));
      mailClose();
    } catch (e) {
      if (!(e && e.name === 'AbortError')) toast(t('Не получилось открыть почту', 'Nie udało się otworzyć poczty'));
    }
    return;
  }
  // Без фото или «Поделиться» с файлами не работает (компьютер) — обычная ссылка mailto
  location.href = `mailto:${to.map(encodeURIComponent).join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  if (files.length) toast(t('Фото добавь в письме вручную', 'Zdjęcia dodaj w mailu ręcznie'));
  mailClose();
}

document.addEventListener('click', (ev) => {
  if (!mail) return;
  const el = ev.target;
  const m = el.closest('[data-mail]');
  if (m && (m.dataset.mail !== 'bg' || el === m)) {
    ev.preventDefault();
    if (m.dataset.mail === 'close' || m.dataset.mail === 'bg') mailClose();
    if (m.dataset.mail === 'send') mailSend();
    return;
  }
  const r = el.closest('[data-mail-reason]');
  if (r) {
    mailRead();
    const tpl = MAIL_REASONS.find((x) => x[0] === r.dataset.mailReason);
    // Текст меняем, только если человек его не правил (он совпадает с прежним шаблоном)
    const prev = MAIL_REASONS.find((x) => x[0] === mail.reason);
    if (!mail.text.trim() || (prev && mail.text === prev[3])) mail.text = tpl[3];
    mail.reason = tpl[0];
    renderMail();
    return;
  }
  const s = el.closest('[data-mail-subj]');
  if (s) { mailRead(); mail.subject = s.dataset.mailSubj; renderMail(); return; }
  const d = el.closest('[data-mail-del]');
  if (d) { mailRead(); const [p] = mail.photos.splice(Number(d.dataset.mailDel), 1); if (p) URL.revokeObjectURL(p.url); renderMail(); }
});
document.addEventListener('change', (ev) => {
  if (mail && ev.target.dataset.mailFiles !== undefined && ev.target.files && ev.target.files.length) mailAddFiles(ev.target.files);
});
document.addEventListener('keydown', (ev) => { if (mail && ev.key === 'Escape') mailClose(); });

/* ===================== Жабки: план на день и отчёты в WhatsApp ===================== */
/* У каждого свой список Жабок (Настройки, или владелец в админке) — по строке на Жабку,
   например «Bosch, Warszawa, Jutrzenki 105, ZG356-1». Вечером отмечаешь, какие Жабки в этот день.
   По каждой — один отчёт: «… ZG356-1 przed/po» и до 4 фото (оба состояния автомата) → «Поделиться» → WhatsApp.
   В плане дня a = отчёт отправлен (b не используется — осталось от варианта с двумя отчётами).
   Количество Жабок за день по-прежнему вводится вручную (кнопки −/+ выше). */
const ZMAX_PHOTOS = 4;
const zText = (line) => `${line} przed/po`;
const zlist = () => (S.settings.zlist || []).filter(Boolean);
let zpick = false; // открыт выбор Жабок на день
let zrep = null;   // открытое окно отчёта: { day, t, photos: [{ file, url }] }

function zabkiCard(d) {
  const plan = entry(d).z || [], list = zlist();
  const done = plan.filter((i) => i.a).length;
  let body;
  if (zpick) {
    const items = [...new Set([...list, ...plan.map((i) => i.t)])];
    body = items.length
      ? `<p class="muted small">${t('Отметь Жабки на этот день', 'Zaznacz Żabki na ten dzień')}</p>
        <div class="zpick">${items.map((s) => {
          const on = plan.some((i) => i.t === s);
          return `<button class="zp ${on ? 'on' : ''}" data-act="z-toggle" data-t="${esc(s)}">${ic(on ? 'check' : 'plus', 16)}<span>${esc(s)}</span></button>`;
        }).join('')}</div>
        <button class="btn primary" data-act="z-pick-done">${t('Готово', 'Gotowe')}</button>`
      : `<p class="muted">${t('Список Жабок пуст — добавь свои Жабки в Настройках (по одной в строке).', 'Lista Żabek jest pusta — dodaj swoje Żabki w Ustawieniach (jedna w linii).')}</p>
        <button class="btn tonal" data-act="z-pick-done">${t('Закрыть', 'Zamknij')}</button>`;
  } else if (!plan.length) {
    body = `<p class="muted small">${list.length
      ? t(`Жабок в твоём списке: ${list.length}. Выбери, какие будут в этот день.`, `Żabek na Twojej liście: ${list.length}. Wybierz, które będą w tym dniu.`)
      : t('Добавь свои Жабки в Настройках — потом здесь выбираешь, какие в этот день, и отправляешь отчёты с фото.', 'Dodaj swoje Żabki w Ustawieniach — potem tu wybierasz, które w tym dniu, i wysyłasz raporty ze zdjęciami.')}</p>
      <button class="btn tonal" data-act="z-pick">${ic('check', 18)} ${t('Выбрать Жабки на этот день', 'Wybierz Żabki na ten dzień')}</button>`;
  } else {
    body = `<div class="zlist">${plan.map((i, n) => `<div class="zrow">
        <div class="zt">${esc(i.t)}</div>
        <button class="zb ${i.a ? 'done' : ''}" data-act="z-rep" data-n="${n}">${ic(i.a ? 'check' : 'camera', 16)} ${i.a ? t('Отправлено', 'Wysłano') : 'Raport przed/po'}</button>
      </div>`).join('')}</div>
      <button class="link" data-act="z-pick">${t('Изменить выбор', 'Zmień wybór')}</button>`;
  }
  return card('store', t('Отчёты Жабок', 'Raporty Żabek'), plan.length ? `<span class="hint">${done}/${plan.length} ✓</span>` : '', body);
}

/** Отметить отчёт по Жабке отправленным (или снять отметку). */
function zMark(day, text, on) {
  update(day, (x) => { x.z = (x.z || []).map((i) => (i.t === text ? { ...i, a: on } : i)); });
}

function renderZrep() {
  let root = document.getElementById('zrep-root');
  if (!root) { root = document.createElement('div'); root.id = 'zrep-root'; document.body.appendChild(root); }
  if (!zrep) { root.innerHTML = ''; return; }
  const item = (entry(zrep.day).z || []).find((i) => i.t === zrep.t);
  const sent = item && item.a;
  root.innerHTML = `<div class="sheet-bg" data-zrep="bg"><div class="sheet mail-sheet" role="dialog" aria-modal="true">
    <div class="row-between"><h2>Raport przed/po</h2>
      <button class="round" data-zrep="close" aria-label="${t('Закрыть', 'Zamknij')}">${ic('x', 20)}</button></div>
    <label class="lbl">${t('Текст в WhatsApp', 'Tekst do WhatsApp')}</label>
    <div class="ztext">${esc(zText(zrep.t))}</div>
    <label class="lbl">${t('Фото «до» и «после»', 'Zdjęcia „przed” i „po”')} · ${zrep.photos.length} / ${ZMAX_PHOTOS}</label>
    <div class="mail-photos">
      ${zrep.photos.map((p, i) => `<div class="ph"><img src="${p.url}" alt=""><button data-zrep-del="${i}" aria-label="${t('Убрать', 'Usuń')}">${ic('x', 14)}</button></div>`).join('')}
      ${zrep.photos.length < ZMAX_PHOTOS ? `<label class="ph add">${ic('camera', 22)}<span>${t('Снять / выбрать', 'Zrób / wybierz')}</span><input type="file" accept="image/*" multiple hidden data-zrep-files></label>` : ''}
    </div>
    <button class="btn primary" data-zrep="send">${ic('send', 18)} ${t('Отправить в WhatsApp', 'Wyślij do WhatsApp')}</button>
    <p class="muted small">${t('Откроется «Поделиться» — выбери WhatsApp и группу. Текст тоже скопирован: если WhatsApp его не подставил, вставь.',
      'Otworzy się „Udostępnij” — wybierz WhatsApp i grupę. Tekst jest też skopiowany: jeśli WhatsApp go nie wstawił, wklej.')}</p>
    ${sent ? `<button class="link" data-zrep="unmark">${t('Снять отметку «отправлено»', 'Usuń oznaczenie „wysłane”')}</button>` : ''}
  </div></div>`;
}

function zrepClose() {
  if (zrep) zrep.photos.forEach((p) => URL.revokeObjectURL(p.url));
  zrep = null;
  renderZrep();
}

async function zrepSend(btn) {
  const text = zText(zrep.t);
  const files = zrep.photos.map((p) => p.file);
  const { day, t: zt } = zrep;
  btn.disabled = true;
  await copyText(text);
  if (files.length && navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, text });
    } catch (e) {
      btn.disabled = false;
      if (!(e && e.name === 'AbortError')) toast(t('Не получилось открыть «Поделиться»', 'Nie udało się otworzyć „Udostępnij”'));
      return;
    }
  } else if (files.length) {
    // Компьютер: фото через «Поделиться» не отправить — открываем WhatsApp с текстом, фото добавить вручную
    openWhatsApp(text);
    toast(t('Фото добавь в WhatsApp вручную', 'Zdjęcia dodaj w WhatsApp ręcznie'));
  } else {
    openWhatsApp(text);
  }
  zMark(day, zt, true);
  zrepClose();
  if (ui.tab === 0 && ui.day === day) render();
}

document.addEventListener('click', (ev) => {
  if (!zrep) return;
  const el = ev.target;
  const b = el.closest('[data-zrep]');
  if (b && (b.dataset.zrep !== 'bg' || el === b)) {
    ev.preventDefault();
    if (b.dataset.zrep === 'close' || b.dataset.zrep === 'bg') zrepClose();
    if (b.dataset.zrep === 'send') zrepSend(b);
    if (b.dataset.zrep === 'unmark') { zMark(zrep.day, zrep.t, false); zrepClose(); render(); }
    return;
  }
  const del = el.closest('[data-zrep-del]');
  if (del) { const [p] = zrep.photos.splice(Number(del.dataset.zrepDel), 1); if (p) URL.revokeObjectURL(p.url); renderZrep(); }
});
document.addEventListener('change', async (ev) => {
  if (!zrep || ev.target.dataset.zrepFiles === undefined || !ev.target.files || !ev.target.files.length) return;
  for (const f of [...ev.target.files].slice(0, ZMAX_PHOTOS - zrep.photos.length)) {
    const file = await shrinkPhoto(f, zrep.photos.length + 1);
    zrep.photos.push({ file, url: URL.createObjectURL(file) });
  }
  renderZrep();
});
document.addEventListener('keydown', (ev) => { if (zrep && ev.key === 'Escape') zrepClose(); });

/* ===================== Отчёт ===================== */
function buildReport(p) {
  const pl = S.report.polish, lang = pl ? 'pl' : 'ru';
  // Жабки выключены — в отчёте их нет; если иначе ничего не осталось, показываем точки
  const o = { ...S.report, machines: S.report.machines && Z() };
  if (!o.points && !o.machines && !o.hours) o.points = true;
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
    case 'logged_out': return t('Ты вышел. Введи свой код или код коллеги.', 'Wylogowano. Wpisz swój kod lub kod kolegi.');
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
      syncNow();
    }
  } catch (e) { /* нет интернета — работаем как обычно */ }
}

/* «Я в приложении»: пока приложение открыто на экране — отметка раз в минуту, при сворачивании — «вышел».
   По этим отметкам владелец видит на странице управления, кто сейчас в сети.
   text/plain — чтобы браузер не делал лишний предварительный запрос (CORS). */
const PING_EVERY = 60 * 1000;
function presence(on) {
  if (!AUTH_API || !S.auth.ok || !S.auth.code) return;
  const data = JSON.stringify({ code: S.auth.code, device: deviceId(), platform: platform(), version: VERSION, off: !on, t: Date.now() });
  // При сворачивании страница может сразу уснуть — sendBeacon всё равно доставит
  if (!on && navigator.sendBeacon && navigator.sendBeacon(AUTH_API + '/ping', new Blob([data], { type: 'text/plain' }))) return;
  fetch(AUTH_API + '/ping', { method: 'POST', body: data, headers: { 'Content-Type': 'text/plain' }, keepalive: true, cache: 'no-store' }).catch(() => {});
}
setInterval(() => { if (document.visibilityState === 'visible') presence(true); }, PING_EVERY);

/** Запомнить ответ сервера: имя, срок кода, общие настройки (объявление, лимит без интернета). */
function acceptServer(r) {
  S.auth.lastOk = Date.now();
  if (r.name) S.auth.name = r.name;
  S.auth.expires = r.expires || null;
  if (r.cfg) S.auth.cfg = r.cfg;
  S.auth.owner = !!r.owner;
}

/* ===================== Записи на сервере (синхронизация) ===================== */
/* Записи, ставки, шапка и раздел Жабки хранятся на сервере под кодом доступа — одинаковые на всех устройствах
   с этим кодом, и при смене телефона ничего не пропадает. Одно и то же изменено на двух устройствах —
   остаётся более позднее изменение. Владелец отличается только тем, что его код работает на любом количестве устройств. */
const isOwner = () => !!(AUTH_API && S.auth.ok && S.auth.owner);
const syncOn = () => !!(AUTH_API && S.auth.ok && S.auth.code);
let syncBusy = false, syncTimer = null, syncedOnce = false;
/** Почему не получилась последняя синхронизация: network, invalid (кода больше нет), denied (не это устройство) и т.п. */
let syncError = '';
const hasPendingSync = () => !!(Object.keys(S.sync.dirty).length || Object.keys(S.sync.paidDirty).length || S.sync.metaDirty);

function syncSoon(ms = 4000) {
  if (!syncOn()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), ms);
}

/** force — даже если приложение сейчас заперто (нужно, чтобы дослать записи старого кода при вводе нового). */
async function syncNow(force) {
  if (!(force ? AUTH_API && S.auth.code : syncOn()) || syncBusy) return false;
  syncBusy = true;
  syncError = '';
  const z = S.sync;
  // Первый раз за запуск отправляем все дни целиком — так ничего не потеряется, даже если раньше что-то не дошло
  const all = !syncedOnce || !z.since;
  const keys = all ? [...new Set([...Object.keys(S.entries), ...Object.keys(z.deleted)])] : Object.keys(z.dirty);
  const days = {};
  for (const k of keys) {
    const x = S.entries[k];
    if (x) days[k] = { p: x.points || 0, m: x.machines || 0, s: x.start ?? null, e: x.end ?? null, n: x.note || '', z: x.z || [], u: x.u || 1 };
    else if (z.deleted[k]) days[k] = { del: 1, u: z.deleted[k] };
  }
  const sendMeta = all || z.metaDirty;
  const meta = sendMeta ? { rates: S.rates, header: S.settings.header || '', zabka: !!S.settings.zabka, zlist: S.settings.zlist || [], u: z.metaU || 1 } : null;
  const paid = {};
  for (const k of all ? Object.keys(S.paid) : Object.keys(z.paidDirty)) if (S.paid[k]) paid[k] = S.paid[k];
  // Снимаем отметку «не отправлено» заранее: если за время запроса день снова изменят, отметка встанет снова
  const pending = Object.keys(z.dirty);
  z.dirty = {};
  const pendingPaid = Object.keys(z.paidDirty);
  z.paidDirty = {};
  const metaWas = z.metaDirty;
  z.metaDirty = false;
  try {
    let r;
    try { r = await api('/sync', { code: S.auth.code, device: deviceId(), since: z.since || 0, days, meta, paid }); }
    catch (e) { syncError = 'network'; throw e; }
    if (!r || !r.ok) { syncError = (r && r.reason) || 'error'; throw new Error('sync'); }
    let changedUi = false;
    for (const [k, d] of Object.entries(r.days || {})) {
      const loc = S.entries[k];
      const locU = loc ? (loc.u || 1) : (z.deleted[k] || 0);
      if (d.u < locU) continue; // здесь изменено позже — оставляем своё
      if (d.del) {
        if (loc) { delete S.entries[k]; changedUi = true; }
        z.deleted[k] = d.u;
      } else {
        const nx = { points: d.p || 0, machines: d.m || 0, start: d.s ?? null, end: d.e ?? null, note: d.n || '', z: d.z || (loc && loc.z) || [], u: d.u };
        if (!loc || !sameEntry(loc, nx)) changedUi = true;
        S.entries[k] = nx;
        delete z.deleted[k];
      }
    }
    if (r.meta && r.meta.u >= (z.metaU || 0)) {
      const rt = r.meta.rates || {};
      if (rt.point > 0 && rt.machine > 0 && (rt.point !== S.rates.point || rt.machine !== S.rates.machine)) {
        S.rates = { point: rt.point, machine: rt.machine }; changedUi = true;
      }
      if (typeof r.meta.header === 'string' && r.meta.header !== S.settings.header) {
        S.settings.header = r.meta.header; changedUi = true;
      }
      if (typeof r.meta.zabka === 'boolean' && r.meta.zabka !== !!S.settings.zabka) {
        S.settings.zabka = r.meta.zabka; changedUi = true;
      }
      if (Array.isArray(r.meta.zlist) && JSON.stringify(r.meta.zlist) !== JSON.stringify(S.settings.zlist || [])) {
        S.settings.zlist = r.meta.zlist; changedUi = true;
      }
      z.metaU = r.meta.u;
    }
    for (const [k, d] of Object.entries(r.paid || {})) {
      const loc = S.paid[k];
      if (loc && d.u < loc.u) continue; // здесь изменено позже — оставляем своё
      const v = d.v == null ? null : Number(d.v);
      if ((loc ? loc.v : null) !== v) changedUi = true;
      S.paid[k] = { v, u: d.u };
    }
    z.since = r.now;
    z.at = Date.now();
    z.dataCode = S.auth.code; // записи на этом устройстве — этого кода
    syncedOnce = true;
    save();
    // Не перерисовываем, пока человек что-то печатает — иначе собьётся ввод
    const a = document.activeElement;
    const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
    if (changedUi && !typing) render();
    else if (ui.tab === 4 && !typing) render();
    return true;
  } catch (e) {
    for (const k of pending) z.dirty[k] = 1;
    for (const k of pendingPaid) z.paidDirty[k] = 1;
    if (metaWas) z.metaDirty = true;
    save();
    return false;
  } finally {
    syncBusy = false;
  }
}

/**
 * Ввели код, а записи на этом устройстве — другого кода (например, владелец ввёл код работника).
 * Сначала досылаем всё на сервер по старому коду, кладём запасную копию в uchet-raboty-stash-<КОД>
 * и очищаем — записи нового кода придут с сервера. Если старого кода больше нет (его сменили в админке),
 * это записи того же человека: они остаются и уходят на сервер под новым кодом.
 */
async function switchData(code) {
  const prev = S.sync.dataCode || S.auth.code || '';
  const hasData = Object.keys(S.entries).length || Object.keys(S.paid).length;
  if (!prev || prev === code || !hasData) { S.sync.dataCode = code; return; }
  syncedOnce = false; // отправить старые записи целиком
  const sent = await syncNow(true);
  if (!sent && syncError === 'invalid') {
    Object.assign(S.sync, { since: 0, dataCode: code });
    syncedOnce = false;
    save();
    return;
  }
  try {
    localStorage.setItem(`uchet-raboty-stash-${prev}`, JSON.stringify({
      at: Date.now(), code: prev, sent, entries: S.entries, paid: S.paid, rates: S.rates, header: S.settings.header || '',
    }));
  } catch (e) { /* нет места — копия не обязательна, записи уже на сервере */ }
  S.entries = {};
  S.paid = {};
  S.settings.header = '';
  S.settings.zabka = false;
  S.settings.zlist = [];
  S.sync = { ...JSON.parse(JSON.stringify(DEFAULTS.sync)), dataCode: code };
  syncedOnce = false;
  save();
}

/**
 * «Выйти»: например, чтобы зайти под кодом коллеги и добавить ему Жабку, а потом вернуться к себе.
 * Сначала всё неотправленное уходит на сервер (без интернета выйти нельзя — иначе записи могут потеряться),
 * потом записи убираются с устройства: они на сервере и вернутся, когда снова введёшь свой код.
 */
async function logout() {
  if (!(await syncNow())) return false;
  presence(false);
  try { await api('/logout', { code: S.auth.code, device: deviceId() }); } catch (e) { /* не страшно: устройство само отвалится при «Выйти на всех» */ }
  S.entries = {};
  S.paid = {};
  S.settings.header = '';
  S.settings.zabka = false;
  S.settings.zlist = [];
  S.sync = JSON.parse(JSON.stringify(DEFAULTS.sync));
  S.auth = { ...S.auth, ok: false, code: '', name: '', owner: false, expires: null, reason: 'logged_out' };
  syncedOnce = false;
  save();
  return true;
}

/* Без связи с сервером дольше, чем разрешил владелец, — просим подключиться к интернету */
function offlineLocked() {
  if (!AUTH_API || !S.auth.ok) return false;
  const days = S.auth.cfg && S.auth.cfg.offlineDays;
  return !!days && !!S.auth.lastOk && Date.now() - S.auth.lastOk > days * DAY_MS;
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
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-12.2 7.5L3 21l2-5.5A8.4 8.4 0 1 1 21 11.5z"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 3v5h5"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 21v-5h-5"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
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

    <div class="col">
    ${card('chat', 'WhatsApp', '',
      `${d === td || d === td + 1 ? `<div class="btn-row wa-row">
         <button class="btn tonal" data-act="wa-start">${ic('play', 18)} ${esc(waStatus('Start'))}</button>
         <button class="btn tonal" data-act="wa-end">${ic('stop', 18)} ${esc(waStatus('Koniec'))}</button>
       </div>` : ''}
       <button class="btn tonal" data-act="wa-mini">${ic('send', 18)} ${t('Минирапорт за', 'Miniraport za')} ${shortD(d)}</button>`)}

    ${card('truck', t('Точки катеринга', 'Punkty cateringu'), `<span class="hint">× ${rate(S.rates.point)} zł</span>`,
      `<input class="num" data-field="points" inputmode="numeric" pattern="[0-9]*" placeholder="0" autocomplete="off" value="${x.points || ''}" aria-label="${t('Точки', 'Punkty')}">`)}

    ${Z() ? card('store', t('Автоматы Жабки', 'Automaty Żabki'), `<span class="hint">× ${rate(S.rates.machine)} zł</span>`,
      `<div class="stepper">
        <button class="step" data-act="m-minus" aria-label="${t('Меньше', 'Mniej')}">${ic('minus', 22)}</button>
        <input class="num" data-field="machines" inputmode="numeric" pattern="[0-9]*" placeholder="0" autocomplete="off" value="${x.machines || ''}" aria-label="${t('Автоматы', 'Automaty')}">
        <button class="step" data-act="m-plus" aria-label="${t('Больше', 'Więcej')}">${ic('plus', 22)}</button>
      </div>`) : ''}

    ${Z() ? zabkiCard(d) : ''}

    ${card('clock', t('Часы работы', 'Godziny pracy'), `<span id="hours-pill">${hoursPill(x)}</span>`,
      `<div class="times">${timeTile('start', t('Начало', 'Początek'), x.start)}${timeTile('end', t('Конец', 'Koniec'), x.end)}</div>
       <div class="right" id="clear-time" ${x.start == null && x.end == null ? 'hidden' : ''}>
         <button class="link" data-act="clear-time">${t('Сбросить время', 'Wyczyść godziny')}</button>
       </div>`)}
    </div>

    <div class="col">
    ${card('mail', t('Письмо о проблеме', 'Zgłoszenie mailem'), '',
      `<p class="muted small">${t('Нет пачки, повреждённый товар — письмо с фото на почту фирмы.', 'Brak paczki, uszkodzony towar — mail ze zdjęciami do firmy.')}</p>
       <button class="btn tonal" data-act="mail-open">${ic('mail', 18)} ${t('Написать письмо', 'Napisz maila')}</button>`)}
    </div>`;
}

const hoursPill = (x) => (worked(x) > 0 ? `<span class="pill">${hours(worked(x))}</span>` : '');

function refreshDay() {
  const x = entry(ui.day);
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  set('hours-pill', hoursPill(x));
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
      ${Z() && x && x.machines ? `<span class="cm">Ż${x.machines}</span>` : ''}
    </button>`;
  }
  const halves = [{ start: first, end: dayOf(y, m, 15) }, { start: dayOf(y, m, 16), end: dayOf(y, m, n) }];
  const halfCards = halves.map(payCard).join('');

  return `
    ${navHead(monthTitle(mi), t('Нажми на день, чтобы изменить', 'Dotknij dnia, aby edytować'))}
    <div class="col wide">
    <div class="cal-wrap"><div class="cal-head">${heads}</div><div class="cal">${cells}</div></div>
    <div class="legend">
      <span><i style="background:var(--primary)"></i>${t('точки', 'punkty')}</span>
      ${Z() ? `<span><i style="background:var(--tertiary)"></i>${t('Жабка', 'Żabka')}</span>` : ''}    </div>
    </div>
    <div class="col">${halfCards}</div>`;
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

  const chip = (act, k, label, on) => `<button class="chip ${on ? 'on' : ''}" data-act="${act}" data-k="${k}">${on ? ic('check', 14) : ''}${label}</button>`;
  const repBody = `
    <p class="muted">${t('Что включить', 'Co uwzględnić')}</p>
    <div class="chips">
      ${chip('rep', 'points', t('Точки', 'Punkty'), o.points || (!o.hours && !(o.machines && Z())))}
      ${Z() ? chip('rep', 'machines', t('Жабка', 'Żabka'), o.machines) : ''}
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
    return `<button class="trow ${Z() ? '' : 'noz'} ${e === td ? 'today' : ''}" data-act="open-day" data-day="${e}">
      <span>${shortD(e)} ${weekdayShort(e)}</span>
      <span>${x.points || dash}</span>${Z() ? `<span>${x.machines || dash}</span>` : ''}<span>${worked(x) ? hoursShort(worked(x)) : dash}</span>
      <span class="zl">${dayMoney(x) > 0 ? rate(dayMoney(x)) : dash}</span>
    </button>`;
  }).join('');
  const daysBody = `
    <div>
      <div class="trow head ${Z() ? '' : 'noz'}"><span>${t('Дата', 'Data')}</span><span>${t('Точки', 'Punkty')}</span>${Z() ? `<span>${t('Жабка', 'Żabka')}</span>` : ''}<span>${t('Часы', 'Godziny')}</span><span class="zl">zł</span></div>
      ${rows}
    </div>
    <p style="margin:0;font-weight:650;font-size:15px">${t('Итого', 'Razem')}: ${s.points} ${t('точек', 'punktów')}${Z() ? `, ${s.machines} ${t('автоматов', 'automatów')}` : ''}, ${hours(s.minutes)} · ${money(sumMoney(s))}</p>`;

  return `
    ${navHead(periodTitle(p), `${t('Период выплаты', 'Okres rozliczeniowy')} · ${ymd(p.end).y}`)}
    <div class="col">
    ${progress}
    <div class="tiles">
      ${tile(t('Точек', 'Punktów'), s.points)}
      ${Z() ? tile(t('Автоматов', 'Automatów'), s.machines, monthMachines != null ? `${t('за месяц', 'za miesiąc')}: ${monthMachines}` : '')
        : tile(t('К выплате', 'Do wypłaty'), money(pay.total))}
      ${tile(t('Часов', 'Godzin'), hoursShort(s.minutes))}
      ${tile(t('Рабочих дней', 'Dni pracy'), s.workDays)}
    </div>
    ${card('doc', t('Отчёт', 'Raport'), '', repBody)}
    </div>
    <div class="col">${card('list', t('По дням', 'Dzień po dniu'), '', daysBody)}</div>`;
}

/* Сверка выплаты: человек вписывает, сколько пришло на счёт, — видно, не недоплатили ли */
const paidInputValue = (v) => (v == null ? '' : v.toFixed(2).replace('.', ','));

function paidDiffHtml(expected, paid) {
  if (paid == null) return `<span class="muted small">${t('Впиши сумму, когда придут деньги, — сравню с расчётом.', 'Wpisz kwotę, gdy przyjdą pieniądze — porównam z wyliczeniem.')}</span>`;
  const r = reconcile(expected, paid);
  if (r.status === 'ok') return `<span class="paid-ok">${ic('check', 16)} ${t('Сходится с расчётом', 'Zgadza się z wyliczeniem')}</span>`;
  if (r.status === 'less') return `<span class="paid-less">${t('Недоплатили', 'Brakuje')} ${money(-r.diff)}</span>`;
  return `<span class="paid-more">${t('Пришло больше на', 'Wpłynęło więcej o')} ${money(r.diff)}</span>`;
}

function paidBlock(p, expected) {
  const k = iso(p.start);
  return `<div class="paid">
    <label class="lbl" for="paid-input-${k}">${t('Пришло на счёт, zł', 'Wpłynęło na konto, zł')}</label>
    <input class="field" id="paid-input-${k}" data-field="paid" data-k="${k}" inputmode="decimal" autocomplete="off"
      placeholder="${t('сумма из банка', 'kwota z banku')}" value="${paidInputValue(paidOf(p))}">
    <div id="paid-diff-${k}">${paidDiffHtml(expected, paidOf(p))}</div>
  </div>`;
}

/** Карточка «К оплате» за период выплаты (в календаре — по одной на каждую половину месяца). */
function payCard(p) {
  const s = summarize(p), pay = payout(p);
  const endDay = daysInMonth(ymd(p.start).y, ymd(p.start).m);
  const body = `
    <p class="muted">${s.points} ${t('точек', 'punktów')}${Z() ? ` · ${s.machines} ${t('автоматов', 'automatów')}` : ''} · ${hours(s.minutes)}</p>
    <div class="money-row"><span>${t('Точки', 'Punkty')} ${pay.points} × ${rate(S.rates.point)}</span><span>${money(pay.pointsMoney)}</span></div>
    ${Z() && pay.paidNow ? `<div class="money-row"><span>${t('Жабка за месяц', 'Żabka za miesiąc')} ${pay.machines} × ${rate(S.rates.machine)}</span><span>${money(pay.machinesMoney)}</span></div>` : ''}
    <div class="total"><span style="font-weight:650">${t('Всего', 'Razem')}</span><b>${money(pay.total)}</b></div>
    ${Z() && !pay.paidNow ? `<p class="muted small">${t(`Жабка оплачивается раз в месяц — войдёт в выплату за 16–${endDay}. Сейчас: ${pay.machines} авт. = ${money(pay.machinesMoney)}`,
      `Żabka jest płatna raz w miesiącu — wejdzie do wypłaty za 16–${endDay}. Teraz: ${pay.machines} aut. = ${money(pay.machinesMoney)}`)}</p>` : ''}
    ${s.minutes > 0 ? `<p class="muted small">${t('Заработано в час', 'Zarobek na godzinę')}: ≈ ${money(sumMoney(s) / (s.minutes / 60))}</p>` : ''}
    ${paidBlock(p, pay.total)}`;
  return card('money', `${t('К оплате', 'Do wypłaty')} · ${periodTitle(p)}`, '', body);
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
    <div class="col">
    <div class="hero">
      <div class="lbl2">${t('Доход за месяц', 'Dochód za miesiąc')}</div>
      <div class="big">${money(m)}</div>
      ${pct != null ? `<div class="small">${t('Прошлый месяц', 'Poprzedni miesiąc')}: ${money(pm)} (${pct >= 0 ? '+' : ''}${pct}%)</div>` : ''}
    </div>
    <div class="tiles">
      ${tile(t('Точек', 'Punktów'), s.points, money(s.points * S.rates.point))}
      ${Z() ? tile(t('Автоматов', 'Automatów'), s.machines, money(s.machines * S.rates.machine))
        : tile(t('Лучший день', 'Najlepszy dzień'), bestV || '—', bestV > 0 ? shortD(days[bestI]) : '')}
      ${tile(t('Рабочих дней', 'Dni pracy'), s.workDays)}
      ${tile(t('Точек в день', 'Punktów dziennie'), num(avgP, 1))}
      ${tile(t('Часов', 'Godzin'), hours(s.minutes), avgMin ? `≈ ${hours(avgMin)} ${t('в день', 'dziennie')}` : '')}
      ${tile(t('В час', 'Na godzinę'), s.minutes ? money(m / (s.minutes / 60)) : '—')}
    </div>
    </div>
    <div class="col">
    ${card('chart', t('Точки по дням', 'Punkty dziennie'), '',
      bars(pts, 'var(--primary)', 130) +
      (bestV > 0 ? `<p class="muted">${t('Лучший день', 'Najlepszy dzień')}: ${shortD(days[bestI])} — ${bestV}</p>` : ''))}
    ${Z() ? card('store', t('Жабка по дням', 'Żabka dziennie'), '', bars(mach, 'var(--tertiary)', 90)) : ''}
    </div>`;
}

/* ===================== Экран «Настройки» ===================== */
function renderSettings() {
  const st = S.settings, pal = PALETTES[st.palette] || PALETTES[0];
  const seg = (act, val, label, on) => `<button class="${on ? 'on' : ''}" data-act="${act}" data-v="${val}">${label}</button>`;
  const swatches = PALETTES.map((p, i) =>
    `<button class="swatch ${i === st.palette ? 'on' : ''}" data-act="palette" data-v="${i}" style="background:${hslHex(p.h, 62 * p.k, 42)}" aria-label="${isPl() ? p.pl : p.ru}">${i === st.palette ? ic('check', 22) : ''}</button>`).join('');

  return `
    <h1 class="page-title">${t('Настройки', 'Ustawienia')}</h1>
    <div class="col">
    ${installCard()}
    ${card('globe', t('Язык приложения', 'Język aplikacji'), '',
      `<div class="seg">${seg('lang', 'ru', 'Русский', st.lang === 'ru')}${seg('lang', 'pl', 'Polski', st.lang === 'pl')}</div>`)}
    ${card('palette', t('Оформление', 'Wygląd'), '',
      `<p class="muted">${t('Цвет', 'Kolor')}: ${isPl() ? pal.pl : pal.ru}</p>
       <div class="swatches">${swatches}</div>
       <p class="muted">${t('Тема', 'Motyw')}</p>
       <div class="seg">${seg('theme', 'system', t('Как в системе', 'Systemowy'), st.theme === 'system')}${seg('theme', 'light', t('Светлая', 'Jasny'), st.theme === 'light')}${seg('theme', 'dark', t('Тёмная', 'Ciemny'), st.theme === 'dark')}</div>`)}
    </div>
    <div class="col">
    ${card('doc', t('Шапка отчёта', 'Nagłówek raportu'), '',
      `<textarea class="field" data-field="header" rows="3" placeholder="${t('Имя Фамилия&#10;Код&#10;Номер', 'Imię Nazwisko&#10;Kod&#10;Numer')}">${esc(st.header)}</textarea>
       <p class="muted small">${t('Эти строки стоят в начале каждого отчёта и в минирапорте. Вторая строка — код для «Start» / «Koniec» в WhatsApp.',
         'Te linie są na początku każdego raportu i w miniraporcie. Druga linia to kod do «Start» / «Koniec» w WhatsApp.')}</p>`)}
    ${card('store', t('Автоматы Жабки', 'Automaty Żabki'),
      `<label class="switch"><input type="checkbox" data-check="zabka" ${st.zabka ? 'checked' : ''} aria-label="${t('Автоматы Жабки', 'Automaty Żabki')}"><span></span></label>`,
      `<p class="muted">${t('Включи, если делаешь Жабки. Выключено — Жабок нет на экране «День», в календаре, итогах и отчёте, считаются только точки. Уже записанные Жабки не удаляются.',
        'Włącz, jeśli robisz Żabki. Wyłączone — Żabek nie ma na ekranie «Dzień», w kalendarzu, podsumowaniu i raporcie, liczą się tylko punkty. Zapisane Żabki nie są usuwane.')}</p>
       ${st.zabka ? `<label class="lbl">${t('Мои Жабки — по одной в строке', 'Moje Żabki — jedna w linii')}</label>
       <textarea class="field" data-field="zlist" rows="6" placeholder="Bosch, Warszawa, Jutrzenki 105, ZG356-1">${esc(zlist().join('\n'))}</textarea>
       <p class="muted small">${t('Строка целиком уходит в WhatsApp, в конце добавляется «przed/po». Список меняется раз в неделю — его может поправить и владелец в админке.',
         'Cała linia idzie do WhatsApp, na końcu dochodzi „przed/po”. Lista zmienia się raz w tygodniu — może ją poprawić też właściciel w panelu.')}</p>` : ''}`)}
    ${card('money', t('Ставки', 'Stawki'), '',
      `<label class="lbl">${t('За 1 точку, zł', 'Za 1 punkt, zł')}</label>
       <input class="field" data-field="rate-point" inputmode="decimal" value="${rate(S.rates.point)}">
       ${Z() ? `<label class="lbl">${t('За 1 автомат Жабки, zł', 'Za 1 automat Żabki, zł')}</label>
       <input class="field" data-field="rate-machine" inputmode="decimal" value="${rate(S.rates.machine)}">` : ''}`)}
    ${syncOn() ? card('sync', t('Записи на сервере', 'Wpisy na serwerze'), '',
      `<p class="muted">${isOwner()
        ? t('Записи, ставки и шапка отчёта хранятся на сервере под твоим кодом и одинаковые на всех твоих устройствах. Язык и тема — у каждого устройства свои.',
          'Wpisy, stawki i nagłówek są na serwerze pod Twoim kodem i takie same na wszystkich Twoich urządzeniach. Język i motyw — osobno na każdym.')
        : t('Записи, ставки и шапка отчёта хранятся копией на сервере под твоим кодом. Сменишь телефон — введи код на новом, и всё будет на месте.',
          'Wpisy, stawki i nagłówek są w kopii na serwerze pod Twoim kodem. Zmienisz telefon — wpisz kod na nowym i wszystko będzie na miejscu.')}</p>
       <p class="muted small">${t('Последняя синхронизация', 'Ostatnia synchronizacja')}: ${S.sync.at ? fullDate(S.sync.at) : '—'}${hasPendingSync() ? ` · ${t('есть неотправленное', 'są niewysłane zmiany')}` : ''}</p>
       <button class="btn tonal" data-act="sync-now">${ic('sync', 18)} ${t('Синхронизировать сейчас', 'Synchronizuj teraz')}</button>
       <p class="muted small" style="margin:0">${t('Нужно зайти под кодом коллеги (например, добавить ему Жабку)? Выйди и введи его код. Потом выйди и введи свой — твои записи вернутся.',
         'Musisz wejść na kod kolegi (np. dopisać mu Żabkę)? Wyloguj się i wpisz jego kod. Potem wyloguj się i wpisz swój — Twoje wpisy wrócą.')}</p>
       <button class="btn tonal" data-act="logout">${ic('back', 18)} ${t('Выйти', 'Wyloguj')} · ${esc(prettyCode(S.auth.code))}${S.auth.name ? ` (${esc(S.auth.name)})` : ''}</button>`) : ''}
    </div>
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
  $top.innerHTML = html;
  // Значок с числом на иконке раньше показывал напоминания о заметках — убираем его
  try { if (navigator.clearAppBadge) navigator.clearAppBadge(); } catch (e) { /* не поддерживается */ }
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
    <p class="muted">${t('Точки катеринга, часы и готовый отчёт за 15 дней. Делаешь Жабки — включи их в Настройках. Записи хранятся на телефоне и копией на сервере под твоим кодом — при смене телефона ничего не пропадёт.',
      'Punkty cateringu, godziny i gotowy raport za 15 dni. Robisz Żabki — włącz je w Ustawieniach. Wpisy są w telefonie i w kopii na serwerze pod Twoim kodem — przy zmianie telefonu nic nie zginie.')}</p>
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
  // На компьютере меню слева, сверху — название приложения (на телефоне скрыто)
  $tabs.innerHTML = `<div class="brand"><img src="icons/icon-192.png" alt=""><div><b>Ewidencja Pracy</b>${S.auth.name ? `<span>${esc(S.auth.name)}</span>` : ''}</div></div>` +
    TABS.map((tb, i) =>
      `<button class="tab ${i === ui.tab ? 'on' : ''}" data-act="tab" data-v="${i}"><span class="ib">${ic(tb.icon, 22)}</span><span>${t(tb.ru, tb.pl)}</span></button>`).join('');
}

function render(resetScroll) {
  applyTheme();
  renderTabs();
  renderTop();
  const scroll = $screen.scrollTop;
  $screen.innerHTML = `<div class="page t${ui.tab}">${TABS[ui.tab].render()}</div>`;
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

/** Скачать файл (или «Поделиться» на телефоне). Нужно для «Сохранить мои записи» на экране входа. */
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

const actions = {
  // Человек без доступа (код отключён / нет интернета) всё равно может забрать свои записи
  backup() { shareFile(`uchet-raboty-${iso(todayDay())}.json`, JSON.stringify({ app: 'uchet-raboty', version: VERSION, entries: S.entries, rates: S.rates, header: S.settings.header || '', paid: S.paid }, null, 1), 'application/json'); },
  tab(el) { const v = Number(el.dataset.v); if (v !== ui.tab) { ui.tab = v; if (v === 0) ui.day = ui.day; render(true); } else if (v === 0 && ui.day !== todayDay()) { ui.day = todayDay(); render(true); } },
  prev() { navigate(-1); },
  next() { navigate(1); },
  today() { ui.day = todayDay(); render(true); },
  'open-day'(el) { ui.day = Number(el.dataset.day); ui.tab = 0; render(true); },
  'm-minus'() { update(ui.day, (x) => { x.machines = Math.max(0, x.machines - 1); }); syncNum('machines'); refreshDay(); },
  'm-plus'() { update(ui.day, (x) => { x.machines += 1; }); syncNum('machines'); refreshDay(); },
  'mail-open'() { mailOpen(); },
  'z-pick'() { zpick = true; render(); },
  'z-pick-done'() { zpick = false; render(); },
  'z-toggle'(el) {
    const s = el.dataset.t, order = zlist();
    update(ui.day, (x) => {
      const plan = x.z || [];
      const next = plan.some((i) => i.t === s) ? plan.filter((i) => i.t !== s) : [...plan, { t: s, a: false, b: false }];
      // в порядке списка Жабок; то, чего в списке уже нет, — в конце
      const pos = (i) => { const k = order.indexOf(i.t); return k < 0 ? 1e6 : k; };
      x.z = next.sort((p, q) => pos(p) - pos(q));
    });
    render();
  },
  'z-rep'(el) {
    const item = (entry(ui.day).z || [])[Number(el.dataset.n)];
    if (!item) return;
    zrep = { day: ui.day, t: item.t, photos: [] };
    renderZrep();
  },
  'wa-start'() { waStartEnd('start', 'Start'); },
  'wa-end'() { waStartEnd('end', 'Koniec'); },
  'wa-mini'() {
    if (!teamCode()) { toast(t('Сначала заполни «Шапку отчёта» в Настройках', 'Najpierw uzupełnij «Nagłówek raportu» w Ustawieniach')); return; }
    if (!entry(ui.day).points) { toast(t('Сначала впиши точки за этот день', 'Najpierw wpisz punkty za ten dzień')); return; }
    openWhatsApp(miniReport(ui.day));
  },
  'clear-time'() { update(ui.day, (x) => { x.start = null; x.end = null; }); refreshDay(); },
  rep(el) {
    const k = el.dataset.k, o = S.report;
    const others = ['points', 'machines', 'hours'].filter((n) => n !== k && (n !== 'machines' || Z())).some((n) => o[n]);
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
        await switchData(code);
        S.auth = { ...S.auth, code, ok: true, name: r.name || '', reason: '', checkedAt: Date.now() };
        acceptServer(r);
        save();
        $sheet.innerHTML = '';
        render();
        toast(`${t('Добро пожаловать', 'Witaj')}${r.name ? `, ${r.name}` : ''}!`);
        syncNow(); // владелец на новом устройстве сразу получит свои записи
        presence(true);
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
  'hide-install'() { S.installHidden = true; save(); renderTop(); },
  async install() { if (!installEvent) return; installEvent.prompt(); try { await installEvent.userChoice; } catch (e) { /* ignore */ } installEvent = null; render(); },
  'open-report'() { ui.tab = 2; ui.period = periodIndex(payPeriod(todayDay())); render(true); },
  'hide-report'() { S.reportHidden = todayDay(); save(); renderTop(); },
  'hide-msg'(el) { S.msgHidden = Number(el.dataset.id); save(); renderTop(); },
  async 'sync-now'(el) {
    el.disabled = true;
    const ok = await syncNow();
    toast(ok ? t('Синхронизировано', 'Zsynchronizowano') : t('Нет связи с сервером', 'Brak połączenia z serwerem'));
    render();
  },
  async logout(el) {
    if (!confirm(t(`Выйти из кода ${prettyCode(S.auth.code)}? Записи останутся на сервере — введёшь код снова, и они вернутся.`,
      `Wylogować się z kodu ${prettyCode(S.auth.code)}? Wpisy zostaną na serwerze — po ponownym wpisaniu kodu wrócą.`))) return;
    el.disabled = true;
    if (!(await logout())) {
      el.disabled = false;
      toast(t('Нет связи с сервером — выйти можно только с интернетом, чтобы записи не потерялись', 'Brak połączenia — wylogować można tylko z internetem, żeby wpisy nie zginęły'));
      return;
    }
    ui.tab = 0; ui.day = todayDay();
    $sheet.innerHTML = '';
    render(true);
  },
  async 'offline-retry'(el) {
    el.disabled = true;
    await checkAccess(true);
    if (offlineLocked()) { el.disabled = false; toast(t('Нет связи с сервером', 'Brak połączenia z serwerem')); }
  },
};

function syncNum(field) {
  const inp = document.querySelector(`[data-field="${field}"]`);
  if (inp) { const v = entry(ui.day)[field]; inp.value = v || ''; }
}

const fields = {
  points(el) { const v = el.value.replace(/\D/g, '').slice(0, 4); if (v !== el.value) el.value = v; update(ui.day, (x) => { x.points = Number(v) || 0; }); refreshDay(); },
  machines(el) { const v = el.value.replace(/\D/g, '').slice(0, 3); if (v !== el.value) el.value = v; update(ui.day, (x) => { x.machines = Number(v) || 0; }); refreshDay(); },
  header(el) { S.settings.header = el.value; metaChanged(); save(); },
  zlist(el) { S.settings.zlist = el.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 60); metaChanged(); save(); },
  'rate-point'(el) { const v = parseFloat(el.value.replace(',', '.')); if (Number.isFinite(v) && v >= 0) { S.rates.point = v; metaChanged(); save(); } },
  'rate-machine'(el) { const v = parseFloat(el.value.replace(',', '.')); if (Number.isFinite(v) && v >= 0) { S.rates.machine = v; metaChanged(); save(); } },
  paid(el) {
    const raw = el.value.replace(/[\s  ]/g, '').replace(',', '.');
    const v = raw === '' ? null : Number(raw);
    if (v != null && !(Number.isFinite(v) && v >= 0)) return; // ввели не число — ничего не меняем
    const k = el.dataset.k;
    setPaid(k, v == null ? null : Math.round(v * 100) / 100);
    const p = payPeriod(fromIso(k));
    const d = document.getElementById(`paid-diff-${k}`);
    if (d) d.innerHTML = paidDiffHtml(payout(p).total, paidOf(p));
  },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) { ev.preventDefault(); fn(el); }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.id === 'lock-code') { ev.preventDefault(); actions.activate(); }
  // На компьютере: стрелки ← → листают день / месяц / период (если не печатаешь и нет окна)
  const tag = (ev.target.tagName || '').toUpperCase();
  if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)
      && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !$sheet.innerHTML.trim() && !mail && ui.tab <= 3) {
    ev.preventDefault();
    navigate(ev.key === 'ArrowLeft' ? -1 : 1);
  }
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
  if (el.dataset.check === 'zabka') { S.settings.zabka = el.checked; metaChanged(); save(); render(); }
  if (el.dataset.field === 'rate-point' || el.dataset.field === 'rate-machine') render();
});

function onTime(el) {
  const which = el.dataset.time;
  const m = parseClock(el.value);
  update(ui.day, (x) => { x[which] = m; });
  refreshDay();
}

/* ===================== Запуск ===================== */
darkMq.addEventListener('change', () => { if (S.settings.theme === 'system') applyTheme(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { renderTop(); checkAccess(); if (offlineLocked()) renderSheet(); syncNow(); presence(true); }
  if (document.visibilityState === 'hidden') presence(false);
  // Уходим из приложения — сразу отправляем неотправленное (только владелец)
  if (document.visibilityState === 'hidden' && hasPendingSync()) syncNow();
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
presence(true);
