/* list-apartment.js — форма заявки «разместить объявление» → POST
 * 6.valuate/api.py::/submit-listing. Автономная страница, тот же дух, что
 * valuate.js: без общего state с app.js, но переиспользует общий site-ui.js
 * для темы/языка/профиля (решение юзера 2026-09-23).
 *
 * Заявка НЕ хранится в БД (осознанное решение MVP, см. докстринг api.py) —
 * уходит одним сообщением в Telegram админу для ручной обработки. Честная
 * форма — риск злоупотребления ниже, чем у автозаполнения по ссылке
 * (valuate.js), но бэкенд всё равно проверяет honeypot (_hp) и дневной
 * лимит по IP — эта страница со своей стороны просто держит _hp реально
 * пустым для людей (см. CSS в list-apartment.html) и ничего с ним не делает
 * до отправки, кроме как включает его значение в payload как есть.
 */

import { initTheme, initLang, initProfile } from "./site-ui.js?v=202610102210";
// Адрес бэкенда: localhost в исходниках, живой адрес туннеля в опубликованной
// копии — см. api-base.js.
import { API_BASE } from "./api-base.js?v=202610102210";

const $ = (s) => document.querySelector(s);

const T = {
  ru: {
    la_header_label: "Разместить объявление",
    theme_t: "Светлая / тёмная тема",
    hero_h1: "Продать или сдать квартиру",
    hero_p: "Заполните форму — заявку посмотрит модератор и свяжется с вами. Объявление на сайте автоматически не публикуется.",
    apt_title: "Квартира",
    type_label: "Что вы хотите сделать", type_sell: "Продать", type_rent: "Сдать",
    address_label: "Адрес квартиры", address_ph: "например, ul. Puławska 10",
    params_title: "Параметры — не обязательно",
    price_label: "Цена, PLN", rooms_label: "Комнаты", area_label: "Площадь, м²",
    desc_label: "Описание",
    desc_ph: "Кратко: состояние, условия продажи или аренды, что важно знать",
    contacts_title: "Контакты",
    name_label: "Как к вам обращаться", name_ph: "Имя",
    phone_label: "Телефон", email_label: "Email",
    contact_hint: "Нужен хотя бы один способ связи — телефон, Telegram или email.",
    submit_btn: "Отправить заявку", submit_busy: "Отправляю…",
    back_link: "← Ко всем квартирам в базе",
    err_name: "Укажите, как к вам обращаться.",
    err_contact: "Укажите хотя бы один способ связи: телефон, Telegram или email.",
    err_address: "Укажите адрес квартиры.",
    err_generic: (status) => `Не удалось отправить заявку (${status}). Попробуйте ещё раз.`,
    err_network: (base) => `Не удалось связаться с сервером (${base}). Проверьте соединение и попробуйте ещё раз.`,
    ok_sent: "Заявка отправлена, мы свяжемся с вами.",
  },
  pl: {
    la_header_label: "Dodaj ogłoszenie",
    theme_t: "Jasny / ciemny motyw",
    hero_h1: "Sprzedaj lub wynajmij mieszkanie",
    hero_p: "Wypełnij formularz — zgłoszenie sprawdzi moderator i skontaktuje się z Tobą. Ogłoszenie nie jest publikowane na stronie automatycznie.",
    apt_title: "Mieszkanie",
    type_label: "Co chcesz zrobić", type_sell: "Sprzedać", type_rent: "Wynająć",
    address_label: "Adres mieszkania", address_ph: "np. ul. Puławska 10",
    params_title: "Parametry — opcjonalnie",
    price_label: "Cena, PLN", rooms_label: "Pokoje", area_label: "Powierzchnia, m²",
    desc_label: "Opis",
    desc_ph: "Krótko: stan, warunki sprzedaży lub najmu, co warto wiedzieć",
    contacts_title: "Kontakt",
    name_label: "Jak się do Ciebie zwracać", name_ph: "Imię",
    phone_label: "Telefon", email_label: "Email",
    contact_hint: "Potrzebny jest przynajmniej jeden sposób kontaktu — telefon, Telegram lub email.",
    submit_btn: "Wyślij zgłoszenie", submit_busy: "Wysyłam…",
    back_link: "← Do wszystkich mieszkań w bazie",
    err_name: "Podaj, jak się do Ciebie zwracać.",
    err_contact: "Podaj przynajmniej jeden sposób kontaktu: telefon, Telegram lub email.",
    err_address: "Podaj adres mieszkania.",
    err_generic: (status) => `Nie udało się wysłać zgłoszenia (${status}). Spróbuj ponownie.`,
    err_network: (base) => `Nie udało się połączyć z serwerem (${base}). Sprawdź połączenie i spróbuj ponownie.`,
    ok_sent: "Zgłoszenie wysłane, skontaktujemy się z Tobą.",
  },
};

