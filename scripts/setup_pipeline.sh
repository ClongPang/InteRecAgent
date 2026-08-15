#!/usr/bin/env bash
set -euo pipefail

: "${OPENSEARCH_HOST:?Missing OPENSEARCH_HOST}"
: "${OPENSEARCH_USER:?Missing OPENSEARCH_USER}"
: "${OPENSEARCH_PASSWORD:=${OPENSEARCH_PASS:?Missing OPENSEARCH_PASSWORD or OPENSEARCH_PASS}}"

OPENSEARCH_PORT="${OPENSEARCH_PORT:-9200}"
OPENSEARCH_SCHEME="${OPENSEARCH_SCHEME:-http}"

curl -u "${OPENSEARCH_USER}:${OPENSEARCH_PASSWORD}" \
  -X PUT "${OPENSEARCH_SCHEME}://${OPENSEARCH_HOST}:${OPENSEARCH_PORT}/_search/pipeline/globex_hybrid_pipeline" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "KNN + BM25 双路召回的归一与加权融合",
    "phase_results_processors": [
      {
        "normalization-processor": {
          "normalization": { "technique": "min_max" },
          "combination": {
            "technique": "arithmetic_mean",
            "parameters": { "weights": [0.7, 0.3] }
          }
        }
      }
    ]
  }'
