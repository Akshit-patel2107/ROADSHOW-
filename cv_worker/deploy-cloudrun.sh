#!/usr/bin/env bash
set -euo pipefail

# ROADSHADOW 2.0 — Deploy Python YOLO + ByteTrack CV Service to Google Cloud Run
#
# Usage:
#   cd cv_worker
#   export GCP_PROJECT_ID="your-gcp-project-id"
#   export CV_SERVICE_API_KEY="$(openssl rand -hex 32)"   # Recommended
#   bash deploy-cloudrun.sh
#
# Optional overrides:
#   GCP_REGION (default: asia-southeast1)
#   CLOUD_RUN_SERVICE (default: roadshadow-cv-worker)

GCP_PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
GCP_REGION="${GCP_REGION:-asia-southeast1}"
CLOUD_RUN_SERVICE="${CLOUD_RUN_SERVICE:-roadshadow-cv-worker}"
CV_SERVICE_API_KEY="${CV_SERVICE_API_KEY:-}"

if [[ -z "${GCP_PROJECT_ID}" ]]; then
  echo "Error: Set GCP_PROJECT_ID or run 'gcloud config set project <PROJECT_ID>' first." >&2
  exit 1
fi

echo "Deploying ${CLOUD_RUN_SERVICE} to Cloud Run (${GCP_PROJECT_ID} / ${GCP_REGION})..."

ENV_VARS="YOLO_DEVICE=cpu,CV_TRACKER_CONFIG=bytetrack.yaml,CV_SAMPLE_FPS=4.0,CV_MAX_FRAMES=360,CV_CONF_THRESHOLD=0.30,CV_MAX_UPLOAD_MB=250,CV_PRELOAD_MODEL=true"
if [[ -n "${CV_SERVICE_API_KEY}" ]]; then
  ENV_VARS="${ENV_VARS},CV_SERVICE_API_KEY=${CV_SERVICE_API_KEY}"
else
  echo "Warning: CV_SERVICE_API_KEY is empty. Set CV_SERVICE_API_KEY in production to protect your worker." >&2
fi

gcloud run deploy "${CLOUD_RUN_SERVICE}" \
  --project "${GCP_PROJECT_ID}" \
  --region "${GCP_REGION}" \
  --source . \
  --platform managed \
  --allow-unauthenticated \
  --cpu 2 \
  --memory 4Gi \
  --timeout 300 \
  --concurrency 2 \
  --max-instances 3 \
  --min-instances 0 \
  --set-env-vars "${ENV_VARS}"

SERVICE_URL="$(gcloud run services describe "${CLOUD_RUN_SERVICE}" \
  --project "${GCP_PROJECT_ID}" \
  --region "${GCP_REGION}" \
  --format='value(status.url)')"

echo ""
echo "Deployed CV Worker URL: ${SERVICE_URL}"
echo "Verifying /health endpoint..."
curl -fsS "${SERVICE_URL}/health"
echo ""
echo ""
echo "Next steps in ROADSHADOW (AI Studio Secrets / .env):"
echo "  CV_SERVICE_URL=${SERVICE_URL}"
if [[ -n "${CV_SERVICE_API_KEY}" ]]; then
  echo "  CV_SERVICE_API_KEY=${CV_SERVICE_API_KEY}"
fi
