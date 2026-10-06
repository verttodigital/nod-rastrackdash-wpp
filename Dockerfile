# syntax=docker/dockerfile:1.7

FROM node:22-bookworm AS base

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:/usr/local/bin:${PATH}"

RUN corepack enable \
  && corepack prepare pnpm@9.15.0 --activate

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json

# Keep the two large Prisma tarballs on BuildKit's download path. The VPS
# reliably pulls image layers, while pnpm's build-container connection stalls.
ADD --checksum=sha256:d742c70dd4ca1b0f103ce14fa31114736f6374b4bee737b026b0826c78fd57dc \
  https://registry.npmjs.org/@prisma/client/-/client-6.19.3.tgz \
  /tmp/prisma-client-6.19.3.tgz
ADD --checksum=sha256:2f80b9a34fe3a3605469281067ad7990a65f085a1b0551c16757535730b18ab1 \
  https://registry.npmjs.org/prisma/-/prisma-6.19.3.tgz \
  /tmp/prisma-cli-6.19.3.tgz

RUN --mount=type=cache,id=wpptrack-api-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm config set store-dir /pnpm/store \
  && pnpm config set network-concurrency 4 \
  && pnpm config set fetch-retries 5 \
  && pnpm config set fetch-retry-mintimeout 1000 \
  && pnpm config set fetch-retry-maxtimeout 10000 \
  && pnpm config set fetch-timeout 30000 \
  && pnpm store add /tmp/prisma-client-6.19.3.tgz /tmp/prisma-cli-6.19.3.tgz \
  && pnpm install --frozen-lockfile --prefer-offline --filter @wpptrack/api...

# Resolves the installed template commit (shown in /backoffice) from the
# build context's git metadata, then drops that metadata. .dockerignore only
# lets the read-only subset git needs in (HEAD, refs, objects, index, shallow);
# never config/remotes/hooks/logs. Later stages copy from /src after `.git` is
# removed, so neither history nor credentials reach the image. See
# scripts/resolve-build-identity.mjs for the rules (unknown when unsure).
FROM base AS source

WORKDIR /src

COPY . .

# Optional fallback for builds without git metadata (archive/tarball). It never
# overrides the commit read from a git checkout.
ARG GIT_SHA=
ARG SOURCE_COMMIT=

# Coolify removes .git before building and supplies the actual checkout SHA
# as SOURCE_COMMIT when "Include Source Commit in Build" is enabled.
RUN GIT_SHA="${GIT_SHA:-${SOURCE_COMMIT}}" node scripts/resolve-build-identity.mjs /src /identity/build-identity.json \
  && rm -rf /src/.git

FROM deps AS build

COPY --from=source /src ./

ENV DATABASE_URL="postgresql://postgres:postgres@localhost:5432/wpptrack"

RUN pnpm --dir apps/api exec prisma generate --schema prisma/schema.prisma
RUN pnpm --filter @wpptrack/shared build
RUN pnpm --filter @wpptrack/api build

FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app ./
# Read by the API (template-version BUILD_IDENTITY_FILE).
COPY --from=source /identity/build-identity.json ./build-identity.json

EXPOSE 3000

CMD ["sh", "-c", "pnpm --dir apps/api exec prisma migrate deploy --schema prisma/schema.prisma && pnpm --filter @wpptrack/api start"]
