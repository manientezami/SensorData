# MoniRail Web Rider

A mobile-first engineering dashboard for recording and analysing train ride quality from a smartphone.

---

## Quick start (browser)

```bash
# Serve locally — required because DeviceMotion needs HTTPS or localhost
npx serve .
# or
python3 -m http.server 8080
```

Open `http://localhost:8080` in Chrome (Android) or Safari (iOS 13+).

> **HTTPS is mandatory for production.** Both DeviceMotion and Geolocation APIs are blocked on plain HTTP except on `localhost`.

---

## Browser compatibility

| Browser | Motion | GPS | Magnetometer | Notes |
|---------|--------|-----|--------------|-------|
| Chrome Android | ✓ | ✓ | Partial | Best support |
| Samsung Internet | ✓ | ✓ | Partial | |
| Safari iOS 13+ | ✓* | ✓ | ✗ | *Requires permission tap |
| Firefox Android | ✓ | ✓ | ✗ | |
| Desktop browsers | ✗ | ✗ | ✗ | Sensors unavailable |

*iOS: A permission dialog appears when you tap **Start**. If denied, the app enters `LIMITED IOS MODE` and motion data will not be collected.*

---

## Permissions required

- **DeviceMotion / DeviceOrientation** — accelerometer and gyroscope
- **Geolocation** — GPS position and speed
- *Magnetometer via Generic Sensor API (Chromium only, not required)*

---

## Folder structure

```
monirail-web-rider/
├── index.html          Main application page
├── css/
│   └── style.css       Engineering dashboard theme
├── js/
│   ├── config.js       ← All thresholds and settings (edit here)
│   ├── sensors.js      ← Sensor acquisition (DeviceMotion + GPS)
│   ├── calibration.js  ← Phone → train frame coordinate transform
│   ├── processing.js   ← EN 12299 Wb/Wd filters + comfort metrics
│   ├── events.js       ← Event detection (comfort, displacement, curve, shock)
│   ├── map.js          ← Leaflet route and event marker layer
│   ├── export.js       ← CSV export (raw data, events, summary)
│   └── app.js          ← Application controller (wires all modules)
└── README.md
```

---

## Calibration

Before recording, select the phone mounting orientation:

| Mode | Description |
|------|-------------|
| Portrait — screen faces forward | Phone upright, screen facing direction of travel |
| Portrait — screen faces up | Phone flat on seat, top toward front |
| Landscape — screen faces forward | Horizontal phone, screen forward |
| Custom — capture calibration | App captures 100 still samples to estimate gravity vector |

Tap **Apply** before starting a recording.

---

## EN 12299 comfort filters

The Wd (lateral) and Wb (vertical) weighting filters are ported exactly from `comfort.m`:

- Continuous-time transfer functions are built from the same pole/zero specifications as the MATLAB source
- Discretisation uses the bilinear (Tustin) transform at the measured sample rate — identical to `c2d(sysc, Ts, 'tustin')`
- IIR filtering uses Direct Form II Transposed for numerical stability

### Comfort thresholds (configurable in `config.js`)

| Range | Status |
|-------|--------|
| Ccy, Ccz < 0.20 | 🟢 GREEN |
| 0.20 ≤ Ccy, Ccz < 0.30 | 🟢 GREEN *(gap resolved — default GREEN per project decision)* |
| 0.30 ≤ Ccy, Ccz < 0.40 | 🟡 AMBER |
| Ccy or Ccz ≥ 0.40 | 🔴 RED |

Change `CONFIG.comfort.AMBER_MIN` to `0.20` to make the 0.20–0.30 range AMBER instead.

---

## MATLAB migration

Search for `MATLAB_PLACEHOLDER` in `processing.js` and `events.js` to find every function awaiting a client-supplied equation.

Each placeholder documents:
- **Inputs** — exact variable names and units
- **Expected outputs** — variable names and units
- **MATLAB reference** — which section of `comfort.m` the equation comes from

