#!/bin/bash
set -e

# ── Configuration ─────────────────────────────────────────────────────────────
SERVER_USER="root"
SERVER_HOST="your.server.ip"
SERVER_PATH="/opt/krabs"
GHCR_OWNER="oleonov"
GHCR_PACKAGE="krabs"
GHCR_IMAGE="ghcr.io/${GHCR_OWNER}/${GHCR_PACKAGE}"
IMAGE_TAG="latest"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}=== Krabs Deployment Script (ghcr.io) ===${NC}\n"

# Verify .env.production exists locally before starting
if [ ! -f ".env.production" ]; then
    echo -e "${RED}ERROR: .env.production not found.${NC}"
    echo "Copy .env.production.example to .env.production and fill in your values."
    exit 1
fi

# Load deploy-time secrets (GHCR_PAT) — NOT shipped to server
if [ ! -f ".env.deploy" ]; then
    echo -e "${RED}ERROR: .env.deploy not found.${NC}"
    echo "Copy .env.deploy.example to .env.deploy and fill in GHCR_PAT."
    echo "Required PAT scope: read:packages (used only for visibility check)."
    exit 1
fi
# shellcheck disable=SC1091
set -a; . ./.env.deploy; set +a
if [ -z "${GHCR_PAT:-}" ]; then
    echo -e "${RED}ERROR: GHCR_PAT is empty in .env.deploy.${NC}"
    exit 1
fi

# Verify local docker is logged into ghcr.io (one-time setup):
#   echo $GHCR_WRITE_PAT | docker login ghcr.io -u oleonov --password-stdin
if ! grep -q '"ghcr.io"' "${HOME}/.docker/config.json" 2>/dev/null; then
    echo -e "${RED}ERROR: local docker is not logged into ghcr.io.${NC}"
    echo "Run once: echo \$GHCR_WRITE_PAT | docker login ghcr.io -u ${GHCR_OWNER} --password-stdin"
    echo "PAT needs scope: write:packages (separate token from .env.deploy GHCR_PAT)."
    exit 1
fi

# Pre-flight: run tests, lint, typecheck
echo -e "${GREEN}[0/6] Running pre-flight checks (typecheck, test, lint)...${NC}"
pnpm run typecheck || { echo -e "${RED}ERROR: typecheck failed${NC}"; exit 1; }
pnpm run test || { echo -e "${RED}ERROR: tests failed${NC}"; exit 1; }
pnpm run lint || { echo -e "${RED}ERROR: lint failed${NC}"; exit 1; }
echo -e "${GREEN}Pre-flight checks passed ✓${NC}\n"

# Step 1: Build Docker image locally with all required tags
GIT_SHA=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain)" ]; then
  GIT_SHA="${GIT_SHA}-dirty"
  echo -e "${YELLOW}WARNING: working tree is dirty — SHA will be marked as ${GIT_SHA}${NC}"
fi
echo -e "${GREEN}[1/6] Building Docker image (linux/amd64, sha: ${GIT_SHA})...${NC}"
docker build --platform linux/amd64 --build-arg GIT_SHA="${GIT_SHA}" \
    -t "${GHCR_IMAGE}:${IMAGE_TAG}" \
    -t "${GHCR_IMAGE}:${GIT_SHA}" \
    .

# Step 2: Push to ghcr.io (replaces save + scp under FPT shaping)
echo -e "\n${GREEN}[2/6] Pushing image to ghcr.io...${NC}"
docker push "${GHCR_IMAGE}:${IMAGE_TAG}"
docker push "${GHCR_IMAGE}:${GIT_SHA}"

# Step 3: Hard-verify package is PRIVATE — refuse to deploy a public image
echo -e "\n${GREEN}[3/6] Verifying ghcr.io package visibility is private...${NC}"
PKG_JSON=$(curl -sf -H "Authorization: Bearer ${GHCR_PAT}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/user/packages/container/${GHCR_PACKAGE}") || {
        echo -e "${RED}ERROR: GitHub API call failed — cannot confirm package is private.${NC}"
        echo "Check GHCR_PAT scope (read:packages) and that package '${GHCR_PACKAGE}' exists."
        exit 1
    }
VISIBILITY=$(echo "$PKG_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('visibility',''))")
if [ "$VISIBILITY" != "private" ]; then
    echo -e "${RED}ERROR: package visibility is '${VISIBILITY}', expected 'private'.${NC}"
    echo "Fix at: https://github.com/users/${GHCR_OWNER}/packages/container/${GHCR_PACKAGE}/settings"
    echo "→ Danger Zone → Change package visibility → Private."
    exit 1
fi
echo "Package visibility: ${VISIBILITY} ✓"

# Step 4: Capture current bot state, ship compose + env, write resume intent
echo -e "\n${GREEN}[4/6] Syncing compose/env and capturing bot state...${NC}"
SSH_OPTS="-o ServerAliveInterval=15 -o ServerAliveCountMax=20 -o TCPKeepAlive=yes -o ConnectTimeout=30"
ssh ${SSH_OPTS} ${SERVER_USER}@${SERVER_HOST} "mkdir -p ${SERVER_PATH}/config"

