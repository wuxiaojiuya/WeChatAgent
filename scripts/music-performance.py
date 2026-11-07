"""Measure stems and execute bounded dynamics for source-vocal RVC covers.

Legacy plan validation is retained for historical task receipts.
"""
import copy
import json
from pathlib import Path
import numpy as np
from scipy.ndimage import uniform_filter1d
from scipy.signal import find_peaks, resample_poly
from math import gcd

VERSION = 'score-performance-v1'
ARRANGEMENT_VERSION = 'source-vocal-arrangement-v1'


def validate_arrangement(plan, seconds):
    if not isinstance(plan, dict) or set(plan) != {'version', 'emotion', 'intention', 'pitchShift', 'accompanimentGainDb', 'phrases'}:
        raise ValueError('Invalid source-vocal arrangement')
    if plan['version'] != ARRANGEMENT_VERSION or type(plan['pitchShift']) is not int or abs(plan['pitchShift']) > 3:
        raise ValueError('Invalid arrangement pitch')
    gain = plan['accompanimentGainDb']
    if not isinstance(gain, (float, int)) or isinstance(gain, bool) or not np.isfinite(gain) or not -6 <= gain <= 3:
        raise ValueError('Invalid accompaniment gain')
    if not isinstance(plan['phrases'], list) or any(not isinstance(p, dict) or set(p) != {'start', 'end', 'gainDb', 'contour'} for p in plan['phrases']):
        raise ValueError('Invalid source-vocal phrases')
    validate_plan({'version': VERSION, 'emotion': plan['emotion'], 'intention': plan['intention'],
                   'phrases': [{**p, 'articulation': 'flowing', 'timingMs': 0, 'tail': 'natural'} for p in plan['phrases']]}, seconds)
    return copy.deepcopy(plan)


def validate_plan(plan, seconds):
    if not isinstance(plan, dict) or set(plan) != {'version', 'emotion', 'intention', 'phrases'}:
        raise ValueError('Invalid performance plan')
    if plan['version'] != VERSION or plan['emotion'] not in ['warm', 'joyful', 'sad', 'bold', 'tender', 'restrained']:
        raise ValueError('Invalid performance version or emotion')
    if not isinstance(plan['intention'], str) or not plan['intention'].strip() or len(plan['intention']) > 240 or any(c in plan['intention'] for c in '\0\r\n'):
        raise ValueError('Invalid performance intention')
    if not isinstance(plan['phrases'], list) or not 1 <= len(plan['phrases']) <= 16:
        raise ValueError('Invalid performance phrases')
    end = 0
    def number(value):
        return isinstance(value, (float, int)) and not isinstance(value, bool) and np.isfinite(value)
    for phrase in plan['phrases']:
        if not isinstance(phrase, dict) or set(phrase) != {'start', 'end', 'articulation', 'timingMs', 'tail', 'gainDb', 'contour'}:
            raise ValueError('Invalid performance phrase')
        if not all(number(phrase[k]) for k in ['start', 'end', 'gainDb', 'timingMs']):
            raise ValueError('Non-finite performance control')
        if phrase['start'] < end or phrase['end'] > seconds+.005 or phrase['end']-phrase['start'] < .15:
            raise ValueError('Performance phrase timing is invalid')
        if phrase['articulation'] not in ['clear', 'flowing', 'relaxed'] or phrase['tail'] not in ['natural', 'hold', 'short'] or phrase['contour'] not in ['even', 'build', 'relax'] or abs(phrase['gainDb']) > 3 or abs(phrase['timingMs']) > 40:
            raise ValueError('Performance control outside supported range')
        end = phrase['end']
    return copy.deepcopy(plan)


def apply_dynamics(audio, rate, plan, seconds=None):
    """Apply model-selected phrase dynamics after RVC, before accompaniment mix."""
    samples = np.asarray(audio, dtype=np.float64)
    padding = 0
    if seconds is not None:
        expected = round(seconds*rate)
        if abs(len(samples)-expected) > round(rate*.1):
            raise ValueError('Converted vocal duration mismatch')
        padding = max(0, expected-len(samples))
        samples = samples[:expected]
        if padding:
            samples = np.pad(samples, ((0,padding),(0,0)) if samples.ndim == 2 else (0,padding))
    validator = validate_arrangement if plan.get('version') == ARRANGEMENT_VERSION else validate_plan
    validator(plan, seconds if seconds is not None else len(samples)/rate)
    db = np.zeros(len(samples))
    for phrase in plan['phrases']:
        start, end = round(phrase['start']*rate), min(len(samples), round(phrase['end']*rate))
        if end <= start:
            continue
        contour = {'even': (0., 0.), 'build': (-.8, .8), 'relax': (.8, -.8)}[phrase['contour']]
        db[start:end] = np.clip(phrase['gainDb']+np.linspace(*contour, end-start), -4, 4)
    db = uniform_filter1d(db, size=max(1, round(rate*.04)), mode='nearest')
    gain = 10**(db/20)
    output = samples * (gain[:, None] if samples.ndim == 2 else gain)
    if not np.isfinite(output).all():
        raise ValueError('Invalid arranged vocal')
    return output.astype(np.float32), {'applied': True, 'min_db': round(float(db.min()), 3), 'max_db': round(float(db.max()), 3), 'tail_padding_samples': padding}


