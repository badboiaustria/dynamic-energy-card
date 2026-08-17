# Changelog

## 2.0.0 (2026-08-17)

First public release as **Dynamic EnergyCard** (previously a private card called EnergyCard).

- Renamed card type to `custom:dynamic-energy-card`
- Full i18n: English (default) and German, auto-detected from the Home Assistant
  profile language, overridable via `language:`
- Number and date formatting follow the Home Assistant locale
- Generic defaults everywhere; no installation-specific entities left in the code
- GPL-3.0 license

Feature set at release:

- Animated live energy flow: sources on the inner ring, consumers on the outer
  ring, collision-free force layout, circle size and pulse frequency scale with power
- Auto role switching for bidirectional sensors (battery, grid) with hysteresis
- Groups with expand/collapse, drag & drop pinning, shake to shuffle and
  tilt gravity on mobile devices
- Daily energy panel and storage panel (battery / EV / hot water in kWh + %)
- Virtual "Not monitored" circle for unmetered consumption
- Centre circle shows the sum of all active sources (or a configured entity)
- Visual config editor with unit-filtered entity pickers, Energy dashboard
  import and a bulk power-entity picker
- Demo mode with scenario buttons
