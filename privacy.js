/* privacy.js — страница «Конфиденциальность» (10.10.2026, экспертный разбор:
 * политики не было, хотя бот и сайт хранят данные пользователей, а форма заявки
 * собирает контакты). Текст — RU/PL, тот же site-ui.js для темы/языка/профиля.
 * Факты в тексте должны совпадать с кодом: что хранит бот (4.bot/bot.py
 * settings), профиль (profiles.py), счётчик (site_stats.py), лимиты
 * (6.valuate/api.py::_budget_key), сроки копий (backup_settings.py, backup_db.py). */

import { initTheme, initLang, initProfile } from "./site-ui.js?v=202610241540";

const $ = (s) => document.querySelector(s);
const BOT = '<a href="https://t.me/Flats_Warsaw_Bot" target="_blank" rel="noopener">@Flats_Warsaw_Bot</a>';

const T = {
  ru: {
    pv_header: "Конфиденциальность", pv_h1: "Конфиденциальность", pv_date: "Действует с 10.10.2026",
    theme_t: "Светлая / тёмная тема",
    sections: [
      ["Кто отвечает за данные",
       [`Warsaw Flats — некоммерческий проект частного лица (Варшава). Связь по любым вопросам о данных — сообщение боту ${BOT}.`]],
      ["Какие данные мы храним",
       ["<b>Бот:</b> ваш Telegram ID, имя и @username из Telegram, язык, фильтры поиска, адрес для расчёта времени в пути (координаты), избранное, скрытые, «Важно для меня». Сообщения, которые вы пишете боту, пересылаются владельцу сервиса.",
        "<b>Сайт:</b> cookies не используются. Ваши настройки, избранное и заметки хранятся в браузере (localStorage). Если вы входите по личной ссылке из бота, они хранятся и в профиле на сервере вместе с «Моими местами».",
        "<b>Статистика посещений:</b> страница, источник перехода и обезличенный код посетителя — он вычисляется из IP и браузера с секретным ключом и меняется каждый день; сам IP не хранится.",
        "<b>Статистика бота:</b> источник перехода и шаги (запуск, подписка) с обезличенным кодом чата — по нему нельзя узнать ваш Telegram ID. Хранится 180 дней и при удалении данных остаётся: по ней нельзя определить человека.",
        "<b>«Оценить квартиру», «Мои места», время в пути:</b> введённый адрес передаётся для поиска координат сервису OpenStreetMap (Nominatim). Для защиты от злоупотреблений сервер считает запросы по обезличенному коду IP, счётчик обнуляется каждый день.",
        "<b>Форма «Продать или сдать квартиру»:</b> имя, контакты, адрес и описание уходят одним сообщением владельцу сервиса в Telegram; в базе не хранятся."]],
      ["Зачем и на каком основании",
       ["Чтобы присылать подходящие квартиры и показывать ваши списки (RODO, ст. 6 п. 1 b — оказание услуги); чтобы связаться с вами по заявке (ст. 6 п. 1 a — согласие); для обезличенной статистики и защиты от злоупотреблений (ст. 6 п. 1 f — законный интерес). Данные не продаются и не передаются для рекламы."]],
      ["Кому передаются",
       ["Telegram — доставка сообщений бота; GitHub Pages — размещение сайта; Cloudflare — передача запросов к серверу; OpenStreetMap Nominatim — поиск координат по адресу."]],
      ["Сколько хранятся",
       ["Пока вы пользуетесь ботом или профилем. После удаления данные исчезают сразу из рабочей базы, из резервных копий — в течение 8 недель (копии настроек бота — 30 дней). Статистика посещений — 180 дней."]],
      ["Ваши права",
       [`Вы можете узнать, какие данные о вас хранятся, исправить или удалить их, ограничить обработку, возразить против неё и получить копию. Удалить всё сразу: в боте ☰ → «Меню» → Профиль → «Удалить мои данные» или напишите боту ${BOT}. Жалобу можно подать в Urząd Ochrony Danych Osobowych (uodo.gov.pl).`]],
      ["Объявления и источники",
       ["Сервис показывает публичные объявления о продаже квартир со ссылкой на оригинал. Контакты продавцов мы не храним и не показываем. Если вы продавец и хотите убрать своё объявление из сервиса — напишите боту.",
        "Цены сделок — Rejestr Cen Nieruchomości m.st. Warszawy. Карта и данные о районе — © участники OpenStreetMap и открытые данные города."]],
    ],
  },
  pl: {
    pv_header: "Prywatność", pv_h1: "Prywatność", pv_date: "Obowiązuje od 10.10.2026",
    theme_t: "Jasny / ciemny motyw",
    sections: [
      ["Kto odpowiada za dane",
       [`Warsaw Flats to niekomercyjny projekt osoby prywatnej (Warszawa). W sprawach danych pisz do bota ${BOT}.`]],
      ["Jakie dane przechowujemy",
       ["<b>Bot:</b> Twój identyfikator Telegram, imię i @username z Telegrama, język, filtry, adres do liczenia czasu dojazdu (współrzędne), ulubione, ukryte, „Ważne dla mnie”. Wiadomości, które piszesz do bota, trafiają do właściciela serwisu.",
        "<b>Strona:</b> nie używamy cookies. Ustawienia, ulubione i notatki są zapisane w przeglądarce (localStorage). Jeśli logujesz się osobistym linkiem z bota, są też zapisane w profilu na serwerze razem z „Moimi miejscami”.",
        "<b>Statystyka odwiedzin:</b> strona, źródło wejścia i zanonimizowany kod odwiedzającego — liczony z IP i przeglądarki z tajnym kluczem, zmienia się codziennie; samego IP nie przechowujemy.",
        "<b>Statystyka bota:</b> źródło wejścia i kroki (start, subskrypcja) z zanonimizowanym kodem czatu — nie da się z niego odczytać Twojego identyfikatora Telegram. Przechowywana 180 dni i zostaje po usunięciu danych: nie pozwala zidentyfikować osoby.",
        "<b>„Wyceń mieszkanie”, „Moje miejsca”, czas dojazdu:</b> wpisany adres jest przekazywany do usługi OpenStreetMap (Nominatim) w celu znalezienia współrzędnych. Dla ochrony przed nadużyciami serwer liczy zapytania według zanonimizowanego kodu IP, licznik zeruje się codziennie.",
        "<b>Formularz „Sprzedaj lub wynajmij”:</b> imię, kontakt, adres i opis trafiają jedną wiadomością do właściciela serwisu na Telegramie; nie są zapisywane w bazie."]],
      ["Cel i podstawa",
       ["Wysyłanie pasujących mieszkań i pokazywanie Twoich list (RODO, art. 6 ust. 1 lit. b — świadczenie usługi); kontakt w sprawie zgłoszenia (lit. a — zgoda); zanonimizowana statystyka i ochrona przed nadużyciami (lit. f — prawnie uzasadniony interes). Danych nie sprzedajemy i nie przekazujemy do celów reklamowych."]],
      ["Komu przekazujemy",
       ["Telegram — dostarczanie wiadomości bota; GitHub Pages — hosting strony; Cloudflare — przekazywanie zapytań do serwera; OpenStreetMap Nominatim — wyszukiwanie współrzędnych adresu."]],
      ["Jak długo",
       ["Dopóki korzystasz z bota lub profilu. Po usunięciu dane znikają od razu z bazy roboczej, z kopii zapasowych — w ciągu 8 tygodni (kopie ustawień bota — 30 dni). Statystyka odwiedzin — 180 dni."]],
      ["Twoje prawa",
       [`Możesz dowiedzieć się, jakie dane o Tobie przechowujemy, poprawić je lub usunąć, ograniczyć przetwarzanie, sprzeciwić się mu i otrzymać kopię. Usunąć wszystko naraz: w bocie ☰ → „Menu” → Profil → „Usuń moje dane” albo napisz do bota ${BOT}. Skargę możesz złożyć do Prezesa Urzędu Ochrony Danych Osobowych (uodo.gov.pl).`]],
      ["Ogłoszenia i źródła",
       ["Serwis pokazuje publiczne ogłoszenia sprzedaży mieszkań z linkiem do oryginału. Nie przechowujemy i nie pokazujemy kontaktów sprzedających. Jeśli jesteś sprzedającym i chcesz usunąć swoje ogłoszenie z serwisu — napisz do bota.",
        "Ceny transakcji — Rejestr Cen Nieruchomości m.st. Warszawy. Mapa i dane o okolicy — © współtwórcy OpenStreetMap i otwarte dane miasta."]],
    ],
  },
};

function render(tr, lang) {
  $("#pv-body").innerHTML = T[lang].sections.map(([h, ps]) =>
    `<section class="pv-card"><h2>${h}</h2>${ps.length > 1
      ? `<ul>${ps.map((p) => `<li>${p}</li>`).join("")}</ul>` : `<p>${ps[0]}</p>`}</section>`).join("");
  document.title = `Warsaw Flats — ${tr("pv_h1").toLowerCase()}`;
}

initTheme();
initProfile();      // до initLang: тот читает состояние входа (аудит 21.10 — «без входа» у вошедших)
const langApi = initLang(T, (lang, tr) => render(tr, lang));
render(langApi.tr, langApi.lang());
