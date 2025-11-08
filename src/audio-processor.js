// Audio processing constants
const COMPRESSOR_KNEE    = 0;      // Hard knee for brick-wall limiting
const COMPRESSOR_RATIO   = 20;     // Very high ratio for aggressive limiting
const COMPRESSOR_ATTACK  = 0.003;  // 3ms - fast but not instant (prevents clicks)
const COMPRESSOR_RELEASE = 0.1;    // 100ms - smooth release for natural sound
const LIMITER_ATTACK     = 0.003;  // 3ms - fast response to prevent clipping
const LIMITER_RELEASE    = 0.05;   // 50ms - smooth release for natural sound

// Multi-band crossover frequencies (Hz)
const CROSSOVER_LOW  = 300;   // Below this: low band (rumble, low-frequency noise)
const CROSSOVER_HIGH = 3000;  // Above this: high band (hiss, high-frequency noise)
                              // Between: mid band (300-3000Hz) - primary voice frequencies

// Hybrid audio limiter using compressor + hard ceiling
class VoiceVolumeNormalizer {
  constructor(threshold) {
    this.audioCtx = null;
    this.sourceNode = null;
    this.destinationNode = null;
    this.compressor = null;
    this.limiterCompressor = null;  // First-stage compressor for smooth limiting
    this.mixerAnalyser = null;      // Analyser to measure signal after first-stage limiter
    this.limiterGain = null;        // Final safety limiter (hard ceiling)
    this.threshold = threshold;
    this.isActive = false;
    this.animationFrameId = null;

    // Multi-band processing nodes
    this.lowBandFilter = null;      // Lowpass filter for low band
    this.midBandFilterHP = null;    // Highpass filter for mid band
    this.midBandFilterLP = null;    // Lowpass filter for mid band
    this.highBandFilter = null;     // Highpass filter for high band
    this.lowBandGain = null;        // Gain node for low band
    this.midBandGain = null;        // Gain node for mid band
    this.highBandGain = null;       // Gain node for high band
    this.mixerGain = null;          // Gain node that mixes all three bands
  }

  // Initialize with an audio context and create internal processing nodes
  initialize(audioContext) {
    if (this.audioCtx) return;

    this.audioCtx = audioContext;

    // Create frequency band filters
    // Low band: frequencies below 300Hz (rumble, low-frequency noise)
    this.lowBandFilter = new BiquadFilterNode(this.audioCtx, {
      type: 'lowpass',
      frequency: CROSSOVER_LOW,
      Q: 0.7071, // Butterworth response (Q = 1/√2): maximally flat passband, no resonance peak
                 // Default Q = 1 would create slight resonance at cutoff; 0.7071 is standard for crossovers
    });

    // Mid band: frequencies 300-3000Hz (primary voice range)
    // Requires two filters in series to create bandpass
    this.midBandFilterHP = new BiquadFilterNode(this.audioCtx, {
      type: 'highpass',
      frequency: CROSSOVER_LOW,
      Q: 0.7071,
    });

    this.midBandFilterLP = new BiquadFilterNode(this.audioCtx, {
      type: 'lowpass',
      frequency: CROSSOVER_HIGH,
      Q: 0.7071,
    });

    // High band: frequencies above 3000Hz (sibilance, high-frequency noise)
    this.highBandFilter = new BiquadFilterNode(this.audioCtx, {
      type: 'highpass',
      frequency: CROSSOVER_HIGH,
      Q: 0.7071,
    });

    // Create gain nodes for each band (for mixing and potential level adjustment)
    this.lowBandGain = new GainNode(this.audioCtx, {
      gain: 1.0, // Unity gain - pass through unmodified
    });

    this.midBandGain = new GainNode(this.audioCtx, {
      gain: 1.0, // Unity gain
    });

    this.highBandGain = new GainNode(this.audioCtx, {
      gain: 1.0, // Unity gain - pass through unmodified
    });

    // Create mixer gain node (combines all three bands before analysis)
    this.mixerGain = new GainNode(this.audioCtx, {
      gain: 1.0, // Unity gain - just for routing/mixing
    });

    // Create compressor (only used for mid band)
    this.compressor = new DynamicsCompressorNode(this.audioCtx, {
      threshold: this.threshold,
      knee: COMPRESSOR_KNEE,
      ratio: COMPRESSOR_RATIO,
      attack: COMPRESSOR_ATTACK,
      release: COMPRESSOR_RELEASE,
    });

    // Create first-stage limiter (compressor for smooth limiting)
    this.limiterCompressor = new DynamicsCompressorNode(this.audioCtx, {
      threshold: this.threshold,    // -20 dB ceiling
      knee: 0,                      // Hard knee (brick-wall limiting)
      ratio: 20,                    // Very high ratio (20:1) for aggressive limiting
      attack: LIMITER_ATTACK,       // 3ms - fast response to catch peaks
      release: LIMITER_RELEASE,     // 50ms - smooth release (slower than mid-band compressor)
    });

    // Create analyser to measure signal after first-stage limiter
    this.mixerAnalyser = new AnalyserNode(this.audioCtx, {
      fftSize: 2048,
      smoothingTimeConstant: 0.3,
    });

    // Create final safety limiter (hard ceiling gain node)
    this.limiterGain = new GainNode(this.audioCtx, {
      gain: 1.0,
    });
  }

