# SPDX-License-Identifier: GPL-3.0-or-later
"""Optional Linux acceptance check using installed Anki, Qt and PulseAudio tools.

Run with the Python interpreter that can import the installed anki and aqt:
  /usr/bin/python test/anki-capture-desktop.py --assets /tmp/capture-assets

The assets directory must contain capture.avif and capture.wav from the real
Chrome capture harness. Every run creates a fresh temporary Anki profile,
separate application instance and private null audio sink. It keeps JSON,
rendered image samples and the played PCM under the printed temporary path.
The live Anki profile, add-ons and AnkiConnect endpoint are never opened.
"""

import argparse
import array
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import wave

parser = argparse.ArgumentParser()
parser.add_argument('--assets', type=Path, required=True)
parser.add_argument('--basename', default='capture', help='use full-capture for the full ten-second export')
parser.add_argument('--static', action='store_true', help='require the same scene across two clip durations, allowing small codec rounding')
args = parser.parse_args()
assets = args.assets.resolve()


def source_asset(name):
    return assets / f'{args.basename}{Path(name).suffix}'


for name in ('capture.avif', 'capture.wav'):
    if not source_asset(name).is_file():
        parser.error(f'Missing {source_asset(name)}')
output = Path(tempfile.mkdtemp(prefix='hachidori-anki-desktop-'))
inputs = output / 'inputs'
inputs.mkdir()
for name in ('capture.avif', 'capture.wav'):
    (inputs / name).write_bytes(source_asset(name).read_bytes())
base = output / 'profile-base'
base.mkdir()
profile = 'Capture validation'
with wave.open(str(inputs / 'capture.wav')) as source:
    duration = source.getnframes() / source.getframerate()
    source_samples = array.array('h', source.readframes(source.getnframes()))
