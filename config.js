/**
 * MoniRail Web Rider — Configuration
 * All thresholds, tuning parameters and feature flags live here.
 * DO NOT scatter magic numbers across other modules.
 *
 * Algorithm version tag is stamped into every export record so that
 * results can be traced back to the exact processing specification.
 */

const CONFIG = Object.freeze({

  // ── Meta ──────────────────────────────────────────────────────────────────
  APP_NAME:           'MoniRail Web Rider',
  ALGORITHM_VERSION:  '1.0.0-EN12299',

  // ── Sampling ──────────────────────────────────────────────────────────────
  sampling: {
    TARGET_HZ:          100,    // Requested sensor rate (Hz); actual rate may vary
    UI_REFRESH_HZ:      10,     // DOM/chart repaint rate (Hz)
    MAP_REFRESH_HZ:     1,      // Leaflet position update rate (Hz)
    CALC_HZ:            20,     // Comfort metric recalculation rate (Hz)
    // A gap larger than this between samples triggers a "drop" log entry
    MAX_INTERVAL_MS:    100,    // 10 Hz lower bound before flagging a drop
    // If delivered rate falls below this, set quality flag SENSOR_DROPS
    MIN_ACCEPTABLE_HZ:  20,
  },

  // ── EN 12299 Comfort filter ────────────────────────────────────────────────
  // These constants define the Wd (lateral / longitudinal) and Wb (vertical)
  // weighting filters.  They must not be altered without reference to the
  // standard.  The bilinear transform in processing.js uses them directly.
  filterWd: {
    f1: 0.4, f2: 100.0, Q1: 1.0 / Math.SQRT2,   // Band-limiting
    f3: 2.0, f4: 2.0,   Q2: 0.63,                // A-V transition
    // Upward step is commented out in the MATLAB source for Wd — keep disabled
  },
  filterWb: {
    f1: 0.4, f2: 100.0, Q1: 1.0 / Math.SQRT2,   // Band-limiting
    f3: 16.0, f4: 16.0, Q2: 0.63,                // A-V transition
    f5: 2.5,  f6: 4.0,  Q3: 0.8,  Q4: 0.8,      // Upward step
    k:  0.4,                                       // Upward step gain
  },

  // ── Comfort RMS envelope ──────────────────────────────────────────────────
  comfort: {
    WINDOW_SEC:       5,        // Wl — sliding RMS window length (seconds)

    // Traffic-light thresholds (EN 12299 / project requirements)
    // Gap between 0.20 and 0.30 is deliberately GREEN per project decision.
    // Change AMBER_MIN to 0.20 here if the client later requests stricter rules.
    GREEN_MAX:        0.20,     // < 0.20  → GREEN
    AMBER_MIN:        0.30,     // >= 0.30 → AMBER (0.20–0.30 remains GREEN)
    RED_MIN:          0.40,     // >= 0.40 → RED

    // Mean comfort (Nmv / Nvd) percentile parameters — matches MATLAB exactly
    NMV_UPPER_PCT:    95,
    NVD_MEDIAN_PCT:   50,
    NVD_UPPER_PCT:    95,
  },

  // ── PCT / PDE event thresholds ────────────────────────────────────────────
  // PCT and PDE are derived from the mean comfort calculation.
  // MATLAB placeholder functions in processing.js await exact equations.
  pctPde: {
    EVENT_THRESHOLD_PERCENT: 10.0,  // Log event when PCT or PDE > 10 %
  },

  // ── Displacement thresholds ───────────────────────────────────────────────
  displacement: {
    LATERAL_EVENT_MM:  20,
    VERTICAL_EVENT_MM: 20,
    // High-pass filter cutoff applied before integration (Hz)
    // Reduces sensor bias drift without removing ride motion
    HP_CUTOFF_HZ:      0.5,
    // If estimated RMS noise floor exceeds this, flag low-confidence
    CONFIDENCE_NOISE_THRESHOLD_MM: 5.0,
  },

  // ── GPS / GNSS ────────────────────────────────────────────────────────────
  gnss: {
    ACCURACY_GOOD_M:   10,    // hdop-equivalent threshold for GOOD status
    ACCURACY_POOR_M:   50,    // above this → LOW GNSS status
    UPDATE_INTERVAL_MS: 1000,
  },

  // ── Event detection ───────────────────────────────────────────────────────
  events: {
    // Curve transient: placeholder — port MATLAB detection here
    CURVE_JERK_THRESHOLD_MS3: 2.0,    // m/s³ lateral jerk
    CURVE_MIN_DURATION_MS:    500,

    // Discrete / shock: placeholder — port MATLAB detection here
    SHOCK_PEAK_THRESHOLD_MS2: 5.0,    // m/s² peak
    SHOCK_MIN_DURATION_MS:    50,
    SHOCK_MAX_DURATION_MS:    500,

    // Minimum re-trigger gap to avoid flooding the log
    MIN_RETRIGGER_MS: 2000,
  },

  // ── Chart display ─────────────────────────────────────────────────────────
  chart: {
    WINDOW_SEC:  10,    // Seconds of history shown in live scrolling plot
    MAX_POINTS:  1000,  // Hard cap on points kept in rolling chart buffer
  },

  // ── Map ───────────────────────────────────────────────────────────────────
  map: {
    DEFAULT_LAT:  51.5,
    DEFAULT_LNG:  -0.12,
    DEFAULT_ZOOM: 14,
    TILE_URL:     'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    ATTRIBUTION:  '© OpenStreetMap contributors',
  },

  // ── Data quality status labels ────────────────────────────────────────────
  quality: {
    GOOD:                    'GOOD',
    LOW_GNSS:                'LOW GNSS',
    SENSOR_DROPS:            'SENSOR DROPS',
    MAGNETOMETER_UNAVAILABLE:'MAGNETOMETER UNAVAILABLE',
    LIMITED_IOS_MODE:        'LIMITED IOS MODE',
    PERMISSION_DENIED:       'PERMISSION DENIED',
  },

});
