# Kokoro TTS service (hexgrad/kokoro). kokoro 0.9.x supports Python <= 3.12.
FROM python:3.12-slim

# espeak-ng: misaki's fallback for words missing from its dictionary.
RUN apt-get update && apt-get install -y --no-install-recommends espeak-ng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# CUDA 12.8 build of PyTorch; it also runs on the CPU when no GPU is passed to the container.
RUN pip install --no-cache-dir torch==2.8.0 --index-url https://download.pytorch.org/whl/cu128
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

ENV HF_HOME=/opt/hf
COPY app.py .
# Download the model, the chosen voice and spaCy's English model now, then run offline.
# Changing KOKORO_VOICE needs a rebuild (docker compose build tts).
ARG KOKORO_VOICE=af_heart
ENV KOKORO_VOICE=${KOKORO_VOICE}
RUN KOKORO_WARMUP=1 KOKORO_DEVICE=cpu python app.py
ENV HF_HUB_OFFLINE=1

EXPOSE 8880
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8880"]
