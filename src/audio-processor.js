// Audio processing constants
const COMPRESSOR_KNEE    = 0;      // Hard knee for brick-wall limiting
const COMPRESSOR_RATIO   = 20;     // Very high ratio for aggressive limiting
const COMPRESSOR_ATTACK  = 0.003;  // 3ms - fast but not instant (prevents clicks)
const COMPRESSOR_RELEASE = 0.1;    // 100ms - smooth release for natural sound

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
    this.compressorAnalyser = null;
    this.limiterGain = null;
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
    this.mixerGain = null;          // Gain node that mixes all three bands before analyser
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

    this.compressorAnalyser = new AnalyserNode(this.audioCtx, {
      fftSize: 2048,
      smoothingTimeConstant: 0.3,
    });

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

    // BAND MIXING & ANALYSIS: All three bands are mixed, then analyzed
    // The analyser measures the COMBINED output of all three bands
    // This ensures the hard limiter responds to the true signal level
    this.mixerGain.connect(this.compressorAnalyser);
    this.compressorAnalyser.connect(this.limiterGain);

    // FINAL STAGE: Hard limiter based on combined signal, then to destination
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

      // Disconnect mixer and analysis chain
      this.mixerGain.disconnect();
      this.compressorAnalyser.disconnect();

      // Disconnect final limiter
      this.limiterGain.disconnect();
    } catch (e) {
      // Ignore if already disconnected
    }

    // Reconnect source directly to destination (bypass mode)
    this.sourceNode.connect(this.destinationNode);

    this.isActive = false;
  }

  // Start the update loop for the limiter
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

  // Update hard ceiling limiter based on compressor output
  updateLimiter() {
    if (!this.compressorAnalyser || !this.limiterGain || !this.isActive) {
      return;
    }

    const compressorData = new Float32Array(this.compressorAnalyser.fftSize);
    this.compressorAnalyser.getFloatTimeDomainData(compressorData);

    let sumSquares = 0;
    for (let i = 0; i < compressorData.length; i++) {
      sumSquares += compressorData[i] * compressorData[i];
    }
    const compressorRMS = Math.sqrt(sumSquares / compressorData.length);
    const compressorDb = 20 * Math.log10(compressorRMS || 1e-5);

    if (compressorDb > this.threshold) {
      const gainDb = this.threshold - compressorDb;
      const targetGain = Math.pow(10, gainDb / 20);
      this.limiterGain.gain.value = targetGain;
    } else {
      this.limiterGain.gain.value = 1.0;
    }
  }
}
