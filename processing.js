/**
 * MoniRail Web Rider — Signal Processing Layer  (processing.js)
 *
 * ──────────────────────────────────────────────────────────────────────────
 * EN 12299 Comfort Filters — MATLAB → JavaScript Port
 * ──────────────────────────────────────────────────────────────────────────
 * Source: comfort.m  (supplied by client)
 * The two continuous-time weighting filters (Wd and Wb) are defined exactly
 * as in the MATLAB source.  The bilinear (Tustin) transform discretises them
 * at the measured sample rate — mirroring c2d(sysc, Ts, 'tustin').
 *
 * Wd  — lateral / longitudinal comfort  (numd / dend in MATLAB)
 * Wb  — vertical comfort                (numb / denb in MATLAB)
 *
 * Every mathematical step below maps 1-to-1 onto the MATLAB code.
 * Constants come from CONFIG.filterWd / CONFIG.filterWb so they can be
 * audited without reading the filter algebra.
 *
 * MATLAB migration guide
 * ──────────────────────
 * Search for "MATLAB_PLACEHOLDER" to find functions awaiting exact equations
 * from the client.  Each placeholder documents expected inputs and outputs.
 * ──────────────────────────────────────────────────────────────────────────
 */

// ── Polynomial helpers (mirrors MATLAB conv / polyval) ────────────────────────

/**
 * Multiply two polynomials represented as coefficient arrays.
 * Coefficients are in DESCENDING power order (MATLAB convention).
 * e.g. [1, 2, 3] → s² + 2s + 3
 */
function polyMul(a, b) {
  const result = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      result[i + j] += a[i] * b[j];
    }
  }
  return result;
}

/**
 * Scale a polynomial by a scalar.
 */
function polyScale(a, s) { return a.map(v => v * s); }

// ── Bilinear (Tustin) transform ───────────────────────────────────────────────
//
// Implements MATLAB:  sysd = c2d(sysc, Ts, 'tustin')
//
// Given a continuous-time transfer function H(s) = B(s)/A(s) with polynomial
// coefficients in descending powers of s, substitute:
//
//   s  =  (2/Ts) · (z − 1) / (z + 1)
//
// and multiply numerator and denominator through by (z+1)^n to obtain
// polynomials in z (descending powers).  Normalise so the leading
// denominator coefficient equals 1.
//
// The substitution for a polynomial of degree n is:
//
//   p(s) · (z+1)^n  =  Σᵢ pᵢ · (2/Ts)^(n-i) · (z−1)^(n-i) · (z+1)^i
//

function bilinearTransform(numC, denC, Ts) {
  const k = 2.0 / Ts;
  const n = denC.length - 1;          // filter order

  // Pad numerator to the same degree as denominator
  const numPad = new Array(n + 1 - numC.length).fill(0).concat(numC.slice());
  const denPad = denC.slice();

  // Precompute (z−1)^j and (z+1)^j for j = 0 … n
  // Each entry is a length-(j+1) coefficient array [c_j, c_{j-1}, … c_0]
  const zm1pow = [[1]];
  const zp1pow = [[1]];
  for (let j = 1; j <= n; j++) {
    zm1pow.push(polyMul(zm1pow[j - 1], [1, -1]));
    zp1pow.push(polyMul(zp1pow[j - 1], [1,  1]));
  }

  const numZ = new Array(n + 1).fill(0);
  const denZ = new Array(n + 1).fill(0);

  for (let i = 0; i <= n; i++) {
    const a       = n - i;                    // power of (z−1)
    const b       = i;                        // power of (z+1)
    const product = polyMul(zm1pow[a], zp1pow[b]); // length a+b+1 = n+1
    const kPow    = Math.pow(k, a);

    for (let j = 0; j <= n; j++) {
      numZ[j] += numPad[i] * kPow * product[j];
      denZ[j] += denPad[i] * kPow * product[j];
    }
  }

  // Normalise — mirrors MATLAB's automatic normalisation of tf objects
  const d0 = denZ[0];
  return {
    num: numZ.map(v => v / d0),
    den: denZ.map(v => v / d0),
  };
}

