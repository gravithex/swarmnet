FROM node:20-alpine AS base
WORKDIR /app

# Copy workspace manifests
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/agent-planner/package.json ./packages/agent-planner/

# Install all workspace deps
RUN npm install --ignore-scripts

# Copy source
COPY packages/shared/src ./packages/shared/src
COPY packages/agent-planner/src ./packages/agent-planner/src
COPY tsconfig.json ./
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/agent-planner/tsconfig.json ./packages/agent-planner/

ENV NODE_ENV=production

CMD ["node", "--import", "tsx/esm", "packages/agent-planner/src/index.ts"]
