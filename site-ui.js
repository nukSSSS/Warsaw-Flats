// site-ui.js — общий модуль для новых страниц (homepage/market/valuate/
// list-apartment): тема, переключатель языка (RU/PL) и кнопка профиля.
//
// Общий файл вместо копии в каждой странице: тема уже была продублирована
// один в один в homepage.js/market.js, дублировать туда же ещё и язык, и
// профиль было бы той же ошибкой в третий и четвёртый раз. Свой, более
// простой набор функций — а не импорт app.js целиком: там логика карты и
// списка квартир, которой здесь нет, а словарь языка и меню профиля жёстко
// привязаны к разметке app.html (см. #tabs/#flt-panel/т.п.).
//
// Профиль на этих страницах ТОЛЬКО читает избранное/скрытые (wf_fav/
// wf_hidden в localStorage) — сами страницы туда ничего не пишут, эти
// списки наполняются на app.html. Пункты меню — обычные ссылки на
// app.html?view=fav / app.html?view=hidden (сам параметр view= разбирает
// app.js::readUrl(), см. правку там и комментарий рядом с ней).
//
// Внешний файл, не инлайн-скрипт: CSP всех четырёх страниц — script-src
// 'self' без 'unsafe-inline', инлайн-скрипт эти страницы не пропустят.

export function initTheme() {
  const btn = document.getElementById("theme");
  if (!btn) return;
  try {
    const saved = localStorage.getItem("wf_theme");
    const theme = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
    btn.setAttribute("aria-pressed", String(theme === "dark"));
  } catch {}
  btn.onclick = () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    btn.setAttribute("aria-pressed", String(next === "dark"));
    try { localStorage.setItem("wf_theme", next); } catch {}
  };
}

/* T — {ru:{...}, pl:{...}}, свой на каждой странице (текст там разный).
 * onChange(lang, tr) — необязательный хук для текста, которого нет в
 * разметке как data-i18n* (например, текст, который страница сама
 * генерирует в JS — сообщения об ошибках, подписи результата). Вызывается
 * и сразу при загрузке (с сохранённым языком), и при каждом переключении.
 *
 * ?lang= в адресе главнее localStorage — тот же паритет, что в app.js
 * (комментарий там: «бот шлёт lang= осознанно, под язык подписчика»). Без
 * этого будущая диплинк-ссылка бота на любую из этих страниц игнорировала
 * бы выбранный подписчиком язык. */
export function initLang(T, onChange) {
  const btn = document.getElementById("lang");
  let LANG;
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "pl" || q === "ru") {
    LANG = q;
  } else {
    try { LANG = localStorage.getItem("wf_lang") || "ru"; } catch { LANG = "ru"; }
  }
  const tr = (k) => (T[LANG] && T[LANG][k] !== undefined ? T[LANG][k] : T.ru[k]) ?? k;

  function apply() {
    document.documentElement.lang = LANG;
    if (btn) btn.textContent = LANG === "ru" ? "PL" : "RU";
    document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = tr(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = tr(el.dataset.i18nPh); });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = tr(el.dataset.i18nTitle); });
    document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", tr(el.dataset.i18nAria)); });
    if (onChange) onChange(LANG, tr);
  }

  if (btn) {
    btn.onclick = () => {
      LANG = LANG === "ru" ? "pl" : "ru";
      try { localStorage.setItem("wf_lang", LANG); } catch {}
      // lang= в адресе — та же ссылка на эту страницу дальше открывается
      // на выбранном языке (скопировал/переслал — язык не потерялся).
      const p = new URLSearchParams(location.search);
      p.set("lang", LANG);
      history.replaceState(null, "", `?${p}`);
      apply();
    };
  }
  apply();
  return { lang: () => LANG, tr };
}

/* Кнопка профиля — избранное/скрытые. Разметка (#profile/#profile-btn/
 * #profile-menu/#menu-fav/#menu-hidden/#profile-dot) — тот же набор
 * id/классов, что в app.html, ради переиспользования CSS из app.css без
 * своих правил. Открытие/закрытие — тот же приём, что и в app.js:
 * stopPropagation внутри меню, закрытие кликом где угодно ещё. */
export function initProfile() {
  const btn = document.getElementById("profile-btn");
  const menu = document.getElementById("profile-menu");
  if (!btn || !menu) return;

  function counts() {
    let fav = 0, hidden = 0;
    try { fav = (JSON.parse(localStorage.getItem("wf_fav") || "[]") || []).length; } catch {}
    try { hidden = (JSON.parse(localStorage.getItem("wf_hidden") || "[]") || []).length; } catch {}
    return { fav, hidden };
  }

  function refreshBadges() {
    const { fav, hidden } = counts();
    const favBtn = document.getElementById("menu-fav");
    const hiddenBtn = document.getElementById("menu-hidden");
    if (favBtn) {
      const b = favBtn.querySelector(".menu-badge");
      if (b) { b.hidden = fav === 0; b.textContent = String(fav); }
    }
    if (hiddenBtn) {
      const b = hiddenBtn.querySelector(".menu-badge");
      if (b) { b.hidden = hidden === 0; b.textContent = String(hidden); }
    }
    const dot = document.getElementById("profile-dot");
    if (dot) dot.hidden = !(fav || hidden);
  }

  function setOpen(on) {
    menu.hidden = !on;
    btn.setAttribute("aria-expanded", String(on));
  }

  btn.onclick = (e) => { e.stopPropagation(); setOpen(menu.hidden); };
  menu.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => setOpen(false));

  refreshBadges();
}
