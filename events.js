/**
 * MoniRail Web Rider — Event Detection Layer  (events.js)
 *
 * Detects and logs seven event classes:
 *   1. Comfort exceedance (CCY / CCZ threshold)
 *   2. PCT > 10 %
 *   3. PDE > 10 %
 *   4. Lateral displacement > 20 mm
 *   5. Vertical displacement > 20 mm
 *   6. Curve transient          (MATLAB_PLACEHOLDER)
 *   7. Discrete / shock event   (MATLAB_PLACEHOLDER)
 *
 * Every event record contains the full set of fields required by the
 * logging specification in the requirements document.
 *
 * All thresholds are read from CONFIG — never hard-coded here.
 *
 * MATLAB migration notes
 * ──────────────────────
 * Curve transient and shock detectors are placeholder objects.
 * When the client supplies MATLAB code for these algorithms, replace
 * the bodies of CurveTransientDetector.push() and ShockDetector.push()
 * only — the event-record format and the emit() call must remain.
 */

const EventModule = (() => {

  // ── State ──────────────────────────────────────────────────────────────────
  let _events    = [];
  let _eventId   = 0;
  let _callbacks = {};
  let _lastTrigger = {}; // event type → last trigger monotonic time

  // ── Helper: build a complete event record ──────────────────────────────────

  function _newEvent({
    type, startMono, endMono = null, peakMono,
    utc, lat, lon, speed_mph,
    severity, source, peakValue, units, confidence,
  }) {
    return {
      event_id:       ++_eventId,
      event_type:     type,
      start_mono_ms:  startMono,
      end_mono_ms:    endMono,
      peak_mono_ms:   peakMono,
      utc_iso:        new Date(utc).toISOString(),
      latitude:       lat  ?? null,
      longitude:      lon  ?? null,
      speed_mph:      speed_mph ?? null,
      severity,                       // 'INFO' | 'WARNING' | 'CRITICAL'
      signal_source:  source,
      peak_value:     peakValue,
      units,
      confidence:     confidence ?? 'HIGH',
      algorithm_version: CONFIG.ALGORITHM_VERSION,
    };
  }

  function _emit(event, data) {
    (_callbacks[event] || []).forEach(fn => fn(data));
  }

  /** Guard against re-triggering within MIN_RETRIGGER_MS for the same type. */
  function _canTrigger(type, mono) {
    const last = _lastTrigger[type] || -Infinity;
    if (mono - last >= CONFIG.events.MIN_RETRIGGER_MS) {
      _lastTrigger[type] = mono;
      return true;
    }
    return false;
  }

  function _log(record) {
    _events.push(record);
    _emit('event', record);
  }

  // ── 1 + 2 + 3: Comfort / PCT / PDE ────────────────────────────────────────

  function checkComfort({ ccy, ccz, pct, pde, mono, utc, lat, lon, speed_mph }) {
    const { AMBER_MIN, RED_MIN } = CONFIG.comfort;
    const { EVENT_THRESHOLD_PERCENT } = CONFIG.pctPde;

    // CCY
    if ((ccy >= AMBER_MIN) && _canTrigger('CCY', mono)) {
      const severity = ccy >= RED_MIN ? 'CRITICAL' : 'WARNING';
      _log(_newEvent({
        type: 'COMFORT_CCY', startMono: mono, peakMono: mono,
        utc, lat, lon, speed_mph, severity,
        source: 'CCY', peakValue: ccy, units: '-',
      }));
    }

    // CCZ
    if ((ccz >= AMBER_MIN) && _canTrigger('CCZ', mono)) {
      const severity = ccz >= RED_MIN ? 'CRITICAL' : 'WARNING';
      _log(_newEvent({
        type: 'COMFORT_CCZ', startMono: mono, peakMono: mono,
        utc, lat, lon, speed_mph, severity,
        source: 'CCZ', peakValue: ccz, units: '-',
      }));
    }

    // PCT
    if ((pct > EVENT_THRESHOLD_PERCENT) && _canTrigger('PCT', mono)) {
      _log(_newEvent({
        type: 'PCT_EXCEEDANCE', startMono: mono, peakMono: mono,
        utc, lat, lon, speed_mph, severity: 'WARNING',
        source: 'PCT', peakValue: pct, units: '%',
      }));
    }

    // PDE
    if ((pde > EVENT_THRESHOLD_PERCENT) && _canTrigger('PDE', mono)) {
      _log(_newEvent({
        type: 'PDE_EXCEEDANCE', startMono: mono, peakMono: mono,
        utc, lat, lon, speed_mph, severity: 'WARNING',
        source: 'PDE', peakValue: pde, units: '%',
      }));
    }
  }

  // ── 4 + 5: Displacement ────────────────────────────────────────────────────

  function checkDisplacement({ lateral_mm, vertical_mm, mono, utc, lat, lon, speed_mph }) {
    const { LATERAL_EVENT_MM, VERTICAL_EVENT_MM } = CONFIG.displacement;

    if (Math.abs(lateral_mm) > LATERAL_EVENT_MM && _canTrigger('DISP_LAT', mono)) {
      _log(_newEvent({
        type: 'LATERAL_DISPLACEMENT', startMono: mono, peakMono: mono,
        utc, lat, lon, speed_mph, severity: 'WARNING',
        source: 'DISPLACEMENT_LAT', peakValue: lateral_mm, units: 'mm',
        confidence: 'LOW',   // Displacement from integration is approximate
      }));
    }

    if (Math.abs(vertical_mm) > VERTICAL_EVENT_MM && _canTrigger('DISP_VERT', mono)) {
      _log(_newEvent({
        type: 'VERTICAL_DISPLACEMENT', startMono: mono, peakMono: mono,
        utc, lat, lon, speed_mph, severity: 'WARNING',
        source: 'DISPLACEMENT_VERT', peakValue: vertical_mm, units: 'mm',
        confidence: 'LOW',
      }));
    }
  }

  // ── 6: Curve transient ─────────────────────────────────────────────────────
  //
  // MATLAB_PLACEHOLDER: Replace the body of push() with the client's
  // curve-transient detection algorithm.
  //
  // Expected inputs:
  //   ay          — train-frame lateral acceleration (m/s²)
  //   jerkY       — lateral jerk (m/s³) — differentiate ay before calling
  //   mono, utc, lat, lon, speed_mph — timing and position context
  //
  // Expected behaviour:
  //   Detect sustained lateral acceleration changes characteristic of entering
  //   or exiting a curve.  Use CURVE_JERK_THRESHOLD_MS3 and
  //   CURVE_MIN_DURATION_MS from CONFIG.events.
  //
  const CurveTransientDetector = (() => {
    let _active    = false;
    let _startMono = null;
    let _peakJerk  = 0;
    let _peakMono  = null;
    let _startCtx  = null;

    return {
      push({ ay, jerkY, mono, utc, lat, lon, speed_mph }) {
        const THRESH   = CONFIG.events.CURVE_JERK_THRESHOLD_MS3;
        const MIN_DUR  = CONFIG.events.CURVE_MIN_DURATION_MS;

        const exceeds = Math.abs(jerkY) > THRESH;

        if (!_active && exceeds) {
          _active    = true;
          _startMono = mono;
          _peakJerk  = jerkY;
          _peakMono  = mono;
          _startCtx  = { utc, lat, lon, speed_mph };
        } else if (_active && exceeds) {
          if (Math.abs(jerkY) > Math.abs(_peakJerk)) {
            _peakJerk = jerkY; _peakMono = mono;
          }
        } else if (_active && !exceeds) {
          const dur = mono - _startMono;
          if (dur >= MIN_DUR && _canTrigger('CURVE', _startMono)) {
            _log(_newEvent({
              type: 'CURVE_TRANSIENT',
              startMono: _startMono, endMono: mono, peakMono: _peakMono,
              utc: _startCtx.utc, lat: _startCtx.lat, lon: _startCtx.lon,
              speed_mph: _startCtx.speed_mph,
              severity: 'INFO',
              source: 'JERK_LAT', peakValue: _peakJerk, units: 'm/s³',
              confidence: 'MEDIUM',
            }));
          }
          _active = false; _peakJerk = 0;
        }
      },
      reset() { _active = false; _startMono = null; _peakJerk = 0; },
    };
  })();

  // ── 7: Discrete / shock event ─────────────────────────────────────────────
  //
  // MATLAB_PLACEHOLDER: Replace the body of push() with the client's
  // shock / discrete-event detection algorithm.
  //
  // Expected inputs:
  //   az          — train-frame vertical acceleration (m/s²) — gravity removed
  //   mono, utc, lat, lon, speed_mph
  //
  // Expected behaviour:
  //   Detect brief high-amplitude acceleration spikes using
  //   SHOCK_PEAK_THRESHOLD_MS2, SHOCK_MIN_DURATION_MS, SHOCK_MAX_DURATION_MS.
  //
  const ShockDetector = (() => {
    let _active    = false;
    let _startMono = null;
    let _peakAcc   = 0;
    let _peakMono  = null;
    let _startCtx  = null;

    return {
      push({ az, mono, utc, lat, lon, speed_mph }) {
        const THRESH   = CONFIG.events.SHOCK_PEAK_THRESHOLD_MS2;
        const MIN_DUR  = CONFIG.events.SHOCK_MIN_DURATION_MS;
        const MAX_DUR  = CONFIG.events.SHOCK_MAX_DURATION_MS;

        const exceeds = Math.abs(az) > THRESH;

        if (!_active && exceeds) {
          _active    = true;
          _startMono = mono;
          _peakAcc   = az;
          _peakMono  = mono;
          _startCtx  = { utc, lat, lon, speed_mph };
        } else if (_active && exceeds) {
          if (Math.abs(az) > Math.abs(_peakAcc)) { _peakAcc = az; _peakMono = mono; }
          // Abandon if event exceeds max duration (not a discrete shock)
          if (mono - _startMono > MAX_DUR) { _active = false; }
        } else if (_active && !exceeds) {
          const dur = mono - _startMono;
          if (dur >= MIN_DUR && _canTrigger('SHOCK', _startMono)) {
            _log(_newEvent({
              type: 'DISCRETE_EVENT',
              startMono: _startMono, endMono: mono, peakMono: _peakMono,
              utc: _startCtx.utc, lat: _startCtx.lat, lon: _startCtx.lon,
              speed_mph: _startCtx.speed_mph,
              severity: Math.abs(_peakAcc) > THRESH * 2 ? 'CRITICAL' : 'WARNING',
              source: 'ACC_VERT', peakValue: _peakAcc, units: 'm/s²',
              confidence: 'HIGH',
            }));
          }
          _active = false; _peakAcc = 0;
        }
      },
      reset() { _active = false; _startMono = null; _peakAcc = 0; },
    };
  })();

  // ── Public API ─────────────────────────────────────────────────────────────

  function on(event, handler) {
    if (!_callbacks[event]) _callbacks[event] = [];
    _callbacks[event].push(handler);
  }

  function reset() {
    _events = []; _eventId = 0; _lastTrigger = {};
    CurveTransientDetector.reset();
    ShockDetector.reset();
  }

  function getAll()   { return _events.slice(); }
  function getCount() { return _events.length; }
  function getCountByType(type) { return _events.filter(e => e.event_type === type).length; }

  return {
    on, reset, getAll, getCount, getCountByType,
    checkComfort, checkDisplacement,
    CurveTransientDetector, ShockDetector,
  };

})();
