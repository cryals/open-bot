<!-- module-reference:start -->

# Slowmode

![Slowmode — иллюстрация модуля](../../assets/modules/slowmode.png)

Интервал сообщений Discord и ограничения частоты силами бота.

**ID:** `slowmode` · **Процесс:** Bot.

**Зависимости:** `community`.

**События Gateway:** `messages`, `messageContent`.

**Права бота:** `ManageMessages`.

## Команды

| Команда             | Назначение        | Доступ                   |
| ------------------- | ----------------- | ------------------------ |
| `/slowmode status`  | Состояние модуля  | Проверяется обработчиком |
| `/slowmode enable`  | Включить модуль   | Проверяется обработчиком |
| `/slowmode disable` | Выключить модуль  | Проверяется обработчиком |
| `/slowmode discord` | Slowmode: discord | Проверяется обработчиком |
| `/slowmode user`    | Slowmode: user    | Проверяется обработчиком |
| `/slowmode channel` | Slowmode: channel | Проверяется обработчиком |
| `/slowmode off`     | Slowmode: off     | Проверяется обработчиком |

Доступ проверяется по актуальным ролям и правам Discord. У отдельных подкоманд могут быть дополнительные ограничения; справочник не выдаёт полномочий.

[Все модули](../catalog.md) · [Настройка модулей](../community.md)

<!-- module-reference:end -->
