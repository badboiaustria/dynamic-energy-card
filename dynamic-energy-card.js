/**
 * Dynamic EnergyCard – animated live energy-flow card for Home Assistant
 * https://github.com/badboiaustria/dynamic-energy-card
 *
 * Copyright (C) 2026  Michael Böhm
 * Licensed under the GNU General Public License v3.0 (GPL-3.0).
 * This program comes with ABSOLUTELY NO WARRANTY; see the LICENSE file.
 *
 * A single file, no build step. Vanilla web component, hybrid rendering:
 * an SVG layer (links, flow dots, fill rings) plus an HTML layer (circles,
 * icons, labels, pulse rings). Custom mini force simulation (fixed 60 Hz
 * timestep with render interpolation, critically damped springs).
 *
 * Highlights:
 * - Sources on the inner ring, consumers on the outer ring, collision-free
 * - Circle size and pulse frequency scale with live power
 * - Groups that expand/collapse, drag & drop pinning, shake to shuffle,
 *   tilt gravity on mobile devices
 * - Daily energy panel, storage panel (battery / EV / hot water in kWh + %),
 *   virtual "Not monitored" circle for unmetered consumption
 * - English and German UI, visual config editor with filtered entity pickers
 *
 * Example configuration (Lovelace YAML):
 *
 *   type: custom:dynamic-energy-card
 *   language: en                # en | de (default: Home Assistant profile)
 *   inverter:
 *     name: Inverter
 *     icon: mdi:engine
 *     color: '#1565C0'
 *     size: 90                  # centre circle diameter in px
 *     power_entity: sensor.house_consumption   # optional; default = sum of sources
 *   options:
 *     max_power: 20000          # W for 2.5x size / max pulse frequency
 *     min_circle_px: 60         # circle diameter at 0 W
 *     pulse_hz_min: 0.5
 *     pulse_hz_max: 10
 *     visual_pulse_cap_hz: 3    # visible pulse cap (0 = uncapped)
 *     dots_max: 60
 *     zero_threshold_w: 25      # dead zone: below this P = 0
 *   stats:                      # daily energy panel (top left)
 *     grid_import: sensor.grid_import_daily
 *     grid_export: sensor.grid_export_daily
 *     pv: sensor.pv_energy_daily
 *     battery_in: sensor.battery_charged_daily
 *     battery_out: sensor.battery_discharged_daily
 *   storage:                    # storage panel below the daily values
 *     show: true
 *     items:
 *       - name: Battery
 *         soc_entity: sensor.battery_soc                  # % directly
 *         capacity_entity: sensor.battery_capacity        # Wh/kJ/kWh auto-converted
 *       - name: Hot water
 *         temp_entity: sensor.boiler_temperature          # temperature mapping
 *         temp_min: 20            # °C = 0 %
 *         temp_max: 80            # °C = 100 %
 *         capacity_kwh: 30        # kWh at 100 %
 *   residual:                   # virtual circle for unmetered consumers
 *     show: true                #   = sum of sources − known consumers
 *   groups:
 *     - id: wallboxes
 *       name: Wallboxes
 *       icon: mdi:ev-station
 *       color: '#AB47BC'
 *   nodes:
 *     - id: pv
 *       name: PV
 *       icon: mdi:solar-power
 *       color: '#FDB813'
 *       power_entity: sensor.pv_power
 *       role: source            # source | consumer | auto (+ = source)
 *     - id: battery
 *       name: Battery
 *       icon: mdi:battery-high
 *       color: '#4CAF50'
 *       power_entity: sensor.battery_net_power
 *       role: auto
 *       ring: fill              # fill ring instead of pulse ring
 *       fill_entity: sensor.battery_soc
 *       fill_min: 0
 *       fill_max: 100
 *       inner_text_entity: sensor.battery_soc
 *       inner_text_unit: '%'
 *     - id: wallbox_1
 *       name: Wallbox
 *       group: wallboxes
 *       power_entity: sensor.wallbox_power
 *       toggle_entity: switch.wallbox
 *   demo: false                 # true = simulation mode with scenario buttons
 */
