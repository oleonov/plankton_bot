# Validated Strategy Rulebook

Дата: 2026-03-13

Основа этого документа:
- [hypothesis_test_results.md](~/Downloads/tmp_proj/poly_plankton/docs/hypothesis_test_results.md)
- [strategy_reconstruction_evidence_matrix.md](~/Downloads/tmp_proj/poly_plankton/docs/strategy_reconstruction_evidence_matrix.md)
- [algorithm_spec_from_reconstruction.md](~/Downloads/tmp_proj/poly_plankton/docs/algorithm_spec_from_reconstruction.md)

Цель:
- превратить подтверждённые гипотезы в набор правил для будущего алгоритма
- отделить обязательные правила от желательных
- явно зафиксировать, что не нужно копировать у planktonXD

## Как читать этот документ

Правила разделены на три класса:

- `Hard Rule`: правило уже достаточно подтверждено текущей БД и должно считаться базовым ограничением или обязательной логикой
- `Soft Heuristic`: сильная идея, но данных пока недостаточно, чтобы считать её жёстким правилом
- `Not For V1`: то, что не стоит включать в первую реализацию

## Итог по статусам

По формальной проверке:
- `14` гипотез подтверждены
- `2` гипотезы частично подтверждены

Это означает:
- базовый rulebook уже можно собирать
- но не нужно делать вид, что мы знаем точную hidden-реализацию исходного бота

## 1. Что является core-моделью стратегии

Подтверждённая модель:

1. Отбор идёт по `family + regime + horizon`, а не по категории.
2. Новый вход часто начинается с маленького probe.
3. Лучший normal scale-in режим это `2-3` buys.
4. Основной способ монетизации это `SELL` на repricing.
5. Two-sided recycling существует, но только в ограниченном universe.
6. Главный structural leak это open tail inventory.

Иными словами:

`family-first selector + probe-first entry + confirmation scale-in + repricing exit + selective inventory recycling + strict tail suppression`

## 2. Hard Rules

## HR1. Единица отбора должна быть `family + regime + horizon`

Основание:
- `H1` подтверждено
- `H2` частично подтверждено, но direction уже однозначно правильный

Правило:
- нельзя торговать по логике “берём категорию politics/sports/crypto”
- нельзя объединять рынки только по теме
- идентичность family должна включать:
  - family key
  - regime
  - cadence/horizon

Практический смысл:
- `elon-musk-of-tweets` и `elon-musk-of-tweets26` не должны жить под одной логикой
- `bitcoin-above` и `bitcoin-price` не должны считаться одним и тем же правилом входа/выхода

## HR2. Новый universe должен стартовать только с probe-режима

Основание:
- `H4` подтверждено
- `H15` подтверждено

Правило:
- новая family не должна сразу получать большой размер
- первая стадия всегда `probe-only`
- promotion в `scaled mode` допускается только после повторного recycle evidence

Что это значит:
- сначала маленький вход
- потом смотрим, получается ли повторно забирать repricing
- только после этого даём normal scale-in

## HR3. Активное торговое окно по умолчанию: `14:00-21:00 UTC`

Основание:
- `H3` подтверждено

Правило:
- default aggressive mode должен жить в `14:00-21:00 UTC`
- вне этого окна активность должна быть ниже

Поддерживающие цифры:
- `49.24%` всех BUY-initiated legs стартовали именно в этом окне
- avg pnl active window: `$3.06`
- avg pnl off-hours: `$2.23`

Это не значит:
- “вне окна нельзя торговать вообще”

Это значит:
- нельзя считать качество времени суток равномерным

## HR4. Default entry model: `probe first`

Основание:
- `H5` подтверждено

Правило:
- дешёвые входы допустимы как probe / optionality
- дешёвые входы не должны быть основным carrier капитала
- broad cheap spraying запрещён

Поддерживающие цифры:
- cheap buy-leg share `<0.05`: `59.88%`
- cheap open-tail cost share `<0.05`: `68.67%`

Вывод:
- дешёвый вход полезен
- бесконтрольный дешёвый хвост вреден

## HR5. В непроверенной family запрещены one-shot high-price entries

Основание:
- `H6` подтверждено

Правило:
- входы `0.20+` не должны быть одиночными в weak/unproven family
- high-price entry допустим только:
  - в proven family
  - или как часть уже подтверждённой кампании

