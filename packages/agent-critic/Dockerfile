FROM node:20-alpine AS base
WORKDIR /app

# Copy workspace manifests
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/agent-critic/package.json ./packages/agent-critic/

# Install all workspace deps
RUN npm install --ignore-scripts

# Copy source
COPY packages/shared/src ./packages/shared/src
COPY packages/agent-critic/src ./packages/agent-critic/src
COPY tsconfig.json ./
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/agent-critic/tsconfig.json ./packages/agent-critic/

ENV NODE_ENV=production

CMD ["node", "--import", "tsx/esm", "packages/agent-critic/src/index.ts"]
