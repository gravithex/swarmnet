FROM node:20-alpine AS base
WORKDIR /app

# Copy workspace manifests
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/agent-executor/package.json ./packages/agent-executor/

# Install all workspace deps
RUN npm install --ignore-scripts

# Copy source
COPY packages/shared/src ./packages/shared/src
COPY packages/agent-executor/src ./packages/agent-executor/src
COPY tsconfig.json ./
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/agent-executor/tsconfig.json ./packages/agent-executor/

ENV NODE_ENV=production

CMD ["node", "--import", "tsx/esm", "packages/agent-executor/src/index.ts"]
