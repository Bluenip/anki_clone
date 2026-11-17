"""Kokoro text-to-speech as a small HTTP service for the backend.

POST /speak {"text": "...", "voice": "af_heart", "speed": 1.0} -> audio/wav (24 kHz, 16-bit mono)
GET  /health -> {"device": "cuda", "voice": "af_heart"}

Uses hexgrad/kokoro (Kokoro-82M). Runs on the GPU when one is visible, else on the CPU.
The model and the default voice are downloaded at image build time, so the
container works offline.
"""
import io
import os
import threading
import wave

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from kokoro import KModel, KPipeline
from pydantic import BaseModel, Field

RATE = 24000
REPO = 'hexgrad/Kokoro-82M'
DEFAULT_VOICE = os.getenv('KOKORO_VOICE', 'af_heart')
DEVICE = 'cuda' if torch.cuda.is_available() and os.getenv('KOKORO_DEVICE', '') != 'cpu' else 'cpu'

app = FastAPI(title='Kokoro TTS')
_model = None
_pipelines = {}
_lock = threading.Lock()


def pipeline(voice):
    """One pipeline per language (the voice name's first letter: a = US English, b = UK English)."""
    global _model
    lang = voice[0]
    if lang not in 'ab':
        raise HTTPException(status_code=400, detail=f'Unsupported voice {voice!r}: only English voices (a*, b*) are enabled')
    if _model is None:
        _model = KModel(repo_id=REPO).to(DEVICE).eval()
    if lang not in _pipelines:
        _pipelines[lang] = KPipeline(lang_code=lang, repo_id=REPO, model=_model)
    return _pipelines[lang]


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    voice: str = Field(default=DEFAULT_VOICE, pattern=r'^[ab][fm]_[a-z]+$')
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


def to_wav(samples):
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype('<i2').tobytes()
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(pcm)
    return buffer.getvalue()


@app.post('/speak')
def speak(request: SpeakRequest):
    with _lock:  # one model on one GPU: requests take turns
        pieces = [result.audio for result in pipeline(request.voice)(request.text, voice=request.voice, speed=request.speed)
                  if result.audio is not None]
    if not pieces:
        raise HTTPException(status_code=422, detail='Nothing to say')
    samples = np.concatenate([piece.detach().cpu().numpy() for piece in pieces])
    return Response(content=to_wav(samples), media_type='audio/wav')


@app.get('/health')
def health():
    return {'device': DEVICE, 'voice': DEFAULT_VOICE, 'gpu': torch.cuda.get_device_name(0) if DEVICE == 'cuda' else None}


if __name__ == '__main__' and os.getenv('KOKORO_WARMUP'):
    # Build step: download the model, the default voice and the G2P data so the image works offline.
    with _lock:
        list(pipeline(DEFAULT_VOICE)('Hello.', voice=DEFAULT_VOICE))
    print('warmed up on', DEVICE)
