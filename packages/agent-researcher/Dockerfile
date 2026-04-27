FROM node:20-alpine AS base
WORKDIR /app

# Copy workspace manifests
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/agent-researcher/package.json ./packages/agent-researcher/

# Install all workspace deps
RUN npm install --ignore-scripts

# Copy source
COPY packages/shared/src ./packages/shared/src
COPY packages/agent-researcher/src ./packages/agent-researcher/src
COPY tsconfig.json ./
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/agent-researcher/tsconfig.json ./packages/agent-researcher/

ENV NODE_ENV=production

CMD ["node", "--import", "tsx/esm", "packages/agent-researcher/src/index.ts"]