Functions to replace:
1. `computePctPde()` in `processing.js` — PCT and PDE from EN 12299 §6/7
2. `CurveTransientDetector.push()` in `events.js` — curve entry/exit detection
3. `ShockDetector.push()` in `events.js` — discrete event / shock detection
4. `createDisplacementPipeline()` in `processing.js` — replace with validated inertial algorithm

---

## CSV exports

Three files are generated when recording stops (or when **↓ CSV** is tapped):

### `raw_sensor_data_<TIMESTAMP>.csv`
One row per processed sensor sample. Columns: `monotonic_timestamp_ms`, `utc_timestamp_iso`, `sample_interval_ms`, `latitude`, `longitude`, `altitude_m`, `gps_speed_mps`, `gps_speed_mph`, `gps_heading_deg`, `gps_accuracy_m`, `satellite_count`, `acc_x`, `acc_y`, `acc_z`, `gyro_x`, `gyro_y`, `gyro_z`, `mag_x`, `mag_y`, `mag_z`, `roll_deg`, `pitch_deg`, `yaw_deg`, `lateral_acc_mss`, `vertical_acc_mss`, `lateral_disp_mm`, `vertical_disp_mm`, `ccy`, `ccz`, `pct`, `pde`, `comfort_status`, `quality_flag`

### `event_log_<TIMESTAMP>.csv`
One row per detected event. Columns: `event_id`, `event_type`, `start_mono_ms`, `end_mono_ms`, `peak_mono_ms`, `utc_iso`, `latitude`, `longitude`, `speed_mph`, `severity`, `signal_source`, `peak_value`, `units`, `confidence`, `algorithm_version`

### `journey_summary_<TIMESTAMP>.csv`
Single row. Columns: `start_utc`, `end_utc`, `duration_sec`, `total_distance_m`, `avg_speed_mph`, `peak_speed_mph`, `gnss_status`, `mean_sample_rate_hz`, `dropped_gaps`, `max_ccy`, `max_ccz`, `max_pct`, `max_pde`, `comfort_events`, `displacement_events`, `curve_transient_events`, `discrete_events`, `raw_file`, `event_file`, `algorithm_version`

---

## Wrapping with Capacitor (iPhone / enhanced Android)

If browser sensor access is insufficient, wrap the app with Capacitor:

```bash
npm install @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android
npm install @capacitor/motion @capacitor/geolocation

npx cap init "MoniRail Web Rider" "com.monirail.webrider" --web-dir .
npx cap add ios
npx cap add android
npx cap copy
```

Then in **`sensors.js`**, replace `_startMotion()` and `_startGPS()` with Capacitor plugin calls. The `_emit('motion', sample)` interface is unchanged — no other module needs editing.

For file export on device, replace `_downloadBlob()` in **`export.js`** with:

```javascript
import { Filesystem, Directory } from '@capacitor/filesystem';
await Filesystem.writeFile({ path: filename, data: csvString, directory: Directory.Documents });
```

---

## Data quality flags

| Flag | Meaning |
|------|---------|
| `GOOD` | All sensors delivering acceptable data |
| `LOW GNSS` | GPS accuracy > 50 m |
| `SENSOR DROPS` | Sample gap > 100 ms detected |
| `MAGNETOMETER UNAVAILABLE` | Heading from GPS only |
| `LIMITED IOS MODE` | iOS motion permission denied |
| `PERMISSION DENIED` | Sensor permission not granted |

---

## Important engineering notes

- **Do not assume fixed sampling.** Every sample carries its own timestamp. The delivered rate is measured and displayed in the Validation panel.
- **Displacement estimates are approximate.** Smartphone inertial integration always carries drift. The displacement pipeline applies high-pass filtering to mitigate this but results should not be compared to certified rail instrumentation.
- **Comfort metrics require sufficient data.** The EN 12299 RMS envelope uses a 5-second sliding window. Values in the first 5 seconds of recording are not yet fully settled.
- **Algorithm version** `1.0.0-EN12299` is stamped into every export row for traceability.
