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
scp config/family_rules.yaml ${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/config/

# Step 4: Capture current bot state before deploy
echo -e "\n${GREEN}[4/6] Capturing current bot state...${NC}"
API_KEY=$(grep '^PLANKTON_API_KEY=' .env.production | cut -d'=' -f2-)
API_BASE="https://bot.example.com"
WAS_RUNNING="unknown"
if [ -n "$API_KEY" ]; then
    STATUS_JSON=$(curl -sf -H "Authorization: Bearer ${API_KEY}" "${API_BASE}/api/v1/status" 2>/dev/null || echo "")
    if [ -n "$STATUS_JSON" ]; then
        PAUSED=$(echo "$STATUS_JSON" | grep -o '"paused":[a-z]*' | cut -d: -f2)
        if [ "$PAUSED" = "false" ]; then
            WAS_RUNNING="true"
            echo "Bot was RUNNING — will resume after deploy"
        else
            WAS_RUNNING="false"
            echo "Bot was PAUSED — will stay paused after deploy"
        fi
    else
        echo -e "${YELLOW}Could not reach API — will not auto-resume${NC}"
    fi
else
    echo -e "${YELLOW}No PLANKTON_API_KEY — will not auto-resume${NC}"
fi

# Step 5: Load image and start containers
echo -e "\n${GREEN}[5/6] Loading image and starting containers on server...${NC}"
ssh ${SERVER_USER}@${SERVER_HOST} << ENDSSH
set -e
echo "Loading Docker image..."
docker load < /tmp/${IMAGE_NAME}.tar.gz

cd ${SERVER_PATH}

echo "Stopping existing containers..."
docker-compose --env-file .env.production down 2>/dev/null || true

echo "Starting containers..."
docker-compose --env-file .env.production up -d

echo "Cleaning up..."
rm /tmp/${IMAGE_NAME}.tar.gz
docker image prune -f

echo "Container status:"
docker-compose --env-file .env.production ps
ENDSSH

# Restore bot state if it was running before deploy
if [ "$WAS_RUNNING" = "true" ]; then
    echo -e "\n${GREEN}Restoring bot state — resuming...${NC}"
    # Wait for API to become healthy
    for i in 1 2 3 4 5; do
        HEALTH=$(curl -sf -H "Authorization: Bearer ${API_KEY}" "${API_BASE}/api/v1/status" 2>/dev/null || echo "")
        if [ -n "$HEALTH" ]; then break; fi
        echo "Waiting for API to come up... (attempt $i/5)"
        sleep 3
    done
    RESUME_RESP=$(curl -sf -X POST "${API_BASE}/api/v1/actions/resume" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${API_KEY}" \
        -d '{"reason": "post-deploy auto-resume"}' 2>/dev/null || echo "")
    if [ -n "$RESUME_RESP" ]; then
        echo "Resume command sent"
    else
        echo -e "${YELLOW}WARNING: Could not resume — do it manually${NC}"
    fi
fi

# Step 6: Cleanup local archive
echo -e "\n${GREEN}[6/6] Cleaning up local files...${NC}"
rm /tmp/${IMAGE_NAME}.tar.gz

echo -e "\n${GREEN}=== Deployment complete! ===${NC}"
echo -e "Dashboard: https://bot.example.com"
echo -e "\nTo check status:"
echo -e "  ssh ${SERVER_USER}@${SERVER_HOST} 'cd ${SERVER_PATH} && docker-compose --env-file .env.production ps'"
echo -e "\nTo view logs:"
echo -e "  ssh ${SERVER_USER}@${SERVER_HOST} 'cd ${SERVER_PATH} && docker-compose --env-file .env.production logs -f plankton-runtime'"
echo -e "  ssh ${SERVER_USER}@${SERVER_HOST} 'cd ${SERVER_PATH} && docker-compose --env-file .env.production logs -f plankton-api'"
