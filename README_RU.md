<p align="center">
  <img src="docs/assets/open-bot-cover.png" alt="Open Bot — управление серверами Discord" width="1000">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README_RU.md"><b>Русский</b></a>
</p>

<p align="center">
  <b>Ваш Discord-сервер. Одна панель управления.</b><br>
  Правила, тикеты, модерация, сообщения и мониторинг — подключайте нужные модули.
</p>

<p align="center">
  <a href="https://github.com/cryals/open-bot/releases/tag/v1.3.0"><img src="docs/assets/badges/status.svg" alt="Релиз 1.3"></a>
  <a href="https://nodejs.org/en/download"><img src="docs/assets/badges/runtime.svg" alt="Node.js 24.18+"></a>
  <a href="docs/user/catalog.md"><img src="docs/assets/badges/discord.svg" alt="Discord Components V2"></a>
  <a href="docs/DOCKER.md"><img src="docs/assets/badges/hosting.svg" alt="Размещение на своём сервере"></a>
  <a href="https://github.com/cryals/open-bot/actions/workflows/check.yml"><img src="docs/assets/badges/checks.svg" alt="CI: открыть реальные запуски"></a>
  <a href="LICENSE"><img src="docs/assets/badges/license.svg" alt="Собственная лицензия проекта"></a>
</p>

---

**Open Bot** — Discord-бот с веб-панелью и модульными slash-командами. Публикуйте правила и сообщения, обрабатывайте тикеты, управляйте модерацией и следите за игровыми серверами. Одна установка обслуживает один Discord-сервер; дополнительные модули выключены до настройки.

## С чего начать

| Пользоваться ботом                                     | Разрабатывать бота                                          |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| **[Документация пользователя →](docs/user/README.md)** | **[Документация разработчика →](docs/developer/README.md)** |
| Установка, права, работа с панелью и резервные копии.  | Архитектура, модули, команды, метрики и внесение изменений. |

[Все модули и команды](docs/user/catalog.md) · [Что вошло в релиз 1.3](docs/RELEASE-1.3.md)

## Команды под рукой

<p align="center">
  <img src="docs/assets/readme-commands-1.3.png" alt="Команды Open Bot: /help — модули, /ping — задержка, /send-info — публикация информации" width="1000">
</p>

`/help` показывает доступные вам команды. `/ping` сообщает задержку. Администратор через `/send-info` отправляет **опубликованную** версию информации. Остальные команды и требования к доступу — [на страницах модулей](docs/user/catalog.md).

<p align="center">
  <img src="docs/assets/readme-monitoring-1.3.png" alt="Мониторинг SS14, SS13, Minecraft, Terraria TShock и Project Zomboid; управление питанием Watchdog — только для SS14" width="1000">
</p>

`/server-status` поддерживает **SS14, SS13, Minecraft Java/Bedrock, Terraria TShock и Project Zomboid**. `/watchdog` выполняет подтверждённые действия питания **SS14**. [Настройка серверов и требования протоколов →](docs/user/game-servers.md)

_Иллюстрации с командами — оформление. Настоящие скриншоты панели находятся [в руководствах](docs/user/README.md)._

## Зависимости и стек

Нужны **Node.js 24.18+**, Discord-приложение с ботом, данные OAuth и доступная для записи папка данных. Redis необязателен. Подпискам нужны ключи соответствующих платформ; Docker-варианту — работающий Docker Engine.

**TypeScript · discord.js 14 · Components V2 · Fastify · React · Vite · SQLite / Drizzle · Redis Streams · Prometheus / Grafana · MkDocs Material**

## Запуск

```sh
git clone https://github.com/cryals/open-bot.git
cd open-bot
npm ci
cp .env.example .env
```

Заполните `BOT_TOKEN`, `GUILD_ID`, `CLIENT_ID`, `CLIENT_SECRET` и `REDIRECT` в `.env`. В PowerShell используйте `Copy-Item .env.example .env`. Зарегистрируйте точный callback URL в Discord Developer Portal, затем:

```sh
npm run build
npm start
```

Откройте [localhost:3000](http://localhost:3000) или адрес с выбранным `PORT`, войдите через Discord и настройте доступ и модули в панели.

**[Полная инструкция установки →](docs/user/setup.md)** · **[Docker и HTTPS →](docs/DOCKER.md)** · **[Запуск для разработки →](docs/developer/workflow.md)**

## Лицензия и юридическая информация

© 2026 cryals и участники проекта. [Open Bot Project License 1.0](LICENSE) — **собственная лицензия с доступным исходным кодом**. Разрешено частное некоммерческое использование; публичное размещение, использование сообществами, распространение и коммерческое использование требуют предварительного письменного разрешения cryals.

[Сторонние компоненты](THIRD_PARTY_NOTICES.md) · [Происхождение иллюстраций](docs/ARTWORK.md) · Вопросы лицензирования: **support@stopco.ru**.

Open Bot — независимый проект, не связанный с Discord Inc. Названия Discord и игр принадлежат их правообладателям. Лицензия проекта не заменяет условия сторонних компонентов. Не публикуйте токены бота и секреты OAuth.
