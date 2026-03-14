/**
 * MoniRail Web Rider — Sensor Acquisition Layer  (sensors.js)
 *
 * Responsibilities
 * ─────────────────
 * • Request DeviceMotion, DeviceOrientation and Geolocation permissions
 * • Attach event listeners at the highest available rate
 * • Timestamp every sample with both monotonic (performance.now) and UTC clock
 * • Detect and log dropped samples / large timing gaps
 * • Maintain delivered-rate and jitter statistics
 * • Notify the rest of the app via registered callbacks
 *
 * NOTE: Browser APIs do NOT guarantee a fixed rate.  Every consumer of this
 * module must handle variable-interval data.  See CONFIG.sampling notes.
 *
 * iPhone / iOS limitations
 * ─────────────────────────
 * iOS 13+ requires a user-gesture call to DeviceMotionEvent.requestPermission().
 * The START button in app.js triggers this.  If permission is denied the module
 * enters LIMITED_IOS_MODE and marks all motion samples as unavailable.
 * A Capacitor plugin can replace the Web API calls without touching the rest of
 * the module — replace the _startMotion() body and emit via the same callbacks.
 */

const SensorModule = (() => {

  // ── Internal state ─────────────────────────────────────────────────────────
  let _running       = false;
  let _callbacks     = {};          // event name → array of handler functions

  // Timing statistics (reset on each recording start)
  let _stats = {};

  // Geolocation watchId
  let _geoWatchId = null;

  // Feature availability flags (set during _probe())
  let _available = {
    motion:      false,
    orientation: false,
    gyroscope:   false,  // DeviceMotion includes gyro via rotationRate
    magnetometer:false,
    gps:         false,
  };

  // iOS permission flag
  let _iosMotionPermission = false;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function _resetStats() {
    _stats = {
      sampleCount:      0,
      droppedGaps:      0,
      lastMonotonic:    null,
      intervalSumMs:    0,
      intervalMin:      Infinity,
      intervalMax:      -Infinity,
      intervalSqSum:    0,
      deliveredHz:      0,
      startTime:        performance.now(),
    };
  }

  /** Update timing stats and detect drops.  Returns the interval in ms. */
  function _recordTiming(mono) {
    let interval = null;
    if (_stats.lastMonotonic !== null) {
      interval = mono - _stats.lastMonotonic;
      _stats.intervalSumMs  += interval;
      _stats.intervalSqSum  += interval * interval;
      if (interval < _stats.intervalMin) _stats.intervalMin = interval;
      if (interval > _stats.intervalMax) _stats.intervalMax = interval;
      if (interval > CONFIG.sampling.MAX_INTERVAL_MS) {
        _stats.droppedGaps++;
        _emit('gap', { mono, interval });
      }
    }
    _stats.lastMonotonic = mono;
    _stats.sampleCount++;
    const elapsed = (mono - _stats.startTime) / 1000;
    if (elapsed > 0) _stats.deliveredHz = _stats.sampleCount / elapsed;
    return interval;
  }

  function _emit(event, data) {
    (_callbacks[event] || []).forEach(fn => fn(data));
  }

  // ── Permission probe ───────────────────────────────────────────────────────

  /**
   * Probe which sensors are available without starting them.
   * Must be called before start().
   */
  async function probe() {
    _available.gps = ('geolocation' in navigator);

    // Magnetometer via Generic Sensor API (Chromium-based) or fallback flag
    if (typeof Magnetometer !== 'undefined') {
      try {
        const sensor = new Magnetometer({ frequency: 10 });
        await sensor.start(); sensor.stop();
        _available.magnetometer = true;
      } catch (_) { _available.magnetometer = false; }
    } else {
      _available.magnetometer = false;
    }

    // DeviceMotion check (always available on Android; needs permission on iOS)
    if (typeof DeviceMotionEvent !== 'undefined') {
      _available.motion = true;
      _available.gyroscope = true;  // rotationRate is part of DeviceMotion
    }

    if (typeof DeviceOrientationEvent !== 'undefined') {
      _available.orientation = true;
    }

    _emit('availability', { ..._available });
    return { ..._available };
  }

  // ── iOS permission request ─────────────────────────────────────────────────

  /**
   * Call this from a user-gesture handler (button click).
   * Returns true if motion permission is granted.
   */
  async function requestMotionPermission() {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const result = await DeviceMotionEvent.requestPermission();
        _iosMotionPermission = (result === 'granted');
        if (!_iosMotionPermission) {
          _emit('permissionDenied', { sensor: 'motion' });
        }
        return _iosMotionPermission;
      } catch (err) {
        _emit('permissionDenied', { sensor: 'motion', error: err.message });
        return false;
      }
    }
    // Android / non-iOS: no explicit permission needed
    return true;
  }

  // ── Sensor start / stop ────────────────────────────────────────────────────

  function _startMotion() {
    if (!_available.motion) return;

    window.addEventListener('devicemotion', _onMotion, { passive: true });
    _emit('status', { sensor: 'motion', state: 'started' });
  }

  function _stopMotion() {
    window.removeEventListener('devicemotion', _onMotion);
  }

  function _startOrientation() {
    if (!_available.orientation) return;
    window.addEventListener('deviceorientationabsolute', _onOrientation, { passive: true });
    window.addEventListener('deviceorientation',         _onOrientation, { passive: true });
  }

  function _stopOrientation() {
    window.removeEventListener('deviceorientationabsolute', _onOrientation);
    window.removeEventListener('deviceorientation',         _onOrientation);
  }

  function _startGPS() {
    if (!_available.gps) return;
    _geoWatchId = navigator.geolocation.watchPosition(
      _onPosition,
      _onPositionError,
      {
        enableHighAccuracy: true,
        maximumAge:         0,
        timeout:            10000,
      }
    );
  }

  function _stopGPS() {
    if (_geoWatchId !== null) {
      navigator.geolocation.clearWatch(_geoWatchId);
      _geoWatchId = null;
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  function _onMotion(evt) {
    if (!_running) return;

    const mono = performance.now();
    const utc  = Date.now();
    const interval = _recordTiming(mono);

    const acc = evt.accelerationIncludingGravity || {};
    const accLG = evt.acceleration || {};   // linear (gravity removed by OS)
    const rot = evt.rotationRate || {};

    /** @type {RawMotionSample} */
    const sample = {
      type:              'motion',
      monotonic_ms:      mono,
      utc_ms:            utc,
      interval_ms:       interval,
      // Accelerometer including gravity (phone frame, m/s²)
      acc_x:             acc.x  ?? null,
      acc_y:             acc.y  ?? null,
      acc_z:             acc.z  ?? null,
      // Linear acceleration (gravity removed by OS — may be inaccurate)
      accLin_x:          accLG.x ?? null,
      accLin_y:          accLG.y ?? null,
      accLin_z:          accLG.z ?? null,
      // Gyroscope — deg/s
      gyro_x:            rot.beta  ?? null,   // rotation around X (front–back tilt rate)
      gyro_y:            rot.gamma ?? null,   // rotation around Y (left–right tilt rate)
      gyro_z:            rot.alpha ?? null,   // rotation around Z (yaw rate)
      interval_requested_hz: evt.interval ? (1000 / evt.interval) : null,
    };

    _emit('motion', sample);
  }

  function _onOrientation(evt) {
    if (!_running) return;
    _emit('orientation', {
      type:         'orientation',
      monotonic_ms: performance.now(),
      utc_ms:       Date.now(),
      alpha:        evt.alpha,  // compass bearing (deg)
      beta:         evt.beta,   // front–back tilt (deg)
      gamma:        evt.gamma,  // left–right tilt (deg)
      absolute:     evt.absolute || false,
    });
  }

  function _onPosition(pos) {
    if (!_running) return;
    const c = pos.coords;
    _emit('gps', {
      type:             'gps',
      monotonic_ms:     performance.now(),
      utc_ms:           pos.timestamp,
      latitude:         c.latitude,
      longitude:        c.longitude,
      altitude:         c.altitude   ?? null,
      speed_mps:        c.speed      ?? null,
      speed_mph:        c.speed != null ? c.speed * 2.23694 : null,
      heading_deg:      c.heading    ?? null,
      accuracy_m:       c.accuracy,
      altitude_accuracy_m: c.altitudeAccuracy ?? null,
      // satellite_count is not available via W3C Geolocation API
      // A Capacitor plugin can fill this field
      satellite_count:  null,
    });
  }

  function _onPositionError(err) {
    _emit('gpsError', { code: err.code, message: err.message });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  function on(event, handler) {
    if (!_callbacks[event]) _callbacks[event] = [];
    _callbacks[event].push(handler);
  }

  function off(event, handler) {
    if (!_callbacks[event]) return;
    _callbacks[event] = _callbacks[event].filter(fn => fn !== handler);
  }

  async function start() {
    if (_running) return;
    _resetStats();
    _running = true;

    const granted = await requestMotionPermission();
    if (!granted) {
      _emit('qualityFlag', { flag: CONFIG.quality.LIMITED_IOS_MODE });
    }

    _startMotion();
    _startOrientation();
    _startGPS();

    // Check magnetometer availability and warn
    if (!_available.magnetometer) {
      _emit('qualityFlag', { flag: CONFIG.quality.MAGNETOMETER_UNAVAILABLE });
    }

    _emit('started', { timestamp: Date.now() });
  }

  function stop() {
    if (!_running) return;
    _running = false;
    _stopMotion();
    _stopOrientation();
    _stopGPS();
    _emit('stopped', { stats: getStats(), timestamp: Date.now() });
  }

  /**
   * Returns a snapshot of the current timing statistics.
   * @returns {SamplingStats}
   */
  function getStats() {
    const n = _stats.sampleCount;
    const mean = n > 1 ? _stats.intervalSumMs / (n - 1) : 0;
    const variance = n > 2
      ? (_stats.intervalSqSum / (n - 1)) - mean * mean
      : 0;
    return {
      sampleCount:    n,
      deliveredHz:    _stats.deliveredHz,
      requestedHz:    CONFIG.sampling.TARGET_HZ,
      meanIntervalMs: mean,
      minIntervalMs:  _stats.intervalMin === Infinity ? 0 : _stats.intervalMin,
      maxIntervalMs:  _stats.intervalMax === -Infinity ? 0 : _stats.intervalMax,
      jitterMs:       Math.sqrt(Math.max(0, variance)),
      droppedGaps:    _stats.droppedGaps,
      healthOk:       _stats.deliveredHz >= CONFIG.sampling.MIN_ACCEPTABLE_HZ,
    };
  }

  function getAvailability() { return { ..._available }; }
  function isRunning()       { return _running; }

  return { probe, start, stop, on, off, getStats, getAvailability, isRunning, requestMotionPermission };

})();
