FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# tsx runs the TypeScript directly, so dev dependencies are needed at runtime.
RUN npm ci --no-audit --no-fund
COPY tsconfig.json POLICY.md ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3000
USER node
CMD ["npx", "tsx", "src/server.ts"]
