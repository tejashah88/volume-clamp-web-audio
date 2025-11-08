// Audio processing constants
const ANALYSER_FFT_SIZE = 2048;
const ANALYSER_SMOOTHING = 0.3;

// Handles real-time visualization of audio levels
class AudioVisualizer {
  constructor(processor) {
    this.processor = processor;
    this.animationId = null;
    this.onMetersUpdate = null;
    this.inputAnalyser = null;
    this.lowBandAnalyser = null;
    this.midBandAnalyser = null;
    this.highBandAnalyser = null;
    this.mixedAnalyser = null; // Will reference processor.compressorAnalyser
    this.outputAnalyser = null;
  }

  // Initialize analysers when processor is ready
  initialize() {
    if (!this.processor.audioCtx || this.inputAnalyser) return;

    // Create input analyser (taps raw source)
    this.inputAnalyser = new AnalyserNode(this.processor.audioCtx, {
      fftSize: ANALYSER_FFT_SIZE,
      smoothingTimeConstant: ANALYSER_SMOOTHING,
    });

    // Create band analysers (tap each frequency band)
    this.lowBandAnalyser = new AnalyserNode(this.processor.audioCtx, {
      fftSize: ANALYSER_FFT_SIZE,
      smoothingTimeConstant: ANALYSER_SMOOTHING,
    });
    this.midBandAnalyser = new AnalyserNode(this.processor.audioCtx, {
      fftSize: ANALYSER_FFT_SIZE,
      smoothingTimeConstant: ANALYSER_SMOOTHING,
    });
    this.highBandAnalyser = new AnalyserNode(this.processor.audioCtx, {
      fftSize: ANALYSER_FFT_SIZE,
      smoothingTimeConstant: ANALYSER_SMOOTHING,
    });

    // Reuse processor's analyser for mixed signal (already connected in processor)
    this.mixedAnalyser = this.processor.compressorAnalyser;

    // Create output analyser (taps final output)
    this.outputAnalyser = new AnalyserNode(this.processor.audioCtx, {
      fftSize: ANALYSER_FFT_SIZE,
      smoothingTimeConstant: ANALYSER_SMOOTHING,
    });

    // Connect analysers in parallel to tap into audio chain (non-invasive)
    this.processor.sourceNode.connect(this.inputAnalyser);
    this.processor.lowBandGain.connect(this.lowBandAnalyser);
    this.processor.compressor.connect(this.midBandAnalyser);
    this.processor.highBandGain.connect(this.highBandAnalyser);
    // mixedAnalyser already connected (it's the processor's compressorAnalyser)
    this.processor.limiterGain.connect(this.outputAnalyser);
  }