Поддерживающие цифры:
- one-shot `0.20+`: loss rate `1.52%`, avg pnl `$1.33`
- one-shot `<0.20`: loss rate `0.99%`, avg pnl `$2.09`
- scaled `0.20+`: loss rate `0.45%`, avg pnl `$3.21`

## HR6. Standard scale-in режим: `2-3 buys`

Основание:
- `H7` подтверждено

Правило:
- нормальная логика добора должна быть настроена под `2-3` entries
- `1` buy это probe или single-shot
- `4+` buys это уже conviction mode, не default

Поддерживающие цифры:
- `1 buy`: avg pnl `$1.73`
- `2-3 buys`: avg pnl `$3.20`
- median pnl тоже выше в `2-3 buys`

## HR7. Heavy campaigns разрешать только в proven families

Основание:
- `H8` подтверждено

Правило:
- `4+` buys нельзя разрешать глобально
- heavy mode должен включаться только там, где family уже доказала recycle quality

Поддерживающие цифры:
- heavy in proven families: avg pnl `$5.42`
- heavy in weak families: avg pnl `$3.41`

## HR8. Основной выход строить через repricing, а не через resolution

Основание:
- `H9` подтверждено
- `H10` подтверждено

Правило:
- primary exit path это `SELL`
- resolution / redeem не должен считаться главной моделью монетизации

Поддерживающие цифры:
- SELL volume: `$99,985.85`
- REDEEM payout: `$95.39`
- SELL/REDEEM ratio: `1048x`

## HR9. Exit-логика должна быть нацелена на meaningful repricing

Основание:
- `H10` подтверждено

Правило:
- нельзя проектировать выход как “забери первый минимальный тик и выйди”
- основная exit-логика должна допускать meaningful repricing

Поддерживающие цифры:
- `20-50%` ROI bucket дал `277` winning legs и `+$849.51`
- `100%+` bucket тоже существенный, но это уже не central case

Практический смысл:
- fast exits нужны
- но стратегия не равна микро-скальпу

## HR10. Two-sided trading не должно быть глобальным режимом

Основание:
- `H11` подтверждено

Правило:
- two-sided recycle разрешён только в ограниченном set active families
- нельзя включать его по умолчанию на всём universe

Поддерживающие цифры:
- both-sided markets с non-trivial activity: `276` из `8238`, то есть `3.35%`

Типичный candidate-universe:
- `ethereum-price`
- `btc-updown-4h`
- `donald-trump-of-truth-social-posts`
- `spx-up-or-down`
- `will-iran-name-a-successor-to-khamenei-by`
- `xrp-updown-4h`

## HR11. Основная risk-метрика должна быть tail-adjusted

Основание:
- `H12` подтверждено

Правило:
- family health нельзя считать только по realized pnl
- главная базовая метрика должна быть:

`realized_pnl_fifo - open_tail_cost`

Поддерживающие цифры:
- clean negative pnl: `-$7.73`
- total open tail cost: `$27,647.95`

Это один из самых важных выводов всей работы.

## HR12. Threshold families требуют отдельного tail-control

Основание:
- `H13` подтверждено

Правило:
- threshold markets нельзя торговать без family-level cleanup
- family должна уходить в quarantine, если tail cost съедает realized edge

Поддерживающие цифры:
- среди threshold families с positive realized pnl
- `62.67%` после вычета tail cost становятся отрицательными

## HR13. Длинные sports outright / award / leaderboard families не должны входить в default universe

Основание:
- `H14` частично подтверждено, но cluster risk уже очевиден

Правило:
- не включать season-long sports outrights / awards / leaderboards в default mode
- если они когда-либо будут торговаться, то только в отдельном restricted mode

Почему:
- blanket-blacklist всего sports сегмента БД не доказывает
- но toxic cluster внутри long-dated sports families уже виден явно

## HR14. Remote closed snapshot не является source of truth для полной оценки стратегии

Основание:
- `H16` подтверждено

Правило:
- remote closed positions использовать только как auxiliary source
- primary truth для выводов строить по local FIFO + tail-adjusted analysis

Поддерживающие цифры:
- в remote closed snapshot `1000` rows
- non-positive rows: `0`

