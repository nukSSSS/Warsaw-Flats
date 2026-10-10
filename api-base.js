/* api-base.js — адрес бэкенда 6.valuate/api.py, один на все страницы
 * (app.js и site-ui.js → /commute*, /geocode, /profile*; valuate.js, list-apartment.js).
 *
 * В исходниках — localhost:5050: так работает локальный serve.py против
 * локального api.py. Опубликованная копия этого файла ДРУГАЯ —
 * 4.bot/publisher.py::_copy_web() пишет вместо неё адрес Cloudflare Quick
 * Tunnel из 6.valuate/tunnel_url.txt. Адрес туннеля меняется при каждом его
 * перезапуске; следит за этим 6.valuate/tunnel_watch.py (перезапускает мёртвый
 * туннель и переопубликовывает сайт с новым адресом). Поэтому адрес туннеля
 * не хранится в git и руками здесь не правится.
 */
export const API_BASE = "https://highlights-fence-delhi-rep.trycloudflare.com";