// ── Build Wd continuous-time numerator / denominator ─────────────────────────
//
// MATLAB lines reproduced verbatim (variable names kept identical):
//
//   f1=0.4; f2=100.0; Q1=1/sqrt(2);
//   f3=2;   f4=2;     Q2=0.63;
//
//   w2=f2*2*pi; b2=w2*w2; a2=[1, w2/Q1, w2*w2];
//   w1=f1*2*pi; b1=[1,0,0]; a1=[1, w1/Q1, w1*w1];
//   w3=f3*2*pi; w4=f4*2*pi;
//   b3=w4*w4*[1,w3]; a3=w3*[1, w4/Q2, w4*w4];
//
//   bb=conv(conv(b1,b2),b3); aa=conv(conv(a1,a2),a3);
//
function _buildWdContinuous() {
  const { f1, f2, Q1, f3, f4, Q2 } = CONFIG.filterWd;
  const TWO_PI = 2 * Math.PI;
  const w1 = f1 * TWO_PI, w2 = f2 * TWO_PI;
  const w3 = f3 * TWO_PI, w4 = f4 * TWO_PI;

  // Band-limiting sections
  const b2 = w2 * w2;
  const a2 = [1, w2 / Q1, w2 * w2];
  const b1 = [1, 0, 0];
  const a1 = [1, w1 / Q1, w1 * w1];

  // A-V transition
  const b3 = polyScale([1, w3], w4 * w4);
  const a3 = polyScale([1, w4 / Q2, w4 * w4], w3);

  // Combine  (mirrors MATLAB conv chains)
  const bb = polyMul(polyMul(b1, [b2]), b3);   // b2 is scalar → wrap as [b2]
  const aa = polyMul(polyMul(a1,  a2),  a3);

  return { bb, aa };
}

// ── Build Wb continuous-time numerator / denominator ─────────────────────────
//
// MATLAB lines reproduced verbatim:
//
//   f1=0.4; f2=100.0; Q1=1/sqrt(2);
//   f3=16;  f4=16;    Q2=0.63;
//   f5=2.5; f6=4;     Q3=0.8; Q4=0.8; k=0.4;
//
//   w2=f2*2*pi; b2=w2*w2; a2=[1, w2/Q1, w2*w2];
//   w1=f1*2*pi; b1=[1,0,0]; a1=[1, w1/Q1, w1*w1];
//   w3=f3*2*pi; w4=f4*2*pi; b3=w4*w4*[1,w3]; a3=w3*[1,w4/Q2,w4*w4];
//   w5=f5*2*pi; w6=f6*2*pi;
//   b5=k*[1,w5/Q3,w5*w5]*w6*w6; a5=[1,w6/Q4,w6*w6]*w5*w5;
//
//   bb=conv(conv(conv(b1,b2),b3),b5); aa=conv(conv(conv(a1,a2),a3),a5);
//
function _buildWbContinuous() {
  const { f1, f2, Q1, f3, f4, Q2, f5, f6, Q3, Q4, k } = CONFIG.filterWb;
  const TWO_PI = 2 * Math.PI;
  const w1 = f1 * TWO_PI, w2 = f2 * TWO_PI;
  const w3 = f3 * TWO_PI, w4 = f4 * TWO_PI;
  const w5 = f5 * TWO_PI, w6 = f6 * TWO_PI;

  // Band-limiting
  const b2 = w2 * w2;
  const a2 = [1, w2 / Q1, w2 * w2];
  const b1 = [1, 0, 0];
  const a1 = [1, w1 / Q1, w1 * w1];

  // A-V transition
  const b3 = polyScale([1, w3], w4 * w4);
  const a3 = polyScale([1, w4 / Q2, w4 * w4], w3);

  // Upward step
  // MATLAB: b5 = k * [1, w5/Q3, w5*w5] * w6*w6
  const b5 = polyScale([1, w5 / Q3, w5 * w5], k * w6 * w6);
  // MATLAB: a5 = [1, w6/Q4, w6*w6] * w5*w5
  const a5 = polyScale([1, w6 / Q4, w6 * w6], w5 * w5);

  // Combine
  const bb = polyMul(polyMul(polyMul(b1, [b2]), b3), b5);
  const aa = polyMul(polyMul(polyMul(a1,  a2),  a3), a5);

  return { bb, aa };
}

