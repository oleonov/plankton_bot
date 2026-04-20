#!/bin/bash
set -e

# ── Configuration ─────────────────────────────────────────────────────────────
SERVER_USER="root"
SERVER_HOST="old.server.ip"
SERVER_PATH="/opt/plankton"
IMAGE_NAME="plankton"
IMAGE_TAG="latest"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}=== Plankton Deployment Script ===${NC}\n"

# Verify .env.production exists locally before starting
if [ ! -f ".env.production" ]; then
    echo -e "${RED}ERROR: .env.production not found.${NC}"
    echo "Copy .env.production.example to .env.production and fill in your values."
    exit 1
fi

# Pre-flight: run tests, lint, typecheck
echo -e "${GREEN}[0/6] Running pre-flight checks (typecheck, test, lint)...${NC}"
pnpm run typecheck || { echo -e "${RED}ERROR: typecheck failed${NC}"; exit 1; }
pnpm run test || { echo -e "${RED}ERROR: tests failed${NC}"; exit 1; }
pnpm run lint || { echo -e "${RED}ERROR: lint failed${NC}"; exit 1; }
echo -e "${GREEN}Pre-flight checks passed ✓${NC}\n"

# Step 1: Build Docker image locally
GIT_SHA=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain)" ]; then
  GIT_SHA="${GIT_SHA}-dirty"
  echo -e "${YELLOW}WARNING: working tree is dirty — SHA will be marked as ${GIT_SHA}${NC}"
fi
echo -e "${GREEN}[1/6] Building Docker image locally (linux/amd64, sha: ${GIT_SHA})...${NC}"
docker build --platform linux/amd64 --build-arg GIT_SHA="${GIT_SHA}" -t ${IMAGE_NAME}:${IMAGE_TAG} .

# Step 2: Save image to archive
echo -e "\n${GREEN}[2/6] Saving image to archive...${NC}"
docker save ${IMAGE_NAME}:${IMAGE_TAG} | gzip > /tmp/${IMAGE_NAME}.tar.gz
echo "Image saved to /tmp/${IMAGE_NAME}.tar.gz ($(du -h /tmp/${IMAGE_NAME}.tar.gz | cut -f1))"

