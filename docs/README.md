# Документация Open Bot

**[Релиз 1.0](RELEASE-1.0.md).** Выберите руководство по своей задаче.

## Пользователю

Настройка установки, работа с панелью и ежедневное обслуживание.

- [Начать пользоваться](user/README.md)
- [Установка и первый вход](user/setup.md)
- [Правила и информационное сообщение](user/rules.md)
- [Сообщения от имени бота](user/messages.md)
- [Тикеты и закрытые обсуждения](user/tickets.md)
- [Игровые серверы SS14](user/game-servers.md)
- [Watchdog](user/watchdog.md)
- [Prometheus и Grafana](user/metrics.md)
- [Модули сообщества и настройки](user/community.md)
- [Каталог модулей](user/catalog.md)
- [Журнал, версии и восстановление](user/logs.md)
- [Slash-команды](user/commands.md)
- [Решение проблем](user/troubleshooting.md)

## Разработчику

Устройство приложения, расширение модулей и выпуск изменений.

- [Войти в проект](developer/README.md)
- [Архитектура и хранение данных](developer/architecture.md)
- [Создание и обслуживание модулей](developer/modules.md)
- [Журнал, ошибки и метрики](developer/telemetry.md)
- [Контракты тикетов и внешних сервисов](developer/integrations.md)
- [Устройство модулей сообщества](developer/community.md)
- [Разработка, проверка и выпуск](developer/workflow.md)
- [Проектные навыки Codex](developer/skills.md)

## Справочники

[Переменные окружения и эксплуатация](OPERATIONS.md) · [Docker Compose](DOCKER.md) · [Runtime](MODULES.md) · [Производительность](PERFORMANCE.md)

Одна установка обслуживает один Discord-сервер. Open Bot публикует сообщения и правила, ведёт журнал административных действий. Состав выпуска и отдельно запланированные расширения указаны в [tasks.md](https://github.com/cryals/open-bot/blob/main/tasks.md).

Отдельная вики на MkDocs Material имеет поиск и навигацию пользователя/разработчика. Workflow Documentation собирает artifact и публикует через GitHub Pages при доступности этой функции. Веб-панель не обслуживает вики. Markdown доступен в репозитории независимо от Pages. Иллюстрации сняты в FakeDiscord.