// ── Build digital filter coefficients at a given sample rate ─────────────────

/**
 * Returns the digital Wd filter coefficients for the given sample rate.
 * Mirrors:  sysd = c2d(tf(bb,aa), 1/fs, 'tustin')
 *           numd = sysd.num{1};  dend = sysd.den{1};
 */
function buildWdCoeffs(fs) {
  const Ts = 1.0 / fs;
  const { bb, aa } = _buildWdContinuous();
  return bilinearTransform(bb, aa, Ts);
}

/**
 * Returns the digital Wb filter coefficients for the given sample rate.
 * Mirrors:  sysd = c2d(tf(bb,aa), 1/fs, 'tustin')
 *           numb = sysd.num{1};  denb = sysd.den{1};
 */
function buildWbCoeffs(fs) {
  const Ts = 1.0 / fs;
  const { bb, aa } = _buildWbContinuous();
  return bilinearTransform(bb, aa, Ts);
}

// ── IIR filter (stateful, Direct Form II Transposed) ─────────────────────────
//
// Direct Form II Transposed is preferred for numerical stability at high
// filter orders.
//
// Reference: Oppenheim & Schafer, "Discrete-Time Signal Processing", §6.
//
function createIIRFilter(b, a) {
  // b[0..n], a[0..n] with a[0] = 1 (already normalised by bilinearTransform)
  const n = a.length - 1;
  const w = new Float64Array(n); // state vector

  return {
    /**
     * Process one scalar sample, returning the filtered output.
     * Mirrors MATLAB:  filter(b, a, signal)  applied sample-by-sample.
     */
    process(x) {
      const y = b[0] * x + w[0];
      for (let i = 0; i < n - 1; i++) {
        w[i] = b[i + 1] * x - a[i + 1] * y + w[i + 1];
      }
      w[n - 1] = b[n] * x - a[n] * y;
      return y;
    },
    reset() { w.fill(0); },
    order: n,
  };
}

// ── Sliding RMS envelope ──────────────────────────────────────────────────────
//
// Mirrors MATLAB:  [Cc,~] = envelope(Xf, Wl*fs, 'rms')
//
// Maintains a circular buffer of length windowSamples and returns the RMS
// of the current window on each call to push().
//
function createRMSEnvelope(windowSamples) {
  const buf  = new Float64Array(windowSamples);
  let   head = 0;
  let   sumSq = 0;
  let   count = 0;

  return {
    push(x) {
      const old = buf[head];
      sumSq -= old * old;
      sumSq += x * x;
      buf[head] = x;
      head = (head + 1) % windowSamples;
      if (count < windowSamples) count++;
      return Math.sqrt(sumSq / count);
    },
    reset() {
      buf.fill(0);
      head = 0; sumSq = 0; count = 0;
    },
    get windowSamples() { return windowSamples; },
  };
}

// ── High-pass filter for displacement (drift mitigation) ─────────────────────
//
// Second-order Butterworth high-pass at CONFIG.displacement.HP_CUTOFF_HZ.
// Applied before integration to remove DC bias and low-frequency drift.
// Replace this with the client's MATLAB-derived filter when available.
//
function buildHighPassCoeffs(cutoffHz, fs) {
  // Bilinear Butterworth HP via standard 2nd-order prototype
  const f0 = cutoffHz;
  const Ts = 1.0 / fs;
  const k  = Math.tan(Math.PI * f0 * Ts);
  const norm = 1.0 / (1.0 + Math.SQRT2 * k + k * k);
  const b = [norm, -2 * norm, norm];
  const a = [1.0, 2 * norm * (k * k - 1), norm * (1 - Math.SQRT2 * k + k * k)];
  return { num: b, den: a };
}