  // Calculate RMS (Root Mean Square) for perceived loudness
  calculateRMS(dataArray) {
    let sumSquares = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sumSquares += dataArray[i] * dataArray[i];
    }
    return Math.sqrt(sumSquares / dataArray.length);
  }

  // Convert dB to percentage for bar height
  dbToPercent(db, minDb = -60, maxDb = 0) {
    const percent = ((db - minDb) / (maxDb - minDb)) * 100;
    return Math.max(0, Math.min(100, percent));
  }

  // Main visualization loop - reads analysers and updates UI
  updateMeters() {
    if (!this.inputAnalyser || !this.outputAnalyser || !this.processor.isActive) {
      return;
    }

    // Read all 6 stages
    const inputData = new Float32Array(this.inputAnalyser.fftSize);
    const lowBandData = new Float32Array(this.lowBandAnalyser.fftSize);
    const midBandData = new Float32Array(this.midBandAnalyser.fftSize);
    const highBandData = new Float32Array(this.highBandAnalyser.fftSize);
    const mixedData = new Float32Array(this.mixedAnalyser.fftSize);
    const outputData = new Float32Array(this.outputAnalyser.fftSize);

    this.inputAnalyser.getFloatTimeDomainData(inputData);
    this.lowBandAnalyser.getFloatTimeDomainData(lowBandData);
    this.midBandAnalyser.getFloatTimeDomainData(midBandData);
    this.highBandAnalyser.getFloatTimeDomainData(highBandData);
    this.mixedAnalyser.getFloatTimeDomainData(mixedData);
    this.outputAnalyser.getFloatTimeDomainData(outputData);

    // Calculate RMS for each stage
    const inputRMS = this.calculateRMS(inputData);
    const lowBandRMS = this.calculateRMS(lowBandData);
    const midBandRMS = this.calculateRMS(midBandData);
    const highBandRMS = this.calculateRMS(highBandData);
    const mixedRMS = this.calculateRMS(mixedData);
    const outputRMS = this.calculateRMS(outputData);

    // Convert to dB
    const inputDb = 20 * Math.log10(inputRMS || 1e-5);
    const lowBandDb = 20 * Math.log10(lowBandRMS || 1e-5);
    const midBandDb = 20 * Math.log10(midBandRMS || 1e-5);
    const highBandDb = 20 * Math.log10(highBandRMS || 1e-5);
    const mixedDb = 20 * Math.log10(mixedRMS || 1e-5);
    const outputDb = 20 * Math.log10(outputRMS || 1e-5);

    // Update the hard limiter
    this.processor.updateLimiter();

    // Calculate compression amount on mid band
    // Compare filtered mid-band input to compressed mid-band output
    // Note: This is an approximation since we're comparing input (full spectrum) to mid-band
    const compressionDb = Math.max(0, inputDb - midBandDb);

    // Calculate total reduction (input to output)
    const totalReductionDb = inputDb - outputDb;
    const totalReductionPercent = totalReductionDb > 0
      ? (1 - Math.pow(10, -totalReductionDb / 20)) * 100
      : 0;

    if (this.onMetersUpdate) {
      this.onMetersUpdate({
        inputDb: inputDb,
        inputPercent: this.dbToPercent(inputDb),
        lowBandDb: lowBandDb,
        lowBandPercent: this.dbToPercent(lowBandDb),
        midBandDb: midBandDb,
        midBandPercent: this.dbToPercent(midBandDb),
        highBandDb: highBandDb,
        highBandPercent: this.dbToPercent(highBandDb),
        mixedDb: mixedDb,
        mixedPercent: this.dbToPercent(mixedDb),
        outputDb: outputDb,
        outputPercent: this.dbToPercent(outputDb),
        compressionDb: compressionDb,
        reductionPercent: Math.max(0, totalReductionPercent),
      });
    }

    this.animationId = requestAnimationFrame(() => this.updateMeters());
  }

  // Reconnect analyser taps (needed after processor.disable() which disconnects everything)
  reconnectAnalysers() {
    if (!this.inputAnalyser || !this.processor.isActive) return;

    // Reconnect all analyser taps to the audio chain
    this.processor.sourceNode.connect(this.inputAnalyser);
    this.processor.lowBandGain.connect(this.lowBandAnalyser);
    this.processor.compressor.connect(this.midBandAnalyser);
    this.processor.highBandGain.connect(this.highBandAnalyser);
    // mixedAnalyser is already in the main chain (processor.compressorAnalyser)
    this.processor.limiterGain.connect(this.outputAnalyser);
  }

  // Start visualization loop
  start() {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    this.initialize();
    this.reconnectAnalysers();
    this.updateMeters();
  }

  // Stop visualization loop and reset state
  stop() {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    if (this.onMetersUpdate) {
      this.onMetersUpdate({
        inputDb: -Infinity,
        inputPercent: 0,
        lowBandDb: -Infinity,
        lowBandPercent: 0,
        midBandDb: -Infinity,
        midBandPercent: 0,
        highBandDb: -Infinity,
        highBandPercent: 0,
        mixedDb: -Infinity,
        mixedPercent: 0,
        outputDb: -Infinity,
        outputPercent: 0,
        compressionDb: 0,
        reductionPercent: 0,
      });
    }
  }
}
