# Open Bot в Docker

[README](https://github.com/cryals/open-bot/blob/main/README.md) · [На русском](https://github.com/cryals/open-bot/blob/main/README_RU.md) · [Эксплуатация](OPERATIONS.md)

## Быстрый запуск

Нужны Docker Engine с Compose v2 или Docker Desktop в режиме Linux containers. Node.js на хосте не требуется: зависимости, веб-панель и сервер собираются в образе.

```sh
git clone https://github.com/cryals/open-bot.git
cd open-bot
cp .env.example .env
```

В PowerShell последняя команда — `Copy-Item .env.example .env`.

Заполните в `.env`:

```dotenv
BOT_TOKEN=токен_бота
GUILD_ID=id_сервера
CLIENT_ID=id_приложения
CLIENT_SECRET=секрет_OAuth
PORT=3000
REDIRECT=http://localhost:3000/auth/discord/callback
```

В Discord Developer Portal добавьте точный `REDIRECT` в **OAuth2 → Redirects**. Бот должен быть установлен на сервер с доступом к нужным каналам; права описаны в [инструкции](OPERATIONS.md#подключение-discord).

```sh
docker compose up -d --build
docker compose logs -f --tail=100 open-bot
```

Панель: [http://localhost:3000](http://localhost:3000). При другом `PORT` измените адрес и callback в Discord. Обычный `Ctrl+C` в просмотре логов не останавливает контейнер.

Если существующий `.env` находится в родительской папке, копировать секреты не требуется:

```sh
docker compose --env-file ../.env up -d --build
```

Тот же `--env-file ../.env` указывайте в следующих командах Compose. Переменные передаются контейнеру при запуске; сам `.env` не включается в образ и не монтируется в контейнер.

## Что входит

| Файл                                                                                          | Назначение                                                                                  |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Dockerfile](https://github.com/cryals/open-bot/blob/main/Dockerfile)                         | Сборка Node.js 24, TypeScript и Vite; отдельный runtime без компилятора и dev-зависимостей. |
| [compose.yaml](https://github.com/cryals/open-bot/blob/main/compose.yaml)                     | Бот, веб-панель, постоянный том, ограничения ресурсов и политика перезапуска.               |
| [compose.https.yaml](https://github.com/cryals/open-bot/blob/main/compose.https.yaml)         | Дополнительный Caddy для публичного домена и HTTPS.                                         |
| [docker/Caddyfile](https://github.com/cryals/open-bot/blob/main/docker/Caddyfile)             | HTTPS-прокси к веб-панели.                                                                  |
| [docker/start.sh](https://github.com/cryals/open-bot/blob/main/docker/start.sh)               | Блокировка тома и запуск существующего супервизора.                                         |
| [docker/healthcheck.mjs](https://github.com/cryals/open-bot/blob/main/docker/healthcheck.mjs) | Проверка готовности через `/api/health`.                                                    |
| [.dockerignore](https://github.com/cryals/open-bot/blob/main/.dockerignore)                   | В контекст сборки попадают только необходимые исходники.                                    |

Образ использует Debian Bookworm и официальный `node:24-bookworm-slim`. `better-sqlite3` устанавливается внутри Linux; при отсутствии подходящего готового бинарного файла он собирается на стадии build. Windows-каталог `node_modules` не переносится в контейнер.

Внутри контейнера работает супервизор с отдельными Bot и Web. Приложение запускается пользователем `node` с UID/GID `1000:1000`; корневая файловая система доступна только для чтения. Запись разрешена в том данных и временный `/tmp`.

При каждом старте удерживается системная `flock`-блокировка тома. Только получив её, стартовый скрипт убирает старый PID-файл супервизора: PID из предыдущего контейнера нельзя использовать для определения живого процесса в новом контейнере. Два контейнера с одним томом не запускают двух супервизоров. Не открывайте одну базу одновременно из контейнера и отдельной установки на хосте; используйте локальный Docker volume, а не общий сетевой диск.

## Порты и настройки

| Переменная              | В Docker                                                           |
| ----------------------- | ------------------------------------------------------------------ |
| `PORT`                  | Публикуемый порт хоста; по умолчанию `3000`. Внутри всегда `3000`. |
| `BIND_ADDRESS`          | Интерфейс хоста; по умолчанию `127.0.0.1`.                         |
| `REDIRECT`              | Внешний адрес callback, который открывает браузер.                 |
| `MEMORY_LIMIT`          | Лимит памяти контейнера; по умолчанию `1g`.                        |
| `DOMAIN`                | Публичный домен для варианта с Caddy, без схемы и пути.            |
| `TRUST_PROXY`           | По умолчанию `false`; вариант с Caddy задаёт `true`.               |
| `LOG_ID`, `LOG_WEBHOOK` | Основной канал и резервный вебхук отчётов об ошибках.              |

Compose задаёт `HOST=0.0.0.0` и `DATABASE_PATH=/app/data/open-bot.sqlite` внутри контейнера. Значения этих двух переменных из локального `.env` не переносятся. `APP_ORIGIN` не передаётся: production-панель использует origin из `REDIRECT`.

По умолчанию порт доступен только на самом хосте — это подходит для локального запуска или внешнего reverse proxy. Для публикации порта на всех интерфейсах задайте `BIND_ADDRESS=0.0.0.0`. Если панель открывается извне, используйте внешний HTTPS-адрес в `REDIRECT`.

На VPS для небольшой установки выделите хотя бы 1 ГБ памяти для приложения и дополнительную память на сборку. Внутренний лимит V8 рабочих процессов и `MEMORY_LIMIT` — разные ограничения.

## HTTPS одной дополнительной конфигурацией

1. Направьте DNS-записи домена на сервер с Docker.
2. Освободите и откройте входящие TCP-порты `80` и `443`. UDP `443` используется для HTTP/3.
3. Задайте в `.env`, например:

   ```dotenv
   DOMAIN=bot.example.com
   REDIRECT=https://bot.example.com/auth/discord/callback
   BIND_ADDRESS=127.0.0.1
   ```

4. Зарегистрируйте этот `REDIRECT` в Discord.
5. Запустите оба файла:

   ```sh
   docker compose -f compose.yaml -f compose.https.yaml up -d --build
   ```

Панель откроется по `https://bot.example.com`. Caddy получает и обновляет сертификат; его данные сохраняются в отдельных томах. Исходящий доступ к Discord и центру сертификации должен быть доступен.

При этом варианте во всех дальнейших командах добавляйте `-f compose.yaml -f compose.https.yaml`, чтобы Compose управлял и ботом, и Caddy. Например:

```sh
docker compose -f compose.yaml -f compose.https.yaml logs -f --tail=100
```

Если на сервере уже работает Nginx, Caddy или другой HTTPS-прокси, используйте основной `compose.yaml`, направьте свой прокси на `127.0.0.1:PORT` и задайте `TRUST_PROXY=true` для доверенного прокси.

## Данные и резервные копии

Compose также запускает `redis:8-alpine` с AOF и отдельным томом `redis-data`. Порт 6379 не публикуется на хосте. Для уже существующего Redis задайте `REDIS_URL`; встроенный сервис можно не поднимать командой `docker compose up -d --build open-bot`. Значения URL с паролями остаются секретами.

Redis хранит Stream журнала; SQLite остаётся основной базой. Для событий используется постоянный `activity-outbox/` в томе приложения. При сбое Redis Bot записывает дисковые события пакетами напрямую. Политика Redis `noeviction` запрещает незаметно вытеснять очередь при достижении 128 МБ; отказ записи включает локальный режим. Контейнер Redis имеет лимит памяти 256 МБ дополнительно к лимиту Open Bot. Приложение не ждёт Redis для старта и не требует его для healthcheck.

Детали ACK, дедупликации, задержки журнала и восстановления описаны в [эксплуатации](OPERATIONS.md#пакетный-журнал-и-redis). Если нужен атомарный снимок SQLite и локальной очереди, остановите приложение перед копированием тома. Снимок Redis для восстановления событий не обязателен, если SQLite и outbox скопированы согласованно.

Именованный том `open-bot-data` монтируется в `/app/data`. При стандартном имени Compose-проекта его имя на хосте — `open-bot_open-bot-data`. Там сохраняются база, вложения, сессии, журналы, очередь ошибок и резервные копии.

`docker compose up --build`, пересоздание контейнера и обычный `docker compose down` сохраняют том. Команда `down -v` удаляет тома и данные — для обычной остановки не добавляйте `-v`.

Создать резервную копию работающей установки:

```sh
docker compose exec open-bot node dist/server/scripts/backup.js
docker compose cp open-bot:/app/data/backups/. ./backups
```

Это тот же скрипт резервного копирования, что и в обычной установке, но скомпилированный в JavaScript: `tsx` и dev-зависимости в runtime не нужны. Копии на хосте в `backups/` исключены из Git. Храните копии и вне Docker-хоста.

### Перенос существующей установки или восстановление

1. Создайте резервную копию исходной установки и перенесите её на новый хост. Папка снимка должна содержать `open-bot.sqlite` и соответствующие каталоги вложений и журналов.
2. Остановите исходную установку перед переключением на новую, чтобы не держать два бота с одним токеном и разными базами.
3. На новом хосте с новым пустым томом соберите образ:

   ```sh
   docker compose build open-bot
   ```

4. Скопируйте содержимое снимка в том, подставив реальное имя папки вместо `SNAPSHOT`:

   ```sh
   docker compose run --rm --no-deps --entrypoint sh --volume ./backups/SNAPSHOT:/restore:ro open-bot -c 'cp -R /restore/. /app/data/'
   ```

5. Запустите `docker compose up -d` и проверьте вход и сохранённые публикации.

Команда копирования выполняется пользователем приложения, поэтому не требует ручного `chown` тома. На Linux файлы копии должны быть доступны для чтения UID `1000`. Этот порядок рассчитан на пустой том. В существующую базу нельзя подмешивать старые SQLite `-wal`/`-shm`; полный порядок восстановления и сохранения текущих данных описан в [эксплуатации](OPERATIONS.md#резервные-копии-и-восстановление).

## Обновление и управление

Перед обновлением создайте резервную копию. Затем:

```sh
git pull --ff-only
docker compose up -d --build
docker compose ps
```

Чтобы также обновить базовый образ Node, перед пересборкой используйте `docker compose build --pull`, затем `docker compose up -d`.

Полезные команды:

```sh
docker compose logs -f --tail=100 open-bot
docker compose restart open-bot
docker compose stop
docker compose start
docker compose down
```

Изменения `.env` применяйте через `docker compose up -d`: простой `restart` не пересоздаёт окружение контейнера.

## Готовность и диагностика

Healthcheck обращается к `http://127.0.0.1:3000/api/health` внутри контейнера. Статус зависит от готовности бота, поэтому недоступность Discord также даёт `unhealthy`.

`restart: unless-stopped` перезапускает завершившийся контейнер и поднимает его после перезапуска Docker, если он не был остановлен вручную. Сам статус `unhealthy` не запускает контейнер заново; рабочие процессы восстанавливает внутренний супервизор.

Проверка синтаксиса Compose без вывода токенов:

```sh
docker compose config --quiet
```

Не публикуйте полный вывод `docker compose config` или `docker inspect`: в окружении есть секреты. Если CLI сообщает, что Docker daemon недоступен, сначала запустите Docker Engine или Docker Desktop. Если порт занят существующей установкой, остановите её либо измените `PORT` и `REDIRECT`.

## Справочные источники

[Многостадийная сборка Docker](https://docs.docker.com/build/building/multi-stage/), [переменные Compose](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/), [постоянные тома](https://docs.docker.com/engine/storage/volumes/), [политика перезапуска](https://docs.docker.com/engine/containers/start-containers-automatically/), [Caddy в Compose](https://caddyserver.com/docs/running#docker-compose).

## Ticket и мониторинг

Ticket включается через события сообщений в настройках приложения и Message Content Intent в Developer Portal. Подготовьте отдельный закрытый служебный канал и права управления каналами/ветками по [руководству](user/tickets.md). `ticket-files/` сохраняется в томе вместе с SQLite и входит в backup.

Для SS14 и Watchdog задайте разрешённые хосты в настройках приложения. Секрет `WATCHDOG_TOKEN_MAIN` остаётся в ENV. Дополнительные `WATCHDOG_TOKEN_*` явно добавляйте в `services.open-bot.environment` своего override-файла; произвольные переменные хоста контейнер не получает.

При включении метрик в панели нужен `METRICS_TOKEN` от 32 символов. Внутри контейнера exporter слушает `0.0.0.0:9091`, на хосте Compose публикует `${METRICS_BIND_ADDRESS:-127.0.0.1}:${METRICS_PORT:-9091}`. Подключите существующий Prometheus; Grafana и Prometheus не добавляются в Compose. Пример scrape и dashboard описаны в [метриках](user/metrics.md).

Документация MkDocs Material собирается отдельно и не включается в образ приложения. Python требуется только для сборки вики.