# Verify server is logged into ghcr.io BEFORE shipping new compose (else pull will fail)
if ! ssh ${SSH_OPTS} ${SERVER_USER}@${SERVER_HOST} "grep -q '\"ghcr.io\"' /root/.docker/config.json 2>/dev/null"; then
    echo -e "${RED}ERROR: server is not logged into ghcr.io.${NC}"
    echo "One-time setup on server:"
    echo "  ssh ${SERVER_USER}@${SERVER_HOST}"
    echo "  echo \$GHCR_READ_PAT | docker login ghcr.io -u ${GHCR_OWNER} --password-stdin"
    echo "Server PAT needs scope: read:packages only."
    exit 1
fi

scp ${SSH_OPTS} docker-compose.yml ${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/
scp ${SSH_OPTS} .env.production ${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/.env.production

API_KEY=$(grep '^KRABS_API_KEY=' .env.production | cut -d'=' -f2-)
API_BASE="https://bot.example.com"
CONTROL_DB="/var/lib/docker/volumes/krabs-data/_data/control.db"
if [ -n "$API_KEY" ]; then
    STATUS_JSON=$(curl -sf -H "Authorization: Bearer ${API_KEY}" "${API_BASE}/api/v1/status" 2>/dev/null || echo "")
    if [ -n "$STATUS_JSON" ]; then
        PAUSED=$(echo "$STATUS_JSON" | grep -o '"paused":[a-z]*' | cut -d: -f2)
        if [ "$PAUSED" = "false" ]; then
            echo "Bot was RUNNING — writing resume intent to control.db"
            INTENT_RESULT=$(ssh ${SSH_OPTS} ${SERVER_USER}@${SERVER_HOST} "sqlite3 ${CONTROL_DB} \"UPDATE runtime_control_state SET resume_intent_at = datetime('now') WHERE id = 1; SELECT resume_intent_at FROM runtime_control_state WHERE id = 1;\"" 2>/dev/null || echo "FAILED")
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
    echo -e "${YELLOW}No KRABS_API_KEY — no resume intent${NC}"
fi

# Step 5: Pull image and replace containers (atomic swap — no separate down)
echo -e "\n${GREEN}[5/6] Pulling image and replacing containers on server...${NC}"
ssh ${SSH_OPTS} ${SERVER_USER}@${SERVER_HOST} << ENDSSH
set -e
echo "Pulling ${GHCR_IMAGE}:${IMAGE_TAG} from ghcr.io..."
docker pull ${GHCR_IMAGE}:${IMAGE_TAG}

cd ${SERVER_PATH}

# docker compose up -d with --force-recreate replaces containers in-place.
# No separate "down" step — if the script dies after pull but before up,
# the old containers keep running with the old image.
echo "Replacing containers (force-recreate)..."
docker compose --env-file .env.production up -d --force-recreate --remove-orphans

echo "Cleaning up dangling images..."
docker image prune -f

echo "Container status:"
docker compose --env-file .env.production ps
ENDSSH

# Step 6: Health check + update deploy metadata
echo -e "\n${GREEN}[6/6] Verifying deploy and updating version...${NC}"
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
    PREV_VERSION=$(ssh ${SSH_OPTS} ${SERVER_USER}@${SERVER_HOST} "python3 -c \"
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
        echo -e "${YELLOW}Fix manually: ssh ${SSH_OPTS} ${SERVER_USER}@${SERVER_HOST} 'cat ${DEPLOY_META}'${NC}"
        PREV_VERSION=""
    fi

    if [ -z "$PREV_VERSION" ]; then
        echo "Skipping deploy version update (metadata unreadable)"
    else

    NEXT_VERSION=$((PREV_VERSION + 1))
    DEPLOYED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Atomic write: temp file → mv (prevents truncated/corrupt metadata)
    ssh ${SSH_OPTS} ${SERVER_USER}@${SERVER_HOST} "cat > ${DEPLOY_META}.tmp && mv ${DEPLOY_META}.tmp ${DEPLOY_META}" << METAEOF
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

echo -e "\n${GREEN}=== Deployment complete! ===${NC}"
echo -e "Dashboard: https://bot.example.com"
echo -e "Image:     ${GHCR_IMAGE}:${GIT_SHA}"
echo -e "\nTo check status:"
echo -e "  ssh ${SSH_OPTS} ${SERVER_USER}@${SERVER_HOST} 'cd ${SERVER_PATH} && docker compose --env-file .env.production ps'"
echo -e "\nTo view logs:"
echo -e "  ssh ${SSH_OPTS} ${SERVER_USER}@${SERVER_HOST} 'cd ${SERVER_PATH} && docker compose --env-file .env.production logs -f krabs-runtime'"
echo -e "  ssh ${SSH_OPTS} ${SERVER_USER}@${SERVER_HOST} 'cd ${SERVER_PATH} && docker compose --env-file .env.production logs -f krabs-api'"
