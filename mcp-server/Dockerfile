# Arbitova MCP Server (Path B, non-custodial)
# Sandbox image for Glama and other MCP registries.
FROM node:20-alpine

WORKDIR /app

# Only runtime artifacts — prompts/ is read at runtime for resource exposure.
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js ./
COPY prompts/ ./prompts/

# MCP uses stdio. Healthcheck: simply verify the entry script is runnable.
# Env vars (ARBITOVA_RPC_URL, ARBITOVA_ESCROW_ADDRESS, ARBITOVA_USDC_ADDRESS,
# ARBITOVA_AGENT_PRIVATE_KEY) are supplied by the host runtime.
ENTRYPOINT ["node", "/app/index.js"]
