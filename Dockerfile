# syntax=docker/dockerfile:1

#############
# Create base image.

FROM node:24.20.0-alpine AS base-image

# The `CI` environment variable must be set for pnpm to run in headless mode
ENV CI=true

WORKDIR /srv/app/

RUN corepack enable


#############
# Serve Strapi in development mode.

FROM base-image AS development

ENV CI=false

RUN mkdir \
        /srv/.pnpm-store \
        /srv/app/node_modules \
    && chown node:node \
        /srv/.pnpm-store \
        /srv/app/node_modules

VOLUME /srv/.pnpm-store
VOLUME /srv/app
VOLUME /srv/app/node_modules

USER node

ENTRYPOINT ["/srv/app/docker-entrypoint.sh"]
CMD ["pnpm", "run", "develop"]
EXPOSE 1337


################################################################################
# Prepare

FROM base-image AS prepare

COPY ./pnpm-lock.yaml ./package.json ./pnpm-workspace.yaml ./

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm fetch

COPY ./ ./

RUN pnpm install --offline

################################################################################
# Lint

FROM prepare AS lint

RUN pnpm run lint


################################################################################
# Build

FROM prepare AS build

ENV NODE_ENV=production

RUN pnpm run build \
  && pnpm install --ignore-scripts --prod


################################################################################
FROM build AS production

RUN --mount=type=cache,id=apk-cache,target=/var/cache/apk \
    apk add --no-cache vips-dev

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}
ENV PATH=/srv/node_modules/.bin:$PATH

COPY --from=lint /srv/app/package.json /dev/null

USER node

ENTRYPOINT ["/srv/app/docker-entrypoint.sh"]
CMD ["pnpm", "run", "start"]
EXPOSE 1337
