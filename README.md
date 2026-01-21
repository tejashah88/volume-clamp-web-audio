# Volume Clamping Web Audio API example

This is a demo to showcase volume clamping, ensuring the output volume does not exceed a set decibel limit, by using a custom AudioWorklet. The original purpose was to implement an absolute volume clamper for proximity chat (via the BetterCrewLink app) in Among Us lobbies, notably to save your ears from loud voices from afar.

Check out the demo here: https://tejashah88.github.io/volume-clamp-web-audio/

![Example View of Demo](docs/example.png)

Credits go to Claude Sonnet 4.5 for helping with the Web Audio API implementation and AudioWorklet architecture.

## Running the Example Locally

```bash
# NOTE: Minimum of Python v3.10.12 needed
python3 -m http.server
```

Then navigate to http://localhost:8000 in your browser.

## How It Works

This is effectively a stripped-down reimplementation of the `DynamicsCompressor` with no makeup gain (see [this issue](https://github.com/WebAudio/web-audio-api/issues/2639) for more context). The base idea is that the application looks slightly ahead of the audio stream to calculate the RMS of the signal, which represents the absolute measure of volume. If the threshold gain is exceeded by the measured volume gain, a target gain is set. The reason the measured gain is not immediately set is to prevent distortion effects, and the concept of an attack and release envelope is used to adjust the measured gain towards the target gain in an exponential manner.
