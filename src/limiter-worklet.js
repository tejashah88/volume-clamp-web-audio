// Default constants
const DEFAULT_THRESHOLD = -20;           // dB threshold
const DEFAULT_ATTACK_TIME = 0.015;       // seconds (15ms) - smooth gain reduction
const DEFAULT_RELEASE_TIME = 0.08;       // seconds (80ms) - balanced recovery speed
const DEFAULT_RMS_WINDOW = 0.005;        // seconds (5ms) - fast level detection
const DEFAULT_LOOKAHEAD_TIME = 0.010;    // seconds (10ms) - anticipatory limiting
const DEFAULT_INITIAL_GAIN = 1.0;        // Unity gain at start
const MAX_CHANNELS = 2;                  // Stereo support
const MIN_DB_VALUE = -100;               // Minimum dB for logarithmic calculations

/**
 * Key Features:
 * - Attack/release envelope prevents gain jitter
 * - No gain boost (unity gain when below threshold)
 * - Runs at audio rate (48kHz)
 */
class LimiterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Limiter parameters
    this.threshold = DEFAULT_THRESHOLD;
    this.currentGain = DEFAULT_INITIAL_GAIN;

    // Attack/Release time constants
    this.attackTime = DEFAULT_ATTACK_TIME;
    this.releaseTime = DEFAULT_RELEASE_TIME;

    // Calculate smoothing coefficients (exponential moving average)
    // Coefficient = 1 - e^(-1 / (time * sampleRate))
    this.attackCoeff = 1 - Math.exp(-1 / (this.attackTime * sampleRate));
    this.releaseCoeff = 1 - Math.exp(-1 / (this.releaseTime * sampleRate));

    // RMS calculation with sliding window
    this.rmsWindowSize = Math.floor(sampleRate * DEFAULT_RMS_WINDOW);
    this.rmsBuffer = new Float32Array(this.rmsWindowSize);
    this.rmsBufferIndex = 0;
    this.rmsSum = 0;

    // Lookahead buffer for anticipatory limiting
    // Analyzes future audio before output to eliminate lag-based pumping
    this.lookaheadTime = DEFAULT_LOOKAHEAD_TIME;
    this.lookaheadSize = Math.floor(sampleRate * this.lookaheadTime);

    // Support up to 2 channels (stereo)
    this.maxChannels = MAX_CHANNELS;
    this.lookaheadBuffers = [];
    this.lookaheadIndices = [];
    this.lookaheadFilled = [];

    for (let ch = 0; ch < this.maxChannels; ch++) {
      this.lookaheadBuffers[ch] = new Float32Array(this.lookaheadSize);
      this.lookaheadIndices[ch] = 0;
      this.lookaheadFilled[ch] = 0;
    }

    // Listen for parameter updates from main thread
    this.port.onmessage = (event) => {
      if (event.data.type === 'updateParameters') {
        if (event.data.threshold !== undefined) {
          this.threshold = event.data.threshold;
        }
        if (event.data.attackTime !== undefined) {
          this.attackTime = event.data.attackTime;
          this.attackCoeff = 1 - Math.exp(-1 / (this.attackTime * sampleRate));
        }
        if (event.data.releaseTime !== undefined) {
          this.releaseTime = event.data.releaseTime;
          this.releaseCoeff = 1 - Math.exp(-1 / (this.releaseTime * sampleRate));
        }
        if (event.data.rmsWindow !== undefined) {
          // Update RMS window size and reset buffer
          const newWindowSize = Math.floor(sampleRate * event.data.rmsWindow);
          if (newWindowSize !== this.rmsWindowSize) {
            this.rmsWindowSize = newWindowSize;
            this.rmsBuffer = new Float32Array(this.rmsWindowSize);
            this.rmsBufferIndex = 0;
            this.rmsSum = 0;
          }
        }
      }
    };
  }

  /**
   * Calculate RMS (Root Mean Square) using a sliding window
   * Provides perceived loudness measurement more accurate than peak detection
   */
  calculateRMS(sample) {
    // Remove oldest sample from sum
    this.rmsSum -= this.rmsBuffer[this.rmsBufferIndex] * this.rmsBuffer[this.rmsBufferIndex];

    // Add new sample to buffer and sum
    this.rmsBuffer[this.rmsBufferIndex] = sample;
    this.rmsSum += sample * sample;

    // Move to next buffer position (circular buffer)
    this.rmsBufferIndex = (this.rmsBufferIndex + 1) % this.rmsWindowSize;

    // Calculate RMS
    return Math.sqrt(this.rmsSum / this.rmsWindowSize);
  }

  /**
   * Main processing function - called for each 128-sample block
   */
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0) {
      return true;
    }

    // Process each channel (mono or stereo)
    for (let channel = 0; channel < input.length; channel++) {
      const inputChannel = input[channel];
      const outputChannel = output[channel];

      const lookaheadBuffer = this.lookaheadBuffers[channel];
      let lookaheadIndex = this.lookaheadIndices[channel];
      let filled = this.lookaheadFilled[channel];

      // Process each sample in the block (128 samples)
      for (let i = 0; i < inputChannel.length; i++) {
        const sample = inputChannel[i];

        // STEP 1: Write incoming sample to lookahead buffer
        lookaheadBuffer[lookaheadIndex] = sample;

        // STEP 2: Analyze current sample (the "future" audio)
        const rms = this.calculateRMS(sample);
        const db = rms > 0 ? 20 * Math.log10(rms) : MIN_DB_VALUE;

        // Calculate target gain based on threshold
        let targetGain;
        if (db > this.threshold) {
          const gainDb = this.threshold - db;
          targetGain = Math.pow(10, gainDb / 20);
        } else {
          targetGain = DEFAULT_INITIAL_GAIN; // Unity gain when below threshold
        }

        // STEP 3: Smooth gain changes with attack/release envelope
        // This prevents rapid gain jitter while lookahead prevents lag-based pumping
        if (targetGain < this.currentGain) {
          // Attack: fast gain reduction
          this.currentGain += (targetGain - this.currentGain) * this.attackCoeff;
        } else {
          // Release: slow gain restoration
          this.currentGain += (targetGain - this.currentGain) * this.releaseCoeff;
        }

        // STEP 4: Determine output sample
        let outputSample;
        if (filled < this.lookaheadSize) {
          // Buffer still filling - output current sample with gain (no delay yet)
          outputSample = sample * this.currentGain;
          filled++;
        } else {
          // Buffer full - read oldest sample (lookahead delay is active)
          // Apply gain calculated from "future" audio to delayed sample
          const readIndex = (lookaheadIndex + 1) % this.lookaheadSize;
          outputSample = lookaheadBuffer[readIndex] * this.currentGain;
        }

        outputChannel[i] = outputSample;

        // STEP 5: Advance circular buffer index
        lookaheadIndex = (lookaheadIndex + 1) % this.lookaheadSize;
      }

      // Save channel state back
      this.lookaheadIndices[channel] = lookaheadIndex;
      this.lookaheadFilled[channel] = filled;
    }

    return true;
  }
}

registerProcessor('limiter-processor', LimiterProcessor);