(() => {
  'use strict';
  if (customElements.get('dynamic-energy-card')) return;

  const VERSION = '2.0.0';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const STEP = 1 / 60;          // fester Physik-Timestep (s)
  const MAX_STEPS = 4;          // Schutz gegen "spiral of death"
  const DT_CLAMP = 0.05;        // s – Deckel nach Tab-Rückkehr
  const ROLE_DEBOUNCE_MS = 2000;
  const TEXT_THROTTLE_MS = 500;
  const LABEL_GAP = 4;

  // Physik-Konstanten (im POC getunt)
  const K_RAD = 42, C_RAD = 2 * Math.sqrt(K_RAD);
  const K_MEM = 80, C_MEM = 2 * Math.sqrt(K_MEM);
  const K_SPREAD = 7.0;         // v1.3: schwächer, treibt Kreis-Karussell weniger an
  const K_HOME = 2.2, C_HOME = 7.0; // v1.3: Tangentialdämpfung deutlich erhöht
  const HOME_DEADBAND = 0.03;   // rad – darunter keine Rückstellkraft (Sleep!)
  const VEL_DAMP = 0.985;       // v1.3: stärkere Grunddämpfung gegen Endlos-Kreisen
  const SLEEP_MOVE = 0.03;      // px Netto-Bewegung/Step – darunter gilt "still"
  const SLEEP_TICKS = 45;

  // Neigung (deviceorientation) & Schütteln (devicemotion)
  const TILT_DEAD_DEG = 8;      // Totzone – normales Halten driftet nicht
  const TILT_SAT_DEG = 42;      // ab hier volle Fallbeschleunigung
  const TILT_ACCEL = 2600;      // px/s² bei voller Neigung
  const TILT_SOFT = 0.12;       // Feder-Restanteil, solange Neigung aktiv ist
  const SHAKE_THRESH = 11;      // m/s² Abweichung von 1 g zählt als Ruck
  const SHAKE_REARM = 6;        // m/s² – erst darunter wird der nächste Ruck scharf
  const SHAKE_COUNT = 3;        // getrennte Rucke im Fenster → Schütteln erkannt
  const SHAKE_WINDOW_MS = 900;
  const SHAKE_COOLDOWN_MS = 1500;

  /* ============================== i18n =============================== */
  // Embedded translations. English is the reference; missing keys fall back
  // to English. The card resolves the language from config.language or the
  // Home Assistant profile language. PRs for new languages are welcome.
  const TRANSLATIONS = {
    en: {
      shuffle: 'Shuffle', shuffle_title: 'Rearrange circles randomly (releases pins)',
      stop: 'Stop animation', stop_title: 'Halt all motion (breaks rotation loops)',
      hide_values: 'Hide values', show_values: 'Show values',
      toggle_values_title: 'Show/hide the tables on the left',
      grid_import: 'Grid import', grid_export: 'Grid export', pv_yield: 'PV yield',
      battery_in: 'Battery charged', battery_out: 'Battery discharged',
      energy_total: 'Energy used', storage: 'Storage', sum: 'Total',
      power: 'Power', energy: 'Energy', energy_today: 'Energy today',
      turn_on: 'Turn on', turn_off: 'Turn off',
      not_monitored: 'Not monitored', inverter: 'Inverter',
      demo_pv: 'PV drops', demo_batt: 'Battery flips', demo_wallbox: 'Wallbox 11 kW',
      demo_peak: 'Peak 20 kW', demo_flutter: 'Fluttering grid', demo_auto: 'Auto',
      sec_setup: 'Setup', sec_options: 'Options', sec_storage: 'Storage',
      sec_groups: 'Groups', sec_devices: 'Devices',
      demo_mode: 'Demo mode ', show_clock: 'Show clock ', show_stats: 'Show energy values ',
      show_residual: '"Not monitored" circle ', show_storage: 'Show storage panel ',
      import_energy: 'Import from Energy dashboard', load_power: 'Load all power entities',
      name_filter: 'Name filter', pick_new: 'Pick new power entities',
      pick_new_title: 'List all watt entities and add them individually',
      close: 'Close', add: 'Add', cancel: 'Cancel',
      add_group: '+ Group', add_storage: '+ Storage', new_group_ph: 'New group…',
      del: 'Delete', name: 'Name', group: 'Group', no_group: '(no group)',
      color: 'Color', icon_lbl: 'Icon (mdi:…)', role: 'Role',
      role_consumer: 'Consumer', role_source: 'Source', role_auto: 'auto (+ = source)',
      energy_entity: 'Energy entity (optional)', toggle_entity: 'Toggle entity (optional)',
      st_soc: 'SoC level (%)', st_temp: 'or temperature (°C)',
      st_range: 'Temp range °C (0 % / 100 %)', st_cap_entity: 'Capacity entity',
      st_cap_title: 'Capacity in kWh (leave empty if a capacity entity is set)',
      st_new: 'New storage', st_default: 'Storage',
      no_groups: 'No groups yet.', no_storage: 'No storage yet – create one with "+ Storage".',
      no_devices: 'No devices yet – import them or use YAML.',
      no_conn: 'No Home Assistant connection.', reading_energy: 'Reading Energy dashboard…',
      no_stat_rate: 'No power sensors (stat_rate) found in the Energy dashboard.',
      imported: '{n} nodes imported.', import_failed: 'Import failed: ',
      loaded_n: '{n} power entities loaded.', nothing_new: 'Nothing new found (filter: "{f}").',
      invalid_json: 'Invalid JSON at "{n}": ', added_x: '"{n}" added.',
      enter_group_name: 'Enter a group name.', picker_header: 'New power entities (W/kW)',
      none_found: 'No new power entities found – everything is already configured.',
      expected_object: 'Expected an object',
      storage_hint: 'Per storage: level as a SoC entity (%) OR a temperature entity with a '
        + 'range (e.g. 20–80 °C), plus a capacity as a number (kWh) or an entity '
        + '(Wh, kJ, MJ, kWh are converted automatically). The number wins; a row '
        + 'without capacity or level is ignored.',
      devices_hint: 'Per device: name, group, delete – and below a JSON field for everything '
        + 'else (color, icon, role, ring sector fill_entity/fill_min/fill_max, text inside '
        + 'the circle, popup/toggle entities). Empty = defaults. See the placeholder.',
      f_max_power: 'Max power in W (100 % size/frequency)', f_min_circle: 'Min circle diameter (px)',
      f_size_factor: 'Max size factor (× min size)', f_pulse_min: 'Pulse frequency min (Hz)',
      f_pulse_max: 'Pulse frequency max (Hz)', f_pulse_cap: 'Visible pulse cap (Hz, 0 = off)',
      f_dots: 'Max flow dots total', f_deadzone: 'Dead zone (W)',
      f_density: 'Density (0.5 loose … 2 tight)', f_width: 'Width (px, empty = auto, "max")',
      f_height: 'Height (px, empty = auto, "max")',
      f_grid_import: 'Grid import energy (entity, kWh)', f_grid_export: 'Grid export energy (entity, kWh)',
      f_pv: 'PV yield energy (entity, kWh)', f_battery_in: 'Battery charged energy (entity, kWh)',
      f_battery_out: 'Battery discharged energy (entity, kWh)',
      f_center_size: 'Centre diameter (px)', f_center_icon: 'Centre icon (mdi:…)',
      f_center_color: 'Centre color', f_center_entity: 'Centre power entity',
    },
    de: {
      shuffle: 'Neu mischen', shuffle_title: 'Kreise zufällig neu anordnen (löst Fixierungen)',
      stop: 'Stopp Animation', stop_title: 'Bewegung anhalten (bricht Dreh-Schleifen)',
      hide_values: 'Werte ausblenden', show_values: 'Werte einblenden',
      toggle_values_title: 'Tabellen links ein-/ausblenden',
      grid_import: 'Netzbezug', grid_export: 'Netzeinspeisung', pv_yield: 'PV-Ertrag',
      battery_in: 'Batterie Einspeisung', battery_out: 'Batterie Bezug',
      energy_total: 'Energienutzung', storage: 'Speicher', sum: 'Summe',
      power: 'Leistung', energy: 'Energie', energy_today: 'Energie heute',
      turn_on: 'Einschalten', turn_off: 'Ausschalten',
      not_monitored: 'Nicht überwacht', inverter: 'Wechselrichter',
      demo_pv: 'PV bricht ein', demo_batt: 'Batterie dreht um', demo_wallbox: 'Wallbox 11 kW',
      demo_peak: 'Peak 20 kW', demo_flutter: 'Flatter-Netz', demo_auto: 'Auto',
      sec_setup: 'Setup', sec_options: 'Optionen', sec_storage: 'Speicher',
      sec_groups: 'Gruppen', sec_devices: 'Geräte',
      demo_mode: 'Demo-Modus ', show_clock: 'Uhr anzeigen ', show_stats: 'Energie-Werte anzeigen ',
      show_residual: 'Kreis "Nicht überwacht" ', show_storage: 'Speicher-Panel anzeigen ',
      import_energy: 'Aus Energie-Dashboard importieren', load_power: 'Alle Leistungs-Entities laden',
      name_filter: 'Namensfilter', pick_new: 'Neue Leistungs-Entities einlesen',
      pick_new_title: 'Alle Watt-Entities anzeigen und einzeln konfiguriert hinzufügen',
      close: 'Schließen', add: 'Hinzufügen', cancel: 'Abbrechen',
      add_group: '+ Gruppe', add_storage: '+ Speicher', new_group_ph: 'Neue Gruppe…',
      del: 'Löschen', name: 'Name', group: 'Gruppe', no_group: '(keine Gruppe)',
      color: 'Farbe', icon_lbl: 'Icon (mdi:…)', role: 'Rolle',
      role_consumer: 'Verbraucher', role_source: 'Quelle', role_auto: 'auto (+ = Quelle)',
      energy_entity: 'Energie-Entity (optional)', toggle_entity: 'Schalt-Entity (optional)',
      st_soc: 'Ladestand SoC (%)', st_temp: 'oder Temperatur (°C)',
      st_range: 'Temp-Bereich °C (0 % / 100 %)', st_cap_entity: 'Kapazitäts-Entity',
      st_cap_title: 'Kapazität in kWh (leer lassen, wenn Kapazitäts-Entity gesetzt)',
      st_new: 'Neuer Speicher', st_default: 'Speicher',
      no_groups: 'Noch keine Gruppen.', no_storage: 'Noch keine Speicher – mit "+ Speicher" anlegen.',
      no_devices: 'Noch keine Geräte – per Import laden oder YAML nutzen.',
      no_conn: 'Keine HA-Verbindung.', reading_energy: 'Lese Energie-Dashboard…',
      no_stat_rate: 'Keine Leistungssensoren (stat_rate) im Energie-Dashboard gefunden.',
      imported: '{n} Knoten importiert.', import_failed: 'Import fehlgeschlagen: ',
      loaded_n: '{n} Leistungs-Entities geladen.', nothing_new: 'Nichts Neues gefunden (Filter: "{f}").',
      invalid_json: 'Ungültiges JSON bei "{n}": ', added_x: '"{n}" hinzugefügt.',
      enter_group_name: 'Gruppennamen eingeben.', picker_header: 'Neue Leistungs-Entities (W/kW)',
      none_found: 'Keine neuen Leistungs-Entities gefunden – alles bereits konfiguriert.',
      expected_object: 'Objekt erwartet',
      storage_hint: 'Pro Speicher: Ladestand als SoC-Entity (%) ODER Temperatur-Entity mit '
        + 'Bereich (z. B. 20–80 °C), dazu Kapazität als Zahl (kWh) oder als Entity '
        + '(Wh, kJ, MJ, kWh werden automatisch umgerechnet). Die Zahl hat Vorrang; '
        + 'ohne Kapazität und ohne Ladestand wird die Zeile ignoriert.',
      devices_hint: 'Pro Gerät: Name, Gruppe, Löschen – und darunter ein JSON-Feld für alles '
        + 'Weitere (Farbe, Icon, role, Kreissektor fill_entity/fill_min/fill_max, Text im '
        + 'Kreis, Popup-/Schalt-Entities). Leer = Standard. Beispiel siehe Platzhalter.',
      f_max_power: 'Max. Leistung in W (100 % Größe/Frequenz)', f_min_circle: 'Kreis-Mindestdurchmesser (px)',
      f_size_factor: 'Max. Größenfaktor (× Mindestgröße)', f_pulse_min: 'Pulsfrequenz min (Hz)',
      f_pulse_max: 'Pulsfrequenz max (Hz)', f_pulse_cap: 'Sichtbarer Puls-Deckel (Hz, 0 = aus)',
      f_dots: 'Max. Fluss-Punkte gesamt', f_deadzone: 'Totzone (W)',
      f_density: 'Dichte (0.5 locker … 2 eng)', f_width: 'Breite (px, leer = auto, "max")',
      f_height: 'Höhe (px, leer = auto, "max")',
      f_grid_import: 'Energie Netzbezug (Entity, kWh)', f_grid_export: 'Energie Netzeinspeisung (Entity, kWh)',
      f_pv: 'Energie PV-Ertrag (Entity, kWh)', f_battery_in: 'Energie Batterie Einspeisung (Entity, kWh)',
      f_battery_out: 'Energie Batterie Bezug (Entity, kWh)',
      f_center_size: 'Zentrum-Durchmesser (px)', f_center_icon: 'Zentrum-Icon (mdi:…)',
      f_center_color: 'Zentrum-Farbe', f_center_entity: 'Zentrum-Leistungs-Entity',
    },
  };
  // Resolve 'en'/'de' from an explicit config value or the HA profile language
  function resolveLang(hass, cfgLang) {
    const raw = cfgLang
      || (hass && hass.locale && hass.locale.language)
      || (hass && hass.language) || 'en';
    const l = String(raw).toLowerCase().slice(0, 2);
    return TRANSLATIONS[l] ? l : 'en';
  }
  function makeT(lang) {
    const d = TRANSLATIONS[lang] || TRANSLATIONS.en;
    return (key) => d[key] != null ? d[key] : (TRANSLATIONS.en[key] != null ? TRANSLATIONS.en[key] : key);
  }

  /* ============================== Utils ============================== */

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const wrapAngle = (a) => {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  };

  // Locale-aware number formatting; one set per card instance, derived from
  // the HA profile language (falls back to the browser locale).
  function makeFormatters(locale) {
    const nf = (opts) => {
      try { return new Intl.NumberFormat(locale, opts); }
      catch (e) { return new Intl.NumberFormat(undefined, opts); }
    };
    const kw = nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const w = nf({ maximumFractionDigits: 0 });
    const kwh = nf({ minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const power = (v) => {
      const a = Math.abs(v);
      if (a >= 1000) return kw.format(a / 1000) + ' kW';
      return w.format(a) + ' W';
    };
    // Signed: export/charging (negative) carries a minus sign
    const powerSigned = (v) => (v < 0 ? '-' : '') + power(v);
    const energy = (v) => kwh.format(v) + ' kWh';
    return { power, powerSigned, energy };
  }

  // Unity-SmoothDamp: kritisch gedämpfte Feder, framerate-unabhängig.
  function smoothDamp(cur, target, vel, smoothTime, dt) {
    smoothTime = Math.max(1e-4, smoothTime);
    const omega = 2 / smoothTime;
    const x = omega * dt;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    let change = cur - target;
    const temp = (vel + omega * change) * dt;
    let newVel = (vel - omega * temp) * exp;
    let newVal = (cur - change) + (change + temp) * exp;
    if ((target - cur > 0) === (newVal > target)) { newVal = target; newVel = 0; }
    return [newVal, newVel];
  }

  const _measureCtx = document.createElement('canvas').getContext('2d');
  const _textWidthCache = new Map();
  function textWidth(text, font) {
    const key = font + '|' + text;
    let w = _textWidthCache.get(key);
    if (w === undefined) {
      _measureCtx.font = font;
      w = _measureCtx.measureText(text).width;
      if (_textWidthCache.size > 800) _textWidthCache.clear();
      _textWidthCache.set(key, w);
    }
    return w;
  }

  // null = Entity fehlt oder unavailable/unknown (unterscheidbar von echten 0 W)
  function parsePowerState(st) {
    if (!st) return null;
    const v = parseFloat(st.state);
    if (!isFinite(v)) return null;
    const unit = (st.attributes && st.attributes.unit_of_measurement) || 'W';
    return /kW/i.test(unit) ? v * 1000 : v;
  }

  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function div(cls, parent) {
    const el = document.createElement('div');
    if (cls) el.className = cls;
    if (parent) parent.appendChild(el);
    return el;
  }

  /* =========================== Force-Sim ============================ */

  class ForceSim {
    constructor() {
      this.nodes = [];        // alle sichtbaren Knoten (Top-Level + expandierte Member)
      this.cx = 0; this.cy = 0;
      this.availA = 150; this.availB = 150;
      this.invFoot = 20;
      this.boundsW = 300; this.boundsH = 300; this.boundsBottomPad = 0; this.boundsTopPad = 0;
      this.spreadFactor = 1.12;
      this.gravX = 0; this.gravY = 0;  // Neigungs-Gravitation (px/s²)
      this.sleeping = false;
      this._stillTicks = 0;
    }

    setViewport(w, h, invFoot, bottomPad, topPad) {
      this.cx = w / 2; this.cy = h / 2;
      this.availA = Math.max(60, w / 2 - 12);
      this.availB = Math.max(60, h / 2 - 12);
      this.boundsW = w; this.boundsH = h;
      this.boundsBottomPad = bottomPad || 0;
      this.boundsTopPad = topPad || 0;
      this.invFoot = invFoot;
      this.wake();
    }

    // Ellipsenradius (Zieldistanz) bei Winkel theta für Ringanteil frac
    ellipseDist(theta, frac) {
      const a = this.availA, b = this.availB;
      const ct = Math.cos(theta), st = Math.sin(theta);
      return frac * (a * b) / Math.max(1, Math.hypot(b * ct, a * st));
    }

    wake() { this.sleeping = false; this._stillTicks = 0; }

    step(dt) {
      if (this.sleeping) return;
      const nodes = this.nodes;
      const cx = this.cx, cy = this.cy;

      // Positionen für Render-Interpolation sichern
      for (const n of nodes) { n.px = n.x; n.py = n.y; }

      // Neigungs-Gravitation: solange aktiv, werden die Layout-Federn stark
      // abgeschwächt (nur Restanteil TILT_SOFT), damit die Kreise wirklich
      // zum Kartenrand "fallen" können. Dämpfungen bleiben voll erhalten.
      const gx = this.gravX, gy = this.gravY;
      const gravOn = Math.abs(gx) + Math.abs(gy) > 1;
      const soft = gravOn ? TILT_SOFT : 1;

      // --- Kräfte ---
      for (const n of nodes) {
        if (n.pinned) { n.vx = 0; n.vy = 0; continue; } // fixierte Kreise bewegen sich nicht
        let fx = 0, fy = 0;
        if (n.groupNode && n.groupNode.expanded) {
          // Gruppen-Mitglied: 2D-Feder zum Fächer-Ziel
          fx = -K_MEM * soft * (n.x - n.fanX) - C_MEM * n.vx;
          fy = -K_MEM * soft * (n.y - n.fanY) - C_MEM * n.vy;
        } else {
          const dx = n.x - cx, dy = n.y - cy;
          const d = Math.max(1, Math.hypot(dx, dy));
          const ex = dx / d, ey = dy / d;
          const theta = Math.atan2(dy, dx);
          const rt = this.ellipseDist(theta, n.ringFrac);
          const vd = n.vx * ex + n.vy * ey;           // Radialgeschwindigkeit
          const fr = -K_RAD * soft * (d - rt) - C_RAD * vd;  // kritisch gedämpfte Radialfeder
          fx += fr * ex; fy += fr * ey;

          // Heimwinkel-Rückstellung. Die Totzone gilt nur für die Rückstell-
          // KRAFT; die Tangential-DÄMPFUNG wirkt immer – sonst pumpt die
          // Spreizkraft an der Totzonen-Kante einen Grenzzyklus auf (Kreise
          // "drehen sich" endlos langsam im Ring).
          const tx = -ey, ty = ex;                    // Tangente
          const vt = n.vx * tx + n.vy * ty;
          const dTheta = wrapAngle(n.homeAngle - theta);
          let ft = -C_HOME * vt;
          if (Math.abs(dTheta) > HOME_DEADBAND) ft += K_HOME * soft * dTheta * d;
          fx += ft * tx; fy += ft * ty;
        }
        fx += gx; fy += gy;
        n.vx += fx * dt; n.vy += fy * dt;
      }

      // Winkel-Spreizkraft pro Ring (nur Top-Level); beim "Fallen" aus,
      // sonst rührt sie im Haufen am Rand endlos um
      if (!gravOn) {
        this._spread(this._ringList('source'), dt);
        this._spread(this._ringList('consumer'), dt);
      }

      // --- Integration ---
      for (const n of nodes) {
        if (n.pinned) continue;
        n.vx *= VEL_DAMP; n.vy *= VEL_DAMP;
        n.x += n.vx * dt; n.y += n.vy * dt;
      }

      // --- Kollisionsauflösung (Footprints, 2 Iterationen) ---
      for (let it = 0; it < 2; it++) {
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          // gegen Wechselrichter (statisch)
          this._separateStatic(a, cx, cy, this.invFoot);
          for (let j = i + 1; j < nodes.length; j++) {
            this._separate(a, nodes[j]);
          }
        }
        // Kartenränder (invertierte Intervalle abfangen: Footprint größer als
        // Karte). Beim Klemmen wird die in die Wand gerichtete Geschwindigkeit
        // genullt, sonst hält Dauer-Gravitation maxV hoch.
        for (const n of nodes) {
          const r = n.foot.r;
          let loX = r + 2, hiX = this.boundsW - r - 2;
          if (loX > hiX) loX = hiX = this.boundsW / 2;
          const nx = clamp(n.x, loX, hiX);
          if (nx !== n.x) {
            if ((nx === loX && n.vx < 0) || (nx === hiX && n.vx > 0)) n.vx = 0;
            n.x = nx;
          }
          const fy0 = n.y + n.foot.offY;
          let loY = this.boundsTopPad + r + 2, hiY = this.boundsH - this.boundsBottomPad - r - 2;
          if (loY > hiY) loY = hiY = (this.boundsTopPad + this.boundsH - this.boundsBottomPad) / 2;
          const ny = clamp(fy0, loY, hiY);
          if (ny !== fy0) {
            if ((ny === loY && n.vy < 0) || (ny === hiY && n.vy > 0)) n.vy = 0;
            n.y = ny - n.foot.offY;
          }
        }
      }

      // Sleep-Kriterium: NETTO-Positionsänderung nach Kollision/Clamp (nicht
      // Geschwindigkeit). Wandgepinnte oder im Haufen eingeklemmte Knoten
      // (Dauer-Neigung) stehen netto still, tragen aber Rest-v und internen
      // Druck-Churn – sie dürfen trotzdem einschlafen. Echte Auflösung erzeugt
      // immer Netto-Bewegung und hält die Sim wach.
      let maxMove = 0;
      for (const n of nodes) {
        const m = Math.abs(n.x - n.px) + Math.abs(n.y - n.py);
        if (m > maxMove) maxMove = m;
      }
      // Im gepressten Rand-Haufen (aktive Neigung) bleibt eine unsichtbare
      // Mikro-Zirkulation von ~0.07 px/Step – dort großzügigere Schwelle.
      if (maxMove < (gravOn ? 4 * SLEEP_MOVE : SLEEP_MOVE)) {
        if (++this._stillTicks > SLEEP_TICKS) {
          this.sleeping = true;
          for (const n of nodes) { n.vx = 0; n.vy = 0; } // kein v-Burst beim Aufwachen
        }
      } else {
        this._stillTicks = 0;
      }
    }

    _ringList(role) {
      const out = [];
      for (const n of this.nodes) {
        if (n.groupNode && n.groupNode.expanded) continue;
        if (n.role === role) out.push(n);
      }
      return out;
    }

    _spread(list, dt) {
      if (list.length < 2) return;
      const cx = this.cx, cy = this.cy;
      list.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
      for (let i = 0; i < list.length; i++) {
        const a = list[i], b = list[(i + 1) % list.length];
        const ta = Math.atan2(a.y - cy, a.x - cx);
        const tb = Math.atan2(b.y - cy, b.x - cx);
        let gap = tb - ta;
        if (i === list.length - 1) gap += 2 * Math.PI;
        const da = Math.max(30, Math.hypot(a.x - cx, a.y - cy));
        const db = Math.max(30, Math.hypot(b.x - cx, b.y - cy));
        const needed = (Math.asin(Math.min(0.9, a.foot.r / da)) + Math.asin(Math.min(0.9, b.foot.r / db))) * this.spreadFactor;
        const deficit = needed - gap;
        if (deficit > 0.005) {
          const f = K_SPREAD * deficit;
          // a gegen Uhrzeigersinn, b im Uhrzeigersinn wegdrücken
          const axT = -(a.y - cy) / da, ayT = (a.x - cx) / da;
          const bxT = -(b.y - cy) / db, byT = (b.x - cx) / db;
          a.vx -= f * axT * da * dt; a.vy -= f * ayT * da * dt;
          b.vx += f * bxT * db * dt; b.vy += f * byT * db * dt;
        }
      }
    }

    _separate(a, b) {
      if (a.pinned && b.pinned) return; // zwei fixierte Kreise bleiben, wo sie sind
      const ax = a.x, ay = a.y + a.foot.offY;
      const bx = b.x, by = b.y + b.foot.offY;
      let dx = bx - ax, dy = by - ay;
      let d = Math.hypot(dx, dy);
      const min = a.foot.r + b.foot.r;
      if (d >= min || min <= 0) return;
      if (d < 0.01) { dx = 1; dy = 0; d = 0.01; }
      const overlap = min - d;
      const ux = dx / d, uy = dy / d;
      if (a.pinned) {
        // fixierter Kreis ist unverrückbar – der andere weicht voll aus
        b.x += ux * overlap; b.y += uy * overlap;
      } else if (b.pinned) {
        a.x -= ux * overlap; a.y -= uy * overlap;
      } else {
        const push = overlap / 2;
        a.x -= ux * push; a.y -= uy * push;
        b.x += ux * push; b.y += uy * push;
      }
      // aufeinander zulaufende Geschwindigkeit killen (nur bewegliche Kreise)
      const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
      const vn = rvx * ux + rvy * uy;
      if (vn < 0) {
        if (!a.pinned) { a.vx += ux * vn * 0.5; a.vy += uy * vn * 0.5; }
        if (!b.pinned) { b.vx -= ux * vn * 0.5; b.vy -= uy * vn * 0.5; }
      }
    }

    _separateStatic(n, sx, sy, sr) {
      if (n.pinned) return;
      const nx = n.x, ny = n.y + n.foot.offY;
      let dx = nx - sx, dy = ny - sy;
      let d = Math.hypot(dx, dy);
      const min = n.foot.r + sr;
      if (d >= min) return;
      if (d < 0.01) { dx = 0; dy = -1; d = 1; }
      const push = min - d;
      n.x += (dx / d) * push; n.y += (dy / d) * push;
    }
  }

  /* =========================== Demo-Engine =========================== */

  class DemoEngine {
    constructor(card) {
      this.card = card;
      this.timer = null;
      this.osc = null;       // Flatter-Szenario
      this.peakT = null;     // Peak-Rückramp-Timeout
      this.auto = true;
      this.items = new Map(); // nodeId -> {val, target, rate}
      this.socDir = 1;
    }

    start() {
      const card = this.card;
      for (const n of card._allNodes()) {
        if (n.kind === 'group' && n.cfg.power === 'sum') continue;
        if (n.cfg.residual) continue; // "Nicht überwacht" wird immer berechnet
        let base = 0;
        if (n.role === 'source') base = 6000 + Math.random() * 3000;
        else if (n.roleMode === 'auto') base = (Math.random() < 0.5 ? -1 : 1) * (800 + Math.random() * 2200);
        else base = Math.random() < 0.4 ? 0 : 40 + Math.random() * 500;
        this.items.set(n.id, { val: base, target: base, rate: 4000 });
      }
      this.timer = setInterval(() => this._tick(), 200);
      this._tick();
    }

    stop() {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (this.osc) { clearInterval(this.osc); this.osc = null; }
      if (this.peakT) { clearTimeout(this.peakT); this.peakT = null; }
    }

    scenario(name) {
      const card = this.card;
      const nodes = card._allNodes();
      const first = (pred) => nodes.find(pred);
      this.auto = false;
      if (name === 'pv') {
        const n = first((x) => x.role === 'source' && x.roleMode !== 'auto');
        if (n) this._ramp(n.id, 400, 5);
      } else if (name === 'batt') {
        const n = first((x) => x.roleMode === 'auto' && x.cfg.ring === 'fill') || first((x) => x.roleMode === 'auto');
        if (n) {
          const it = this.items.get(n.id);
          const to = (it && it.val > 0) ? -2500 : 3500;
          this._ramp(n.id, to, 5);
          this.socDir = to > 0 ? -1 : 1;
        }
      } else if (name === 'wallbox') {
        const n = first((x) => x.groupNode);
        if (n) { this._set(n.id, 11000); if (!n.groupNode.expanded) card._toggleGroup(n.groupNode); }
      } else if (name === 'peak') {
        const n = first((x) => x.roleMode === 'consumer' && !x.groupNode && !x.cfg.residual);
        if (n) {
          this._set(n.id, 20000);
          if (this.peakT) clearTimeout(this.peakT);
          this.peakT = setTimeout(() => { this.peakT = null; this._ramp(n.id, 900, 4); }, 4000);
        }
      } else if (name === 'flutter') {
        const n = first((x) => x.roleMode === 'auto' && x.cfg.ring !== 'fill') || first((x) => x.roleMode === 'auto');
        if (n) {
          const id = n.id;
          const t0 = performance.now();
          if (this.osc) clearInterval(this.osc);
          this.osc = setInterval(() => {
            const t = (performance.now() - t0) / 1000;
            if (t > 6) { clearInterval(this.osc); this.osc = null; this._ramp(id, 1500, 3); return; }
            this._set(id, Math.sin(t * Math.PI * 2 * 4) * 30);
          }, 120);
        }
      } else if (name === 'autoOn') {
        this.auto = true;
      }
    }

    toggleNode(node) {
      const it = this.items.get(node.id);
      if (!it) return;
      if (Math.abs(it.target) > 5) { it.prev = it.target; it.target = 0; }
      else it.target = it.prev != null ? it.prev : 300;
      it.rate = 8000;
    }

    _set(id, w) { const it = this.items.get(id); if (it) { it.target = w; it.rate = 1e9; } }
    _ramp(id, w, secs) {
      const it = this.items.get(id);
      if (it) { it.target = w; it.rate = Math.max(50, Math.abs(w - it.val) / secs); }
    }

    _tick() {
      const card = this.card;
      if (this.auto && Math.random() < 0.06) {
        const keys = [...this.items.keys()];
        const id = keys[(Math.random() * keys.length) | 0];
        const node = card._nodeById(id);
        const it = this.items.get(id);
        if (node && it) {
          if (node.role === 'source' && node.roleMode !== 'auto') it.target = 2000 + Math.random() * 10000;
          else if (node.roleMode === 'auto') it.target = (Math.random() < 0.5 ? -1 : 1) * Math.random() * 5000;
          else it.target = Math.random() < 0.3 ? 0 : Math.random() * 3000;
          it.rate = 300 + Math.random() * 3000;
        }
      }
      const dt = 0.2;
      for (const [id, it] of this.items) {
        const node = card._nodeById(id);
        if (!node) continue;
        const d = it.target - it.val;
        const step = clamp(d, -it.rate * dt, it.rate * dt);
        it.val += step;
        card._setNodePower(node, it.val);
        if (node.cfg.ring === 'fill') {
          node.fillTarget = clamp((node.fillTarget != null ? node.fillTarget * 100 : 53) + this.socDir * 0.05, 5, 98) / 100;
          node.innerTextNext = Math.round(node.fillTarget * 100) + ' %';
        }
      }
      card._afterDataPass();
    }
  }

  /* ============================ Die Karte ============================ */

  class EnergyCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._configRaw = null;
      this._config = null;
      this._hass = null;
      this._built = false;
      this._nodes = [];        // Top-Level (Geräte ohne Gruppe + Gruppen)
      this._byId = new Map();
      this._tracked = new Map(); // entity_id -> [node-refs mit Rolle]
      this._sim = new ForceSim();
      this._raf = 0;
      this._running = false;
      this._lastTs = null;
      this._acc = 0;
      this._visible = true;
      this._inViewport = true;
      this._reduced = false;
      this._shrink = 1; this._shrinkVel = 0; this._shrinkTarget = 1;
      this._lastSolve = 0;
      this._lastDotMgmt = 0;
      this._w = 0; this._h = 0;
      this._demo = null;
      this._popupNode = null;
      this._popupPinned = false;
      this._panelsHidden = false;  // left tables toggled via button
      this._abort = null;
      // i18n: language + locale, refined once config/hass are known
      this._lang = 'en';
      this._locale = undefined;
      this._t = makeT('en');
      this._fmt = makeFormatters(undefined);
      // Neigung/Schütteln
      this._tiltRef = null;      // Neutrallage {b,g} – erstes Sensor-Event
      this._tiltLast = null;
      this._shakeFirstAt = -1e9;
      this._shakeCount = 0;
      this._shakeLastFire = -1e9;
      this._shakeArmed = true;
      this._motionPermAsked = false;
      this._tickBound = (ts) => this._tick(ts);
    }

    /* ------------------------- Lovelace-API ------------------------- */

    setConfig(config) {
      const raw = JSON.stringify(config);
      if (raw === this._configRaw) return;
      this._config = this._normalizeConfig(config); // wirft bei Fehlern – Raw erst danach committen
      this._configRaw = raw;
      this._footPad = 6 / this._config.options.density;
      this._sim.spreadFactor = 1 + 0.12 / this._config.options.density;
      this._applyLang();
      if (this._built) this._teardownDom();
      this._buildModel();
      this._buildDom();
      if (this.isConnected) this._ensureLoop();
    }

    set hass(hass) {
      const old = this._hass;
      this._hass = hass;
      if (!this._config) return;
      // First hass may change the resolved language → rebuild once (model too,
      // so translated default names like "Not monitored" follow along)
      if (this._built && this._applyLang()) {
        this._teardownDom();
        this._buildModel();
        this._buildDom();
        return;
      }
      if (this._config.demo) return; // demo mode ignores live data
      if (!old) { this._readAllEntities(); this._afterDataPass(); return; }
      let changed = false;
      for (const [id, refs] of this._tracked) {
        if (old.states && hass.states && old.states[id] !== hass.states[id]) {
          for (const ref of refs) this._readEntityRef(ref);
          changed = true;
        }
      }
      if (changed) this._afterDataPass();
    }

    get hass() { return this._hass; }

    // Resolve language + number/date locale from config.language and the HA
    // profile; returns true when it changed (the DOM must be rebuilt then)
    _applyLang() {
      const lang = resolveLang(this._hass, this._config && this._config.language);
      const locale = (this._hass && this._hass.locale && this._hass.locale.language) || lang;
      if (lang === this._lang && locale === this._locale) return false;
      this._lang = lang;
      this._locale = locale;
      this._t = makeT(lang);
      this._fmt = makeFormatters(locale);
      return true;
    }

    getCardSize() { return 6; }
    getGridOptions() { return { columns: 12, rows: 8, min_columns: 6, min_rows: 4 }; }
    getLayoutOptions() { return { grid_columns: 12, grid_rows: 8, grid_min_columns: 6, grid_min_rows: 4 }; }

    static getConfigElement() {
      return document.createElement('dynamic-energy-card-editor');
    }

    static getStubConfig() {
      return {
        demo: true,
        groups: [{ id: 'g1', name: 'Geräte', icon: 'mdi:power-plug', color: '#AB47BC' }],
        nodes: [
          { id: 'pv', name: 'PV', icon: 'mdi:solar-power', color: '#FDB813', role: 'source' },
          { id: 'grid', name: 'Netz', icon: 'mdi:transmission-tower', color: '#9E9E9E', role: 'auto' },
          { id: 'batt', name: 'Batterie', icon: 'mdi:battery-high', color: '#4CAF50', role: 'auto', ring: 'fill' },
          { id: 'home', name: 'Haus', icon: 'mdi:home', color: '#42A5F5', role: 'consumer' },
          { id: 'd1', name: 'Gerät 1', icon: 'mdi:power-plug', color: '#FF7043', group: 'g1' },
          { id: 'd2', name: 'Gerät 2', icon: 'mdi:power-plug', color: '#26C6DA', group: 'g1' },
        ],
      };
    }

    connectedCallback() {
      this._abort = new AbortController();
      const sig = this._abort.signal;
      document.addEventListener('visibilitychange', () => {
        this._visible = !document.hidden;
        this._lastTs = null;
        this._gate();
      }, { signal: sig });
      document.addEventListener('pointerdown', (ev) => {
        if (this._popupPinned && !ev.composedPath().includes(this)) this._hidePopup(true);
      }, { signal: sig });
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') this._hidePopup(true);
      }, { signal: sig });

      const mq = matchMedia('(prefers-reduced-motion: reduce)');
      this._reduced = mq.matches;
      mq.addEventListener('change', (e) => { this._reduced = e.matches; }, { signal: sig });

      // Neigung + Schütteln (Mobilgeräte). Ohne Sensoren feuern die Events
      // nie – Desktop bleibt unberührt. iOS 13+ verlangt eine Permission,
      // die nur aus einer User-Geste heraus angefragt werden darf.
      window.addEventListener('deviceorientation', (e) => this._onTilt(e), { signal: sig });
      window.addEventListener('devicemotion', (e) => this._onShake(e), { signal: sig });
      const needsPerm =
        (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') ||
        (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function');
      if (needsPerm) {
        this.addEventListener('pointerdown', () => this._askMotionPermission(), { once: true, signal: sig });
      }

      this._io = new IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        this._inViewport = last ? last.isIntersecting : true;
        this._lastTs = null;
        this._gate();
      }, { rootMargin: '100px' });
      this._io.observe(this);

      // Uhr im Sekundentakt nachführen (geschrieben wird nur bei Minutenwechsel)
      this._clockTimer = setInterval(() => this._updateClock(), 1000);
      this._updateClock();

      if (this._built && this._config && this._config.demo && !this._demo) {
        this._demo = new DemoEngine(this);
        this._demo.start();
      }
      // ResizeObserver nach Re-Parenting (HA hängt Karten routinemäßig um) wiederherstellen
      if (this._built && !this._ro) {
        this._ro = new ResizeObserver(() => this._onResize());
        this._ro.observe(this._wrapEl);
        this._onResize();
      }
      if (this._built) this._ensureLoop();
    }

    disconnectedCallback() {
      if (this._abort) { this._abort.abort(); this._abort = null; }
      if (this._io) { this._io.disconnect(); this._io = null; }
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
      if (this._clockTimer) { clearInterval(this._clockTimer); this._clockTimer = 0; }
      this._stopLoop();
      if (this._demo) { this._demo.stop(); this._demo = null; }
    }

    _updateClock() {
      if (!this._clockEl) return;
      const now = new Date();
      const time = now.toLocaleTimeString(this._locale, { hour: '2-digit', minute: '2-digit' });
      const date = now.toLocaleDateString(this._locale, { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
      if (time !== this._clockTime) { this._clockTime = time; this._clockTimeEl.textContent = time; }
      if (date !== this._clockDate) { this._clockDate = date; this._clockDateEl.textContent = date; }
    }

    // Tages-Energiewerte: Bezüge positiv, Einspeisungen (Netz-Export,
    // Batterie-Ladung) negativ; Summe = Verbrauch aller Geräte heute.
    _updateStats() {
      if (!this._statsEls || !this._hass || !this._hass.states) return;
      const st = this._config.stats;
      const read = (id) => {
        if (!id) return null;
        const s = this._hass.states[id];
        const v = s ? parseFloat(s.state) : NaN;
        return isFinite(v) ? v : null;
      };
      const fmt = (v) => (v == null ? '—' : this._fmt.energy(v));
      let total = 0, have = false;
      const put = (key, raw, negate) => {
        if (!this._statsEls[key]) return;
        let v = raw;
        if (v != null && negate) v = -Math.abs(v);
        if (v != null) { total += v; have = true; }
        this._statsEls[key].textContent = fmt(v);
      };
      put('grid_import', read(st.grid_import), false);
      put('grid_export', read(st.grid_export), true);
      put('pv', read(st.pv), false);
      put('battery_in', read(st.battery_in), true);
      put('battery_out', read(st.battery_out), false);
      this._statsEls.total.textContent = have ? fmt(total) : '—';
    }

    // Speicher-Panel: Ladestand je Speicher (SoC-% oder Temperatur-Mapping,
    // z. B. Warmwasser 20 °C = 0 %, 80 °C = 100 %) mal Kapazität in kWh.
    // Summenzeile: Gesamt-kWh und Prozent der Gesamtkapazität.
    _updateStorage() {
      if (!this._storageEls || !this._hass || !this._hass.states) return;
      const states = this._hass.states;
      const num = (id) => {
        const s = states[id];
        const v = s ? parseFloat(s.state) : NaN;
        return isFinite(v) ? v : null;
      };
      // Kapazität in kWh – Einheit der Entity wird umgerechnet (kJ/MJ/kWh/Wh)
      const capOf = (it) => {
        if (it.capacity_kwh != null) return it.capacity_kwh;
        const s = states[it.capacity_entity];
        const v = s ? parseFloat(s.state) : NaN;
        if (!isFinite(v)) return null;
        const u = String((s.attributes && s.attributes.unit_of_measurement) || 'kWh');
        if (/kj/i.test(u)) return v / 3600;
        if (/mj/i.test(u)) return v / 3.6;
        if (/kwh/i.test(u)) return v;
        if (/wh/i.test(u)) return v / 1000;
        return v;
      };
      let sumK = 0, sumCap = 0, have = false;
      this._config.storage.items.forEach((it, i) => {
        const el = this._storageEls[i];
        if (!el) return;
        const cap = capOf(it);
        let pct = null;
        if (it.soc_entity) {
          const v = num(it.soc_entity);
          if (v != null) pct = clamp(v / 100, 0, 1);
        } else if (it.temp_entity) {
          const t = num(it.temp_entity);
          if (t != null) pct = clamp((t - it.temp_min) / Math.max(1e-6, it.temp_max - it.temp_min), 0, 1);
        }
        if (cap == null || pct == null) { el.textContent = '—'; return; }
        const kwh = pct * cap;
        sumK += kwh; sumCap += cap; have = true;
        el.textContent = this._fmt.energy(kwh) + ' · ' + Math.round(pct * 100) + ' %';
      });
      if (this._storageSumEl) {
        this._storageSumEl.textContent = have && sumCap > 0
          ? this._fmt.energy(sumK) + ' · ' + Math.round((sumK / sumCap) * 100) + ' %'
          : '—';
      }
    }

    /* --------------------------- Config ----------------------------- */

    _normalizeConfig(config) {
      if (!config || typeof config !== 'object') throw new Error('dynamic-energy-card: configuration is missing');
      const c = JSON.parse(JSON.stringify(config));
      const opt = Object.assign({
        max_power: 20000, min_circle_px: 60, size_max_factor: 2.5,
        pulse_hz_min: 0.5, pulse_hz_max: 10, visual_pulse_cap_hz: 3,
        dots_max: 60, zero_threshold_w: 25, density: 1.0,
      }, c.options || {});
      // Optionen härten: keine NaN-Kaskaden durch max_power<=100, pulse_hz_min 0 etc.
      opt.max_power = Math.max(200, +opt.max_power || 20000);
      opt.min_circle_px = clamp(+opt.min_circle_px || 60, 30, 200);
      opt.size_max_factor = clamp(+opt.size_max_factor || 2.5, 1.2, 5);
      opt.pulse_hz_min = clamp(+opt.pulse_hz_min || 0.5, 0.1, 20);
      opt.pulse_hz_max = clamp(+opt.pulse_hz_max || 10, opt.pulse_hz_min, 20);
      opt.visual_pulse_cap_hz = opt.visual_pulse_cap_hz == null ? 3 : Math.max(0, +opt.visual_pulse_cap_hz || 0);
      opt.dots_max = clamp(Math.round(+opt.dots_max || 60), 0, 200);
      opt.zero_threshold_w = Math.max(1, +opt.zero_threshold_w || 25);
      opt.density = clamp(+opt.density || 1, 0.5, 2);
      // Breite/Höhe: Zahl (px), "max" oder leer (= automatisch)
      const normSize = (v) => {
        if (v == null || v === '') return null;
        if (String(v).toLowerCase() === 'max') return 'max';
        const num = +v;
        return isFinite(num) && num >= 100 ? Math.round(num) : null;
      };
      opt.width = normSize(opt.width);
      opt.height = normSize(opt.height);
      opt.show_controls = opt.show_controls !== false;
      opt.show_clock = opt.show_clock !== false;
      // Tages-Energiewerte (Panel links): Einspeisungen werden negativ angezeigt
      const statsIn = (c.stats && typeof c.stats === 'object') ? c.stats : {};
      const stats = {
        show: statsIn.show !== false,
        grid_import: statsIn.grid_import || null,
        grid_export: statsIn.grid_export || null,
        pv: statsIn.pv || null,
        battery_in: statsIn.battery_in || null,
        battery_out: statsIn.battery_out || null,
      };
      stats.any = !!(stats.grid_import || stats.grid_export || stats.pv || stats.battery_in || stats.battery_out);
      // Speicher-Panel (unter den Tages-Energiewerten): Ladestände in kWh + %.
      // Jeder Eintrag braucht soc_entity (%) ODER temp_entity (+ temp_min/max),
      // dazu capacity_kwh (Zahl) oder capacity_entity (Wh/kJ/MJ/kWh erkannt).
      const storIn = (c.storage && typeof c.storage === 'object') ? c.storage : {};
      const stItems = [];
      for (const raw of (Array.isArray(storIn.items) ? storIn.items : [])) {
        if (!raw || typeof raw !== 'object') continue;
        const it = {
          name: raw.name || raw.soc_entity || raw.temp_entity || 'Speicher',
          soc_entity: raw.soc_entity || null,
          temp_entity: raw.temp_entity || null,
          temp_min: raw.temp_min != null && isFinite(+raw.temp_min) ? +raw.temp_min : 20,
          temp_max: raw.temp_max != null && isFinite(+raw.temp_max) ? +raw.temp_max : 80,
          capacity_kwh: raw.capacity_kwh != null && isFinite(+raw.capacity_kwh) ? +raw.capacity_kwh : null,
          capacity_entity: raw.capacity_entity || null,
        };
        if (!it.soc_entity && !it.temp_entity) continue;
        if (it.capacity_kwh == null && !it.capacity_entity) continue;
        stItems.push(it);
      }
      const storage = { show: storIn.show !== false, items: stItems, any: stItems.length > 0 };
      // Virtueller Kreis "Nicht überwacht": Summe der Quellen minus bekannte
      // Verbraucher = nicht gemessene Rest-Verbraucher (nie negativ).
      const resIn = (c.residual && typeof c.residual === 'object') ? c.residual : {};
      const residual = {
        show: c.residual === true || (!!c.residual && resIn.show !== false),
        name: resIn.name || null,
        icon: resIn.icon || 'mdi:help-circle',
        color: resIn.color || '#78909C',
      };
      const inverter = Object.assign({
        name: null, icon: 'mdi:engine', color: '#1565C0', size: 90, power_entity: null,
      }, c.inverter || {});
      const demo = !!c.demo;
      let nodes = Array.isArray(c.nodes) ? c.nodes : [];
      let groups = Array.isArray(c.groups) ? c.groups : [];
      if (demo && nodes.length === 0) {
        const stub = EnergyCard.getStubConfig();
        nodes = stub.nodes; groups = stub.groups;
      }
      const groupIds = new Set(groups.map((g) => g.id));
      const seen = new Set();
      for (const n of nodes) {
        if (!n.id) throw new Error('dynamic-energy-card: every node needs an id');
        if (seen.has(n.id)) throw new Error(`dynamic-energy-card: duplicate id "${n.id}"`);
        seen.add(n.id);
        if (n.group && !groupIds.has(n.group)) throw new Error(`dynamic-energy-card: group "${n.group}" is not defined`);
        if (!demo && !n.power_entity && !n.power_entities) {
          throw new Error(`dynamic-energy-card: node "${n.id}" needs power_entity or power_entities`);
        }
      }
      for (const g of groups) {
        if (seen.has(g.id)) throw new Error(`dynamic-energy-card: group id "${g.id}" collides with a node id`);
        if (g.group) throw new Error('dynamic-energy-card: nested groups are not supported');
      }
      const language = typeof c.language === 'string' && c.language.trim() ? c.language.trim().toLowerCase() : null;
      return { options: opt, inverter, nodes, groups, demo, stats, storage, residual, language };
    }

    /* ---------------------------- Modell ---------------------------- */

    _makeNode(cfg, kind) {
      const opt = this._config.options;
      const rMin = (opt.min_circle_px / 2) * (kind === 'group' ? 1.12 : 1);
      const roleMode = cfg.role === 'source' || cfg.role === 'consumer' ? cfg.role : (cfg.role === 'auto' ? 'auto' : 'consumer');
      return {
        id: cfg.id, cfg, kind,
        groupNode: null, members: [], expanded: false,
        rMin,
        color: cfg.color || '#78909C',
        // Daten
        pRaw: 0, pDisp: 0, unavailable: false, pinned: false,
        roleMode, role: roleMode === 'source' ? 'source' : 'consumer',
        pendingRole: null, pendingSince: 0,
        toggleOn: null,
        fillTarget: cfg.ring === 'fill' ? 0.5 : null,
        fill: 0.5, fillVel: 0, fillDrawn: -1,
        innerText: '', innerTextNext: cfg.inner_text != null ? String(cfg.inner_text) : '',
        powerText: '', powerTextNext: '',
        nameW: 0, powW: 0, labelH: 30,
        textDirty: true, lastTextAt: 0,
        // Ziele / Animation
        rRawTarget: rMin, rTarget: rMin, r: rMin, rVel: 0,
        freqRaw: 0, freq: 0, freqVel: 0,
        pulsePhase: Math.random() * 6.28, pulseAmp: 0.6,
        // Sim
        x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0,
        homeAngle: 0, ringFrac: 0.6,
        fanX: 0, fanY: 0,
        foot: { r: rMin + 20, offY: 15 },
        // DOM
        el: null, link: null,
        rx: -1e9, ry: -1e9, rs: -1, rly: -1e9,
      };
    }

    _buildModel() {
      this._nodes = [];
      this._byId = new Map();
      this._tracked = new Map();
      this._positionsInit = false;
      const cfg = this._config;

      const groupNodes = new Map();
      for (const g of cfg.groups) {
        const node = this._makeNode(g, 'group');
        groupNodes.set(g.id, node);
        this._byId.set(g.id, node);
      }
      const track = (entityId, ref) => {
        if (!entityId) return;
        if (!this._tracked.has(entityId)) this._tracked.set(entityId, []);
        this._tracked.get(entityId).push(ref);
      };

      const topDevices = [];
      for (const nc of cfg.nodes) {
        const node = this._makeNode(nc, 'device');
        this._byId.set(nc.id, node);
        if (nc.group) {
          node.groupNode = groupNodes.get(nc.group);
          node.groupNode.members.push(node);
        } else {
          topDevices.push(node);
        }
        const powerIds = nc.power_entities || (nc.power_entity ? [nc.power_entity] : []);
        node.powerIds = powerIds;
        for (const id of powerIds) track(id, { type: 'power', node });
        if (nc.fill_entity) track(nc.fill_entity, { type: 'fill', node });
        if (nc.inner_text_entity) track(nc.inner_text_entity, { type: 'inner', node });
        if (nc.toggle_entity) track(nc.toggle_entity, { type: 'toggle', node });
        if (nc.energy_entity) track(nc.energy_entity, { type: 'popup', node });
        for (const ex of nc.extra_entities || []) track(ex, { type: 'popup', node });
      }
      for (const g of cfg.groups) {
        const node = groupNodes.get(g.id);
        node.powerIds = g.power_entities || [];
        node.cfg.power = node.powerIds.length ? 'entities' : 'sum';
        // Summen-Gruppen sind vorzeichenbehaftet (Quelle-Member möglich) → auto-Rolle,
        // sofern nicht explizit konfiguriert
        if (node.cfg.power === 'sum' && !g.role) node.roleMode = 'auto';
        for (const id of node.powerIds) track(id, { type: 'power', node });
        if (g.fill_entity) track(g.fill_entity, { type: 'fill', node });
        if (g.inner_text_entity) track(g.inner_text_entity, { type: 'inner', node });
        if (g.toggle_entity) track(g.toggle_entity, { type: 'popup', node });
        if (g.energy_entity) track(g.energy_entity, { type: 'popup', node });
        for (const ex of g.extra_entities || []) track(ex, { type: 'popup', node });
      }

      if (cfg.inverter && cfg.inverter.power_entity) {
        track(cfg.inverter.power_entity, { type: 'invpow', node: null });
      }
      for (const key of ['grid_import', 'grid_export', 'pv', 'battery_in', 'battery_out']) {
        if (cfg.stats[key]) track(cfg.stats[key], { type: 'stats', node: null });
      }
      for (const it of cfg.storage.items) {
        for (const id of [it.soc_entity, it.temp_entity, it.capacity_entity]) {
          if (id) track(id, { type: 'storage', node: null });
        }
      }

      // Synthetischer Knoten "Nicht überwacht": kein power_entity – der Wert
      // wird in _updateCenterSum aus Quellen minus bekannte Verbraucher gerechnet
      this._residualNode = null;
      if (cfg.residual.show) {
        const node = this._makeNode({
          id: '_residual', name: cfg.residual.name || this._t('not_monitored'), icon: cfg.residual.icon,
          color: cfg.residual.color, role: 'consumer', residual: true,
        }, 'device');
        node.powerIds = [];
        this._residualNode = node;
        this._byId.set(node.id, node);
        topDevices.push(node);
      }

      // Top-Level: Geräte ohne Gruppe + alle Gruppen, in Config-Reihenfolge
      this._nodes = [...topDevices, ...groupNodes.values()];

      // Heimwinkel gleichmäßig verteilen, Start oben
      const N = Math.max(1, this._nodes.length);
      this._nodes.forEach((n, i) => { n.homeAngle = -Math.PI / 2 + (i * 2 * Math.PI) / N; });
    }

    _allNodes() {
      const out = [];
      for (const n of this._nodes) { out.push(n); for (const m of n.members) out.push(m); }
      return out;
    }
    _nodeById(id) { return this._byId.get(id); }

    /* ----------------------------- DOM ------------------------------ */

    _buildDom() {
      const root = this.shadowRoot;
      root.innerHTML = '';
      const style = document.createElement('style');
      style.textContent = this._css();
      root.appendChild(style);

      const card = document.createElement('ha-card');
      root.appendChild(card);
      const wrap = div('wrap', card);
      this._wrapEl = wrap;

      // Konfigurierte Breite/Höhe: Zahl in px, "max" oder leer (= automatisch).
      // Verhindert, dass die Grafik aus dem Browser ragt.
      const optSz = this._config.options;
      if (typeof optSz.width === 'number') {
        wrap.style.width = optSz.width + 'px';
        wrap.style.maxWidth = '100%';
        wrap.style.margin = '0 auto';
      }
      if (typeof optSz.height === 'number') {
        wrap.style.height = optSz.height + 'px';
        wrap.style.aspectRatio = 'auto';
      } else if (optSz.height === 'max') {
        wrap.style.height = 'calc(100vh - 130px)'; // Viewport minus HA-Kopfzeile
        wrap.style.aspectRatio = 'auto';
      }

      // iOS: Bewegungssensoren brauchen eine User-Geste für die Freigabe
      wrap.addEventListener('pointerdown', () => this._askMotionPermission(), { once: true });

      const svg = svgEl('svg', { class: 'links' });
      wrap.appendChild(svg);
      this._svg = svg;
      this._svgLines = svgEl('g'); svg.appendChild(this._svgLines);
      this._svgDots = svgEl('g'); svg.appendChild(this._svgDots);

      const layer = div('layer', wrap);
      this._layer = layer;
      this._demoBar = null; // stale Referenz aus vorherigem Demo-Build löschen

      // Centre circle (inverter)
      const invCfg = this._config.inverter;
      const invName = invCfg.name || this._t('inverter');
      const inv = div('inv', layer);
      const invSize = Math.max(22, invCfg.size);
      inv.style.width = inv.style.height = invSize + 'px';
      inv.style.background = invCfg.color;
      // Zentrum zeigt immer eine Leistung: konfiguriertes power_entity oder
      // (Standard) die Summe aller aktuellen Bezugsquellen
      const hasCenterPower = true;
      const invIcon = this._makeIcon(invCfg.icon, invName, Math.round(invSize * (hasCenterPower ? 0.34 : 0.62)));
      invIcon.style.color = '#fff';
      inv.appendChild(invIcon);
      this._invPowEl = hasCenterPower ? div('invPow', inv) : null;
      inv.title = invName;
      this._invEl = inv;
      this._invR = invSize / 2;

      for (const n of this._nodes) {
        this._buildNodeDom(n, layer);
        for (const m of n.members) this._buildNodeDom(m, layer);
      }

      // Popup
      const pop = div('popup', wrap);
      this._popupEl = pop;
      pop.addEventListener('pointerenter', () => { this._popupHover = true; });
      pop.addEventListener('pointerleave', () => { this._popupHover = false; if (!this._popupPinned) this._hidePopup(); });

      // Steuerleiste oben links (abschaltbar via options.show_controls: false)
      this._ctrlBar = null;
      if (this._config.options.show_controls) {
        const ctrl = div('ctrlBar', wrap);
        const mkCtrl = (label, title, fn) => {
          const b = document.createElement('button');
          b.className = 'chip';
          b.textContent = label;
          b.title = title;
          b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
          ctrl.appendChild(b);
        };
        mkCtrl(this._t('shuffle'), this._t('shuffle_title'), () => this._shuffle());
        mkCtrl(this._t('stop'), this._t('stop_title'), () => this._stopMotion());
        this._ctrlBar = ctrl;
      }

      // Uhr oben rechts (abschaltbar via options.show_clock: false)
      this._clockEl = null;
      if (this._config.options.show_clock) {
        const clock = div('clockBar', wrap);
        this._clockTimeEl = div('clockTime', clock);
        this._clockDateEl = div('clockDate', clock);
        this._clockEl = clock;
        this._clockTime = '';
        this._clockDate = '';
        this._updateClock();
      }

      // Linke Spalte unter den Buttons: Tages-Energiewerte + Speicher-Panel
      this._statsEl = null;
      this._statsEls = null;
      this._storageEl = null;
      this._storageEls = null;
      this._storageSumEl = null;
      const stCfg = this._config.stats;
      const spCfg = this._config.storage;
      let leftCol = null;
      const ensureLeftCol = () => {
        if (!leftCol) {
          leftCol = div('leftCol', wrap);
          leftCol.style.top = (this._ctrlBar ? 44 : 8) + 'px';
        }
        return leftCol;
      };
      if (stCfg.show && stCfg.any) {
        const bar = div('statsBar', ensureLeftCol());
        const mkStat = (label) => {
          const row = div('sRow', bar);
          div('sKey', row).textContent = label;
          const v = div('sVal', row);
          v.textContent = '—';
          return v;
        };
        this._statsEls = {
          grid_import: stCfg.grid_import ? mkStat(this._t('grid_import')) : null,
          grid_export: stCfg.grid_export ? mkStat(this._t('grid_export')) : null,
          pv: stCfg.pv ? mkStat(this._t('pv_yield')) : null,
          battery_in: stCfg.battery_in ? mkStat(this._t('battery_in')) : null,
          battery_out: stCfg.battery_out ? mkStat(this._t('battery_out')) : null,
          total: mkStat(this._t('energy_total')),
        };
        this._statsEls.total.parentNode.classList.add('sTotalRow');
        this._statsEl = bar;
        this._updateStats();
      }
      // Speicher-Panel (storage: in der Config): Batterie, E-Autos, Warmwasser
      if (spCfg.show && spCfg.any) {
        const bar = div('statsBar storageBar', ensureLeftCol());
        div('sTitle', bar).textContent = this._t('storage');
        this._storageEls = spCfg.items.map((it) => {
          const row = div('sRow', bar);
          div('sKey', row).textContent = it.name;
          const v = div('sVal', row);
          v.textContent = '—';
          return v;
        });
        const sumRow = div('sRow sTotalRow', bar);
        div('sKey', sumRow).textContent = this._t('sum');
        this._storageSumEl = div('sVal', sumRow);
        this._storageSumEl.textContent = '—';
        this._storageEl = bar;
        this._updateStorage();
      }
      // Button "Werte ein-/ausblenden" für die beiden linken Tabellen; der
      // Zustand (_panelsHidden) überlebt DOM-Rebuilds derselben Karte
      if (leftCol && this._ctrlBar) {
        const b = document.createElement('button');
        b.className = 'chip';
        b.title = this._t('toggle_values_title');
        const applyPanels = () => {
          leftCol.style.display = this._panelsHidden ? 'none' : 'flex';
          b.textContent = this._panelsHidden ? this._t('show_values') : this._t('hide_values');
        };
        applyPanels();
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this._panelsHidden = !this._panelsHidden;
          applyPanels();
        });
        this._ctrlBar.appendChild(b);
      }

      // Demo-Leiste
      if (this._config.demo) {
        const bar = div('demoBar', wrap);
        const mk = (label, key) => {
          const b = document.createElement('button');
          b.className = 'chip'; b.textContent = label;
          b.addEventListener('click', () => { this._demo && this._demo.scenario(key); this._wakeAll(); });
          bar.appendChild(b);
        };
        mk(this._t('demo_pv'), 'pv');
        mk(this._t('demo_batt'), 'batt');
        mk(this._t('demo_wallbox'), 'wallbox');
        mk(this._t('demo_peak'), 'peak');
        mk(this._t('demo_flutter'), 'flutter');
        mk(this._t('demo_auto'), 'autoOn');
        this._demoBar = bar;
      }

      // ha-icon-Fallback: wenn nach 2,5 s nicht registriert → Buchstaben
      if (!customElements.get('ha-icon')) {
        const t = setTimeout(() => this._applyIconFallback(), 2500);
        customElements.whenDefined('ha-icon').then(() => clearTimeout(t)).catch(() => {});
      }

      this._ro = new ResizeObserver(() => this._onResize());
      this._ro.observe(wrap);
      this._built = true;
      this._onResize();

      if (this._config.demo) {
        this._demo = new DemoEngine(this);
        this._demo.start();
      } else if (this._hass) {
        this._readAllEntities();
        this._afterDataPass();
      }
    }

    _teardownDom() {
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
      if (this._demo) { this._demo.stop(); this._demo = null; }
      this._popupNode = null; this._popupPinned = false;
      // Hover-Zustand des alten Popups darf den Neubau nicht überleben
      clearTimeout(this._popupHideT); this._popupHideT = 0; this._popupHover = false;
      this._built = false;
    }

    _makeIcon(icon, name, size) {
      const el = document.createElement('ha-icon');
      el.setAttribute('icon', icon || 'mdi:flash');
      el.style.setProperty('--mdc-icon-size', (size || 26) + 'px');
      el.dataset.fallback = (name || '?').charAt(0).toUpperCase();
      return el;
    }

    _applyIconFallback() {
      if (customElements.get('ha-icon')) return;
      this.shadowRoot.querySelectorAll('ha-icon').forEach((el) => {
        const span = document.createElement('span');
        span.className = 'iconFb';
        span.textContent = el.dataset.fallback || '?';
        span.style.color = el.style.color || 'inherit';
        el.replaceWith(span);
      });
    }

    _buildNodeDom(n, layer) {
      const D0 = n.rMin * 2;
      const wrap = div('nodeW', layer);

      const circle = div('circle', wrap);
      circle.style.width = circle.style.height = D0 + 'px';
      circle.style.left = circle.style.top = (-n.rMin) + 'px';
      circle.setAttribute('role', 'button');
      circle.setAttribute('tabindex', '0');
      circle.setAttribute('aria-label', n.cfg.name || n.id);

      const icon = this._makeIcon(n.cfg.icon, n.cfg.name, Math.round(n.rMin * 0.85));
      icon.style.color = n.color;
      circle.appendChild(icon);

      const inner = div('inner', circle);

      const label = div('label', wrap);
      const nameEl = div('lname', label);
      nameEl.textContent = n.cfg.name || n.id;
      const powEl = div('lpow', label);
      powEl.textContent = '0 W';

      // Farbring als Kind des Kreises: liegt exakt über dem grauen Basisrand,
      // skaliert automatisch mit und pulsiert nur über Opacity (compositor-only).
      const ringSvg = svgEl('svg', { class: 'ringSvg', viewBox: `0 0 ${D0} ${D0}` });
      const rr = n.rMin - 1.5;
      n.ringCirc = 2 * Math.PI * rr;
      const fg = svgEl('circle', {
        cx: n.rMin, cy: n.rMin, r: rr, fill: 'none', 'stroke-width': 3, stroke: n.color,
        transform: `rotate(-90 ${n.rMin} ${n.rMin})`,
        'stroke-linecap': n.cfg.ring === 'fill' ? 'round' : 'butt',
      });
      if (n.cfg.ring === 'fill') {
        fg.setAttribute('stroke-dasharray', `${(n.ringCirc * 0.5).toFixed(1)} ${n.ringCirc.toFixed(1)}`);
      }
      ringSvg.appendChild(fg);
      circle.appendChild(ringSvg);

      n.el = { wrap, circle, icon, inner, label, nameEl, powEl, ringSvg, ringFg: fg };
      n.nameW = textWidth(nameEl.textContent, '400 11px sans-serif');

      // Gruppen-Badge: kleiner gefüllter Kreis mit Plus, rechts unten auf der Kreislinie
      if (n.kind === 'group') {
        const bd = D0 * 0.32;
        const badge = div('gBadge', circle);
        badge.style.width = badge.style.height = bd + 'px';
        badge.style.fontSize = (bd * 0.78) + 'px';
        const off = (n.rMin - 3) + n.rMin * 0.7071 - bd / 2;
        badge.style.left = off + 'px';
        badge.style.top = off + 'px';
        badge.style.background = n.color;
        badge.textContent = '+';
        n.el.badge = badge;
      }

      if (n.cfg.toggle_entity) this._applyToggleFill(n);

      // Verbindungslinie + Punkte-Container
      const line = svgEl('line', { class: 'flowline' });
      this._svgLines.appendChild(line);
      n.link = { line, dots: [], dotCount: 0, p1x: 0, p1y: 0, p2x: 0, p2y: 0, len: 0, dir: 1, fade: 1, dotR: 3 };

      // Interaktion – Long-Press (Popup), Drag (frei platzieren + fixieren),
      // Ghost-Click-Schutz und Slop-Toleranz
      let lpTimer = 0, lpFired = false, lpX = 0, lpY = 0;
      let pressed = false, draggingNode = false, dragSwallow = false;
      circle.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (dragSwallow) { dragSwallow = false; return; } // Click nach Drag schlucken
        if (lpFired) { lpFired = false; return; } // Ghost-Click nach Long-Press schlucken
        this._onNodeClick(n);
      });
      circle.addEventListener('keydown', (ev) => {
        if (ev.repeat) return;
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this._onNodeClick(n); }
      });
      circle.addEventListener('pointerenter', (ev) => {
        if (ev.pointerType === 'mouse' && !this._popupPinned) this._showPopup(n, false);
      });
      circle.addEventListener('pointerleave', (ev) => {
        if (ev.pointerType === 'mouse' && !this._popupPinned) {
          clearTimeout(this._popupHideT);
          this._popupHideT = setTimeout(() => {
            if (!this._popupHover && !this._popupPinned) this._hidePopup();
          }, 120);
        }
      });
      circle.addEventListener('pointerdown', (ev) => {
        lpFired = false; // stale Flag darf keinen echten Klick verschlucken
        pressed = true; draggingNode = false;
        lpX = ev.clientX; lpY = ev.clientY;
        if (ev.pointerType !== 'mouse') {
          lpTimer = setTimeout(() => { lpTimer = 0; lpFired = true; this._showPopup(n, true); }, 500);
        }
      });
      const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = 0; } };
      const endPress = () => { pressed = false; draggingNode = false; cancelLp(); };
      circle.addEventListener('pointerup', endPress);
      circle.addEventListener('pointermove', (ev) => {
        if (!pressed) {
          if (lpTimer && Math.hypot(ev.clientX - lpX, ev.clientY - lpY) > 10) cancelLp();
          return;
        }
        const dist = Math.hypot(ev.clientX - lpX, ev.clientY - lpY);
        if (lpTimer && dist > 10) cancelLp();
        if (!draggingNode && dist > 12) {
          // Drag startet: Kreis fixieren und mit dem Zeiger führen
          draggingNode = true; dragSwallow = true;
          cancelLp(); lpFired = false;
          this._hidePopup(true);
          n.pinned = true;
          wrap.classList.add('pinned');
          try { circle.setPointerCapture(ev.pointerId); } catch (e2) { /* egal */ }
          this._wakeAll();
        }
        if (draggingNode) {
          const rect = this._wrapEl.getBoundingClientRect();
          n.x = clamp(ev.clientX - rect.left, 8, Math.max(8, this._w - 8));
          n.y = clamp(ev.clientY - rect.top, 8, Math.max(8, this._h - 8));
          n.px = n.x; n.py = n.y; n.vx = 0; n.vy = 0;
          this._wakeAll(); // die anderen Kreise machen live Platz
        }
      });
      circle.addEventListener('pointercancel', endPress);
      circle.addEventListener('contextmenu', (ev) => ev.preventDefault());

      if (n.groupNode) {
        wrap.classList.add('member', 'hidden');
        line.classList.add('hidden');
      }
      this._recalcLabel(n);
    }

    _ensureMemberDom(group) {
      // Member-DOM existiert bereits (gepoolt via hidden-Klasse) – nur Sichtbarkeit
      for (const m of group.members) {
        m.el.wrap.classList.toggle('hidden', !group.expanded);
        if (m.link) m.link.line.classList.toggle('hidden', !group.expanded);
      }
    }

    /* --------------------------- Interaktion ------------------------ */

    _onNodeClick(n) {
      if (n.kind === 'group') {
        this._hidePopup(true);
        this._toggleGroup(n);
      } else if (n.cfg.toggle_entity && !this._config.demo) {
        // Schaltbares Endgerät: Klick toggelt direkt (Details weiter via Hover/Longpress)
        if (this._hass) this._hass.callService('homeassistant', 'toggle', { entity_id: n.cfg.toggle_entity });
      } else {
        if (this._popupNode === n && this._popupPinned) this._hidePopup(true);
        else this._showPopup(n, true);
      }
    }

    _toggleGroup(group) {
      group.expanded = !group.expanded;
      if (group.el && group.el.badge) group.el.badge.textContent = group.expanded ? '−' : '+';
      if (group.expanded) {
        // Mitglieder an der Gruppe starten lassen (alte Fixierungen lösen)
        for (const m of group.members) {
          m.pinned = false;
          m.el.wrap.classList.remove('pinned');
          m.x = group.x + (Math.random() - 0.5) * 8;
          m.y = group.y + (Math.random() - 0.5) * 8;
          m.px = m.x; m.py = m.y; m.vx = m.vy = 0;
        }
      }
      this._ensureMemberDom(group);
      this._syncSimNodes();
      this._solveRings();
      this._wakeAll();
      // Punkte sofort anpassen, sonst schweben Member-Punkte bis zu 1 s eingefroren
      this._manageDots();
      this._lastDotMgmt = performance.now();
    }

    _showPopup(n, pinned) {
      clearTimeout(this._popupHideT);
      const samePinned = this._popupPinned && this._popupNode === n;
      this._popupNode = n;
      this._popupPinned = !!pinned || samePinned;
      this._renderPopup();
      this._popupEl.classList.add('open');
      this._positionPopup();
    }

    _hidePopup(force) {
      if (this._popupPinned && !force) return;
      this._popupPinned = false;
      this._popupNode = null;
      this._popupEl.classList.remove('open');
    }

    _renderPopup() {
      const n = this._popupNode;
      if (!n) return;
      const pop = this._popupEl;
      pop.innerHTML = '';
      const title = div('pTitle', pop);
      title.textContent = n.cfg.name || n.id;
      if (n.cfg.area) { const a = div('pArea', pop); a.textContent = n.cfg.area; }

      const addRow = (label, value) => {
        const row = div('pRow', pop);
        const l = div('pKey', row); l.textContent = label;
        const v = div('pVal', row); v.textContent = value;
      };
      const autoSigned = n.roleMode === 'auto' && n.kind !== 'group';
      const signedDisp = autoSigned && n.pRaw < 0 ? -n.pDisp : n.pDisp;
      addRow(this._t('power'), (autoSigned ? this._fmt.powerSigned(signedDisp) : this._fmt.power(n.pDisp))
        + (n.roleMode === 'auto' ? (n.role === 'source' ? ' ⬅' : ' ➡') : ''));

      if (this._config.demo) {
        if (n._demoEnergy == null) n._demoEnergy = (Math.random() * 12).toFixed(1);
        addRow(this._t('energy_today'), n._demoEnergy + ' kWh');
      } else if (n.cfg.energy_entity) {
        addRow(this._t('energy'), this._fmtEntity(n.cfg.energy_entity));
      }
      for (const ex of (n.cfg.extra_entities || []).slice(0, 2)) {
        addRow(this._entityName(ex), this._fmtEntity(ex));
      }

      if (n.cfg.toggle_entity || (this._config.demo && n.groupNode)) {
        const btnRow = div('pRow', pop);
        const btn = document.createElement('button');
        btn.className = 'pToggle';
        const isOn = this._config.demo
          ? Math.abs(n.pDisp) > 5
          : (this._hass && this._hass.states[n.cfg.toggle_entity] || {}).state === 'on';
        btn.textContent = isOn ? this._t('turn_off') : this._t('turn_on');
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (this._config.demo) { this._demo && this._demo.toggleNode(n); }
          else if (this._hass) {
            this._hass.callService('homeassistant', 'toggle', { entity_id: n.cfg.toggle_entity });
          }
          setTimeout(() => this._renderPopup(), 400);
        });
        btnRow.appendChild(btn);
      }
      // Größe einmalig nach dem Rendern cachen – kein Layout-Read im Render-Loop
      this._popupW = pop.offsetWidth || 200;
      this._popupH = pop.offsetHeight || 100;
    }

    _positionPopup() {
      const n = this._popupNode;
      if (!n) return;
      const pop = this._popupEl;
      const pw = this._popupW || 200, ph = this._popupH || 100;
      let x = n.x + n.r + 14;
      if (x + pw > this._w - 6) x = n.x - n.r - 14 - pw;
      if (x < 6) x = clamp(n.x - pw / 2, 6, this._w - pw - 6);
      let y = clamp(n.y - ph / 2, 6, Math.max(6, this._h - ph - 6));
      pop.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;
    }

    _entityName(id) {
      const st = this._hass && this._hass.states[id];
      return (st && st.attributes && st.attributes.friendly_name) || id;
    }

    _fmtEntity(id) {
      const h = this._hass;
      const st = h && h.states[id];
      if (!st) return '—';
      if (h.formatEntityState) { try { return h.formatEntityState(st); } catch (e) { /* fallback */ } }
      const u = st.attributes && st.attributes.unit_of_measurement;
      return st.state + (u ? ' ' + u : '');
    }

    /* ------------------------- Datenpfad ---------------------------- */

    _readAllEntities() {
      for (const refs of this._tracked.values()) {
        for (const ref of refs) this._readEntityRef(ref);
      }
    }

    _readEntityRef(ref) {
      const h = this._hass;
      if (!h || !h.states) return;
      const n = ref.node;
      if (ref.type === 'power') {
        let p = 0, valid = 0;
        for (const id of n.powerIds) {
          const v = parsePowerState(h.states[id]);
          if (v != null) { p += v; valid++; }
        }
        n.unavailable = n.powerIds.length > 0 && valid === 0;
        if (n.cfg.invert) p = -p;
        this._setNodePower(n, p);
      } else if (ref.type === 'fill') {
        const st = h.states[n.cfg.fill_entity];
        const v = st ? parseFloat(st.state) : NaN;
        if (isFinite(v)) {
          const lo = n.cfg.fill_min != null ? n.cfg.fill_min : 0;
          const hi = n.cfg.fill_max != null ? n.cfg.fill_max : 100;
          n.fillTarget = clamp((v - lo) / Math.max(1e-6, hi - lo), 0, 1);
        }
      } else if (ref.type === 'inner') {
        const st = h.states[n.cfg.inner_text_entity];
        if (st) {
          let v = n.cfg.inner_text_attribute
            ? (st.attributes || {})[n.cfg.inner_text_attribute]
            : st.state;
          let txt = '';
          const num = parseFloat(v);
          if (isFinite(num)) {
            const scaled = num * (n.cfg.inner_text_scale != null ? n.cfg.inner_text_scale : 1);
            txt = String(Math.round(scaled));
          } else if (v != null) {
            txt = String(v);
          }
          if (txt && n.cfg.inner_text_unit) txt += ' ' + n.cfg.inner_text_unit;
          n.innerTextNext = txt;
        }
      } else if (ref.type === 'toggle') {
        const st = h.states[n.cfg.toggle_entity];
        n.toggleOn = st ? st.state === 'on' : null;
        this._applyToggleFill(n);
        if (this._popupNode === n) this._renderPopup();
      } else if (ref.type === 'invpow') {
        const v = parsePowerState(h.states[this._config.inverter.power_entity]);
        this._setInvPower(v == null ? 0 : v);
      } else if (ref.type === 'stats') {
        this._updateStats();
      } else if (ref.type === 'storage') {
        this._updateStorage();
      } else if (ref.type === 'popup') {
        if (this._popupNode === n) this._renderPopup();
      }
    }

    // Füllung schaltbarer Geräte: EIN = 65 % Deckkraft, AUS/unbekannt = 10 %
    _applyToggleFill(n) {
      if (!n.el || !n.cfg.toggle_entity) return;
      const on = n.toggleOn === true;
      n.el.circle.style.background = `color-mix(in srgb, ${n.color} ${on ? 65 : 10}%, transparent)`;
      n.el.icon.style.color = on ? '#fff' : n.color;
    }

    _setInvPower(watts) {
      if (this._invPowEl) this._invPowEl.textContent = this._fmt.power(Math.max(0, watts));
    }

    // Zentrum: Summe aller aktuellen BEZUGSQUELLEN (Netzbezug + PV + Batterie-
    // Entladung); Einspeisung/Ladung sind role "consumer" und fallen heraus.
    // Ein konfiguriertes inverter.power_entity hat Vorrang (invpow-Referenz).
    // Nebenbei: virtueller Knoten "Nicht überwacht" = Quellen minus bekannte
    // Verbraucher (auch Netzeinspeisung/Batterie-Ladung zählen als bekannt).
    _updateCenterSum() {
      let src = 0;
      for (const n of this._nodes) if (n.role === 'source') src += n.pDisp;
      if (this._residualNode) {
        let cons = 0;
        for (const n of this._nodes) {
          if (n !== this._residualNode && n.role === 'consumer') cons += n.pDisp;
        }
        this._setNodePower(this._residualNode, Math.max(0, src - cons));
      }
      if (!this._config.inverter.power_entity) this._setInvPower(src);
    }

    _setNodePower(n, watts) {
      n.pRaw = watts;
      const opt = this._config.options;
      const dead = opt.zero_threshold_w;

      if (n.roleMode === 'auto') {
        n.pDisp = Math.abs(watts) < dead ? 0 : Math.abs(watts);
        const desired = watts > dead ? 'source' : watts < -dead ? 'consumer' : null;
        if (desired && desired !== n.role) {
          if (n.pendingRole !== desired) { n.pendingRole = desired; n.pendingSince = performance.now(); }
        } else {
          n.pendingRole = null;
        }
      } else {
        n.role = n.roleMode;
        const p = Math.max(0, watts);
        n.pDisp = p < dead ? 0 : p;
      }
      this._updateNodeTargets(n);
    }

    _updateNodeTargets(n) {
      const opt = this._config.options;
      const maxP = opt.max_power; // durch Normalisierung >= 200
      const p = n.pDisp;
      const fMax = opt.size_max_factor;
      n.rRawTarget = n.rMin * clamp(1 + (fMax - 1) * Math.sqrt(Math.min(1, p / maxP)), 1, fMax);
      if (p <= 0) {
        n.freqRaw = 0;
      } else {
        const denom = Math.log(maxP / 100);
        const t = denom > 1e-6 ? clamp(Math.log(Math.max(1e-3, p / 100)) / denom, 0, 1) : 1;
        n.freqRaw = opt.pulse_hz_min * Math.pow(opt.pulse_hz_max / opt.pulse_hz_min, t);
      }
      // Vorzeichen-Konvention der Anzeige: Verbraucher IMMER plus; Minus nur
      // bei echten auto-Entities (Netz, Batterie), wenn Energie das Haus
      // verlässt (Netzeinspeisung, Batterie-Ladung). Summen-GRUPPEN nutzen
      // intern zwar die auto-Konvention (positiv = Quelle), zeigen aber als
      // Verbraucher-Sammlung immer den Betrag – nie ein Minus.
      const autoSigned = n.roleMode === 'auto' && n.kind !== 'group';
      const signedP = autoSigned && n.pRaw < 0 ? -p : p;
      n.powerTextNext = n.unavailable ? '—'
        : (autoSigned ? this._fmt.powerSigned(signedP) : this._fmt.power(p));
      n.textDirty = true;
    }

    _afterDataPass() {
      // Gruppen-Summen (Verbraucher-positiv aufsummiert)
      for (const n of this._nodes) {
        if (n.kind === 'group' && n.cfg.power === 'sum') {
          let sum = 0;
          for (const m of n.members) sum += m.pDisp * (m.role === 'source' ? -1 : 1);
          // auto-Konvention der Karte: positiv = Quelle → Vorzeichen drehen
          if (n.roleMode === 'auto') this._setNodePower(n, -sum);
          else this._setNodePower(n, Math.max(0, sum));
        }
      }
      this._updateCenterSum();
      // Offenes Popup gedrosselt mitziehen (deckt Live-, Demo- und Gruppen-Pfad ab)
      if (this._popupNode) {
        const nowP = performance.now();
        if (nowP - (this._popupRenderAt || 0) > TEXT_THROTTLE_MS) {
          this._popupRenderAt = nowP;
          this._renderPopup();
        }
      }
      this._ensureLoop();
      // Sim aufwecken, wenn sich Ziele nennenswert geändert haben.
      // Wichtig: gegen rRawTarget*shrink vergleichen – n.rTarget wird nur im
      // laufenden Loop aktualisiert und wäre hier ggf. veraltet.
      for (const n of this._allNodes()) {
        if (Math.abs(n.rRawTarget * this._shrink - n.r) > 1.5) { this._sim.wake(); break; }
      }
    }

    /* ------------------------ Ringe & Layout ------------------------ */

    _onResize() {
      const r = this._wrapEl.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) return;
      this._w = r.width; this._h = r.height;
      this._svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
      this._svg.setAttribute('width', r.width);
      this._svg.setAttribute('height', r.height);
      this._invEl.style.transform =
        `translate3d(${r.width / 2 - this._invR}px,${r.height / 2 - this._invR}px,0)`;
      const pad = this._demoBar ? 40 : 0;
      // Oben Platz für Steuerleiste/Uhr reservieren, sonst fallen Kreise bei
      // Neigung nach oben unter Buttons bzw. Uhr und sind nicht mehr tippbar
      const topPad = (this._ctrlBar || this._clockEl)
        ? Math.max(this._ctrlBar ? this._ctrlBar.offsetHeight : 0,
                   this._clockEl ? this._clockEl.offsetHeight : 0) + 16
        : 0;
      this._sim.setViewport(r.width, r.height, this._invR + 12, pad, topPad);
      this._initPositions();
      this._syncSimNodes();
      this._solveRings();
      this._wakeAll();
    }

    _initPositions() {
      if (this._positionsInit) return;
      this._positionsInit = true;
      const cx = this._w / 2, cy = this._h / 2;
      for (const n of this._nodes) {
        const d = this._sim.ellipseDist(n.homeAngle, n.ringFrac);
        n.x = cx + Math.cos(n.homeAngle) * d;
        n.y = cy + Math.sin(n.homeAngle) * d;
        n.px = n.x; n.py = n.y;
        for (const m of n.members) { m.x = n.x; m.y = n.y; m.px = m.x; m.py = m.y; }
      }
    }

    _syncSimNodes() {
      const list = [];
      for (const n of this._nodes) {
        list.push(n);
        if (n.kind === 'group' && n.expanded) for (const m of n.members) list.push(m);
      }
      this._sim.nodes = list;
    }

    _solveRings() {
      const sim = this._sim;
      const inner = [], outer = [];
      for (const n of this._nodes) (n.role === 'source' ? inner : outer).push(n);
      // Innenring nie in den Inverter-Footprint legen – sonst kämpfen Radialfeder
      // und Kollision endlos gegeneinander und die Sim schläft nie ein
      let maxInnerFoot = 0;
      for (const n of inner) maxInnerFoot = Math.max(maxInnerFoot, n.foot.r);
      const meanR1 = (sim.availA + sim.availB) / 2;
      const fiMin = Math.min(0.6, (sim.invFoot + maxInnerFoot + 6) / Math.max(60, meanR1));
      let fi = Math.max(0.30, fiMin), fo = Math.max(0.60, fi + 0.15);
      const sf = 1 + 0.15 / this._config.options.density;
      const meanR = (f) => f * (sim.availA + sim.availB) / 2;
      const need = (arr, R) => arr.reduce(
        (s, n) => s + 2 * Math.asin(Math.min(0.9, n.foot.r / Math.max(R, n.foot.r + 1))) * sf, 0);
      for (let i = 0; i < 25 && need(outer, meanR(fo)) > 2 * Math.PI && fo < 0.93; i++) fo += 0.02;
      for (let i = 0; i < 25 && need(inner, meanR(fi)) > 2 * Math.PI && fi < fo - 0.24; i++) fi += 0.02;
      let s = 1;
      for (let i = 0; i < 14; i++) {
        if (need(outer, meanR(fo)) * s <= 2 * Math.PI && need(inner, meanR(fi)) * s <= 2 * Math.PI) break;
        s *= 0.94;
      }
      this._shrinkTarget = Math.max(0.5, s);
      for (const n of inner) n.ringFrac = fi;
      for (const n of outer) n.ringFrac = fo;
      this._lastSolve = performance.now();
      this._solveFootSum = this._nodes.reduce((acc, n) => acc + n.foot.r, 0);
      // Neue Ring-Ziele brauchen eine wache Sim (Drift-Aufruf aus _tick!)
      sim.wake();
    }

    _updateFoot(n) {
      const lh = n.labelH;
      const vert = (2 * n.r + LABEL_GAP + lh) / 2;
      const horiz = Math.max(n.r, Math.max(n.nameW, n.powW) / 2) + (this._footPad || 6);
      n.foot.r = Math.max(vert, horiz);
      n.foot.offY = (LABEL_GAP + lh) / 2;
    }

    _recalcLabel(n) {
      n.powW = textWidth(n.powerTextNext || n.powerText || '0 W', '600 13px sans-serif');
      n.labelH = 28;
    }

    _fanTargets(group) {
      const members = group.members;
      const cnt = members.length;
      if (!cnt) return;
      const cx = this._w / 2, cy = this._h / 2;
      let base = Math.atan2(group.y - cy, group.x - cx);
      if (!isFinite(base)) base = -Math.PI / 2;
      let maxFoot = 20;
      for (const m of members) maxFoot = Math.max(maxFoot, m.foot.r);
      const orbit = group.foot.r + maxFoot + 6;
      const dphi = 2 * Math.asin(Math.min(0.85, (maxFoot + 2) / orbit)) * 1.1;
      members.forEach((m, i) => {
        const phi = base + (i - (cnt - 1) / 2) * dphi;
        m.fanX = group.x + Math.cos(phi) * orbit;
        m.fanY = group.y + Math.sin(phi) * orbit;
      });
    }

    /* ------------------------- Animations-Loop ---------------------- */

    _gate() {
      const shouldRun = this._built && this.isConnected && this._visible && this._inViewport;
      if (shouldRun) this._ensureLoop();
      else this._stopLoop();
    }

    _ensureLoop() {
      // isConnected: hass-Updates auf detachter Karte dürfen keinen rAF-Loop starten
      if (this._running || !this._built || !this.isConnected) return;
      if (!this._visible || !this._inViewport) return;
      this._running = true;
      this._lastTs = null;
      this._raf = requestAnimationFrame(this._tickBound);
      for (const n of this._allNodes()) n.el.wrap.style.willChange = 'transform';
    }

    _stopLoop() {
      this._running = false;
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
      if (this._built) for (const n of this._allNodes()) n.el.wrap.style.willChange = '';
    }

    _wakeAll() { this._sim.wake(); this._ensureLoop(); }

    /* ------------------ Mischen / Stopp / Sensorik ------------------ */

    // Zufällige Neuanordnung: gleichmäßige Winkel-Slots permutieren + Impuls-Kick.
    // Löst außerdem alle per Drag fixierten Kreise wieder.
    _shuffle() {
      for (const n of this._allNodes()) {
        if (n.pinned) {
          n.pinned = false;
          if (n.el) n.el.wrap.classList.remove('pinned');
        }
      }
      const N = Math.max(1, this._nodes.length);
      const slots = this._nodes.map((_, i) => -Math.PI / 2 + (i * 2 * Math.PI) / N);
      for (let i = slots.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [slots[i], slots[j]] = [slots[j], slots[i]];
      }
      this._nodes.forEach((n, i) => { n.homeAngle = slots[i] + (Math.random() - 0.5) * 0.4; });
      for (const n of this._sim.nodes) {
        n.vx += (Math.random() - 0.5) * 700;
        n.vy += (Math.random() - 0.5) * 700;
      }
      this._wakeAll();
    }

    // Bewegung sofort anhalten. Der Heimwinkel wird auf den Ist-Winkel gesetzt,
    // damit nach dem Aufwachen keine Rückstellkraft die Drehung wieder anwirft –
    // das bricht Rotations-Endlosschleifen dauerhaft.
    _stopMotion() {
      const cx = this._w / 2, cy = this._h / 2;
      for (const n of this._sim.nodes) {
        n.vx = 0; n.vy = 0; n.px = n.x; n.py = n.y;
        if (!(n.groupNode && n.groupNode.expanded)) {
          n.homeAngle = Math.atan2(n.y - cy, n.x - cx);
        }
      }
      // aktuelle Gerätelage wird zur neuen Neutrallage → Neigung zieht nicht weiter
      if (this._tiltLast) this._tiltRef = { b: this._tiltLast.b, g: this._tiltLast.g, ang: this._tiltLast.ang };
      this._sim.gravX = 0; this._sim.gravY = 0;
      this._sim.sleeping = true;
      this._sim._stillTicks = 0;
    }

    _askMotionPermission() {
      if (this._motionPermAsked) return;
      this._motionPermAsked = true;
      try {
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
          DeviceOrientationEvent.requestPermission().catch(() => {});
        }
        if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
          DeviceMotionEvent.requestPermission().catch(() => {});
        }
      } catch (e) { /* Sensorik bleibt einfach aus */ }
    }

    // Neigung → Gravitation. Relativ zur Neutrallage (Haltung beim ersten Event
    // in der AKTUELLEN Bildschirm-Orientierung), damit die normale Handy-Haltung
    // (~45–60° aufrecht) nicht schon "fällt".
    _onTilt(e) {
      if (e.beta == null || e.gamma == null) return;
      const sim = this._sim;
      // Nahe der Senkrechten (Wandtablet, sehr aufrecht gehaltenes Handy) ist
      // gamma numerisch instabil (Gimbal-Singularität, springt ±85°) – Neigung
      // dort komplett deaktivieren statt Vollausschlag-Zappeln zu riskieren.
      if (Math.abs(e.beta) > 75) {
        this._tiltRef = null; this._tiltLast = null;
        if (sim.gravX || sim.gravY) { sim.gravX = 0; sim.gravY = 0; this._wakeAll(); }
        return;
      }
      const ang = (screen.orientation && screen.orientation.angle != null)
        ? screen.orientation.angle : (window.orientation || 0);
      this._tiltLast = { b: e.beta, g: e.gamma, ang };
      // beta/gamma sind GERÄTE-Achsen: nach einer Portrait/Landscape-Drehung ist
      // eine alte Referenz bedeutungslos → neu anlernen und Gravitation nullen.
      if (!this._tiltRef || this._tiltRef.ang !== ang) {
        this._tiltRef = { b: e.beta, g: e.gamma, ang };
        if (sim.gravX || sim.gravY) { sim.gravX = 0; sim.gravY = 0; this._wakeAll(); }
        return;
      }
      let db = e.beta - this._tiltRef.b;     // vor/zurück
      db = ((db + 540) % 360) - 180;         // beta wrappt bei ±180° (face-down-Start)
      const dg = e.gamma - this._tiltRef.g;  // links/rechts (Range nur ±90, kein Wrap)
      // Neutrallage SEHR langsam nachführen (~1 min): dauerhafte Haltungswechsel
      // (Tisch → Hand) heilen von selbst, bewusstes Neigen bleibt lange wirksam.
      this._tiltRef.b += db * 0.0008;
      this._tiltRef.g += dg * 0.0008;
      // Geräteachsen → Bildschirmachsen (Landscape-Tablets)
      let dx, dy;
      if (ang === 90) { dx = db; dy = -dg; }
      else if (ang === 180) { dx = -dg; dy = -db; }
      else if (ang === 270 || ang === -90) { dx = -db; dy = dg; }
      else { dx = dg; dy = db; }
      const map = (d) => {
        const a = Math.abs(d);
        if (a < TILT_DEAD_DEG) return 0;
        return Math.sign(d) * Math.min(1, (a - TILT_DEAD_DEG) / (TILT_SAT_DEG - TILT_DEAD_DEG));
      };
      const gx = map(dx) * TILT_ACCEL;
      const gy = map(dy) * TILT_ACCEL;
      // Nulldurchgang IMMER committen (sonst bleibt Rest-Gravitation < Hysterese
      // stehen und die Federn laufen dauerhaft abgeschwächt); Hysterese nur ≠ 0.
      const zeroed = gx === 0 && gy === 0 && (sim.gravX !== 0 || sim.gravY !== 0);
      if (zeroed || Math.abs(gx - sim.gravX) > 30 || Math.abs(gy - sim.gravY) > 30) {
        sim.gravX = gx; sim.gravY = gy;
        this._wakeAll();
      }
    }

    // Schütteln → Neu mischen. Gezählt werden nur Übergänge unter→über der
    // Schwelle (Re-Arm erst unter SHAKE_REARM) – sonst zählt ein einzelner Stoß
    // (Handy auf den Tisch legen, Wandtablet anstoßen) als "3 Rucke" in 50 ms.
    _onShake(e) {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null) return;
      const dev = Math.abs(Math.hypot(a.x, a.y, a.z || 0) - 9.81);
      if (dev < SHAKE_THRESH) {
        if (dev < SHAKE_REARM) this._shakeArmed = true;
        return;
      }
      if (!this._shakeArmed) return;
      this._shakeArmed = false;
      const now = performance.now();
      if (now - this._shakeFirstAt > SHAKE_WINDOW_MS) { this._shakeFirstAt = now; this._shakeCount = 0; }
      this._shakeCount++;
      if (this._shakeCount >= SHAKE_COUNT && now - this._shakeLastFire > SHAKE_COOLDOWN_MS) {
        this._shakeLastFire = now;
        this._shakeCount = 0;
        this._shuffle();
      }
    }

    _tick(ts) {
      if (!this._running) return;
      this._raf = requestAnimationFrame(this._tickBound);
      if (this._lastTs == null) { this._lastTs = ts; return; }
      let dt = (ts - this._lastTs) / 1000;
      this._lastTs = ts;
      if (dt <= 0) return;
      if (dt > DT_CLAMP) dt = DT_CLAMP;
      const now = performance.now();

      // Rollen-Hysterese committen
      for (const n of this._allNodes()) {
        if (n.pendingRole && now - n.pendingSince > ROLE_DEBOUNCE_MS) {
          n.role = n.pendingRole;
          n.pendingRole = null;
          this._solveRings();
          this._wakeAll();
          // Rollenwechsel verschiebt eine Bezugsquelle → Zentrums-Summe nachziehen
          this._updateCenterSum();
        }
      }

      // Globaler Shrink + Radius-/Frequenz-/Fill-Federn (pro Frame, framerate-unabhängig)
      [this._shrink, this._shrinkVel] = smoothDamp(this._shrink, this._shrinkTarget, this._shrinkVel, 0.5, dt);
      for (const n of this._allNodes()) {
        n.rTarget = n.rRawTarget * this._shrink;
        // Radius wächst noch? Kollision braucht eine wache Sim, sonst Overlap.
        if (this._sim.sleeping && Math.abs(n.rTarget - n.r) > 1) this._sim.wake();
        [n.r, n.rVel] = smoothDamp(n.r, n.rTarget, n.rVel, 0.45, dt);
        [n.freq, n.freqVel] = smoothDamp(n.freq, n.freqRaw, n.freqVel, 0.6, dt);
        if (n.fillTarget != null) [n.fill, n.fillVel] = smoothDamp(n.fill, n.fillTarget, n.fillVel, 0.8, dt);
        this._updateFoot(n);
        // Puls-Phase akkumulieren (artefaktfrei bei variabler Frequenz)
        const opt = this._config.options;
        const cap = opt.visual_pulse_cap_hz;
        const fVis = cap > 0 ? Math.min(n.freq, cap) : n.freq;
        // Puls-Tiefe (Opacity-Hub); über dem visuellen Cap wächst die Tiefe statt der Frequenz
        n.pulseAmp = 0.6 + (cap > 0 && n.freq > cap
          ? 0.25 * Math.min(1, (n.freq - cap) / Math.max(0.5, opt.pulse_hz_max - cap)) : 0);
        if (!this._reduced && fVis > 0.05) n.pulsePhase += 2 * Math.PI * fVis * dt;
        n.fVis = fVis;
      }

      // Fächer-Ziele für expandierte Gruppen
      for (const n of this._nodes) if (n.kind === 'group' && n.expanded) this._fanTargets(n);

      // Physik: fixed timestep + Interpolation
      let alpha = 1;
      if (!this._sim.sleeping) {
        this._acc += dt;
        let steps = 0;
        while (this._acc >= STEP && steps < MAX_STEPS) {
          this._sim.step(STEP);
          this._acc -= STEP;
          steps++;
        }
        if (steps === MAX_STEPS) this._acc = 0;
        alpha = clamp(this._acc / STEP, 0, 1);
      } else {
        this._acc = 0;
      }

      // Punkte-Verwaltung gedrosselt (1 Hz)
      if (now - this._lastDotMgmt > 1000) { this._lastDotMgmt = now; this._manageDots(); }

      // Ring-Solver-Drift: neu lösen, wenn sich die Footprint-Summe spürbar geändert hat
      if (now - this._lastSolve > 1200) {
        const footSum = this._nodes.reduce((acc, n) => acc + n.foot.r, 0);
        if (Math.abs(footSum - (this._solveFootSum || 0)) > 12) this._solveRings();
        else this._lastSolve = now;
      }

      this._writeFrame(alpha, now, dt);
    }

    /* --------------------------- Rendering -------------------------- */

    _writeFrame(alpha, now, dt) {
      const cx = this._w / 2, cy = this._h / 2;
      const sleeping = this._sim.sleeping;

      for (const n of this._allNodes()) {
        const hidden = n.groupNode && !n.groupNode.expanded;
        if (hidden) continue;
        const x = sleeping ? n.x : lerp(n.px, n.x, alpha);
        const y = sleeping ? n.y : lerp(n.py, n.y, alpha);
        const el = n.el;

        if (Math.abs(x - n.rx) > 0.1 || Math.abs(y - n.ry) > 0.1) {
          el.wrap.style.transform = `translate3d(${x}px,${y}px,0)`;
          n.rx = x; n.ry = y;
          if (this._popupNode === n) this._positionPopup();
        }

        const s = n.r / n.rMin;
        if (Math.abs(s - n.rs) > 0.004) {
          el.circle.style.transform = `scale(${s})`;
          n.rs = s;
        }

        // Puls: Farbring über dem grauen Basisrand, nur Opacity (compositor-only)
        let ringOp;
        if (!this._reduced && n.fVis > 0.05) {
          const w = 0.5 + 0.5 * Math.sin(n.pulsePhase);
          ringOp = (1 - n.pulseAmp * (1 - w)).toFixed(3);
        } else {
          ringOp = n.pDisp > 0 ? '1.000' : '0.400';
        }
        if (el.ringSvg.style.opacity !== ringOp) el.ringSvg.style.opacity = ringOp;

        // Fill-Sektor nur bei Änderung schreiben
        if (n.fillTarget != null && Math.abs(n.fill - n.fillDrawn) > 0.002) {
          n.fillDrawn = n.fill;
          el.ringFg.setAttribute('stroke-dasharray', `${(n.ringCirc * n.fill).toFixed(1)} ${n.ringCirc.toFixed(1)}`);
        }

        // Label unter dem Kreis – lokal zum Wrapper, wandert mit ihm mit
        const ly = n.r + LABEL_GAP;
        if (Math.abs(ly - n.rly) > 0.1) {
          el.label.style.transform = `translate3d(0px,${ly}px,0)`;
          n.rly = ly;
        }

        // Texte gedrosselt aktualisieren
        if (n.textDirty && now - n.lastTextAt > TEXT_THROTTLE_MS) {
          n.lastTextAt = now; n.textDirty = false;
          el.wrap.classList.toggle('unavail', !!n.unavailable);
          if (n.powerTextNext !== n.powerText) {
            n.powerText = n.powerTextNext;
            el.powEl.textContent = n.powerText;
            this._recalcLabel(n);
          }
          if (n.innerTextNext !== n.innerText) {
            n.innerText = n.innerTextNext;
            el.inner.textContent = n.innerText;
          }
        }

        // Verbindungslinie
        this._writeLink(n, x, y, cx, cy, dt);
      }
    }

    _writeLink(n, x, y, cx, cy, dt) {
      const link = n.link;
      if (!link) return;
      let sx, sy, sr;
      if (n.groupNode) {
        const g = n.groupNode;
        sx = g.rx > -1e8 ? g.rx : g.x; sy = g.ry > -1e8 ? g.ry : g.y; sr = g.r;
      } else {
        sx = cx; sy = cy; sr = this._invR;
      }
      const dx = x - sx, dy = y - sy;
      const d = Math.max(1, Math.hypot(dx, dy));
      const ux = dx / d, uy = dy / d;
      const p1x = sx + ux * (sr + 2), p1y = sy + uy * (sr + 2);
      const p2x = x - ux * (n.r + 4), p2y = y - uy * (n.r + 4);
      if (Math.abs(p1x - link.p1x) > 0.4 || Math.abs(p1y - link.p1y) > 0.4 ||
          Math.abs(p2x - link.p2x) > 0.4 || Math.abs(p2y - link.p2y) > 0.4) {
        link.p1x = p1x; link.p1y = p1y; link.p2x = p2x; link.p2y = p2y;
        link.len = Math.max(1, Math.hypot(p2x - p1x, p2y - p1y));
        link.line.setAttribute('x1', p1x.toFixed(1));
        link.line.setAttribute('y1', p1y.toFixed(1));
        link.line.setAttribute('x2', p2x.toFixed(1));
        link.line.setAttribute('y2', p2y.toFixed(1));
      }

      // Fluss-Punkte
      const flow = n.pDisp > 0 && !this._reduced;
      const dir = n.role === 'source' ? -1 : 1; // -1: Knoten → Zentrum/Gruppe
      if (link.dir !== dir) { link.dir = dir; link.fade = 0; }
      link.fade = Math.min(1, link.fade + dt * 5);
      // Pixel-Geschwindigkeit statt Umläufe/s: Linien mit gleicher Leistung laufen
      // gleich schnell, unabhängig von der Linienlänge. Punktradius wächst mit der
      // Leistung (3 px … 12 px = max. 4x).
      const maxP = Math.max(100, this._config.options.max_power);
      const pxSpeed = clamp(n.freq * 80, 25, 400); // px/s
      const dotR = 3 * (1 + 3 * Math.sqrt(Math.min(1, n.pDisp / maxP)));
      if (Math.abs(dotR - link.dotR) > 0.2) {
        link.dotR = dotR;
        for (const dot of link.dots) dot.el.setAttribute('r', dotR.toFixed(1));
      }
      for (const dot of link.dots) {
        if (!flow) { if (dot.el.style.opacity !== '0') dot.el.style.opacity = '0'; continue; }
        dot.frac += (pxSpeed / Math.max(40, link.len)) * dt;
        if (dot.frac >= 1) dot.frac -= 1;
        const f = dir === 1 ? dot.frac : 1 - dot.frac;
        const px = lerp(link.p1x, link.p2x, f);
        const py = lerp(link.p1y, link.p2y, f);
        dot.el.setAttribute('transform', `translate(${px.toFixed(1)} ${py.toFixed(1)})`);
        const op = (0.9 * link.fade).toFixed(2);
        if (dot.el.style.opacity !== op) dot.el.style.opacity = op;
      }
    }

    _manageDots() {
      let budget = this._config.options.dots_max;
      const links = [];
      for (const n of this._allNodes()) {
        if (!n.link) continue;
        if (n.groupNode && !n.groupNode.expanded) {
          while (n.link.dots.length) n.link.dots.pop().el.remove();
          continue;
        }
        links.push(n);
      }
      const maxP = Math.max(100, this._config.options.max_power);
      for (const n of links) {
        // Punktdichte rein leistungsabhängig: Abstand 150 px (wenig) … 50 px (max_power).
        // Gleiche Leistung → gleicher Abstand auf jeder Linie; nur die Linienlänge
        // bestimmt, wie viele Punkte darauf Platz haben.
        const t = Math.sqrt(Math.min(1, n.pDisp / maxP));
        const spacing = 150 - 100 * t;
        const want = n.pDisp > 0 ? clamp(Math.round(n.link.len / spacing), 1, 8) : 0;
        const use = Math.min(want, Math.max(0, budget));
        budget -= use;
        const dots = n.link.dots;
        const before = dots.length;
        while (dots.length < use) {
          // Kettenfarbe: Member-Punkte tragen die Gruppenfarbe, damit Zentrum→Gruppe
          // und Gruppe→Gerät als ein Fluss lesbar sind.
          const el = svgEl('circle', { r: (n.link.dotR || 3).toFixed(1), fill: n.groupNode ? n.groupNode.color : n.color, class: 'dot' });
          this._svgDots.appendChild(el);
          dots.push({ el, frac: 0 });
        }
        while (dots.length > use) {
          const dot = dots.pop();
          dot.el.remove();
        }
        if (dots.length !== before) {
          // Nach Anzahländerung gleichmäßig neu verteilen (Phase des ersten Punkts erhalten)
          const base = isFinite(dots[0] && dots[0].frac) ? dots[0].frac : 0;
          dots.forEach((dch, i) => { dch.frac = (base + i / Math.max(1, dots.length)) % 1; });
        }
        dots.forEach((dch, i) => { if (!isFinite(dch.frac)) dch.frac = i / Math.max(1, use); });
      }
    }

    /* ----------------------------- CSS ------------------------------ */

    _css() {
      return `
        :host { display: block; height: 100%; }
        ha-card { display: block; height: 100%; overflow: hidden; position: relative; }
        /* aspect-ratio greift nur, wenn die Höhe nicht fix ist (Masonry);
           in Panel/Sections gewinnt die definierte Höhe */
        .wrap { position: relative; width: 100%; height: 100%; aspect-ratio: 4 / 3; min-height: 220px; contain: layout style; }
        svg.links { position: absolute; inset: 0; pointer-events: none; }
        .flowline { stroke: var(--divider-color, #444); stroke-width: 1.5; }
        .flowline.hidden { display: none; }
        .dot { transition: opacity 0.2s linear; }
        .layer { position: absolute; inset: 0; pointer-events: none; }
        .nodeW { position: absolute; left: 0; top: 0; pointer-events: none; }
        .nodeW.hidden { display: none; }
        .circle {
          position: absolute; border-radius: 50%; box-sizing: border-box;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          background: var(--card-background-color, #1a1d21);
          border: 3px solid var(--disabled-color, #5f6368);
          cursor: pointer; pointer-events: auto;
          transform-origin: center center; outline: none;
          touch-action: none; -webkit-user-select: none; user-select: none;
          -webkit-touch-callout: none;
        }
        .circle:focus-visible { box-shadow: 0 0 0 2px var(--primary-color, #03a9f4); }
        .nodeW.unavail { opacity: 0.45; }
        /* per Drag fixierte Kreise: gestrichelter Grundring als Merkmal */
        .nodeW.pinned .circle { border-style: dashed; }
        .ringSvg {
          position: absolute; inset: -3px; pointer-events: none; display: block;
          opacity: 0.4;
        }
        .inner {
          font-size: 12px; font-weight: 600; margin-top: 1px;
          color: var(--primary-text-color, #e1e1e1);
          font-variant-numeric: tabular-nums; line-height: 1.1;
        }
        .iconFb { font-size: 20px; font-weight: 700; }
        .label { position: absolute; left: 0; top: 0; pointer-events: none; }
        .label > div { transform: translateX(-50%); white-space: nowrap; text-align: center; }
        .lname { font-size: 11px; color: var(--secondary-text-color, #9aa0a6); line-height: 1.2; }
        .lpow {
          font-size: 13px; font-weight: 600; color: var(--primary-text-color, #e1e1e1);
          font-variant-numeric: tabular-nums; line-height: 1.2;
        }
        .inv {
          position: absolute; left: 0; top: 0; border-radius: 50%;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          z-index: 2;
          box-shadow: 0 0 12px rgba(0,0,0,0.35);
        }
        .inv .iconFb { color: #fff; font-size: 13px; }
        .invPow {
          font-size: 15px; font-weight: 700; color: #fff; margin-top: 2px;
          font-variant-numeric: tabular-nums; line-height: 1.1;
        }
        .gBadge {
          position: absolute; border-radius: 50%; z-index: 1;
          display: flex; align-items: center; justify-content: center;
          color: #fff; font-weight: 700; line-height: 1; pointer-events: none;
        }
        .popup {
          position: absolute; left: 0; top: 0; z-index: 10;
          background: var(--card-background-color, #23272e);
          border: 1px solid var(--divider-color, #444);
          border-radius: 12px; padding: 10px 14px;
          box-shadow: 0 6px 20px rgba(0,0,0,0.45);
          min-width: 170px; max-width: 240px;
          opacity: 0; transition: opacity 0.15s; pointer-events: none;
        }
        .popup.open { opacity: 1; pointer-events: auto; }
        .pTitle { font-weight: 700; font-size: 14px; color: var(--primary-text-color, #fff); }
        .pArea { font-size: 11px; color: var(--secondary-text-color, #9aa0a6); margin-bottom: 4px; }
        .pRow { display: flex; justify-content: space-between; gap: 12px; margin-top: 4px; font-size: 12px; }
        .pKey { color: var(--secondary-text-color, #9aa0a6); }
        .pVal { color: var(--primary-text-color, #e1e1e1); font-variant-numeric: tabular-nums; }
        .pToggle {
          margin-top: 6px; width: 100%; padding: 6px 10px; border-radius: 8px;
          border: 1px solid var(--divider-color, #555);
          background: var(--secondary-background-color, #2c313a);
          color: var(--primary-text-color, #fff); cursor: pointer; font-size: 12px;
        }
        .pToggle:hover { filter: brightness(1.15); }
        .demoBar {
          position: absolute; bottom: 6px; left: 0; right: 0; z-index: 5;
          display: flex; gap: 6px; justify-content: center; flex-wrap: wrap;
        }
        .ctrlBar {
          position: absolute; top: 8px; left: 8px; z-index: 5;
          display: flex; gap: 6px;
        }
        .clockBar {
          position: absolute; top: 8px; right: 12px; z-index: 5;
          text-align: right; pointer-events: none;
        }
        .clockTime {
          font-size: 22px; font-weight: 700; line-height: 1.1;
          color: var(--primary-text-color, #e1e1e1); font-variant-numeric: tabular-nums;
        }
        .clockDate { font-size: 11px; color: var(--secondary-text-color, #9aa0a6); }
        .leftCol {
          position: absolute; left: 8px; z-index: 4; pointer-events: none;
          display: flex; flex-direction: column; gap: 6px; align-items: flex-start;
        }
        .statsBar {
          pointer-events: none;
          background: color-mix(in srgb, var(--card-background-color, #1a1d21) 78%, transparent);
          border-radius: 10px; padding: 6px 10px;
          display: flex; flex-direction: column; gap: 1px; min-width: 190px;
          box-sizing: border-box;
        }
        .storageBar { min-width: 190px; width: 100%; }
        .sTitle {
          font-size: 10px; font-weight: 700; letter-spacing: 0.6px;
          text-transform: uppercase; color: var(--secondary-text-color, #9aa0a6);
          margin-bottom: 1px;
        }
        .sRow { display: flex; justify-content: space-between; gap: 12px; font-size: 11px; }
        .sKey { color: var(--secondary-text-color, #9aa0a6); }
        .sVal { color: var(--primary-text-color, #e1e1e1); font-variant-numeric: tabular-nums; }
        .sTotalRow {
          border-top: 1px solid var(--divider-color, #444);
          margin-top: 3px; padding-top: 3px; font-weight: 700;
        }
        .chip {
          padding: 4px 10px; border-radius: 14px; font-size: 11px; cursor: pointer;
          border: 1px solid var(--divider-color, #555);
          background: var(--secondary-background-color, #2c313a);
          color: var(--primary-text-color, #ddd);
        }
        .chip:hover { filter: brightness(1.2); }
      `;
    }
  }

  /* ==================== Setup-Editor (Phase 2a) ===================== */

  const EDITOR_PALETTE = ['#FF7043', '#26C6DA', '#AB47BC', '#66BB6A', '#FFCA28', '#29B6F6', '#EC407A', '#8D6E63'];

  // Einheiten-Filter für die Entity-Picker (stateObj → boolean)
  const unitOf = (st) => String((st && st.attributes && st.attributes.unit_of_measurement) || '').trim();
  const EDITOR_ENTITY_FILTERS = {
    power: (st) => /^k?W$/i.test(unitOf(st)),
    energy: (st) => /^(k|M)?Wh$/i.test(unitOf(st)),
    percent: (st) => unitOf(st) === '%',
    temperature: (st) => /°[CF]/.test(unitOf(st)),
    capacity: (st) => /^(k?Wh|kJ|MJ)$/i.test(unitOf(st)),
  };

  function makeUniqueSlug(name, used) {
    const base = String(name || 'geraet').toLowerCase()
      .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[c]))
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'geraet';
    let id = base, k = 2;
    while (used.has(id)) id = base + '_' + k++;
    used.add(id);
    return id;
  }

  // Erzeugt nodes[] aus den Energie-Dashboard-Präferenzen (energy/get_prefs).
  // Es werden nur Einträge übernommen, die einen Leistungssensor (stat_rate) haben.
  function buildConfigFromEnergyPrefs(prefs, hass) {
    const nodes = [];
    const used = new Set();
    const slug = (s) => {
      const base = String(s || 'geraet').toLowerCase()
        .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[c]))
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'geraet';
      let id = base, k = 2;
      while (used.has(id)) id = base + '_' + k++;
      used.add(id);
      return id;
    };
    const fname = (id, fb) => {
      const st = hass && hass.states && hass.states[id];
      return (st && st.attributes && st.attributes.friendly_name) || fb || id;
    };
    for (const src of prefs.energy_sources || []) {
      const pc = src.power_config || {};
      const rate = src.stat_rate || pc.stat_rate || null;
      if (!rate) continue;
      if (src.type === 'solar') {
        nodes.push({ id: slug('pv'), name: 'PV', icon: 'mdi:solar-power', color: '#FDB813', power_entity: rate, role: 'source' });
      } else if (src.type === 'battery') {
        nodes.push({ id: slug('batterie'), name: 'Batterie', icon: 'mdi:battery-high', color: '#4CAF50', power_entity: rate, role: 'auto' });
      } else if (src.type === 'grid') {
        nodes.push({ id: slug('netz'), name: 'Netz', icon: 'mdi:transmission-tower', color: '#9E9E9E', power_entity: rate, role: 'auto' });
      }
    }
    let k = 0;
    for (const dev of prefs.device_consumption || []) {
      if (!dev.stat_rate) continue;
      const nm = dev.name || fname(dev.stat_consumption);
      nodes.push({
        id: slug(nm), name: nm, icon: 'mdi:power-plug',
        color: EDITOR_PALETTE[k++ % EDITOR_PALETTE.length],
        power_entity: dev.stat_rate, energy_entity: dev.stat_consumption, role: 'consumer',
      });
    }
    return { nodes, groups: [] };
  }

  const EDITOR_FIELDS = [
    { path: ['options', 'max_power'], labelKey: 'f_max_power', def: 20000 },
    { path: ['options', 'min_circle_px'], labelKey: 'f_min_circle', def: 60 },
    { path: ['options', 'size_max_factor'], labelKey: 'f_size_factor', def: 2.5, step: 0.1 },
    { path: ['options', 'pulse_hz_min'], labelKey: 'f_pulse_min', def: 0.5, step: 0.1 },
    { path: ['options', 'pulse_hz_max'], labelKey: 'f_pulse_max', def: 10, step: 0.5 },
    { path: ['options', 'visual_pulse_cap_hz'], labelKey: 'f_pulse_cap', def: 3, step: 0.5 },
    { path: ['options', 'dots_max'], labelKey: 'f_dots', def: 60 },
    { path: ['options', 'zero_threshold_w'], labelKey: 'f_deadzone', def: 25 },
    { path: ['options', 'density'], labelKey: 'f_density', def: 1, step: 0.1 },
    { path: ['options', 'width'], labelKey: 'f_width', def: '', text: true },
    { path: ['options', 'height'], labelKey: 'f_height', def: '', text: true },
    { path: ['stats', 'grid_import'], labelKey: 'f_grid_import', def: '', text: true, entity: 'energy' },
    { path: ['stats', 'grid_export'], labelKey: 'f_grid_export', def: '', text: true, entity: 'energy' },
    { path: ['stats', 'pv'], labelKey: 'f_pv', def: '', text: true, entity: 'energy' },
    { path: ['stats', 'battery_in'], labelKey: 'f_battery_in', def: '', text: true, entity: 'energy' },
    { path: ['stats', 'battery_out'], labelKey: 'f_battery_out', def: '', text: true, entity: 'energy' },
    { path: ['inverter', 'size'], labelKey: 'f_center_size', def: 90 },
    { path: ['inverter', 'icon'], labelKey: 'f_center_icon', def: 'mdi:engine', text: true },
    { path: ['inverter', 'color'], labelKey: 'f_center_color', def: '#1565C0', text: true },
    { path: ['inverter', 'power_entity'], labelKey: 'f_center_entity', def: '', text: true, entity: 'power' },
  ];

  class EnergyCardEditor extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._config = {};
      this._hass = null;
      this._inputs = new Map();
      this._built = false;
      this._listSig = '';
      this._pickerEls = [];
      this._lang = 'en';
      this._t = makeT('en');
    }

    set hass(h) {
      this._hass = h;
      // pass hass to all live entity pickers (prune detached ones)
      this._pickerEls = this._pickerEls.filter((p) => p.isConnected);
      for (const p of this._pickerEls) p.hass = h;
      if (this._applyLang() && this._built) this._rebuild();
    }

    // Resolve the editor language; returns true when it changed
    _applyLang() {
      const lang = resolveLang(this._hass, this._config && this._config.language);
      if (lang === this._lang) return false;
      this._lang = lang;
      this._t = makeT(lang);
      return true;
    }

    // Full editor rebuild (used when the language changes)
    _rebuild() {
      this._inputs = new Map();
      this._pickerEls = [];
      this._listSig = '';
      this._built = false;
      this._build();
      this._sync();
    }

    // HA-eigene Picker-Elemente laden: der Editor der entities-Card registriert
    // ha-entity-picker. Schlägt das fehl, bleiben die Fallback-Textfelder aktiv.
    static _loadHaPickers() {
      if (customElements.get('ha-entity-picker')) return Promise.resolve();
      if (!EnergyCardEditor._pickersLoading) {
        EnergyCardEditor._pickersLoading = (async () => {
          try {
            if (!window.loadCardHelpers) return;
            const helpers = await window.loadCardHelpers();
            const card = await helpers.createCardElement({ type: 'entities', entities: [] });
            if (card && card.constructor && card.constructor.getConfigElement) {
              await card.constructor.getConfigElement();
            }
          } catch (e) { /* Fallback-Textfelder bleiben */ }
        })();
      }
      return EnergyCardEditor._pickersLoading;
    }

    // Entity-Auswahlfeld: klassisches HA-Pulldown (ha-entity-picker) mit
    // Einheiten-Filter (kind: power/energy/percent/temperature/capacity/toggle);
    // solange der Picker nicht registriert ist, dient ein Textfeld als Fallback.
    // Der zurückgegebene Wrapper hat eine value-Property für _sync.
    _mkEntityPicker(value, kind, onChange) {
      const wrap = document.createElement('div');
      wrap.className = 'epWrap';
      Object.defineProperty(wrap, 'value', {
        get: () => (wrap.firstChild && wrap.firstChild.value != null ? String(wrap.firstChild.value) : ''),
        set: (v) => { if (wrap.firstChild) wrap.firstChild.value = v == null ? '' : String(v); },
      });
      const mount = (initial) => {
        const p = document.createElement('ha-entity-picker');
        if (this._hass) p.hass = this._hass;
        p.value = initial || '';
        p.allowCustomEntity = true;
        if (kind === 'toggle') {
          p.includeDomains = ['switch', 'light', 'input_boolean', 'fan', 'climate', 'humidifier'];
        } else {
          p.includeDomains = ['sensor'];
          const f = EDITOR_ENTITY_FILTERS[kind];
          if (f) p.entityFilter = f;
        }
        p.addEventListener('value-changed', (ev) => {
          ev.stopPropagation();
          onChange((ev.detail && ev.detail.value) || '');
        });
        this._pickerEls.push(p);
        wrap.replaceChildren(p);
      };
      if (customElements.get('ha-entity-picker')) {
        mount(value);
      } else {
        const inp = this._mkInput('text', value || '', 'sensor.…');
        inp.addEventListener('change', () => onChange(inp.value.trim()));
        wrap.appendChild(inp);
        EnergyCardEditor._loadHaPickers().then(() => {
          if (customElements.get('ha-entity-picker') && wrap.firstChild === inp) {
            mount(inp.value.trim() || value || '');
          }
        }).catch(() => {});
      }
      return wrap;
    }

    setConfig(config) {
      this._config = JSON.parse(JSON.stringify(config || {}));
      if (!Array.isArray(this._config.nodes)) this._config.nodes = [];
      if (!Array.isArray(this._config.groups)) this._config.groups = [];
      if (this._applyLang() && this._built) { this._rebuild(); return; }
      if (!this._built) this._build();
      this._sync();
    }

    _get(path, def) {
      let o = this._config;
      for (const key of path) {
        if (!o || typeof o !== 'object') return def;
        o = o[key];
      }
      return o == null ? def : o;
    }

    _setPath(path, val) {
      let o = this._config;
      for (let i = 0; i < path.length - 1; i++) {
        if (typeof o[path[i]] !== 'object' || o[path[i]] == null) o[path[i]] = {};
        o = o[path[i]];
      }
      const last = path[path.length - 1];
      if (val === '' || val == null || Number.isNaN(val)) delete o[last];
      else o[last] = val;
    }

    _emit() {
      this.dispatchEvent(new CustomEvent('config-changed', {
        detail: { config: JSON.parse(JSON.stringify(this._config)) },
        bubbles: true, composed: true,
      }));
    }

    _status(msg) { if (this._statusEl) this._statusEl.textContent = msg || ''; }

    _mkInput(type, value, placeholder, cls) {
      const inp = document.createElement('input');
      inp.type = type;
      if (value != null) inp.value = value;
      if (placeholder) inp.placeholder = placeholder;
      if (cls) inp.className = cls;
      return inp;
    }

    _mkTrash(fn) {
      const b = document.createElement('button');
      b.className = 'trash';
      b.title = this._t('del');
      if (customElements.get('ha-icon')) {
        const ic = document.createElement('ha-icon');
        ic.setAttribute('icon', 'mdi:delete');
        ic.style.setProperty('--mdc-icon-size', '16px');
        b.appendChild(ic);
      } else {
        b.textContent = '🗑';
      }
      b.addEventListener('click', fn);
      return b;
    }

    _build() {
      const root = this.shadowRoot;
      root.innerHTML = '';
      const style = document.createElement('style');
      style.textContent = `
        .ed { display: flex; flex-direction: column; gap: 8px; padding: 4px 2px; }
        label { display: flex; justify-content: space-between; align-items: center; gap: 10px;
                font-size: 13px; color: var(--primary-text-color, #ddd); }
        input[type=number], input[type=text] {
          width: 150px; padding: 5px 7px; border-radius: 6px; box-sizing: border-box;
          border: 1px solid var(--divider-color, #555);
          background: var(--card-background-color, #222);
          color: var(--primary-text-color, #eee); font-size: 13px;
        }
        select {
          padding: 5px 7px; border-radius: 6px; font-size: 12px; max-width: 140px;
          border: 1px solid var(--divider-color, #555);
          background: var(--card-background-color, #222);
          color: var(--primary-text-color, #eee);
        }
        .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
        button {
          padding: 7px 12px; border-radius: 8px; cursor: pointer; font-size: 13px;
          border: 1px solid var(--divider-color, #555);
          background: var(--secondary-background-color, #2c313a);
          color: var(--primary-text-color, #eee);
        }
        button:hover { filter: brightness(1.15); }
        button.trash { padding: 4px 8px; line-height: 1; color: #ef5350; }
        .hint { font-size: 12px; color: var(--secondary-text-color, #999); line-height: 1.4; }
        .status { font-size: 12px; color: var(--primary-color, #03a9f4); min-height: 15px; }
        h4 { margin: 8px 0 2px; font-size: 12px; color: var(--secondary-text-color, #aaa);
             text-transform: uppercase; letter-spacing: 0.5px; }
        .gRow { display: flex; gap: 6px; align-items: center; }
        .gRow input { flex: 1; width: auto; min-width: 0; }
        .nItem { border: 1px solid var(--divider-color, #3c4043); border-radius: 8px;
                 padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
        .nRow { display: flex; gap: 6px; align-items: center; }
        .nName { flex: 1; width: auto !important; min-width: 0; font-weight: 600; }
        .nEid { font-size: 11px; color: var(--secondary-text-color, #888);
                font-family: monospace; word-break: break-all; }
        .nExtra { width: 100% !important; font-family: monospace; font-size: 11px; }
        .nExtra.bad { border-color: #ef5350 !important; }
        .picker { border: 1px solid var(--divider-color, #3c4043); border-radius: 8px;
                  padding: 8px; flex-direction: column; gap: 6px; }
        .pickHead { display: flex; justify-content: space-between; align-items: center;
                    font-weight: 600; font-size: 13px; color: var(--primary-text-color, #eee); }
        .pickList { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
        .pickRow { padding: 4px 6px; border-radius: 6px; cursor: pointer; }
        .pickRow:hover { background: var(--secondary-background-color, #2c313a); }
        .pickName { font-size: 13px; font-weight: 600; color: var(--primary-text-color, #eee); }
        .pickForm { flex-direction: column; gap: 6px; padding-top: 8px;
                    border-top: 1px solid var(--divider-color, #3c4043); }
        .epWrap { flex: 1; min-width: 180px; max-width: 300px; }
        .epWrap input { width: 100%; }
        .epWrap ha-entity-picker { display: block; width: 100%; }
      `;
      root.appendChild(style);
      const box = div('ed', root);
      this._box = box;
      const section = (t) => { const h = document.createElement('h4'); h.textContent = t; box.appendChild(h); };
      EnergyCardEditor._loadHaPickers(); // Picker parallel laden, Felder rüsten selbst nach

      /* ---- Setup ---- */
      section(this._t('sec_setup'));
      const rowTop = div('row', box);
      const demoLbl = document.createElement('label');
      demoLbl.style.justifyContent = 'flex-start';
      demoLbl.appendChild(document.createTextNode(this._t('demo_mode')));
      const demoCb = document.createElement('input');
      demoCb.type = 'checkbox';
      demoLbl.appendChild(demoCb);
      rowTop.appendChild(demoLbl);
      demoCb.addEventListener('change', () => { this._config.demo = demoCb.checked; this._emit(); });
      this._demoCb = demoCb;

      const clockLbl = document.createElement('label');
      clockLbl.style.justifyContent = 'flex-start';
      clockLbl.appendChild(document.createTextNode(this._t('show_clock')));
      const clockCb = document.createElement('input');
      clockCb.type = 'checkbox';
      clockLbl.appendChild(clockCb);
      rowTop.appendChild(clockLbl);
      clockCb.addEventListener('change', () => {
        this._setPath(['options', 'show_clock'], clockCb.checked);
        this._emit();
      });
      this._clockCb = clockCb;

      const statsLbl = document.createElement('label');
      statsLbl.style.justifyContent = 'flex-start';
      statsLbl.appendChild(document.createTextNode(this._t('show_stats')));
      const statsCb = document.createElement('input');
      statsCb.type = 'checkbox';
      statsLbl.appendChild(statsCb);
      rowTop.appendChild(statsLbl);
      statsCb.addEventListener('change', () => {
        this._setPath(['stats', 'show'], statsCb.checked);
        this._emit();
      });
      this._statsCb = statsCb;

      const resLbl = document.createElement('label');
      resLbl.style.justifyContent = 'flex-start';
      resLbl.appendChild(document.createTextNode(this._t('show_residual')));
      const resCb = document.createElement('input');
      resCb.type = 'checkbox';
      resLbl.appendChild(resCb);
      rowTop.appendChild(resLbl);
      resCb.addEventListener('change', () => {
        this._setPath(['residual', 'show'], resCb.checked);
        this._emit();
      });
      this._residualCb = resCb;

      const impBtn = document.createElement('button');
      impBtn.textContent = this._t('import_energy');
      rowTop.appendChild(impBtn);

      const rowImp = div('row', box);
      const filterI = this._mkInput('text', '', this._t('name_filter'));
      filterI.style.width = '120px';
      const powBtn = document.createElement('button');
      powBtn.textContent = this._t('load_power');
      rowImp.appendChild(powBtn);
      rowImp.appendChild(filterI);

      const pickBtn = document.createElement('button');
      pickBtn.textContent = this._t('pick_new');
      pickBtn.title = this._t('pick_new_title');
      rowImp.appendChild(pickBtn);
      pickBtn.addEventListener('click', () => this._openPicker());

      const status = div('status', box);
      this._statusEl = status;

      this._pickerBox = div('picker', box);
      this._pickerBox.style.display = 'none';

      impBtn.addEventListener('click', async () => {
        if (!this._hass || !this._hass.callWS) { this._status(this._t('no_conn')); return; }
        this._status(this._t('reading_energy'));
        try {
          const prefs = await this._hass.callWS({ type: 'energy/get_prefs' });
          const gen = buildConfigFromEnergyPrefs(prefs, this._hass);
          if (!gen.nodes.length) {
            this._status(this._t('no_stat_rate'));
            return;
          }
          this._config.nodes = gen.nodes;
          this._config.demo = false;
          this._emit();
          this._sync();
          this._status(this._t('imported').replace('{n}', gen.nodes.length));
        } catch (e) {
          this._status(this._t('import_failed') + ((e && e.message) || e));
        }
      });

      powBtn.addEventListener('click', () => this._importPowerEntities(filterI.value));

      /* ---- Options ---- */
      section(this._t('sec_options'));
      for (const f of EDITOR_FIELDS) {
        const lbl = document.createElement('label');
        lbl.appendChild(document.createTextNode(this._t(f.labelKey)));
        let inp;
        if (f.entity) {
          // Entity-Felder: klassisches Pulldown, nach Einheit gefiltert
          inp = this._mkEntityPicker(this._get(f.path, '') || '', f.entity, (v) => {
            this._setPath(f.path, v || null);
            this._emit();
          });
        } else {
          inp = document.createElement('input');
          inp.type = f.text ? 'text' : 'number';
          if (!f.text && f.step) inp.step = String(f.step);
          inp.addEventListener('change', () => {
            const v = f.text ? inp.value.trim() : (inp.value === '' ? null : +inp.value);
            this._setPath(f.path, v);
            this._emit();
          });
        }
        lbl.appendChild(inp);
        box.appendChild(lbl);
        this._inputs.set(f.path.join('.'), { f, inp });
      }

      /* ---- Storage ---- */
      section(this._t('sec_storage'));
      const spLbl = document.createElement('label');
      spLbl.style.justifyContent = 'flex-start';
      spLbl.appendChild(document.createTextNode(this._t('show_storage')));
      const spCb = document.createElement('input');
      spCb.type = 'checkbox';
      spLbl.appendChild(spCb);
      box.appendChild(spLbl);
      spCb.addEventListener('change', () => {
        this._setPath(['storage', 'show'], spCb.checked);
        this._emit();
      });
      this._storageCb = spCb;
      this._storageBox = div('', box);
      const addSpRow = div('row', box);
      const addSpBtn = document.createElement('button');
      addSpBtn.textContent = this._t('add_storage');
      addSpRow.appendChild(addSpBtn);
      addSpBtn.addEventListener('click', () => {
        if (!this._config.storage || typeof this._config.storage !== 'object') this._config.storage = {};
        if (!Array.isArray(this._config.storage.items)) this._config.storage.items = [];
        this._config.storage.items.push({ name: this._t('st_new'), capacity_kwh: 10 });
        this._emit();
        this._renderLists();
      });
      const spHint = div('hint', box);
      spHint.textContent = this._t('storage_hint');

      /* ---- Groups ---- */
      section(this._t('sec_groups'));
      this._groupsBox = div('', box);
      const addRow = div('row', box);
      const newGroupI = this._mkInput('text', '', this._t('new_group_ph'));
      const addBtn = document.createElement('button');
      addBtn.textContent = this._t('add_group');
      addRow.appendChild(newGroupI);
      addRow.appendChild(addBtn);
      addBtn.addEventListener('click', () => {
        const name = newGroupI.value.trim();
        if (!name) { this._status(this._t('enter_group_name')); return; }
        const used = new Set([
          ...this._config.groups.map((g) => g.id),
          ...this._config.nodes.map((n) => n.id),
        ]);
        this._config.groups.push({
          id: makeUniqueSlug(name, used), name,
          icon: 'mdi:shape', color: EDITOR_PALETTE[this._config.groups.length % EDITOR_PALETTE.length],
        });
        newGroupI.value = '';
        this._emit();
        this._renderLists();
      });

      /* ---- Devices ---- */
      section(this._t('sec_devices'));
      this._nodesBox = div('', box);

      const hint = div('hint', box);
      hint.textContent = this._t('devices_hint');
      this._built = true;
    }

    /* Alle sensor.*-Entities mit Einheit W/kW laden, optional nach Name gefiltert */
    _importPowerEntities(filter) {
      const h = this._hass;
      if (!h || !h.states) { this._status(this._t('no_conn')); return; }
      const nodes = this._config.nodes;
      const existing = new Set();
      for (const n of nodes) {
        if (n.power_entity) existing.add(n.power_entity);
        for (const e of n.power_entities || []) existing.add(e);
      }
      const used = new Set([
        ...nodes.map((n) => n.id),
        ...this._config.groups.map((g) => g.id),
      ]);
      const f = String(filter || '').trim().toLowerCase();
      let added = 0, k = nodes.length;
      for (const id of Object.keys(h.states).sort()) {
        if (!id.startsWith('sensor.')) continue;
        const st = h.states[id];
        const at = st.attributes || {};
        const unit = String(at.unit_of_measurement || '').trim();
        if (!/^k?W$/i.test(unit)) continue;
        const nm = at.friendly_name || id;
        if (f && !nm.toLowerCase().includes(f) && !id.toLowerCase().includes(f)) continue;
        if (existing.has(id)) continue;
        const cleanName = nm.replace(/\s*(Leistung|Power)\s*$/i, '').trim() || nm;
        nodes.push({
          id: makeUniqueSlug(cleanName, used), name: cleanName,
          icon: 'mdi:power-plug', color: EDITOR_PALETTE[k++ % EDITOR_PALETTE.length],
          power_entity: id, role: 'consumer',
        });
        added++;
      }
      if (added) {
        this._config.demo = false;
        this._emit();
        this._renderLists();
        this._sync();
      }
      this._status(added
        ? this._t('loaded_n').replace('{n}', added)
        : this._t('nothing_new').replace('{f}', f || '–'));
    }

    /* Picker: alle noch nicht verwendeten Watt-Entities anzeigen, Klick öffnet
       das Konfigurationsformular, "Hinzufügen" übernimmt den Knoten. */
    _openPicker() {
      const h = this._hass;
      if (!h || !h.states) { this._status(this._t('no_conn')); return; }
      const box = this._pickerBox;
      box.style.display = 'flex';
      box.innerHTML = '';

      const head = div('pickHead', box);
      const title = document.createElement('span');
      title.textContent = this._t('picker_header');
      head.appendChild(title);
      const closeB = document.createElement('button');
      closeB.textContent = this._t('close');
      closeB.addEventListener('click', () => { box.style.display = 'none'; });
      head.appendChild(closeB);

      const listEl = div('pickList', box);
      const formEl = div('pickForm', box);
      formEl.style.display = 'none';

      const existing = new Set();
      for (const n of this._config.nodes) {
        if (n.power_entity) existing.add(n.power_entity);
        for (const e of n.power_entities || []) existing.add(e);
      }
      const items = [];
      for (const id of Object.keys(h.states)) {
        if (!id.startsWith('sensor.')) continue;
        const st = h.states[id];
        const at = st.attributes || {};
        if (!/^k?W$/i.test(String(at.unit_of_measurement || '').trim())) continue;
        if (existing.has(id)) continue;
        items.push({ id, name: at.friendly_name || id, state: st.state, unit: at.unit_of_measurement });
      }
      items.sort((a, b) => a.name.localeCompare(b.name, this._lang));
      if (!items.length) {
        div('hint', listEl).textContent = this._t('none_found');
        return;
      }
      for (const it of items) {
        const row = div('pickRow', listEl);
        div('pickName', row).textContent = it.name;
        div('nEid', row).textContent = it.id + ' — ' + it.state + ' ' + (it.unit || 'W');
        row.addEventListener('click', () => this._openPickerForm(it, formEl, row));
      }
    }

    _openPickerForm(it, formEl, row) {
      formEl.style.display = 'flex';
      formEl.innerHTML = '';
      div('pickName', formEl).textContent = it.name;

      const mkRow = (label, el) => {
        const lbl = document.createElement('label');
        lbl.appendChild(document.createTextNode(label));
        lbl.appendChild(el);
        formEl.appendChild(lbl);
        return el;
      };
      const cleanName = it.name.replace(/\s*(Leistung|Power)\s*$/i, '').trim() || it.name;
      const nameI = mkRow(this._t('name'), this._mkInput('text', cleanName, ''));

      const groupSel = document.createElement('select');
      const o0 = document.createElement('option');
      o0.value = '';
      o0.textContent = this._t('no_group');
      groupSel.appendChild(o0);
      for (const g of this._config.groups) {
        const o = document.createElement('option');
        o.value = g.id;
        o.textContent = g.name || g.id;
        groupSel.appendChild(o);
      }
      mkRow(this._t('group'), groupSel);

      // Farbe: Auswahlfeld UND Hex-Feld, beidseitig synchron
      const defColor = EDITOR_PALETTE[this._config.nodes.length % EDITOR_PALETTE.length];
      const colorI = this._mkInput('color', defColor, '');
      colorI.style.width = '46px';
      colorI.style.padding = '2px';
      const hexI = this._mkInput('text', defColor, '#rrggbb');
      hexI.style.width = '90px';
      colorI.addEventListener('input', () => { hexI.value = colorI.value; });
      hexI.addEventListener('change', () => {
        const v = hexI.value.trim();
        if (/^#[0-9a-f]{6}$/i.test(v)) colorI.value = v;
      });
      const colorLbl = document.createElement('label');
      colorLbl.appendChild(document.createTextNode(this._t('color')));
      const colorWrap = div('row');
      colorWrap.appendChild(colorI);
      colorWrap.appendChild(hexI);
      colorLbl.appendChild(colorWrap);
      formEl.appendChild(colorLbl);

      const iconI = mkRow(this._t('icon_lbl'), this._mkInput('text', 'mdi:power-plug', ''));
      const roleSel = document.createElement('select');
      [['consumer', this._t('role_consumer')], ['source', this._t('role_source')], ['auto', this._t('role_auto')]].forEach(([v, txt]) => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = txt;
        roleSel.appendChild(o);
      });
      mkRow(this._t('role'), roleSel);
      const energyI = mkRow(this._t('energy_entity'), this._mkEntityPicker('', 'energy', () => {}));
      const toggleI = mkRow(this._t('toggle_entity'), this._mkEntityPicker('', 'toggle', () => {}));

      const btnRow = div('row', formEl);
      const addB = document.createElement('button');
      addB.textContent = this._t('add');
      const cancelB = document.createElement('button');
      cancelB.textContent = this._t('cancel');
      btnRow.appendChild(addB);
      btnRow.appendChild(cancelB);
      cancelB.addEventListener('click', () => { formEl.style.display = 'none'; formEl.innerHTML = ''; });
      addB.addEventListener('click', () => {
        const used = new Set([
          ...this._config.nodes.map((x) => x.id),
          ...this._config.groups.map((g) => g.id),
        ]);
        const node = {
          id: makeUniqueSlug(nameI.value.trim() || cleanName, used),
          name: nameI.value.trim() || cleanName,
          icon: iconI.value.trim() || 'mdi:power-plug',
          color: /^#[0-9a-f]{6}$/i.test(hexI.value.trim()) ? hexI.value.trim() : colorI.value,
          power_entity: it.id,
          role: roleSel.value,
        };
        if (groupSel.value) node.group = groupSel.value;
        if (energyI.value.trim()) node.energy_entity = energyI.value.trim();
        if (toggleI.value.trim()) node.toggle_entity = toggleI.value.trim();
        this._config.nodes.push(node);
        this._config.demo = false;
        this._emit();
        this._renderLists();
        if (row && row.parentNode) row.remove();
        formEl.style.display = 'none';
        formEl.innerHTML = '';
        this._status(this._t('added_x').replace('{n}', node.name));
      });
    }

    _extraJson(n) {
      const skip = new Set(['id', 'name', 'group', 'power_entity', 'power_entities']);
      const extra = {};
      for (const key of Object.keys(n)) if (!skip.has(key)) extra[key] = n[key];
      return Object.keys(extra).length ? JSON.stringify(extra) : '';
    }

    _computeSig() {
      const st = this._config.storage;
      return JSON.stringify([this._config.groups, this._config.nodes, (st && st.items) || []]);
    }

    /* Speicher-Zeilen: Name + Kapazität(kWh) + Trash, darunter Entity-Picker
       für SoC (%), Temperatur (°C, mit Bereich) und Kapazitäts-Entity */
    _renderStorage() {
      const sb = this._storageBox;
      if (!sb) return;
      sb.innerHTML = '';
      sb.style.display = 'flex';
      sb.style.flexDirection = 'column';
      sb.style.gap = '6px';
      const st = this._config.storage;
      const items = (st && Array.isArray(st.items)) ? st.items : [];
      if (!items.length) {
        div('hint', sb).textContent = this._t('no_storage');
        return;
      }
      items.forEach((it, i) => {
        const item = div('nItem', sb);
        const row = div('nRow', item);
        const nameI = this._mkInput('text', it.name || '', this._t('name'), 'nName');
        nameI.addEventListener('change', () => { it.name = nameI.value.trim() || this._t('st_default'); this._emit(); });
        row.appendChild(nameI);
        const capI = this._mkInput('number', it.capacity_kwh != null ? String(it.capacity_kwh) : '', 'kWh');
        capI.style.width = '80px';
        capI.title = this._t('st_cap_title');
        capI.addEventListener('change', () => {
          const v = capI.value === '' ? NaN : +capI.value;
          if (isFinite(v)) it.capacity_kwh = v; else delete it.capacity_kwh;
          this._emit();
        });
        row.appendChild(capI);
        row.appendChild(this._mkTrash(() => {
          items.splice(i, 1);
          this._emit();
          this._renderLists();
        }));
        const mkEnt = (label, key, kind) => {
          const lbl = document.createElement('label');
          lbl.appendChild(document.createTextNode(label));
          lbl.appendChild(this._mkEntityPicker(it[key] || '', kind, (v) => {
            if (v) it[key] = v; else delete it[key];
            this._emit();
          }));
          item.appendChild(lbl);
        };
        mkEnt(this._t('st_soc'), 'soc_entity', 'percent');
        mkEnt(this._t('st_temp'), 'temp_entity', 'temperature');
        const tLbl = document.createElement('label');
        tLbl.appendChild(document.createTextNode(this._t('st_range')));
        const tWrap = div('row');
        const mkTemp = (key, ph) => {
          const inp = this._mkInput('number', it[key] != null ? String(it[key]) : '', ph);
          inp.style.width = '70px';
          inp.addEventListener('change', () => {
            const v = inp.value === '' ? NaN : +inp.value;
            if (isFinite(v)) it[key] = v; else delete it[key];
            this._emit();
          });
          tWrap.appendChild(inp);
          return inp;
        };
        mkTemp('temp_min', '20');
        mkTemp('temp_max', '80');
        tLbl.appendChild(tWrap);
        item.appendChild(tLbl);
        mkEnt(this._t('st_cap_entity'), 'capacity_entity', 'capacity');
      });
    }

    _renderLists() {
      if (!this._built) return;
      const groups = this._config.groups;
      const nodes = this._config.nodes;

      /* Gruppen-Zeilen: Name, Icon, Farbe, Löschen */
      const gb = this._groupsBox;
      gb.innerHTML = '';
      gb.style.display = 'flex';
      gb.style.flexDirection = 'column';
      gb.style.gap = '4px';
      if (!groups.length) {
        const empty = div('hint', gb);
        empty.textContent = this._t('no_groups');
      }
      groups.forEach((g, gi) => {
        const row = div('gRow', gb);
        const nameI = this._mkInput('text', g.name || g.id, this._t('name'));
        const iconI = this._mkInput('text', g.icon || '', 'mdi:…');
        const colorI = this._mkInput('text', g.color || '', '#Farbe');
        nameI.addEventListener('change', () => { g.name = nameI.value.trim() || g.id; this._emit(); });
        iconI.addEventListener('change', () => {
          const v = iconI.value.trim();
          if (v) g.icon = v; else delete g.icon;
          this._emit();
        });
        colorI.addEventListener('change', () => {
          const v = colorI.value.trim();
          if (v) g.color = v; else delete g.color;
          this._emit();
        });
        row.appendChild(nameI);
        row.appendChild(iconI);
        row.appendChild(colorI);
        row.appendChild(this._mkTrash(() => {
          groups.splice(gi, 1);
          for (const n of nodes) if (n.group === g.id) delete n.group;
          this._emit();
          this._renderLists();
        }));
      });

      /* Geräte-Liste: Name + Gruppe + Trash, Entity-Zeile, Extra-JSON */
      const nb = this._nodesBox;
      nb.innerHTML = '';
      nb.style.display = 'flex';
      nb.style.flexDirection = 'column';
      nb.style.gap = '6px';
      if (!nodes.length) {
        const empty = div('hint', nb);
        empty.textContent = this._t('no_devices');
      }
      nodes.forEach((n, ni) => {
        const item = div('nItem', nb);
        const row = div('nRow', item);

        const nameI = this._mkInput('text', n.name || n.id, this._t('name'), 'nName');
        nameI.addEventListener('change', () => { n.name = nameI.value.trim() || n.id; this._emit(); });
        row.appendChild(nameI);

        const sel = document.createElement('select');
        const optNone = document.createElement('option');
        optNone.value = '';
        optNone.textContent = this._t('no_group');
        sel.appendChild(optNone);
        for (const g of groups) {
          const o = document.createElement('option');
          o.value = g.id;
          o.textContent = g.name || g.id;
          sel.appendChild(o);
        }
        sel.value = n.group || '';
        sel.addEventListener('change', () => {
          if (sel.value) n.group = sel.value; else delete n.group;
          this._emit();
        });
        row.appendChild(sel);

        row.appendChild(this._mkTrash(() => {
          nodes.splice(ni, 1);
          this._emit();
          this._renderLists();
        }));

        const eid = div('nEid', item);
        eid.textContent = n.power_entities ? n.power_entities.join(' + ') : (n.power_entity || '(keine Leistungs-Entity)');

        const extraI = this._mkInput('text', this._extraJson(n), '', 'nExtra');
        extraI.placeholder = '{"color":"#4CAF50","icon":"mdi:battery","role":"auto","ring":"fill",'
          + '"fill_entity":"sensor.soc","fill_min":0,"fill_max":100,'
          + '"inner_text_entity":"sensor.soc","inner_text_unit":"%","toggle_entity":"switch.x"}';
        extraI.addEventListener('change', () => {
          const t = extraI.value.trim();
          let extra = {};
          if (t) {
            try {
              extra = JSON.parse(t);
              if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error(this._t('expected_object'));
            } catch (e) {
              extraI.classList.add('bad');
              this._status(this._t('invalid_json').replace('{n}', n.name || n.id) + e.message);
              return;
            }
          }
          extraI.classList.remove('bad');
          this._status('');
          const keep = { id: n.id, name: n.name };
          if (n.power_entity) keep.power_entity = n.power_entity;
          if (n.power_entities) keep.power_entities = n.power_entities;
          if (n.group) keep.group = n.group;
          nodes[ni] = Object.assign(keep, extra);
          this._emit();
        });
        item.appendChild(extraI);
      });

      this._renderStorage();
      this._listSig = this._computeSig();
    }

    _sync() {
      if (!this._built) return;
      const active = this.shadowRoot.activeElement;
      if (this._demoCb) this._demoCb.checked = !!this._config.demo;
      if (this._clockCb) this._clockCb.checked = this._get(['options', 'show_clock'], true) !== false;
      if (this._statsCb) this._statsCb.checked = this._get(['stats', 'show'], true) !== false;
      if (this._storageCb) this._storageCb.checked = this._get(['storage', 'show'], true) !== false;
      if (this._residualCb) this._residualCb.checked = this._get(['residual', 'show'], false) === true;
      for (const { f, inp } of this._inputs.values()) {
        // Picker-Wrapper: Fokus steckt in einem Kind-Element, nicht im Wrapper
        if (inp === active || (active && inp.contains && inp.contains(active))) continue;
        const v = this._get(f.path, f.def);
        inp.value = v == null ? '' : String(v);
      }
      // Listen nur neu bauen, wenn sich Gruppen/Knoten strukturell geändert haben
      // (nach eigenem Emit kommt setConfig mit identischem Inhalt zurück → kein Rebuild,
      // Fokus bleibt erhalten)
      if (this._computeSig() !== this._listSig) this._renderLists();
    }
  }

  customElements.define('dynamic-energy-card', EnergyCard);
  if (!customElements.get('dynamic-energy-card-editor')) customElements.define('dynamic-energy-card-editor', EnergyCardEditor);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'dynamic-energy-card',
    name: 'Dynamic EnergyCard',
    description: 'Animated live energy flow with a force layout, groups, storage panel and demo mode',
    preview: true,
    documentationURL: 'https://github.com/badboiaustria/dynamic-energy-card',
  });
  // eslint-disable-next-line no-console
  console.info(
    `%c DYNAMIC ENERGYCARD %c v${VERSION} `,
    'background:#1565C0;color:#fff;padding:2px 6px;border-radius:4px 0 0 4px;font-weight:700',
    'background:#333;color:#fff;padding:2px 6px;border-radius:0 4px 4px 0'
  );
})();