## 3. Soft Heuristics

## SH1. Horizon-aware clustering надо усилить отдельной нормализацией topic

Основание:
- `H2` только частично подтверждено

Что это значит:
- direction понятен
- но тема-family matching пока слишком heuristic

Следствие:
- rule логически правильный
- но понадобится отдельный нормализатор topic/horizon, если делать production selector

## SH2. Вне активного окна стратегия не должна выключаться полностью

Основание:
- `H3` подтверждает active window
- но не доказывает, что outside-window edge нулевой

Следствие:
- вне окна нужен reduced mode, а не hard off

## SH3. `100%+` ROI winners должны считаться бонусом, а не базовым target

Основание:
- `H10`

Следствие:
- система должна позволять runner’ам жить дольше
- но не нужно строить default exit around rare outliers

## 4. Прямые запреты

Это то, что в будущей реализации стоит прямо запрещать.

## Z1. Не торговать по категории

Запрет:
- нельзя делать selector вида “берём лучшие категории”

Правильно:
- family-first

## Z2. Не делать one-shot `0.20+` в новой family

Запрет:
- одиночный высокий вход в непроверенной family

Правильно:
- probe first
- confirm
- only then scale

## Z3. Не разрешать unlimited cheap-tail accumulation

Запрет:
- бесконечно копить `<0.05`, особенно `<0.03`

Правильно:
- family dust caps
- global dust caps
- stale pruning

## Z4. Не включать two-sided mode глобально

Запрет:
- “раз он иногда торгует обе стороны, значит так надо делать везде”

Правильно:
- только selective overlay

## Z5. Не считать realized pnl достаточной метрикой

Запрет:
- оценка family только по закрытым профитам

Правильно:
- tail-adjusted family scoring

## Z6. Не держать threshold family активной, если хвост уже съел edge

Запрет:
- продолжать новые входы в family, где `realized_pnl - open_tail_cost < 0`

## Z7. Не смешивать topic и horizon

Запрет:
- переносить параметры между short recurring и long dated variants автоматически

## Z8. Не включать long-dated sports outrights в default mode

Запрет:
- awards
- season winners
- long leaderboard families

## 5. Что должно войти в v1

В `v1` разумно включать только то, что опирается на подтверждённые правила.

### Базовый v1 scope

- family-first selector
- active session bias `14:00-21:00 UTC`
- probe-first entry
- default scale-in `2-3 buys`
- repricing-based exits
- selective two-sided overlay только для proven families
- tail-adjusted family scoring
- threshold-family quarantine logic

## 6. Что не брать в v1

## NF1. Full sports universe

Не брать:
- весь sports сегмент целиком

Если брать:
- только отдельные recurring sub-families после проверки

## NF2. Broad cheap-ticket farming

Не брать:
- отдельный модуль массового cheap accumulation без жёсткого kill logic

## NF3. Topic-level parameter sharing

Не брать:
- схему “если Elon tweets family работала, значит любой Elon tweets horizon тоже работоспособен”

## NF4. Resolution-first strategy

Не брать:
- ядро, завязанное на hold-to-resolution

## 7. Минимальный рабочий алгоритм по этому rulebook

Если свести всё к короткой последовательности, то текущий validated rulebook выглядит так:

1. Выбери market не по категории, а по `family + regime + horizon`.
2. Проверь, proven ли эта family по tail-adjusted history.
3. Если family новая или слабая, разреши только маленький probe.
4. Если family подтверждается, разреши normal scale-in до `2-3` buys.
5. Heavy mode разрешай только в strong proven family.
6. Основной выход делай через repricing и `SELL`.
7. Two-sided recycling включай только в очень ограниченном family universe.
8. После каждого цикла пересчитывай не только realized pnl, но и `open_tail_cost`.
9. Как только хвост съедает edge, family должна попасть в quarantine.

## 8. Самый важный итог

Если говорить совсем прямо, то у planktonXD стоит копировать:
- family-first selection
- probe-first entry
- confirmation scale-in
- repricing exits
- selective recycling

И не стоит копировать:
- слабый контроль хвоста
- one-shot high-price stabs
- broad cheap-ticket accumulation
- long-dated sports inventory graveyards

Это и есть самый практичный вывод всей реконструкции.