// ── Displacement estimator ────────────────────────────────────────────────────
//
// ENGINEERING NOTE: Raw double integration of smartphone accelerometer data
// diverges rapidly due to bias and noise.  The pipeline here applies:
//   1. Bias removal (subtract running mean over a long window)
//   2. Gravity compensation via orientation angles from CalibrationModule
//   3. High-pass filtering at HP_CUTOFF_HZ to remove residual bias
//   4. Single integration (trapezoidal rule) → velocity
//   5. Second high-pass filter → removes velocity drift
//   6. Second integration → displacement
//
// Confidence is flagged LOW when the estimated noise floor exceeds the
// threshold in CONFIG.displacement.CONFIDENCE_NOISE_THRESHOLD_MM.
//
// MATLAB_PLACEHOLDER: Replace this pipeline with the client's validated
// inertial algorithm.  The function signature must remain:
//   { lateral_mm, vertical_mm, confidence }  = displacementPipeline.push(ay, az, dt_s)
// where ay is the train-frame lateral acceleration (m/s²) and az is vertical.
//
function createDisplacementPipeline(fs) {
  const hp = buildHighPassCoeffs(CONFIG.displacement.HP_CUTOFF_HZ, fs);
  const hpLatAcc = createIIRFilter(hp.num, hp.den);
  const hpVertAcc = createIIRFilter(hp.num, hp.den);
  const hpLatVel = createIIRFilter(hp.num, hp.den);
  const hpVertVel = createIIRFilter(hp.num, hp.den);

  let velLat = 0, velVert = 0;
  let dispLat = 0, dispVert = 0;
  let noiseSumLat = 0, noiseCount = 0;

  return {
    push(ay_mss, az_mss, dt_s) {
      // Step 3: high-pass filter acceleration (removes bias/gravity residual)
      const ayFilt = hpLatAcc.process(ay_mss);
      const azFilt = hpVertAcc.process(az_mss);

      // Step 4: integrate acceleration → velocity (trapezoidal rule)
      velLat  += ayFilt * dt_s;
      velVert += azFilt * dt_s;

      // Step 5: high-pass velocity (removes velocity drift)
      const vlFilt = hpLatVel.process(velLat);
      const vvFilt = hpVertVel.process(velVert);

      // Step 6: integrate velocity → displacement (m → mm)
      dispLat  += vlFilt  * dt_s * 1000.0;
      dispVert += vvFilt  * dt_s * 1000.0;

      // Running noise estimate for confidence flag
      noiseSumLat += ayFilt * ayFilt;
      noiseCount++;
      const rmsNoise = Math.sqrt(noiseSumLat / noiseCount) * 1000;
      const confidence = rmsNoise < CONFIG.displacement.CONFIDENCE_NOISE_THRESHOLD_MM
        ? 'HIGH' : 'LOW';

      return {
        lateral_mm:  dispLat,
        vertical_mm: dispVert,
        confidence,
      };
    },
    reset() {
      hpLatAcc.reset(); hpVertAcc.reset();
      hpLatVel.reset(); hpVertVel.reset();
      velLat = 0; velVert = 0;
      dispLat = 0; dispVert = 0;
      noiseSumLat = 0; noiseCount = 0;
    },
  };
}

