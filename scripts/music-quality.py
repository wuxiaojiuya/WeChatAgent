"""Conservative vocal conditioning; no pitch, formant or timing changes."""
import numpy as np
from scipy.ndimage import maximum_filter1d, uniform_filter1d
from scipy.signal import butter, resample_poly, sosfiltfilt
from math import gcd


def audio_stats(audio):
    audio = np.asarray(audio, dtype=np.float64)
    if not audio.size or not np.isfinite(audio).all():
        raise ValueError("Audio must be nonempty and finite")
    peak = float(np.max(np.abs(audio)))
    return dict(peak=peak, peak_dbfs=float(20 * np.log10(max(peak, 1e-12))),
                rms=float(np.sqrt(np.mean(audio ** 2))),
                clipped_samples=int(np.count_nonzero(np.abs(audio) >= 0.999)))


def mono(audio):
    audio = np.asarray(audio, dtype=np.float64)
    return audio.mean(axis=1) if audio.ndim == 2 else audio


def envelope(audio, rate, milliseconds=40):
    samples = mono(audio)
    return np.sqrt(np.maximum(0, uniform_filter1d(samples ** 2,
                   size=max(1, int(rate * milliseconds / 1000)), mode="nearest")))


def prepare_vocals(audio, rate):
    """Remove sub-bass bleed before the mono 16 kHz RVC frontend."""
    samples = mono(audio)
    audio_stats(samples)
    filtered = sosfiltfilt(butter(2, [65, min(7800, rate * 0.45)],
                                btype="bandpass", fs=rate, output="sos"), samples)
    peak = np.max(np.abs(filtered))
    if peak > 0.9:
        filtered *= 0.9 / peak
    return filtered.astype(np.float32)


def finish_vocals(converted, rate, reference, reference_rate):
    """Suppress hallucinated vocals only where the source stem is nearly silent.

    The reference envelope has a 120 ms hold and smooth ramps, so consonants,
    breath and sustained note tails are not cut by a hard noise gate.
    """
    samples = mono(converted)
    before = audio_stats(samples)
    reference = mono(reference)
    if rate != reference_rate:
        divisor = gcd(rate, reference_rate)
        reference = resample_poly(reference, rate // divisor, reference_rate // divisor)
    reference = np.pad(reference[:len(samples)], (0, max(0, len(samples) - len(reference))))
    source_envelope = envelope(reference, rate)
    active_level = float(np.quantile(source_envelope, 0.95))
    threshold = max(0.00025, active_level * 0.012)
    held = maximum_filter1d(source_envelope, size=max(1, int(rate * 0.12)), mode="nearest")
    control = np.clip((held - threshold * 0.25) / (threshold * 0.75), 0, 1)
    control = control * control * (3 - 2 * control)
    control = uniform_filter1d(control, size=max(1, int(rate * 0.03)), mode="nearest")
    # Attenuation only: never raise a quiet conversion or inject original vocals.
    samples = sosfiltfilt(butter(2, [60, min(14000, rate * 0.45)],
                                btype="bandpass", fs=rate, output="sos"), samples) * control
    quiet = source_envelope < threshold * 0.25
    def quiet_rms(value):
        return float(np.sqrt(np.mean(value[quiet] ** 2))) if quiet.any() else None
    report = dict(before=before, after=audio_stats(samples), threshold=threshold,
                  quiet_seconds=float(quiet.sum() / rate),
                  quiet_rms_before=quiet_rms(mono(converted)), quiet_rms_after=quiet_rms(samples),
                  original_vocal_blended=False)
    return samples.astype(np.float32), report