def analyze_stems(vocal, accompaniment, rate):
    """Fast CPU descriptors for the chat model; all time ranges are clip-relative."""
    vocal = np.asarray(vocal, dtype=np.float64)
    accompaniment = np.asarray(accompaniment, dtype=np.float64)
    if vocal.ndim == 2: vocal = vocal.mean(axis=1)
    if accompaniment.ndim == 2: accompaniment = accompaniment.mean(axis=1)
    if not len(vocal) or not np.isfinite(vocal).all() or np.sqrt(np.mean(vocal**2)) < 1e-7:
        raise ValueError('No usable singing vocal in reference')
    divisor = gcd(rate, 8000)
    v = resample_poly(vocal, 8000//divisor, rate//divisor)
    a = resample_poly(accompaniment, 8000//divisor, rate//divisor)
    hop, frame = 160, 640
    v = np.pad(v, (0, max(0, frame-len(v))))
    frames = np.lib.stride_tricks.sliding_window_view(v, frame)[::hop].copy()
    rms = np.sqrt(np.mean(frames**2, axis=1))
    fft = np.fft.rfft(frames*np.hanning(frame), 2048, axis=1)
    ac = np.fft.irfft(fft*fft.conj(), axis=1)[:, :frame]
    lo, hi = round(8000/700), round(8000/70)
    lag = ac[:, lo:hi].argmax(axis=1)+lo
    clarity = ac[np.arange(len(ac)), lag]/np.maximum(ac[:, 0], 1e-12)
    active = rms > max(.0005, float(np.quantile(rms, .9))*.12)
    voiced = active & (clarity > .55)
    pitch = np.where(voiced, 8000/lag, np.nan)
    # Energy gaps, rather than lyric boundaries, define reference phrases.
    mask = active.copy()
    for i in range(1, len(mask)):
        if mask[i-1] and not mask[i]:
            later = np.flatnonzero(mask[i:i+13])
            if len(later): mask[i:i+later[0]] = True
    edges = np.diff(np.r_[False, mask, False].astype(int))
    ranges = []
    for start, end in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
        if (end-start)*.02 < .35: continue
        while end-start > 350:
            ranges.append((start, start+350)); start += 350
        if end > start: ranges.append((start, end))
    def quant(values, qs):
        values = values[np.isfinite(values)]
        return [round(float(x), 2) for x in np.quantile(values, qs)] if len(values) else None
    phrases = []
    for start, end in ranges[:16]:
        energy = rms[start:end]
        peaks, _ = find_peaks(energy, prominence=max(.0001, float(energy.max())*.1), distance=4)
        phrases.append({'start': round(start*.02, 3), 'end': round(min(len(vocal)/rate, end*.02+.08), 3),
            'pitch_hz_p10_p50_p90': quant(pitch[start:end], [.1, .5, .9]),
            'level_dbfs': round(float(20*np.log10(max(1e-12, np.sqrt(np.mean(energy**2))))), 2),
            'attack_events_per_second': round(len(peaks)/max(.02, (end-start)*.02), 2),
            'voiced_fraction': round(float(voiced[start:end].mean()), 3)})
    # Autocorrelation over accompaniment energy differences gives a pulse
    # estimate. Half/double tempo ambiguity is retained in the confidence flag.
    a = np.pad(a, (0, max(0, frame-len(a))))
    af = np.lib.stride_tricks.sliding_window_view(a, frame)[::hop]
    onset = np.maximum(0, np.diff(np.sqrt(np.mean(af**2, axis=1)), prepend=0))
    pulse = np.correlate(onset, onset, 'full')[len(onset)-1:]
    low, high = 17, min(len(pulse), 67)
    tempo, strength = None, 0.
    if high > low and pulse[0] > 1e-10:
        best = int(pulse[low:high].argmax())+low
        tempo = round(60/(best*.02), 1)
        strength = round(float(pulse[best]/pulse[0]), 3)
    # Prevent analysis windows from overlapping at the small frame extension.
    for index in range(len(phrases)-1):
        phrases[index]['end'] = min(phrases[index]['end'], phrases[index+1]['start'])
    return {'schema': 'singing-reference-v1', 'seconds': round(len(vocal)/rate, 4),
        'tempo_bpm_estimate': tempo, 'pulse_strength': strength,
        'pitch_hz_p10_p50_p90': quant(pitch, [.1, .5, .9]), 'phrases': phrases,
        'evidence': 'measured-separated-vocal-and-accompaniment',
        'limits': ['节拍可能有半速/倍速误差；音高是自相关估计。',
                   '分句按能量划分，不等于准确歌词边界。',
                   '声学测量不能确定喜怒哀乐或准确识别气声、真假声和转音；结合画面、转写与用户要求判断。',
                   '沿用原曲旋律、节奏与咬字；可执行控制是升降调、分句力度和伴奏比例，不重新生成演唱。']}