  // Enable audio processing with specified source and destination nodes
  enable(sourceNode, destinationNode) {
    if (!this.audioCtx || this.isActive) return;

    // Store the nodes for later use (re-enabling, disabling)
    this.sourceNode = sourceNode;
    this.destinationNode = destinationNode;

    // Disconnect source from any previous connections
    try {
      this.sourceNode.disconnect(this.destinationNode);
    } catch (e) {
      // Ignore if already disconnected
    }

    // Multi-band processing chain:
    // Split source into 3 parallel frequency bands, each processed differently

    // LOW BAND (< 300Hz): Bypass compression, pass through unmodified
    // Rumble and low-frequency noise - no makeup gain amplification
    this.sourceNode.connect(this.lowBandFilter);
    this.lowBandFilter.connect(this.lowBandGain);
    this.lowBandGain.connect(this.mixerGain);

    // MID BAND (300-3000Hz): Full compression for voice normalization
    // Primary voice frequencies - this is where we want aggressive compression
    this.sourceNode.connect(this.midBandFilterHP);
    this.midBandFilterHP.connect(this.midBandFilterLP);
    this.midBandFilterLP.connect(this.compressor);
    this.compressor.connect(this.midBandGain);
    this.midBandGain.connect(this.mixerGain);

    // HIGH BAND (> 3000Hz): Bypass compression, pass through unmodified
    // Sibilance and high-frequency noise - no makeup gain amplification
    this.sourceNode.connect(this.highBandFilter);
    this.highBandFilter.connect(this.highBandGain);
    this.highBandGain.connect(this.mixerGain);

    // FINAL STAGE: Two-stage limiting for smooth + accurate ceiling
    // Stage 1: DynamicsCompressor (20:1 ratio) provides smooth limiting at audio rate
    // Stage 2: GainNode safety limiter provides true hard ceiling
    this.mixerGain.connect(this.limiterCompressor);
    this.limiterCompressor.connect(this.mixerAnalyser);
    this.mixerAnalyser.connect(this.limiterGain);
    this.limiterGain.connect(this.destinationNode);

    this.isActive = true;
    this.startUpdateLoop();
  }

  // Disable audio processing (bypass)
  disable() {
    if (!this.audioCtx || !this.isActive || !this.sourceNode || !this.destinationNode) return;

    this.stopUpdateLoop();

    // Disconnect all multi-band processing nodes
    try {
      // Disconnect source from all three band filters
      this.sourceNode.disconnect(this.lowBandFilter);
      this.sourceNode.disconnect(this.midBandFilterHP);
      this.sourceNode.disconnect(this.highBandFilter);

      // Disconnect low band chain
      this.lowBandFilter.disconnect();
      this.lowBandGain.disconnect();

      // Disconnect mid band chain
      this.midBandFilterHP.disconnect();
      this.midBandFilterLP.disconnect();
      this.compressor.disconnect();
      this.midBandGain.disconnect();

      // Disconnect high band chain
      this.highBandFilter.disconnect();
      this.highBandGain.disconnect();

      // Disconnect mixer and two-stage limiter
      this.mixerGain.disconnect();
      this.limiterCompressor.disconnect();
      this.mixerAnalyser.disconnect();
      this.limiterGain.disconnect();
    } catch (e) {
      // Ignore if already disconnected
    }

    // Reconnect source directly to destination (bypass mode)
    this.sourceNode.connect(this.destinationNode);

    this.isActive = false;
  }

  // Update compressor parameters and band gains
  updateParameters({ threshold, ratio, attack, release, lowBandGain, midBandGain, highBandGain } = {}) {
    if (!this.compressor) return;

    if (threshold !== undefined) {
      this.threshold = threshold;
      this.compressor.threshold.value = threshold;
    }
    if (ratio !== undefined) {
      this.compressor.ratio.value = ratio;
    }
    if (attack !== undefined) {
      this.compressor.attack.value = attack / 1000; // Convert ms to seconds
    }
    if (release !== undefined) {
      this.compressor.release.value = release / 1000; // Convert ms to seconds
    }

    // Update band gains (convert dB to linear gain)
    if (lowBandGain !== undefined && this.lowBandGain) {
      this.lowBandGain.gain.value = Math.pow(10, lowBandGain / 20);
    }
    if (midBandGain !== undefined && this.midBandGain) {
      this.midBandGain.gain.value = Math.pow(10, midBandGain / 20);
    }
    if (highBandGain !== undefined && this.highBandGain) {
      this.highBandGain.gain.value = Math.pow(10, highBandGain / 20);
    }
  }

  // Start the update loop for the safety limiter
  startUpdateLoop() {
    const update = () => {
      this.updateLimiter();
      if (this.isActive) {
        this.animationFrameId = requestAnimationFrame(update);
      }
    };
    this.animationFrameId = requestAnimationFrame(update);
  }

  // Stop the update loop
  stopUpdateLoop() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  // Update safety limiter based on signal after first-stage compressor
  updateLimiter() {
    if (!this.mixerAnalyser || !this.limiterGain || !this.isActive) {
      return;
    }

    // Measure signal level after first-stage compressor
    const analyserData = new Float32Array(this.mixerAnalyser.fftSize);
    this.mixerAnalyser.getFloatTimeDomainData(analyserData);

    let sumSquares = 0;
    for (let i = 0; i < analyserData.length; i++) {
      sumSquares += analyserData[i] * analyserData[i];
    }
    const rms = Math.sqrt(sumSquares / analyserData.length);
    const db = 20 * Math.log10(rms || 1e-5);

    // Calculate target gain for hard ceiling
    let targetGain;
    if (db > this.threshold) {
      const gainDb = this.threshold - db;
      targetGain = Math.pow(10, gainDb / 20);
    } else {
      targetGain = 1.0;
    }

    // OPTION 1: Direct value assignment (causes stepping artifacts)
    this.limiterGain.gain.value = targetGain;

    // OPTION 2: Scheduled parameter automation (commented out for now)
    // const now = this.audioCtx.currentTime;
    // const scheduleTime = now + 0.005; // Schedule 5ms ahead
    // const gainParam = this.limiterGain.gain;
    // gainParam.setValueAtTime(targetGain, scheduleTime);
  }
}