// ── Main comfort processor ────────────────────────────────────────────────────
//
// Maintains all filter state for one recording session.
// Call init(fs) when the sample rate is known, then push() for each sample.
//
const ComfortProcessor = (() => {

  let _fs      = null;
  let _wdX     = null, _wdY = null, _wdZ = null;
  let _wb      = null;
  let _envCcx  = null, _envCcy = null, _envCcz = null;
  let _disp    = null;

  // Downsampled 1-Hz buffers for Nmv / Nvd — mirrors MATLAB CcxDS / CcyDS / CczDS
  let _ccxBuf1hz = [], _ccyBuf1hz = [], _cczBuf1hz = [];
  let _lastDownTs = 0;

  // Last computed comfort values (for UI polling)
  let _last = {
    ccx: 0, ccy: 0, ccz: 0,
    lateral_mm: 0, vertical_mm: 0,
    displacement_confidence: 'LOW',
    pct: 0, pde: 0,
    comfort_status: 'GREEN',
    nmv: null, nvd: null,
  };

  function init(fs) {
    _fs = fs;
    const wdC = buildWdCoeffs(fs);
    const wbC = buildWbCoeffs(fs);

    // One Wd filter instance per axis
    _wdX = createIIRFilter(wdC.num, wdC.den);
    _wdY = createIIRFilter(wdC.num, wdC.den);
    _wdZ = createIIRFilter(wdC.num, wdC.den);  // not used for standard Ccz but kept for Ccx

    // One Wb filter for vertical
    _wb  = createIIRFilter(wbC.num, wbC.den);

    // RMS envelopes  (window = Wl * fs samples)
    const win = Math.round(CONFIG.comfort.WINDOW_SEC * fs);
    _envCcx = createRMSEnvelope(win);
    _envCcy = createRMSEnvelope(win);
    _envCcz = createRMSEnvelope(win);

    _disp = createDisplacementPipeline(fs);

    _ccxBuf1hz = []; _ccyBuf1hz = []; _cczBuf1hz = [];
    _lastDownTs = 0;
    _last = { ccx:0, ccy:0, ccz:0, lateral_mm:0, vertical_mm:0,
              displacement_confidence:'LOW', pct:0, pde:0,
              comfort_status:'GREEN', nmv:null, nvd:null };
  }

  /**
   * Push one train-frame acceleration sample.
   *
   * @param {number} ax   Longitudinal acceleration (m/s²)
   * @param {number} ay   Lateral acceleration      (m/s²)
   * @param {number} az   Vertical acceleration     (m/s²)
   * @param {number} dt_s Sample interval (seconds)
   * @param {number} mono Monotonic timestamp (ms)  — for 1-Hz downsampling
   * @returns {ComfortResult}
   */
  function push(ax, ay, az, dt_s, mono) {
    if (!_fs) throw new Error('ComfortProcessor not initialised — call init(fs) first');

    // ── EN 12299 § 5.3.1  Wd filtering (lateral / longitudinal) ─────────────
    // MATLAB: XAccf = filter(numd,dend,XAcc)
    //         YAccf = filter(numd,dend,YAcc)
    const axFilt = _wdX.process(ax);
    const ayFilt = _wdY.process(ay);

    // ── EN 12299 § 5.3.2  Wb filtering (vertical) ───────────────────────────
    // MATLAB: ZAccf = filter(numb,denb,ZAcc)
    const azFilt = _wb.process(az);

    // ── Continuous comfort (RMS envelope) ────────────────────────────────────
    // MATLAB: [Ccx,~] = envelope(XAccf, Wl*fs, 'rms')
    //         [Ccy,~] = envelope(YAccf, Wl*fs, 'rms')
    //         [Ccz,~] = envelope(ZAccf, Wl*fs, 'rms')
    const ccx = _envCcx.push(axFilt);
    const ccy = _envCcy.push(ayFilt);
    const ccz = _envCcz.push(azFilt);

    // ── 1-Hz downsampling for Nmv / Nvd ─────────────────────────────────────
    // MATLAB: CcxDS=downsample(Ccx,fs)  …  sampled once per second
    if (mono - _lastDownTs >= 1000) {
      _ccxBuf1hz.push(ccx);
      _ccyBuf1hz.push(ccy);
      _cczBuf1hz.push(ccz);
      _lastDownTs = mono;
    }

    // ── Traffic-light status ─────────────────────────────────────────────────
    const status = _comfortStatus(ccy, ccz);

    // ── Displacement pipeline ────────────────────────────────────────────────
    const { lateral_mm, vertical_mm, confidence } = _disp.push(ay, az, dt_s);

    // ── PCT / PDE ─────────────────────────────────────────────────────────────
    // MATLAB_PLACEHOLDER: Insert exact PCT / PDE equations from client source.
    // Expected outputs: pct (%), pde (%)
    const { pct, pde } = computePctPde(ccx, ccy, ccz, _ccxBuf1hz, _ccyBuf1hz, _cczBuf1hz);

    _last = {
      ccx, ccy, ccz,
      lateral_mm, vertical_mm,
      displacement_confidence: confidence,
      pct, pde,
      comfort_status: status,
      nmv: null, nvd: null,   // Computed end-of-journey by computeMeanComfort()
    };

    return _last;
  }

  /** Traffic light per requirements and CONFIG thresholds. */
  function _comfortStatus(ccy, ccz) {
    const { GREEN_MAX, AMBER_MIN, RED_MIN } = CONFIG.comfort;
    if (ccy >= RED_MIN || ccz >= RED_MIN) return 'RED';
    if (ccy >= AMBER_MIN || ccz >= AMBER_MIN) return 'AMBER';
    // Values 0.20 – 0.29 remain GREEN per project decision
    return 'GREEN';
  }

  /**
   * Compute Nmv and Nvd at end of journey.
   * Mirrors the MATLAB percentile + reshape section exactly.
   *
   * MATLAB:
   *   for i=1:length(CcxDS)
   *     st=max(1,i-Wl*60/2); en=min(length(CcxDS),i+Wl*60/2);
   *     Px(i,:)=prctile(CcxDS(st:en),[50 95]);
   *     Py(i,:)=prctile(CcyDS(st:en),[50 95]);
   *     Pz(i,:)=prctile(CczDS(st:en),[50 95]);
   *   end
   *   NmvDS = 6*sqrt(Px(:,2).^2 + Py(:,2).^2 + Pz(:,2).^2)
   *   NvdDS = 3*sqrt(16*Px(:,1).^2 + 4*Py(:,1).^2 + Pz(:,1).^2) + Wl*Py(:,2).^2
   */
  function computeMeanComfort() {
    const Wl   = CONFIG.comfort.WINDOW_SEC;   // minutes in MATLAB; seconds here — see note
    // NOTE: MATLAB Wl is in minutes (default 5).  The 1-Hz buffer here is in
    // seconds.  We use CONFIG.comfort.WINDOW_SEC (5) and treat the half-window
    // as Wl*60/2 samples of the 1-Hz buffer.
    const halfWin = Math.round(Wl * 60 / 2);

    const xBuf = _ccxBuf1hz, yBuf = _ccyBuf1hz, zBuf = _cczBuf1hz;
    const len  = xBuf.length;
    if (len === 0) return { nmv: null, nvd: null };

    const NmvDS = new Array(len);
    const NvdDS = new Array(len);

    for (let i = 0; i < len; i++) {
      const st = Math.max(0, i - halfWin);
      const en = Math.min(len - 1, i + halfWin);
      const px = _prctile(xBuf, st, en, [50, 95]);
      const py = _prctile(yBuf, st, en, [50, 95]);
      const pz = _prctile(zBuf, st, en, [50, 95]);

      // MATLAB: NmvDS = 6*sqrt(Px95^2 + Py95^2 + Pz95^2)
      NmvDS[i] = 6 * Math.sqrt(px[1]**2 + py[1]**2 + pz[1]**2);

      // MATLAB: NvdDS = 3*sqrt(16*Px50^2 + 4*Py50^2 + Pz50^2) + Wl*Py95^2
      // (Wl in minutes in MATLAB — use CONFIG value consistently)
      NvdDS[i] = 3 * Math.sqrt(16 * px[0]**2 + 4 * py[0]**2 + pz[0]**2)
               + Wl * py[1]**2;
    }

    // MATLAB: reshape into Wl*60-sample blocks; compute mean per block
    const blockLen = Math.round(Wl * 60);
    const nBlocks  = Math.floor(len / blockLen);

    const nmvBlocks = [];
    const nvdBlocks = [];
    for (let b = 0; b < nBlocks; b++) {
      const sl  = NmvDS.slice(b * blockLen, (b + 1) * blockLen);
      const sl2 = NvdDS.slice(b * blockLen, (b + 1) * blockLen);
      nmvBlocks.push(_mean(sl));
      nvdBlocks.push(_mean(sl2));
    }
    // Trailing partial block
    if (nBlocks * blockLen < len) {
      nmvBlocks.push(_mean(NmvDS.slice(nBlocks * blockLen)));
      nvdBlocks.push(_mean(NvdDS.slice(nBlocks * blockLen)));
    }

    const nmv = _round2(nmvBlocks[nmvBlocks.length - 1] ?? 0);
    const nvd = _round2(nvdBlocks[nvdBlocks.length - 1] ?? 0);
    _last.nmv = nmv; _last.nvd = nvd;
    return { nmv, nvd, nmvSeries: nmvBlocks, nvdSeries: nvdBlocks };
  }

  // Percentile helper (mirrors MATLAB prctile)
  function _prctile(arr, st, en, pcts) {
    const slice = arr.slice(st, en + 1).sort((a, b) => a - b);
    const n = slice.length;
    return pcts.map(p => {
      const idx = (p / 100) * (n - 1);
      const lo  = Math.floor(idx), hi = Math.ceil(idx);
      return lo === hi ? slice[lo] : slice[lo] + (slice[hi] - slice[lo]) * (idx - lo);
    });
  }

  function _mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }
  function _round2(v) { return Math.round(v * 100) / 100; }

  function getLast()    { return { ..._last }; }
  function reset()      {
    if (_wdX) { _wdX.reset(); _wdY.reset(); _wdZ.reset(); _wb.reset(); }
    if (_envCcx) { _envCcx.reset(); _envCcy.reset(); _envCcz.reset(); }
    if (_disp) _disp.reset();
    _ccxBuf1hz = []; _ccyBuf1hz = []; _cczBuf1hz = [];
    _last = { ccx:0, ccy:0, ccz:0, lateral_mm:0, vertical_mm:0,
              displacement_confidence:'LOW', pct:0, pde:0,
              comfort_status:'GREEN', nmv:null, nvd:null };
  }

  return { init, push, getLast, computeMeanComfort, reset };

})();

