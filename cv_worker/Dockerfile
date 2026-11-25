# ROADSHADOW 2.0 — Production Python FastAPI + Ultralytics YOLO + ByteTrack CV Service
# Built for Google Cloud Run (CPU inference, pre-cached YOLO weights, non-root runtime).

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080 \
    YOLO_CONFIG_DIR=/app/.ultralytics \
    YOLO_MODEL_PATH=/app/weights/yolov8n.pt \
    YOLO_DEVICE=cpu \
    CV_TRACKER_CONFIG=bytetrack.yaml \
    CV_SAMPLE_FPS=4.0 \
    CV_MAX_FRAMES=360 \
    CV_CONF_THRESHOLD=0.30 \
    CV_MAX_UPLOAD_MB=250 \
    CV_PRELOAD_MODEL=true

# System runtime libraries required by OpenCV and RTSP/MP4/WebM/MOV decoding
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install CPU-only PyTorch first to avoid downloading multi-GB CUDA toolkits
RUN pip install --no-cache-dir \
    --index-url https://download.pytorch.org/whl/cpu \
    torch torchvision

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Pre-download YOLO weights at build time so Cloud Run cold starts require no external download
RUN mkdir -p /app/weights /app/.ultralytics \
    && python -c "from ultralytics import YOLO; import shutil; YOLO('yolov8n.pt'); shutil.move('yolov8n.pt', '/app/weights/yolov8n.pt')"

COPY *.py /app/

# Run as dedicated non-root user
RUN useradd --create-home --shell /bin/bash cvuser \
    && chown -R cvuser:cvuser /app
USER cvuser

EXPOSE 8080

# Single worker process avoids duplicating YOLO model weights across RAM while preserving threadpool health checks
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1"]
