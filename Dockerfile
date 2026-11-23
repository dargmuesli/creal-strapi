# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183

#############
# Create base image.

FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS base-image

# The `CI` environment variable must be set for pnpm to run in headless mode
ENV CI=true

WORKDIR /srv/app/

RUN npm i -g pnpm


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
