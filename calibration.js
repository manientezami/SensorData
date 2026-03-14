/**
 * MoniRail Web Rider — Calibration Layer  (calibration.js)
 *
 * The phone can be mounted in any orientation inside the train.
 * This module captures a short "still" calibration window, estimates
 * the gravity vector in phone coordinates, and builds a rotation matrix
 * that maps phone-frame accelerations into train-frame accelerations.
 *
 * Train frame convention (right-hand):
 *   X  — direction of travel (longitudinal)
 *   Y  — lateral (left positive looking forward)
 *   Z  — vertical (upward positive)
 *
 * The user must indicate which direction the phone's screen faces
 * relative to the train.  A calibration button in the UI triggers
 * captureCalibration(), which records N samples, averages them,
 * and stores the resulting rotation matrix for use by the processing layer.
 *
 * NOTE: Magnetometer-based heading is optional.  If the magnetometer is
 * unavailable the longitudinal-axis assignment is estimated from the
 * phone motion direction; this is flagged as approximate.
 */

const CalibrationModule = (() => {

  let _calibrated    = false;
  let _rotMatrix     = null;   // 3×3 row-major Float64Array
  let _gravityRef    = null;   // gravity vector in phone frame [gx, gy, gz]
  let _mounting      = 'PORTRAIT_FACE_FORWARD';  // default assumption
  let _accumSamples  = [];
  let _capturing     = false;
  const CAPTURE_SAMPLES = 100;

  // ── Mounting options ───────────────────────────────────────────────────────
  //
  // These describe the phone's screen orientation relative to the train.
  // The user selects one in the UI before calibration.
  const MOUNTING_MODES = {
    PORTRAIT_FACE_FORWARD:  'Portrait, screen facing forward',
    PORTRAIT_FACE_UP:       'Portrait, screen facing up (flat on seat)',
    LANDSCAPE_FACE_FORWARD: 'Landscape, screen facing forward',
    CUSTOM:                 'Custom — use calibration capture',
  };

  // ── Rotation matrix helpers ───────────────────────────────────────────────

  /** Multiply two 3×3 matrices (row-major flat array). */
  function mat3Mul(A, B) {
    const C = new Float64Array(9);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += A[r*3+k] * B[k*3+c];
        C[r*3+c] = sum;
      }
    }
    return C;
  }

  /** Apply rotation matrix to a 3-vector. */
  function mat3Vec(M, v) {
    return [
      M[0]*v[0] + M[1]*v[1] + M[2]*v[2],
      M[3]*v[0] + M[4]*v[1] + M[5]*v[2],
      M[6]*v[0] + M[7]*v[1] + M[8]*v[2],
    ];
  }

  /** Build identity matrix. */
  function mat3Identity() {
    return new Float64Array([1,0,0, 0,1,0, 0,0,1]);
  }

  /** Normalise a 3-vector in place. */
  function normalise(v) {
    const mag = Math.sqrt(v[0]**2 + v[1]**2 + v[2]**2);
    if (mag < 1e-9) return v;
    return v.map(x => x / mag);
  }

  /**
   * Build a rotation matrix from phone-frame gravity vector to world-frame
   * standard orientation (Z up) using the Gram-Schmidt process.
   *
   * This is the same approach as Android's SensorManager.getRotationMatrix().
   */
  function buildRotationFromGravity(grav, mag) {
    // Downward gravity in phone frame  → negate to get "up" direction
    const up  = normalise(grav.map(x => -x));   // phone Z aligns to world Z
    // East vector (approximate; if mag unavailable use arbitrary reference)
    let east;
    if (mag && (mag[0]**2 + mag[1]**2 + mag[2]**2) > 1e-6) {
      east = normalise(crossProduct(mag, up));
    } else {
      // Fallback: assume phone X ~ train X (longitudinal)
      east = normalise(crossProduct([1, 0, 0], up));
    }
    const north = crossProduct(up, east);

    // Rotation matrix: rows are [east, north, up] → remapped to train [X,Y,Z]
    // east → train Y (lateral), north → train X (longitudinal), up → train Z
    return new Float64Array([
      north[0], north[1], north[2],   // row 0: train X = longitudinal
      east[0],  east[1],  east[2],    // row 1: train Y = lateral
      up[0],    up[1],    up[2],      // row 2: train Z = vertical
    ]);
  }

  function crossProduct(a, b) {
    return [
      a[1]*b[2] - a[2]*b[1],
      a[2]*b[0] - a[0]*b[2],
      a[0]*b[1] - a[1]*b[0],
    ];
  }

  // ── Calibration capture ───────────────────────────────────────────────────

  function startCapture(mountingMode) {
    _mounting      = mountingMode || _mounting;
    _accumSamples  = [];
    _capturing     = true;
    _calibrated    = false;
  }

  /**
   * Feed a raw accelerometer sample (including gravity) during capture.
   * Call from the sensors.js 'motion' callback while _capturing is true.
   * Returns true when capture is complete.
   */
  function feedCaptureSample(sample) {
    if (!_capturing) return false;
    _accumSamples.push([sample.acc_x, sample.acc_y, sample.acc_z]);
    if (_accumSamples.length >= CAPTURE_SAMPLES) {
      _finishCapture(null);
      return true;
    }
    return false;
  }

  function feedCaptureMag(sample) {
    // Store last magnetometer reading for rotation build
    _lastMag = [sample.mag_x, sample.mag_y, sample.mag_z];
  }

  let _lastMag = null;

  function _finishCapture(magOverride) {
    _capturing = false;
    const n = _accumSamples.length;
    if (n === 0) return;

    // Average gravity vector over capture window
    const avg = [0, 0, 0];
    for (const s of _accumSamples) {
      avg[0] += s[0]; avg[1] += s[1]; avg[2] += s[2];
    }
    avg[0] /= n; avg[1] /= n; avg[2] /= n;
    _gravityRef = avg;

    const mag = magOverride || _lastMag;
    _rotMatrix  = buildRotationFromGravity(avg, mag);
    _calibrated = true;
  }

  /**
   * Force calibration from a predefined mounting mode without capture.
   * Useful when the user knows exactly how the phone is mounted.
   */
  function applyPresetMounting(mode) {
    _mounting = mode;
    // These presets assume standard phone orientation conventions.
    // Phone Z = screen normal; Phone Y = toward top; Phone X = to the right.
    const presets = {
      // Screen faces direction of travel; phone held upright
      PORTRAIT_FACE_FORWARD:  new Float64Array([0,0,-1, -1,0,0, 0,1,0]),
      // Screen faces up (phone lying flat); top toward front
      PORTRAIT_FACE_UP:       new Float64Array([0,1,0, -1,0,0, 0,0,1]),
      // Landscape, screen forward, home button to right
      LANDSCAPE_FACE_FORWARD: new Float64Array([1,0,0, 0,0,-1, 0,1,0]),
    };
    _rotMatrix  = presets[mode] || mat3Identity();
    _calibrated = true;
  }

  // ── Transform ─────────────────────────────────────────────────────────────

  /**
   * Transform a phone-frame acceleration vector into train-frame.
   * Also removes the gravity component using the calibrated reference.
   *
   * @param {number} ax  Phone X acceleration (m/s²)
   * @param {number} ay  Phone Y acceleration (m/s²)
   * @param {number} az  Phone Z acceleration (m/s²)
   * @returns {{ lon: number, lat: number, vert: number }}
   *          Train-frame: longitudinal, lateral, vertical (m/s²)
   */
  function toTrainFrame(ax, ay, az) {
    if (!_calibrated) {
      // Pass-through with no transform (fallback before calibration)
      return { lon: ax, lat: ay, vert: az };
    }
    // Remove gravity using calibration reference
    const ag = [
      ax - _gravityRef[0],
      ay - _gravityRef[1],
      az - _gravityRef[2],
    ];
    const t = mat3Vec(_rotMatrix, ag);
    return { lon: t[0], lat: t[1], vert: t[2] };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  return {
    MOUNTING_MODES,
    startCapture,
    feedCaptureSample,
    feedCaptureMag,
    applyPresetMounting,
    toTrainFrame,
    isCalibrated: () => _calibrated,
    isCapturing:  () => _capturing,
    captureProgress: () => Math.min(1, _accumSamples.length / CAPTURE_SAMPLES),
    getMounting:  () => _mounting,
    getGravityRef: () => _gravityRef ? [..._gravityRef] : null,
  };

})();
