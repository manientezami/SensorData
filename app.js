/**
 * MoniRail Web Rider — Application Controller  (app.js)
 *
 * Wires together all modules:
 *   SensorModule → CalibrationModule → ComfortProcessor → EventModule
 *   → MapModule / ExportModule / UI
 *
 * UI refresh is decoupled from sensor acquisition via requestAnimationFrame
 * and per-category timers to avoid overloading the main thread.
 */

const App = (() => {

  // ── State ──────────────────────────────────────────────────────────────────
  let _recording    = false;
  let _startTime    = null;
  let _lastGPS      = null;
  let _lastProcessed = null;
  let _prevJerkY    = 0;
  let _totalDistM   = 0;
  let _peakSpeedMph = 0;
  let _maxCcy = 0, _maxCcz = 0, _maxPct = 0, _maxPde = 0;
  let _qualityFlag  = CONFIG.quality.GOOD;

  // Chart rolling data
  let _chartLat  = [];   // { t, v }
  let _chartVert = [];

  // UI throttle timestamps
  let _lastUiRefresh  = 0;
  let _lastMapRefresh = 0;
  let _uiRafId        = null;
  let _estimatedFs    = CONFIG.sampling.TARGET_HZ;

  // Jerk estimation (finite difference on lateral acc)
  let _prevAy  = 0;
  let _prevMono = null;

  // ── Module references ──────────────────────────────────────────────────────
  let _chart = null;   // Chart.js instance (initialised in initChart())

  // ── Init ───────────────────────────────────────────────────────────────────

  async function init() {
    _bindUI();
    MapModule.init('map');

    const avail = await SensorModule.probe();
    _updateAvailabilityBadge(avail);

    // Sensor event → processing pipeline
    SensorModule.on('motion',      _onMotion);
    SensorModule.on('gps',         _onGPS);
    SensorModule.on('gap',         _onGap);
    SensorModule.on('qualityFlag', d => _setQuality(d.flag));
    SensorModule.on('gpsError',    d => _setQuality(CONFIG.quality.LOW_GNSS));
    SensorModule.on('stopped',     _onSensorsStop);

    // Event module → map + table
    EventModule.on('event', _onEventDetected);

    // Start validation display loop
    _uiRafId = requestAnimationFrame(_uiLoop);

    _initChart();
  }

  // ── Sensor pipeline ────────────────────────────────────────────────────────

  function _onMotion(sample) {
    if (!_recording) {
      // Feed calibration capture
      if (CalibrationModule.isCapturing()) {
        const done = CalibrationModule.feedCaptureSample(sample);
        if (done) _onCalibrationComplete();
      }
      return;
    }

    const { acc_x, acc_y, acc_z, monotonic_ms, utc_ms, interval_ms } = sample;
    if (acc_x == null) return;

    // Update estimated sample rate
    if (interval_ms != null && interval_ms > 0) {
      _estimatedFs = 0.95 * _estimatedFs + 0.05 * (1000 / interval_ms);
      // Re-init processor if rate has drifted significantly
      if (Math.abs(_estimatedFs - ComfortProcessor._lastFs || 0) > 5) {
        ComfortProcessor.init(_estimatedFs);
        ComfortProcessor._lastFs = _estimatedFs;
      }
    }

    const dt_s = interval_ms != null ? interval_ms / 1000 : 1 / _estimatedFs;

    // Coordinate transform (phone → train frame)
    const tf = CalibrationModule.toTrainFrame(acc_x, acc_y, acc_z);

    // Jerk estimation for curve transient detection
    let jerkY = 0;
    if (_prevMono != null && dt_s > 0) {
      jerkY = (tf.lat - _prevAy) / dt_s;
    }
    _prevAy   = tf.lat;
    _prevMono = monotonic_ms;

    // Comfort processing
    const result = ComfortProcessor.push(tf.lon, tf.lat, tf.vert, dt_s, monotonic_ms);

    // Track maxima
    if (result.ccy > _maxCcy) _maxCcy = result.ccy;
    if (result.ccz > _maxCcz) _maxCcz = result.ccz;
    if (result.pct > _maxPct) _maxPct = result.pct;
    if (result.pde > _maxPde) _maxPde = result.pde;

    // Event detection
    const ctx = {
      mono:      monotonic_ms,
      utc:       utc_ms,
      lat:       _lastGPS?.latitude  ?? null,
      lon:       _lastGPS?.longitude ?? null,
      speed_mph: _lastGPS?.speed_mph ?? null,
    };
    EventModule.checkComfort({ ...result, ...ctx });
    EventModule.checkDisplacement({ ...result, ...ctx });
    EventModule.CurveTransientDetector.push({ ay: tf.lat, jerkY, ...ctx });
    EventModule.ShockDetector.push({ az: tf.vert, ...ctx });

    // Chart buffer
    const t = (monotonic_ms - (_startTime || monotonic_ms)) / 1000;
    const MAX = CONFIG.chart.MAX_POINTS;
    _chartLat.push({ t, v: tf.lat });
    _chartVert.push({ t, v: tf.vert });
    if (_chartLat.length > MAX)  { _chartLat.shift(); _chartVert.shift(); }

    // Raw log row
    const gps = _lastGPS || {};
    ExportModule.appendRaw({
      monotonic_timestamp_ms: monotonic_ms,
      utc_timestamp_iso:      new Date(utc_ms).toISOString(),
      sample_interval_ms:     interval_ms ?? '',
      latitude:               gps.latitude  ?? '',
      longitude:              gps.longitude ?? '',
      altitude_m:             gps.altitude  ?? '',
      gps_speed_mps:          gps.speed_mps ?? '',
      gps_speed_mph:          gps.speed_mph ?? '',
      gps_heading_deg:        gps.heading_deg ?? '',
      gps_accuracy_m:         gps.accuracy_m  ?? '',
      satellite_count:        gps.satellite_count ?? '',
      acc_x, acc_y, acc_z,
      gyro_x: sample.gyro_x ?? '',
      gyro_y: sample.gyro_y ?? '',
      gyro_z: sample.gyro_z ?? '',
      mag_x: '', mag_y: '', mag_z: '',   // Filled if magnetometer available
      roll_deg:  '', pitch_deg: '', yaw_deg: '',
      lateral_acc_mss:   tf.lat,
      vertical_acc_mss:  tf.vert,
      lateral_disp_mm:   result.lateral_mm,
      vertical_disp_mm:  result.vertical_mm,
      ccy:                result.ccy,
      ccz:                result.ccz,
      pct:                result.pct,
      pde:                result.pde,
      comfort_status:     result.comfort_status,
      quality_flag:       _qualityFlag,
    });

    _lastProcessed = result;
  }

  function _onGPS(gpsData) {
    _lastGPS = gpsData;
    if (gpsData.speed_mph != null && gpsData.speed_mph > _peakSpeedMph) {
      _peakSpeedMph = gpsData.speed_mph;
    }
    // Accumulate distance
    // (simple: GPS speed × interval — replace with haversine for accuracy)
    if (gpsData.speed_mps != null) {
      _totalDistM += gpsData.speed_mps * (CONFIG.gnss.UPDATE_INTERVAL_MS / 1000);
    }

    // GNSS quality flag
    if (gpsData.accuracy_m > CONFIG.gnss.ACCURACY_POOR_M) {
      _setQuality(CONFIG.quality.LOW_GNSS);
    }
  }

  function _onGap(data) {
    _setQuality(CONFIG.quality.SENSOR_DROPS);
  }

  function _onEventDetected(evt) {
    MapModule.addEvent(evt);
    _appendEventRow(evt);
  }

  function _onSensorsStop(data) {
    _buildSummaryScreen(data.stats);
  }

  // ── Start / Stop recording ─────────────────────────────────────────────────

  async function startRecording() {
    if (_recording) return;
    _resetState();

    // Init comfort processor at target rate (will adjust once measured)
    ComfortProcessor.init(_estimatedFs);
    ComfortProcessor._lastFs = _estimatedFs;

    await SensorModule.start();
    _recording  = true;
    _startTime  = performance.now();

    _setButtonState('recording');
    _clearEventTable();
    MapModule.reset();
    ExportModule.reset();
  }

  function stopRecording() {
    if (!_recording) return;
    _recording = false;
    SensorModule.stop();
    _setButtonState('idle');
  }

  function exportCsv() {
    const summary = _buildSummaryObject();
    const { rawFile, eventFile, summaryFile } = ExportModule.exportAll(summary, EventModule.getAll());
    _showToast(`Exported: ${rawFile}`);
    return { rawFile, eventFile, summaryFile };
  }

  // ── Calibration ────────────────────────────────────────────────────────────

  function startCalibration() {
    const mode = document.getElementById('mountingSelect')?.value || 'PORTRAIT_FACE_FORWARD';
    if (mode === 'CUSTOM') {
      CalibrationModule.startCapture('CUSTOM');
      _showToast('Calibrating — keep phone still…');
      // Progress bar shown via _uiLoop
    } else {
      CalibrationModule.applyPresetMounting(mode);
      _showToast('Calibration applied: ' + mode.replace(/_/g, ' '));
      _updateCalibrationStatus();
    }
  }

  function _onCalibrationComplete() {
    _showToast('Calibration complete ✓');
    _updateCalibrationStatus();
  }

  // ── UI Loop (requestAnimationFrame) ───────────────────────────────────────

  function _uiLoop(now) {
    _uiRafId = requestAnimationFrame(_uiLoop);

    const uiInterval  = 1000 / CONFIG.sampling.UI_REFRESH_HZ;
    const mapInterval = 1000 / CONFIG.sampling.MAP_REFRESH_HZ;

    // Main UI refresh
    if (now - _lastUiRefresh >= uiInterval) {
      _lastUiRefresh = now;
      _refreshStatusPanel();
      _refreshValidationPanel();
      if (_chart && _chartLat.length > 0) _refreshChart();
    }

    // Map position refresh
    if (now - _lastMapRefresh >= mapInterval && _lastGPS) {
      _lastMapRefresh = now;
      if (_recording) {
        MapModule.updatePosition(_lastGPS.latitude, _lastGPS.longitude);
      }
    }

    // Calibration progress
    if (CalibrationModule.isCapturing()) {
      const pct = Math.round(CalibrationModule.captureProgress() * 100);
      const el = document.getElementById('calProgress');
      if (el) el.textContent = `Calibrating… ${pct}%`;
    }
  }

  // ── Status panel ──────────────────────────────────────────────────────────

  function _refreshStatusPanel() {
    const gps = _lastGPS || {};
    const r   = _lastProcessed || {};

    // Speed
    _setText('speedVal', gps.speed_mph != null ? gps.speed_mph.toFixed(1) : '--');

    // GNSS
    const gnssOk = gps.accuracy_m != null && gps.accuracy_m < CONFIG.gnss.ACCURACY_GOOD_M;
    _setText('gnssStatus', gps.accuracy_m != null
      ? `±${gps.accuracy_m.toFixed(0)}m  Acc: ${gnssOk ? 'GOOD' : 'POOR'}`
      : 'No GNSS');
    _setText('satCount', gps.satellite_count ?? '—');

    // Comfort traffic light
    const status = r.comfort_status || 'GREEN';
    const tlEl   = document.getElementById('trafficLight');
    if (tlEl) {
      tlEl.className = 'traffic-light tl-' + status.toLowerCase();
      tlEl.textContent = status;
    }

    // Comfort values
    _setText('valCcy', r.ccy != null ? r.ccy.toFixed(3) : '--');
    _setText('valCcz', r.ccz != null ? r.ccz.toFixed(3) : '--');
    _setText('valPct', r.pct != null ? r.pct.toFixed(1) + '%' : '--');
    _setText('valPde', r.pde != null ? r.pde.toFixed(1) + '%' : '--');
    _setText('valLatDisp', r.lateral_mm != null ? r.lateral_mm.toFixed(1) + ' mm' : '--');
    _setText('valVertDisp', r.vertical_mm != null ? r.vertical_mm.toFixed(1) + ' mm' : '--');

    // Quality badge
    _setText('qualityBadge', _qualityFlag);
    const qEl = document.getElementById('qualityBadge');
    if (qEl) qEl.className = 'quality-badge q-' + (_qualityFlag === 'GOOD' ? 'good' : 'warn');

    // Recording elapsed time
    if (_recording && _startTime) {
      const elapsed = Math.floor((performance.now() - _startTime) / 1000);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const ss = String(elapsed % 60).padStart(2, '0');
      _setText('elapsedTime', `${mm}:${ss}`);
    }

    // Raw sample count
    _setText('sampleCount', ExportModule.getRawCount().toLocaleString());
  }

  // ── Validation panel ───────────────────────────────────────────────────────

  function _refreshValidationPanel() {
    const s = SensorModule.getStats();
    _setText('delivHz',   s.deliveredHz.toFixed(1));
    _setText('reqHz',     s.requestedHz);
    _setText('minInt',    s.minIntervalMs === Infinity ? '--' : s.minIntervalMs.toFixed(1));
    _setText('maxInt',    s.maxIntervalMs === -Infinity ? '--' : s.maxIntervalMs.toFixed(1));
    _setText('jitter',    s.jitterMs.toFixed(2));
    _setText('drops',     s.droppedGaps);
    const hlEl = document.getElementById('sampHealthFlag');
    if (hlEl) {
      hlEl.textContent  = s.healthOk ? 'OK' : 'LOW RATE';
      hlEl.className    = 'health-flag ' + (s.healthOk ? 'hf-ok' : 'hf-warn');
    }
  }

  // ── Live Chart ─────────────────────────────────────────────────────────────

  function _initChart() {
    const ctx = document.getElementById('motionChart');
    if (!ctx || typeof Chart === 'undefined') return;

    _chart = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Lateral (m/s²)',
            data:  [],
            borderColor: '#00bcd4',
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0,
          },
          {
            label: 'Vertical (m/s²)',
            data:  [],
            borderColor: '#ff9800',
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0,
          },
        ],
      },
      options: {
        animation:  false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#cfd8dc', font: { size: 11 } } } },
        scales: {
          x: {
            type:  'linear',
            title: { display: true, text: 'Time (s)', color: '#78909c' },
            ticks: { color: '#78909c', maxTicksLimit: 6 },
            grid:  { color: '#1e2a30' },
          },
          y: {
            title: { display: true, text: 'm/s²', color: '#78909c' },
            ticks: { color: '#78909c' },
            grid:  { color: '#1e2a30' },
          },
        },
      },
    });
  }

  function _refreshChart() {
    if (!_chart) return;
    const WIN = CONFIG.chart.WINDOW_SEC;
    const now = _chartLat.length ? _chartLat[_chartLat.length - 1].t : 0;
    const cutoff = now - WIN;
    const lat  = _chartLat.filter(p => p.t >= cutoff).map(p => ({ x: p.t, y: p.v }));
    const vert = _chartVert.filter(p => p.t >= cutoff).map(p => ({ x: p.t, y: p.v }));
    _chart.data.datasets[0].data = lat;
    _chart.data.datasets[1].data = vert;
    _chart.update('none');
  }

  // ── Event table ────────────────────────────────────────────────────────────

  function _appendEventRow(evt) {
    const tbody = document.getElementById('eventTableBody');
    if (!tbody) return;
    const tr = document.createElement('tr');
    const sev = (evt.severity || 'INFO').toLowerCase();
    tr.className = 'evt-' + sev;
    const loc = (evt.latitude != null && evt.longitude != null)
      ? `${evt.latitude.toFixed(4)},${evt.longitude.toFixed(4)}`
      : '—';
    const utcStr = evt.utc_iso ? evt.utc_iso.replace('T',' ').slice(0,19) : '—';
    const val = evt.peak_value != null
      ? `${evt.peak_value.toFixed(3)} ${evt.units}` : '—';
    tr.innerHTML = `
      <td>${loc}</td>
      <td>${utcStr}</td>
      <td>${evt.event_type.replace(/_/g,' ')}</td>
      <td><span class="sev-badge sev-${sev}">${val}</span></td>`;
    tr.addEventListener('click', () => MapModule.focusEvent(evt.event_id));
    tbody.prepend(tr);   // newest at top
  }

  function _clearEventTable() {
    const tb = document.getElementById('eventTableBody');
    if (tb) tb.innerHTML = '';
  }

  // ── Journey summary ────────────────────────────────────────────────────────

  function _buildSummaryObject() {
    const stats   = SensorModule.getStats();
    const events  = EventModule.getAll();
    const endTime = Date.now();
    const elapsed = _startTime ? (performance.now() - _startTime) / 1000 : 0;

    return {
      start_utc:            _startTime ? new Date(Date.now() - elapsed * 1000).toISOString() : '',
      end_utc:              new Date(endTime).toISOString(),
      duration_sec:         elapsed.toFixed(1),
      total_distance_m:     _totalDistM.toFixed(0),
      avg_speed_mph:        elapsed > 0
        ? ((_totalDistM / elapsed) * 2.23694).toFixed(1) : '0',
      peak_speed_mph:       _peakSpeedMph.toFixed(1),
      gnss_status:          _qualityFlag,
      mean_sample_rate_hz:  stats.deliveredHz.toFixed(1),
      dropped_gaps:         stats.droppedGaps,
      max_ccy:              _maxCcy.toFixed(3),
      max_ccz:              _maxCcz.toFixed(3),
      max_pct:              _maxPct.toFixed(1),
      max_pde:              _maxPde.toFixed(1),
      comfort_events:       EventModule.getCountByType('COMFORT_CCY') + EventModule.getCountByType('COMFORT_CCZ'),
      displacement_events:  EventModule.getCountByType('LATERAL_DISPLACEMENT') + EventModule.getCountByType('VERTICAL_DISPLACEMENT'),
      curve_transient_events: EventModule.getCountByType('CURVE_TRANSIENT'),
      discrete_events:      EventModule.getCountByType('DISCRETE_EVENT'),
    };
  }

  function _buildSummaryScreen(sensorStats) {
    const s   = _buildSummaryObject();
    const dur = parseFloat(s.duration_sec);
    const mm  = String(Math.floor(dur / 60)).padStart(2,'0');
    const ss  = String(Math.floor(dur % 60)).padStart(2,'0');

    const mean = ComfortProcessor.computeMeanComfort();

    const el = document.getElementById('summaryOverlay');
    if (!el) return;
    el.innerHTML = `
      <div class="summary-card">
        <h2>Journey Summary</h2>
        <div class="sum-grid">
          <span>Duration</span>        <strong>${mm}:${ss}</strong>
          <span>Distance</span>        <strong>${(parseFloat(s.total_distance_m)/1000).toFixed(2)} km</strong>
          <span>Avg Speed</span>       <strong>${s.avg_speed_mph} mph</strong>
          <span>Peak Speed</span>      <strong>${s.peak_speed_mph} mph</strong>
          <span>GNSS Status</span>     <strong>${s.gnss_status}</strong>
          <span>Sample Rate</span>     <strong>${s.mean_sample_rate_hz} Hz</strong>
          <span>Dropped Gaps</span>    <strong>${s.dropped_gaps}</strong>
          <span>Max Ccy</span>         <strong>${s.max_ccy}</strong>
          <span>Max Ccz</span>         <strong>${s.max_ccz}</strong>
          <span>Max PCT</span>         <strong>${s.max_pct}%</strong>
          <span>Max PDE</span>         <strong>${s.max_pde}%</strong>
          <span>Nmv</span>             <strong>${mean.nmv ?? '—'}</strong>
          <span>Nvd</span>             <strong>${mean.nvd ?? '—'}</strong>
          <span>Comfort Events</span>  <strong>${s.comfort_events}</strong>
          <span>Disp. Events</span>    <strong>${s.displacement_events}</strong>
          <span>Curve Events</span>    <strong>${s.curve_transient_events}</strong>
          <span>Shock Events</span>    <strong>${s.discrete_events}</strong>
        </div>
        <button class="btn-export btn-primary" id="sumExportBtn">Export CSV</button>
        <button class="btn-export" id="sumCloseBtn">Close</button>
      </div>`;
    el.style.display = 'flex';
    document.getElementById('sumExportBtn')?.addEventListener('click', exportCsv);
    document.getElementById('sumCloseBtn')?.addEventListener('click', () => {
      el.style.display = 'none';
    });
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  function _setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function _showToast(msg, duration = 3000) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast show';
    setTimeout(() => { el.className = 'toast'; }, duration);
  }

  function _setButtonState(state) {
    const startBtn = document.getElementById('startBtn');
    const stopBtn  = document.getElementById('stopBtn');
    if (!startBtn || !stopBtn) return;
    startBtn.disabled = state === 'recording';
    stopBtn.disabled  = state !== 'recording';
    startBtn.classList.toggle('active', state === 'recording');
  }

  function _setQuality(flag) {
    _qualityFlag = flag;
  }

  function _updateAvailabilityBadge(avail) {
    const el = document.getElementById('sensorAvailBadge');
    if (!el) return;
    const items = [
      avail.motion     ? '✓ Motion'       : '✗ Motion',
      avail.gyroscope  ? '✓ Gyro'         : '✗ Gyro',
      avail.magnetometer ? '✓ Mag'        : '✗ Mag',
      avail.gps        ? '✓ GPS'          : '✗ GPS',
    ];
    el.textContent = items.join('  ');
    if (!avail.magnetometer) _setQuality(CONFIG.quality.MAGNETOMETER_UNAVAILABLE);
  }

  function _updateCalibrationStatus() {
    const el = document.getElementById('calStatus');
    if (el) {
      el.textContent = CalibrationModule.isCalibrated()
        ? `Calibrated: ${CalibrationModule.getMounting().replace(/_/g,' ')}`
        : 'Not calibrated';
      el.className = CalibrationModule.isCalibrated() ? 'cal-ok' : 'cal-warn';
    }
  }

  function _resetState() {
    _lastGPS = null; _lastProcessed = null;
    _totalDistM = 0; _peakSpeedMph = 0;
    _maxCcy = 0; _maxCcz = 0; _maxPct = 0; _maxPde = 0;
    _prevAy = 0; _prevMono = null; _prevJerkY = 0;
    _chartLat = []; _chartVert = [];
    _qualityFlag = CONFIG.quality.GOOD;
    _startTime = null;
    EventModule.reset();
    ComfortProcessor.reset();
    ExportModule.reset();
  }

  // ── UI binding ─────────────────────────────────────────────────────────────

  function _bindUI() {
    document.getElementById('startBtn')?.addEventListener('click', startRecording);
    document.getElementById('stopBtn')?.addEventListener('click',  stopRecording);
    document.getElementById('exportBtn')?.addEventListener('click', exportCsv);
    document.getElementById('calBtn')?.addEventListener('click',   startCalibration);
    window.addEventListener('resize', () => MapModule.invalidateSize());
  }

  return { init, startRecording, stopRecording, exportCsv };

})();

// ── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());