let tr = (k) => T.ru[k] ?? k;   // заменится реальным tr() из initLang() ниже

const state = { listingType: "sell" };

function buildTypeToggle() {
  const host = $("#la-type");
  host.querySelectorAll(".chip").forEach((b) => {
    b.onclick = () => {
      host.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      state.listingType = b.dataset.value;
    };
  });
}

function strOrEmpty(id) {
  return $(id).value.trim();
}

function numOrNull(id) {
  const v = $(id).value;
  return v === "" ? null : Number(v);
}

function buildPayload() {
  return {
    contact_name: strOrEmpty("#la-name"),
    contact_phone: strOrEmpty("#la-phone"),
    contact_telegram: strOrEmpty("#la-telegram"),
    contact_email: strOrEmpty("#la-email"),
    listing_type: state.listingType,
    address: strOrEmpty("#la-address"),
    price: numOrNull("#la-price"),
    rooms: numOrNull("#la-rooms"),
    area_m2: numOrNull("#la-area"),
    description: strOrEmpty("#la-description"),
    // Honeypot: реальный человек это поле не видит и не заполняет (см. CSS).
    // Значение просто прокидывается на бэкенд — решение (тихий псевдо-успех
    // без отправки в Telegram) принимает 6.valuate/api.py.
    _hp: strOrEmpty("#la-hp"),
  };
}

function validateFront(p) {
  if (!p.contact_name) return tr("err_name");
  if (!p.contact_phone && !p.contact_telegram && !p.contact_email) {
    return tr("err_contact");
  }
  if (!p.address) return tr("err_address");
  return null;
}

function showMsg(text, kind) {
  const el = $("#la-msg");
  el.hidden = false;
  el.textContent = text;
  el.className = "la-msg " + kind;
}

function clearForm() {
  const form = $("#la-form");
  form.reset();
  // reset() не трогает aria-pressed чипов — возвращаем переключатель типа
  // к дефолту ("Продать") вручную, как и state.listingType.
  $("#la-type").querySelectorAll(".chip").forEach((c) => {
    c.setAttribute("aria-pressed", c.dataset.value === "sell" ? "true" : "false");
  });
  state.listingType = "sell";
}

async function submit(ev) {
  ev.preventDefault();
  const msg = $("#la-msg");
  msg.hidden = true;

  const payload = buildPayload();
  const frontError = validateFront(payload);
  if (frontError) return showMsg(frontError, "err");

  const btn = $("#la-submit");
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = tr("submit_busy");
  try {
    const resp = await fetch(`${API_BASE}/submit-listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || !data.ok) {
      showMsg((data && data.error) || tr("err_generic")(resp.status), "err");
      return;
    }
    showMsg(tr("ok_sent"), "ok");
    clearForm();
  } catch (e) {
    showMsg(tr("err_network")(API_BASE), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}

function init() {
  buildTypeToggle();
  $("#la-form").addEventListener("submit", submit);

  initTheme();
  initProfile();
  const langApi = initLang(T, () => {});
  tr = langApi.tr;
}

init();