# Step 3: Upload to server
echo -e "\n${GREEN}[3/6] Uploading to server...${NC}"
ssh ${SERVER_USER}@${SERVER_HOST} "mkdir -p ${SERVER_PATH}/config"
scp /tmp/${IMAGE_NAME}.tar.gz ${SERVER_USER}@${SERVER_HOST}:/tmp/
scp docker-compose.yml ${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/
scp .env.production ${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/.env.production

# Step 4: Capture current bot state and write resume intent if running
echo -e "\n${GREEN}[4/6] Capturing current bot state...${NC}"
API_KEY=$(grep '^PLANKTON_API_KEY=' .env.production | cut -d'=' -f2-)
API_BASE="https://bot.example.com"
CONTROL_DB="/var/lib/docker/volumes/plankton-data/_data/control.db"
if [ -n "$API_KEY" ]; then
    STATUS_JSON=$(curl -sf -H "Authorization: Bearer ${API_KEY}" "${API_BASE}/api/v1/status" 2>/dev/null || echo "")
    if [ -n "$STATUS_JSON" ]; then
        PAUSED=$(echo "$STATUS_JSON" | grep -o '"paused":[a-z]*' | cut -d: -f2)
        if [ "$PAUSED" = "false" ]; then
            echo "Bot was RUNNING — writing resume intent to control.db"
            INTENT_RESULT=$(ssh ${SERVER_USER}@${SERVER_HOST} "sqlite3 ${CONTROL_DB} \"UPDATE runtime_control_state SET resume_intent_at = datetime('now') WHERE id = 1; SELECT resume_intent_at FROM runtime_control_state WHERE id = 1;\"" 2>/dev/null || echo "FAILED")
            if [ "$INTENT_RESULT" = "FAILED" ] || [ -z "$INTENT_RESULT" ]; then
                echo -e "${YELLOW}WARNING: Failed to write resume intent — bot will start paused${NC}"
            else
                echo "Resume intent written: ${INTENT_RESULT}"
            fi
        else
            echo "Bot was PAUSED — no resume intent"
        fi
    else
        echo -e "${YELLOW}Could not reach API — no resume intent${NC}"
    fi
else
    echo -e "${YELLOW}No PLANKTON_API_KEY — no resume intent${NC}"
fi

# Step 5: Load image and replace containers (atomic swap — no separate down)
echo -e "\n${GREEN}[5/6] Loading image and replacing containers on server...${NC}"
ssh ${SERVER_USER}@${SERVER_HOST} << ENDSSH
set -e
echo "Loading Docker image..."
docker load < /tmp/${IMAGE_NAME}.tar.gz

cd ${SERVER_PATH}

# docker-compose up -d with --force-recreate replaces containers in-place.
# No separate "down" step — if the script dies after load but before up,
# the old containers keep running with the old image.
echo "Replacing containers (force-recreate)..."
docker-compose --env-file .env.production up -d --force-recreate

echo "Cleaning up..."
rm /tmp/${IMAGE_NAME}.tar.gz
docker image prune -f

echo "Container status:"
docker-compose --env-file .env.production ps
ENDSSH

# Step 6: Health check + update deploy metadata
echo -e "\n${GREEN}[6/7] Verifying deploy and updating version...${NC}"
DEPLOY_OK=false
for i in 1 2 3 4 5 6; do
    HEALTH=$(curl -sf -H "Authorization: Bearer ${API_KEY}" "${API_BASE}/api/v1/health" 2>/dev/null || echo "")
    if echo "$HEALTH" | grep -q '"ok":true'; then
        DEPLOY_OK=true
        break
    fi
    echo "Waiting for API health... (attempt $i/6)"
    sleep 5
done

if [ "$DEPLOY_OK" = "true" ]; then
    DEPLOY_META="${SERVER_PATH}/config/deploy-meta.json"

    # Read current deploy version — || true prevents set -e from killing the script
    PREV_VERSION=$(ssh ${SERVER_USER}@${SERVER_HOST} "python3 -c \"
import json, sys
try:
    with open('${DEPLOY_META}') as f:
        v = json.load(f).get('deployVersion', 0)
        if not isinstance(v, int) or v < 0:
            sys.exit(1)
        print(v)
except FileNotFoundError:
    print(0)
except Exception:
    sys.exit(1)
\"" 2>/dev/null) || true

    if [ -z "$PREV_VERSION" ]; then
        echo -e "${YELLOW}WARNING: deploy-meta.json is corrupt or unreadable — version NOT incremented${NC}"
        echo -e "${YELLOW}Fix manually: ssh ${SERVER_USER}@${SERVER_HOST} 'cat ${DEPLOY_META}'${NC}"
        PREV_VERSION=""
    fi

    if [ -z "$PREV_VERSION" ]; then
        echo "Skipping deploy version update (metadata unreadable)"
    else

    NEXT_VERSION=$((PREV_VERSION + 1))
    DEPLOYED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Atomic write: temp file → mv (prevents truncated/corrupt metadata)
    ssh ${SERVER_USER}@${SERVER_HOST} "cat > ${DEPLOY_META}.tmp && mv ${DEPLOY_META}.tmp ${DEPLOY_META}" << METAEOF
{
  "deployVersion": ${NEXT_VERSION},
  "sha": "${GIT_SHA}",
  "deployedAt": "${DEPLOYED_AT}"
}
METAEOF
    echo "Deploy version: v$(printf '%03d' ${NEXT_VERSION}) · ${GIT_SHA} · ${DEPLOYED_AT}"

    fi # end of PREV_VERSION check
else
    echo -e "${YELLOW}WARNING: Health check failed — deploy version NOT incremented${NC}"
fi

# Step 7: Cleanup local archive
echo -e "\n${GREEN}[7/7] Cleaning up local files...${NC}"
rm /tmp/${IMAGE_NAME}.tar.gz

echo -e "\n${GREEN}=== Deployment complete! ===${NC}"
echo -e "Dashboard: https://bot.example.com"
echo -e "\nTo check status:"
echo -e "  ssh ${SERVER_USER}@${SERVER_HOST} 'cd ${SERVER_PATH} && docker-compose --env-file .env.production ps'"
echo -e "\nTo view logs:"
echo -e "  ssh ${SERVER_USER}@${SERVER_HOST} 'cd ${SERVER_PATH} && docker-compose --env-file .env.production logs -f plankton-runtime'"
echo -e "  ssh ${SERVER_USER}@${SERVER_HOST} 'cd ${SERVER_PATH} && docker-compose --env-file .env.production logs -f plankton-api'"
