"""Measure reference stems and execute bounded, model-selected score phrasing.

Acoustic measurements are estimates, not emotion recognition. No source vocal
samples enter the generated output. Score timing stays inside each phrase.
"""
import copy
import json
from pathlib import Path
import numpy as np
from scipy.ndimage import uniform_filter1d
from scipy.signal import find_peaks, resample_poly
from math import gcd

VERSION = 'score-performance-v1'


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


def arrange_score(metadata, plan, seconds):
    """Change rest/note allocation before SoulX inference, retaining total times."""
    validate_plan(plan, seconds)
    result = copy.deepcopy(metadata)
    changes, applied = 0, []
    for segment in result:
        phones = segment['phoneme'].split()
        durations = np.array([float(x) for x in segment['duration'].split()])
        pitches = [int(x) for x in segment['note_pitch'].split()]
        types = segment['note_type'].split()
        if not len(phones) == len(durations) == len(pitches) == len(types) or np.any(durations <= 0) or not np.isfinite(durations).all():
            raise ValueError('Invalid source score alignment')
        before = durations.copy()
        starts = np.r_[0, np.cumsum(durations)[:-1]] + float(segment['time'][0])/1000
        centers = starts+durations/2
        for index, phrase in enumerate(plan['phrases']):
            ids = np.flatnonzero((centers >= phrase['start']) & (centers < phrase['end']))
            if not len(ids):
                continue
            rests = [int(i) for i in ids if phones[i] in ['<SP>', '<AP>']]
            voiced = [int(i) for i in ids if phones[i] not in ['<SP>', '<AP>']]
            if not voiced:
                continue
            # Borrow only a few milliseconds from adjacent notes. Every transfer
            # preserves the note-group duration and hence the accompaniment grid.
            for rest in rests:
                near = min(voiced, key=lambda i: abs(i-rest))
                factor = {'clear': 1.12, 'flowing': .8, 'relaxed': 1.08}[phrase['articulation']]
                delta = np.clip(durations[rest]*(factor-1), -.035, .035)
                delta = np.clip(delta, -max(0, durations[rest]-.025), max(0, durations[near]-.06))
                durations[rest] += delta
                durations[near] -= delta
            leading = next((i for i in rests if i < voiced[0]), None)
            trailing = next((i for i in reversed(rests) if i > voiced[-1]), None)
            shift = 0.
            if leading is not None and trailing is not None:
                shift = float(np.clip(phrase['timingMs']/1000, -max(0, durations[leading]-.025), max(0, durations[trailing]-.025)))
                durations[leading] += shift
                durations[trailing] -= shift
            tail = 0.
            if trailing is not None and phrase['tail'] != 'natural':
                last = voiced[-1]
                tail = min(.1, durations[last]*.12, max(0, durations[trailing]-.025)) if phrase['tail'] == 'hold' else -min(.08, durations[last]*.1, max(0, durations[last]-.06))
                durations[last] += tail
                durations[trailing] -= tail
            applied.append({'segment': segment.get('index'), 'phrase': index+1,
                            'onset_shift_ms': round(shift*1000, 2), 'tail_change_ms': round(tail*1000, 2)})
        if abs(float(durations.sum()-before.sum())) > 1e-6 or np.any(durations <= 0):
            raise ValueError('Score edit broke phrase alignment')
        changes += int(np.count_nonzero(np.abs(durations-before) > 1e-6))
        segment['duration'] = ' '.join(f'{x:.6f}' for x in durations)
        segment['f0'] = ''  # Score inference must not copy the source F0 contour.
        segment['note_pitch'] = ' '.join('0' if ph in ['<SP>', '<AP>'] else str(pitch) for ph, pitch in zip(phones, pitches))
    return result, {'control': 'score', 'source_f0_used': False, 'edited_note_durations': changes,
                    'phrase_edits': applied, 'timing_preserved': True}


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
    validate_plan(plan, seconds if seconds is not None else len(samples)/rate)
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
                   '可执行控制是谱面时值、休止、句尾与力度；不支持文字直接控制嘶吼、哭腔或特定唱腔。']}
