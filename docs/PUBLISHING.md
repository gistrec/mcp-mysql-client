# Публикация и попадание в каталоги

Как выпустить версию и оказаться в каталогах MCP, чтобы сервер находился из Claude, Cursor,
LobeHub и других клиентов. Канонический источник — **официальный реестр MCP**
(`registry.modelcontextprotocol.io`).

## Синхронизация версии (важно)

Версия живёт в **трёх местах и должна совпадать байт в байт**:

- `package.json` → `version`;
- `server.json` → корневой `version`;
- `server.json` → `packages[0].version`.

А `mcpName` в `package.json` должен совпадать с `name` в `server.json`
(`io.github.gistrec/mcp-mysql-client`). Предполётная проверка — все три должны напечатать один и
тот же `X.Y.Z`:

```bash
grep -n '"version"' package.json server.json
grep -n 'mcpName' package.json; grep -n '"name"' server.json
```

> ⚠️ `mcp-publisher` публикует **корневую** `server.json.version`. Если поднять npm и
> `packages[0].version`, но забыть корневую, `npm publish` пройдёт (он читает `package.json`), а
> `mcp-publisher publish` упадёт с обманчивым `400 cannot publish duplicate version` — он
> перепубликовывает старую корневую версию.

> ⚠️ **`description` в `server.json` — не длиннее 100 символов.** Реестр отклоняет длиннее.
> Он намеренно короче `description` из `package.json`; не копируйте тот.

## Релиз (все каналы за один проход)

Публикация только в npm тихо расходится с остальными каналами: `git push --follow-tags` отправляет
тег, но **не** создаёт GitHub Release, а реестр неизменяем по версии — даже правка метаданных
требует бампа.

1. Поднять `version` в трёх местах и записать изменение в `CHANGELOG.md`.
2. `npm publish` — прогонит `typecheck` + `test` + `build` (через `prepublishOnly` / `prepare`).
3. `git commit`, `git tag -a vX.Y.Z -m vX.Y.Z`, `git push origin main --follow-tags`.
4. **GitHub Release:** `gh release create vX.Y.Z --title vX.Y.Z --generate-notes --verify-tag`.
5. **Официальный реестр MCP:**

```bash
brew install mcp-publisher                            # или бинарь из релизов modelcontextprotocol/registry
mcp-publisher logout                                  # логин поверх живого токена его не перевыпустит
mcp-publisher login github --token "$(gh auth token)"
mcp-publisher publish                                 # из корня репозитория, где лежит server.json
```

> ⚠️ JWT реестра живёт **около часа**. Если публикация затянулась после логина — 401; повторите
> `mcp-publisher logout && mcp-publisher login github --token "$(gh auth token)"` прямо перед
> `publish`.

### Что проверяет реестр

- **Пространство имён** — право на `io.github.gistrec/*` доказывается логином под аккаунтом
  `gistrec`. Регистр важен: `io.github.gistrec`, а не `io.github.Gistrec`.
- **Владение npm-пакетом** — поле `mcpName` в **опубликованном** `package.json` (в тарболе npm, а
  не в рабочей копии) сравнивается с `name` из `server.json` посимвольно. Поэтому сначала npm,
  потом реестр.

## Glama

`glama.json` в корне уже лежит. Glama сам обходит GitHub; после релиза стоит проверить, что сервер
проиндексирован и получил оценку — от неё зависит приём PR в списки вида awesome-mcp-servers.

## LobeHub

1. Открыть [lobehub.com/mcp](https://lobehub.com/mcp) → **Submit MCP**.
2. Дать URL репозитория `https://github.com/gistrec/mcp-mysql-client`. LobeHub сам вытянет README,
   список инструментов и конфигурацию установки (`npx -y mcp-mysql-client`).

## Чек-лист перед публикацией

- [ ] `npm test` зелёный (включая `test:dist`)
- [ ] `npm run smoke` прошёл против живой базы
- [ ] Версия синхронизирована в трёх местах, `mcpName` совпадает с `name`
- [ ] `CHANGELOG.md` обновлён
- [ ] `description` в `server.json` ≤ 100 символов
- [ ] README не обещает инструментов, которых нет в `test/dist-smoke.test.js`