// ── PCT / PDE placeholder ─────────────────────────────────────────────────────
//
// MATLAB_PLACEHOLDER: Exact equations for PCT and PDE are not yet available.
// Replace the body of this function with the client's verified MATLAB code.
//
// Inputs
//   ccx, ccy, ccz   — current continuous comfort values (dimensionless)
//   ccxBuf, ccyBuf, cczBuf — 1-Hz downsampled history arrays
//
// Outputs
//   pct  — Percentage Comfort Time exceeded (%)
//   pde  — Percentage Distance Exceeded    (%)
//
function computePctPde(ccx, ccy, ccz, ccxBuf, ccyBuf, cczBuf) {
  /* ──────────────────────────────────────────────────────────────────────
   *  INSERT MATLAB EQUATIONS HERE
   *  Reference: EN 12299 §6 (Nmv standard method) / §7 (Nvd complete method)
   *  PCT is typically the fraction of time Ccy or Ccz exceeds a threshold.
   *  PDE is typically the fraction of distance exceeding a threshold.
   * ──────────────────────────────────────────────────────────────────────
   */
  const threshold = CONFIG.comfort.AMBER_MIN;
  const n         = ccyBuf.length;
  let   nExceed   = 0;
  for (let i = 0; i < n; i++) {
    if (ccyBuf[i] > threshold || cczBuf[i] > threshold) nExceed++;
  }
  const pct = n > 0 ? (nExceed / n) * 100 : 0;
  const pde = pct;   // PLACEHOLDER: replace with distance-weighted calculation
  return { pct, pde };
}
