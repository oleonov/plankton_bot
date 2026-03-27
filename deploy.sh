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

# Step 1: Build Docker image locally
GIT_SHA=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain)" ]; then
  GIT_SHA="${GIT_SHA}-dirty"
  echo -e "${YELLOW}WARNING: working tree is dirty — SHA will be marked as ${GIT_SHA}${NC}"
fi
echo -e "${GREEN}[1/5] Building Docker image locally (linux/amd64, sha: ${GIT_SHA})...${NC}"
docker build --platform linux/amd64 --build-arg GIT_SHA="${GIT_SHA}" -t ${IMAGE_NAME}:${IMAGE_TAG} .

# Step 2: Save image to archive
echo -e "\n${GREEN}[2/5] Saving image to archive...${NC}"
docker save ${IMAGE_NAME}:${IMAGE_TAG} | gzip > /tmp/${IMAGE_NAME}.tar.gz
echo "Image saved to /tmp/${IMAGE_NAME}.tar.gz ($(du -h /tmp/${IMAGE_NAME}.tar.gz | cut -f1))"

# Step 3: Upload to server
echo -e "\n${GREEN}[3/5] Uploading to server...${NC}"
ssh ${SERVER_USER}@${SERVER_HOST} "mkdir -p ${SERVER_PATH}/config"
scp /tmp/${IMAGE_NAME}.tar.gz ${SERVER_USER}@${SERVER_HOST}:/tmp/
scp docker-compose.yml ${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/
scp .env.production ${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/.env.production
scp config/family_rules.yaml ${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/config/

# Step 4: Load image and start containers
echo -e "\n${GREEN}[4/5] Loading image and starting containers on server...${NC}"
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

# Step 5: Cleanup local archive
echo -e "\n${GREEN}[5/5] Cleaning up local files...${NC}"
rm /tmp/${IMAGE_NAME}.tar.gz

echo -e "\n${GREEN}=== Deployment complete! ===${NC}"
echo -e "Dashboard: https://bot.example.com"
echo -e "\nTo check status:"
echo -e "  ssh ${SERVER_USER}@${SERVER_HOST} 'cd ${SERVER_PATH} && docker-compose --env-file .env.production ps'"
echo -e "\nTo view logs:"
echo -e "  ssh ${SERVER_USER}@${SERVER_HOST} 'cd ${SERVER_PATH} && docker-compose --env-file .env.production logs -f plankton-runtime'"
echo -e "  ssh ${SERVER_USER}@${SERVER_HOST} 'cd ${SERVER_PATH} && docker-compose --env-file .env.production logs -f plankton-api'"