sink = 'hachidori_capture_' + output.name.rsplit('-', 1)[1]
module = None
os.environ.update(
    ANKI_SINGLE_INSTANCE_KEY=output.name,
    QT_QPA_PLATFORM='offscreen',
    QTWEBENGINE_CHROMIUM_FLAGS='--disable-gpu --disable-dev-shm-usage',
    ANKI_SOFTWAREOPENGL='1',
    PULSE_SINK=sink,
)
recording = None
result = {
    'output': str(output),
    'assets': {
        name: {
            'source': str(source_asset(name)),
            'bytes': (inputs / name).stat().st_size,
            'sha256': hashlib.sha256((inputs / name).read_bytes()).hexdigest(),
        } for name in ('capture.avif', 'capture.wav')
    },
    'durationSeconds': duration,
    'renderingMode': 'static' if args.static else 'moving',
    'playEvents': [],
    'imageSamples': [],
    'staticFrameDifferences': [],
    'blockedRemoteUrls': [],
    'errors': [],
}
try:
    module = subprocess.check_output([
        'pactl', 'load-module', 'module-null-sink', f'sink_name={sink}', 'rate=48000', 'channels=2',
    ], text=True).strip()
    # PipeWire may restore a muted state even for a new null sink. Set only this
    # test-owned sink; the user's speaker routing and volume remain independent.
    subprocess.run(['pactl', 'set-sink-mute', sink, '0'], check=True)
    subprocess.run(['pactl', 'set-sink-volume', sink, '100%'], check=True)
    (base / 'mpv.conf').write_text(f'ao=pulse\naudio-device=pulse/{sink}\n')
    recording_started = time.monotonic()
    recording = subprocess.Popen([
        'parecord', f'--device={sink}.monitor', '--format=s16le', '--rate=48000',
        '--channels=2', str(output / 'played.wav'),
    ])
    import anki
    import aqt
    from aqt import gui_hooks
    from aqt.profiles import ProfileManager
    from aqt.qt import QTimer, QRect, QImage, QT_VERSION_STR
    from PyQt6.QtWebEngineCore import qWebEngineChromiumVersion
    from aqt.webview import AuthInterceptor
    anki.lang.set_lang('en_US')
    pm = ProfileManager(str(base))
    pm.setupMeta()
    pm.create(profile)
    pm.load(profile)
    pm.profile['autoSync'] = False
    pm.meta.update(defaultLang='en_US', firstRun=False, updates=False, suppressUpdate=True)
    pm.save()
    pm.db.close()
    result.update(anki=anki.version, qt=QT_VERSION_STR, chromium=qWebEngineChromiumVersion())
    app = aqt._run(['anki', '--safemode', '-b', str(base), '-p', profile], exec=False)

    class LocalOnly(AuthInterceptor):
        def interceptRequest(self, info):
            url = info.requestUrl()
            if url.scheme() in ('http', 'https', 'ws', 'wss') and url.host() not in ('127.0.0.1', 'localhost', '::1'):
                result['blockedRemoteUrls'].append(url.toString())
                info.block(True)
            else:
                super().interceptRequest(info)

    web_profile = aqt.mw.web.page().profile()
    local_only = LocalOnly(web_profile)
    web_profile.setUrlRequestInterceptor(local_only)
    started = time.monotonic()
    bounds = None
    hashes = set()
    static_reference = None
    finishing = False

    def play_begin(player, tag):
        subprocess.run(['pactl', 'set-sink-mute', sink, '0'], check=True)
        result['playEvents'].append({
            'event': 'begin', 'at': time.monotonic() - started,
            'player': type(player).__name__, 'filename': tag.filename,
            'audioDevice': player.get_property('audio-device'),
            'volume': player.get_property('volume'),
            'muted': player.get_property('mute'),
        })

    def play_end(player):
        result['playEvents'].append({'event': 'end', 'at': time.monotonic() - started})
        if not finishing and sum(e['event'] == 'end' for e in result['playEvents']) == 1:
            QTimer.singleShot(300, aqt.mw.reviewer.replayAudio)

    gui_hooks.av_player_did_begin_playing.append(play_begin)
    gui_hooks.av_player_did_end_playing.append(play_end)

    def finish():
        global finishing
        if finishing:
            return
        finishing = True
        sample_timer.stop()
        aqt.mw.close()
        QTimer.singleShot(500, app.quit)

    def sample():
        global static_reference
        if bounds is None:
            return
        image = aqt.mw.web.grab().toImage()
        ratio = image.devicePixelRatio()
        crop = image.copy(QRect(*(int(bounds[key] * ratio) for key in ('x', 'y', 'width', 'height'))))
        digest = hashlib.sha256(crop.constBits().asstring(crop.sizeInBytes())).hexdigest()
        if not hashes:
            aqt.mw.grab().save(str(output / 'reviewer.png'))
        result['imageSamples'].append({'at': time.monotonic() - started, 'sha256': digest})
        if args.static and digest not in hashes:
            rgba = crop.convertToFormat(QImage.Format.Format_RGBA8888)
            data = rgba.constBits().asstring(rgba.sizeInBytes())
            rgb = b''.join(data[channel::4] for channel in range(3))
            if static_reference is None:
                static_reference = rgb
            else:
                differences = [abs(a - b) for a, b in zip(static_reference, rgb, strict=True)]
                result['staticFrameDifferences'].append({
                    'maximumChannelDifference': max(differences),
                    'meanAbsoluteChannelDifference': sum(differences) / len(differences),
                    'rootMeanSquareChannelDifference': (
                        sum(value * value for value in differences) / len(differences)
                    ) ** 0.5,
                })
        if digest not in hashes and len(hashes) < 3:
            crop.save(str(output / f'frame-{len(hashes)}.png'))
        hashes.add(digest)

    sample_timer = QTimer()
    sample_timer.timeout.connect(sample)

    def got_image(value):
        global bounds
        result['image'] = value
        if not value or not value['naturalWidth']:
            result['errors'].append('The actual Anki reviewer could not decode the captured AVIF.')
            finish()
            return
        bounds = value
        sample_timer.start(100)
        QTimer.singleShot(int((duration * 2.3 + 1) * 1000), finish)

    def wait_for_question():
        def ready(value):
            if finishing:
                return
            if value and aqt.mw.reviewer.state == 'question':
                answer()
            else:
                QTimer.singleShot(100, wait_for_question)
        aqt.mw.web.evalWithCallback("typeof _showAnswer === 'function'", ready)

    def answer():
        aqt.mw.reviewer._showAnswer()
        QTimer.singleShot(400, lambda: aqt.mw.web.evalWithCallback('''(() => {
          const image=document.getElementById('capture-animation');
          if(!image) return null;
          const r=image.getBoundingClientRect();
          return {naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,
                  x:r.x,y:r.y,width:r.width,height:r.height,src:image.src};
        })()''', got_image))

    def prepare():
        mw = aqt.mw
        if not mw.col:
            QTimer.singleShot(100, prepare)
            return
        try:
            assert str(base) in mw.col.path
            result['collection'] = mw.col.path
            media = Path(mw.col.media.dir())
            for name in ('capture.avif', 'capture.wav'):
                shutil.copy2(inputs / name, media / name)
            model = mw.col.models.new('Capture validation')
            for name in ('Expression', 'Animation', 'Audio'):
                mw.col.models.add_field(model, mw.col.models.new_field(name))
            template = mw.col.models.new_template('Captured context')
            template.update(qfmt='{{Expression}}', afmt='{{FrontSide}}<hr>{{Animation}}{{Audio}}')
            mw.col.models.add_template(model, template)
            model['css'] = (
                '.card { background: white; color: black; text-align: center; } '
                'img { width: 640px; max-width: 100%; }'
            )
            mw.col.models.add(model)
            note = mw.col.new_note(model)
            note['Expression'] = '猫 — isolated capture validation'
            note['Animation'] = '<img id="capture-animation" src="capture.avif">'
            note['Audio'] = '[sound:capture.wav]'
            mw.col.add_note(note, 1)
            mw.col.decks.select(1)
            mw.moveToState('review')
            QTimer.singleShot(100, wait_for_question)
        except Exception as error:
            result['errors'].append(repr(error))
            finish()

    QTimer.singleShot(1200, prepare)
    QTimer.singleShot(int((duration * 3 + 20) * 1000), finish)
    app.exec()
