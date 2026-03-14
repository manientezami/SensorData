/**
 * MoniRail Web Rider - Core Logic
 * Ported from comfort.m (MATLAB)
 */

const CONFIG = {
    thresholds: {
        green: 0.2,
        amber: 0.3,
        red: 0.4,
        dispLimit: 20 // mm
    },
    refreshRateUI: 15, // Hz
};

class ComfortEngine {
    constructor() {
        // Placeholder for filter coefficients derived from MATLAB c2d
        // In a real port, these num/den arrays would match comfort.m results
        this.filterStateY = { x1: 0, x2: 0, y1: 0, y2: 0 };
        this.filterStateZ = { x1: 0, x2: 0, y1: 0, y2: 0 };
    }

    /**
     * Replicates the band-limiting and A-V transition filters 
     * defined in comfort.m for Wd (Lateral) and Wb (Vertical)
     */
    applyWeighting(accelValue, axis) {
        // [INSERT MATLAB EQUATIONS HERE] 
        // Example: Difference equation implementation of sysd (Tustin)
        // y[n] = b0*x[n] + b1*x[n-1] ... - a1*y[n-1]
        return accelValue * 0.95; // Placeholder
    }

    calculateContinuousComfort(weightedSignals) {
        // MATLAB: [Ccx,~]=envelope(XAccf,Wl*fs,'rms');
        // We use a moving RMS window
        return Math.sqrt(weightedSignals.reduce((a, b) => a + b*b, 0) / weightedSignals.length);
    }

    getTrafficLight(val) {
        if (val >= CONFIG.thresholds.red) return 'red';
        if (val >= CONFIG.thresholds.amber) return 'amber';
        return 'green'; // Values < 0.3 default to green per requirements [cite: 91]
    }
}

// --- Sensor Acquisition ---
let isRecording = false;
let startTime = 0;

function startAcquisition() {
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
        DeviceMotionEvent.requestPermission()
            .then(response => {
                if (response == 'granted') {
                    window.addEventListener('devicemotion', handleMotion);
                    isRecording = true;
                }
            })
            .catch(console.error);
    } else {
        window.addEventListener('devicemotion', handleMotion);
        isRecording = true;
    }
}

function handleMotion(event) {
    if (!isRecording) return;
    
    const timestamp = performance.now(); // High-res monotonic [cite: 64]
    const acc = event.accelerationIncludingGravity;
    
    // Process axes (requires calibration step to align with train) 
    // Placeholder for Coordinate Transformation [cite: 117]
    const lateral_acc = acc.y; 
    const vertical_acc = acc.z;

    updateUI(lateral_acc, vertical_acc);
}

// --- UI Updates ---
function updateUI(y, z) {
    const engine = new ComfortEngine();
    const ccy = Math.abs(y * 0.1); // Placeholder logic
    const ccz = Math.abs(z * 0.1);

    // Update Traffic Lights
    document.querySelectorAll('.light').forEach(l => l.style.opacity = 0.2);
    document.getElementById(`light-ccy-${engine.getTrafficLight(ccy)}`).style.opacity = 1.0;
    document.getElementById(`light-ccz-${engine.getTrafficLight(ccz)}`).style.opacity = 1.0;
}

document.getElementById('startStopBtn').addEventListener('click', function() {
    this.textContent = isRecording ? 'Start' : 'Stop';
    this.classList.toggle('btn-start');
    this.classList.toggle('btn-stop');
    if (!isRecording) startAcquisition();
    else isRecording = false;
});