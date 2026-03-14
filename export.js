/**
 * MoniRail Web Rider — Export Layer  (export.js)
 *
 * Generates three CSV files at end of recording:
 *   1. raw_sensor_data_<TIMESTAMP>.csv    — one row per sensor sample
 *   2. event_log_<TIMESTAMP>.csv          — one row per detected event
 *   3. journey_summary_<TIMESTAMP>.csv    — single-row journey statistics
 *
 * In browser mode, files are downloaded using a temporary <a> element.
 * In Capacitor mode, replace _downloadBlob() with a call to the
 * Filesystem plugin:
 *   Filesystem.writeFile({ path, data, directory: Directory.Documents })
 *
 * All column names match the field names in the requirements document
 * exactly so that downstream scripts can parse without aliasing.
 */

const ExportModule = (() => {

  // ── Raw sample ring buffer ─────────────────────────────────────────────────
  // Kept in memory during recording.  Very long trips may accumulate >100 MB.
  // TODO: For Capacitor builds, stream to disk incrementally.

  let _rawRows = [];   // Array<object>  — one entry per processed sample

  // ── Public write methods (called from app.js on each processed sample) ─────

  /**
   * Append one complete processed sample to the raw log.
   * The object shape matches the requirements spec field list exactly.
   */
  function appendRaw(row) {
    _rawRows.push(row);
  }

  // ── CSV generation ─────────────────────────────────────────────────────────

  function _esc(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    // Quote if contains comma, newline or quote
    if (s.includes(',') || s.includes('\n') || s.includes('"')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function _toCsv(headers, rows) {
    const lines = [headers.join(',')];
    for (const row of rows) {
      lines.push(headers.map(h => _esc(row[h])).join(','));
    }
    return lines.join('\r\n');
  }

  // ── File 1: raw_sensor_data ────────────────────────────────────────────────

  const RAW_HEADERS = [
    'monotonic_timestamp_ms',
    'utc_timestamp_iso',
    'sample_interval_ms',
    'latitude',
    'longitude',
    'altitude_m',
    'gps_speed_mps',
    'gps_speed_mph',
    'gps_heading_deg',
    'gps_accuracy_m',
    'satellite_count',
    'acc_x',
    'acc_y',
    'acc_z',
    'gyro_x',
    'gyro_y',
    'gyro_z',
    'mag_x',
    'mag_y',
    'mag_z',
    'roll_deg',
    'pitch_deg',
    'yaw_deg',
    'lateral_acc_mss',
    'vertical_acc_mss',
    'lateral_disp_mm',
    'vertical_disp_mm',
    'ccy',
    'ccz',
    'pct',
    'pde',
    'comfort_status',
    'quality_flag',
  ];

  function buildRawCsv() {
    return _toCsv(RAW_HEADERS, _rawRows);
  }

  // ── File 2: event_log ──────────────────────────────────────────────────────

  const EVENT_HEADERS = [
    'event_id',
    'event_type',
    'start_mono_ms',
    'end_mono_ms',
    'peak_mono_ms',
    'utc_iso',
    'latitude',
    'longitude',
    'speed_mph',
    'severity',
    'signal_source',
    'peak_value',
    'units',
    'confidence',
    'algorithm_version',
  ];

  function buildEventCsv(events) {
    return _toCsv(EVENT_HEADERS, events);
  }

  // ── File 3: journey_summary ────────────────────────────────────────────────

  const SUMMARY_HEADERS = [
    'start_utc',
    'end_utc',
    'duration_sec',
    'total_distance_m',
    'avg_speed_mph',
    'peak_speed_mph',
    'gnss_status',
    'mean_sample_rate_hz',
    'dropped_gaps',
    'max_ccy',
    'max_ccz',
    'max_pct',
    'max_pde',
    'comfort_events',
    'displacement_events',
    'curve_transient_events',
    'discrete_events',
    'raw_file',
    'event_file',
    'algorithm_version',
  ];

  function buildSummaryCsv(summary) {
    return _toCsv(SUMMARY_HEADERS, [summary]);
  }

  // ── Download helpers ───────────────────────────────────────────────────────

  function _downloadBlob(csvString, filename) {
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /**
   * Export all three CSV files.
   *
   * @param {object} summary  — journey summary object matching SUMMARY_HEADERS
   * @param {Array}  events   — array of event records from EventModule
   * @returns {{ rawFile, eventFile, summaryFile }}  — the three filenames
   */
  function exportAll(summary, events) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const rawFile     = `raw_sensor_data_${ts}.csv`;
    const eventFile   = `event_log_${ts}.csv`;
    const summaryFile = `journey_summary_${ts}.csv`;

    try {
      _downloadBlob(buildRawCsv(), rawFile);
    } catch (e) {
      console.error('Export: raw CSV failed', e);
    }

    try {
      _downloadBlob(buildEventCsv(events), eventFile);
    } catch (e) {
      console.error('Export: event CSV failed', e);
    }

    const fullSummary = {
      ...summary,
      raw_file:          rawFile,
      event_file:        eventFile,
      algorithm_version: CONFIG.ALGORITHM_VERSION,
    };
    try {
      _downloadBlob(buildSummaryCsv(fullSummary), summaryFile);
    } catch (e) {
      console.error('Export: summary CSV failed', e);
    }

    return { rawFile, eventFile, summaryFile };
  }

  function reset() {
    _rawRows = [];
  }

  function getRawCount() { return _rawRows.length; }

  // ── Sample CSV format documentation ───────────────────────────────────────
  // (used by the README and validation mode to describe the output format)
  const SAMPLE_FORMAT = {
    raw:     RAW_HEADERS,
    events:  EVENT_HEADERS,
    summary: SUMMARY_HEADERS,
  };

  return { appendRaw, exportAll, reset, getRawCount, SAMPLE_FORMAT };

})();