except Exception as error:
    result['errors'].append(repr(error))
finally:
    if recording is not None:
        try:
            recording.terminate()
            try:
                recording.wait(timeout=5)
            except subprocess.TimeoutExpired:
                recording.kill()
                recording.wait(timeout=5)
        except Exception as error:
            result['errors'].append(f'Audio monitor cleanup: {error!r}')
    if module is not None:
        try:
            subprocess.run(['pactl', 'unload-module', module], check=True)
        except Exception as error:
            result['errors'].append(f'Private sink cleanup: {error!r}')
    pcm = array.array('h')
    try:
        with wave.open(str(output / 'played.wav')) as played:
            pcm = array.array('h', played.readframes((output / 'played.wav').stat().st_size // 2))
    except Exception as error:
        result['errors'].append(f'Audio monitor recording: {error!r}')
    result['audioPeak'] = max((abs(x) for x in pcm), default=0)
    result['sourceAudioPeak'] = max((abs(x) for x in source_samples), default=0)
    result['playbackPeaks'] = []
    result['playbackDurationsSeconds'] = []
    for index, event in enumerate(result['playEvents']):
        if event['event'] != 'begin' or index + 1 >= len(result['playEvents']):
            continue
        end = result['playEvents'][index + 1]
        if end['event'] != 'end':
            continue
        result['playbackDurationsSeconds'].append(end['at'] - event['at'])
        begin_frame = max(0, int((started - recording_started + event['at']) * 48000))
        end_frame = int((started - recording_started + end['at'] + 0.2) * 48000)
        result['playbackPeaks'].append(max((abs(x) for x in pcm[begin_frame * 2:end_frame * 2]), default=0))
    result['distinctRenderedFrames'] = len({x['sha256'] for x in result['imageSamples']})
    seen = {}
    loops = []
    for sample in result['imageSamples']:
        previous = seen.get(sample['sha256'])
        if previous is not None and sample['at'] - previous >= duration * 0.8:
            loops.append(sample['at'] - previous)
        seen.setdefault(sample['sha256'], sample['at'])
    late_hashes = set()
    early_hashes = set()
    if result['imageSamples']:
        first_at = result['imageSamples'][0]['at']
        for sample in result['imageSamples']:
            if sample['at'] > first_at + duration * 1.1:
                late_hashes.add(sample['sha256'])
            elif sample['at'] < first_at + duration:
                early_hashes.add(sample['sha256'])
    result['repeatedFramesInSecondLoop'] = len(early_hashes & late_hashes)
    result['loopRecurrences'] = len(loops)
    result['loopIntervalSeconds'] = min(loops) if loops else None
    result['imageSampleSpanSeconds'] = (
        result['imageSamples'][-1]['at'] - result['imageSamples'][0]['at']
        if result['imageSamples'] else 0
    )
    image_matches = (
        result['distinctRenderedFrames'] > 1 and bool(loops)
        and result['repeatedFramesInSecondLoop'] > 1
    )
    if args.static:
        # Lossy encoding can reconstruct repeated input pixels slightly
        # differently. Compare rendered RGB values, keeping motion checks
        # unchanged in the default mode. Static pixels cannot prove a loop.
        result['repeatedFramesInSecondLoop'] = None
        result['loopRecurrences'] = None
        result['loopIntervalSeconds'] = None
        result['staticPixelTolerance'] = {
            'rootMeanSquareChannelDifference': 1,
        }
        image_matches = (
            result['distinctRenderedFrames'] >= 1
            and result['imageSampleSpanSeconds'] >= duration * 2
            and all(delta['rootMeanSquareChannelDifference'] <= 1
                    for delta in result['staticFrameDifferences'])
        )
    audio_matches = len(result['playbackPeaks']) == 2 and all(
        (peak > 0) == (result['sourceAudioPeak'] > 0) for peak in result['playbackPeaks']
    ) and all(abs(played - duration) <= 0.5 for played in result['playbackDurationsSeconds'])
    result['audioCheck'] = 'playback did not match source zero/nonzero PCM and duration'
    if audio_matches:
        result['audioCheck'] = 'nonzero PCM replayed' if result['sourceAudioPeak'] > 0 else 'silence preserved'
    result['success'] = (
        not result['errors'] and image_matches
        and sum(e['event'] == 'begin' for e in result['playEvents']) == 2
        and sum(e['event'] == 'end' for e in result['playEvents']) >= 2
        and audio_matches
    )
    (output / 'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items() if k != 'imageSamples'}, indent=2), flush=True)
raise SystemExit(0 if result['success'] else 1)
