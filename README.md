# Voice Volume Normalization Example

This is a demo to simulate the volume normalization process to protect against mic spammers. It applies the dynamics compressor with aggressive parameters and a hard limit gain to ensure the volume does not exceed a decibel threshold. This also has the side effect of adding makeup gain, which can (sometimes) boost quiet voices. See the [Web Audio API specification](https://webaudio.github.io/web-audio-api/#DynamicsCompressorOptions-processing) on the processing specifics for more details.

Credits go to Claude Sonnet 4.5 for helping with the Web Audio API explanations and starting implementation.

## Running the example

```bash
# NOTE: Minimum of Python v3.10.12 needed
python3 -m http.server
```

Then navigate to http://localhost:8000 in your browser.

## How It Works

### Multi-Band Processing Architecture

The system uses **frequency-aware multi-band processing** to normalize voice volume while minimizing noise amplification. The audio signal is split into three frequency bands, each processed differently:

```
                    ┌─→ Low Band (< 300Hz) ─→ BYPASS ────┐
Source (microphone) ├─→ Mid Band (300-3000Hz) ─→ COMPRESS ─┼─→ Mixer ─→ Analyser ─→ Hard Limiter ─→ Output
                    └─→ High Band (> 3000Hz) ─→ BYPASS ────┘
```

#### Frequency Band Split

1. **Low Band (< 300Hz)**: Rumble, low-frequency noise, and the fundamental frequencies of very deep voices
   - **Processing**: Bypasses compression entirely (passes through unmodified)
   - **Rationale**: Low-frequency noise (hum, rumble) doesn't need volume normalization and would be amplified by makeup gain

2. **Mid Band (300-3000Hz)**: Primary voice frequencies where most speech energy resides
   - **Processing**: Full aggressive compression (the main voice normalization happens here)
   - **Rationale**: This is where we want to normalize volume differences between users
   - **Contents**: Vowel formants, most consonants, and the bulk of intelligible speech

3. **High Band (> 3000Hz)**: Sibilants (s, sh, z), fricatives (f, th), and high-frequency noise
   - **Processing**: Bypasses compression entirely (passes through unmodified)
   - **Rationale**: High-frequency noise (hiss, static) would be amplified by makeup gain if compressed

#### Stage 1: Multi-Band Compression

**Mid Band Compressor Parameters** (only applied to 300-3000Hz):
   - **Threshold**: -20 dB (default, adjustable via UI) - The volume ceiling. Any audio above this level will be compressed.
   - **Knee**: 0 dB - Hard knee for brick-wall limiting. Creates a sharp transition at the threshold rather than a gradual one.
   - **Ratio**: 20:1 - Very high ratio for aggressive limiting. For every 20 dB over the threshold, only 1 dB comes through.
   - **Attack**: 3ms (0.003s) - Fast but not instant attack time to prevent audible clicks while quickly catching loud transients.
   - **Release**: 100ms (0.1s) - Smooth release time for natural-sounding decay that maintains speech rhythm.

**Automatic Makeup Gain (Mid Band Only):**
Per the Web Audio API specification, the compressor includes automatic makeup gain - "a fixed gain stage that only depends on ratio, knee and threshold parameter of the compressor, and not on the input signal." The makeup gain is calculated as: `(1 / full_range_gain)^0.6`, where `full_range_gain` is the result of applying the compression curve to the value 1.0.

**Critical Insight**: Because only the mid band (300-3000Hz) is compressed, the makeup gain ONLY amplifies voice frequencies, not the full-spectrum noise. Low and high frequency noise remain at their original (quiet) levels.

#### Stage 2: Band Mixing and Analysis

After processing, the three bands are automatically mixed back together by the Web Audio API:
- Low band: uncompressed (original level)
- Mid band: compressed with makeup gain (normalized level)
- High band: uncompressed (original level)

**Critical Design Point**: The AnalyserNode measures the **combined output of all three bands** after mixing, not just the compressed mid band. This ensures the hard limiter (Stage 3) can respond to the true signal level, including any loud low-frequency rumble or high-frequency noise that bypassed compression.

The result is natural-sounding voice with normalized volume, but without amplified background noise.

#### Stage 3: Hard Limiter Gain

Ensures the volume never exceeds the given threshold by continuously monitoring the **combined output** of all three bands and applying additional gain reduction if needed. This acts as a safety net even when loud signals are present in the low or high bands.

**Why This Matters**: If a user has loud low-frequency rumble (e.g., -10dB) passing through the low band uncompressed, but the mid band (voice) is compressed to -20dB, the combined signal could still exceed the threshold. The analyser measuring the mixed output ensures the limiter catches this and reduces gain appropriately.

   **AnalyserNode Configuration:**
   - **FFT Size**: 2048 samples - The window size to analyze the audio samples.
   - **Smoothing**: 0.3 - Applied smoothing that averages current measurement with previous values to reduce jitter. Range is from 0.0 to 1.0.

   **Computation Steps (runs every animation frame):**
   1. **Sample Capture**: Retrieves time-domain samples from the compressor output
   2. **RMS Calculation**: Computes Root Mean Square for perceived loudness: `RMS = sqrt(Σ(sample²) / sample_count)`
   3. **dB Conversion**: Converts RMS to decibels: `dB = 20 × log₁₀(RMS)` (or -100 dB if RMS ≈ 0)
   4. **Threshold Check**: If `dB > threshold`:
      - Calculate required gain reduction: `gain_dB = threshold - current_dB`
      - Convert to linear gain: `gain = 10^(gain_dB / 20)`
      - Apply to limiter gain node (reduces volume)
   5. **Pass-through**: If `dB ≤ threshold`, set gain to 1.0 (unity gain, no change)
