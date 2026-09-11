# Docker/Podman/Kubernetes file for running the bot

# Enable/disable usage of liblqr
ARG LQR="1"

FROM node:lts-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
RUN apk add --no-cache msttcorefonts-installer freetype fontconfig \
		vips vips-cpp grep libltdl icu-libs zxing-cpp
RUN update-ms-fonts && fc-cache -fv
RUN mkdir /built
WORKDIR /app

# Path without liblqr
FROM base AS native-build-0
RUN apk add --no-cache git cmake python3 alpine-sdk \
		fontconfig-dev vips-dev zxing-cpp-dev

# Path with liblqr
FROM base AS native-build-1
RUN apk add --no-cache git cmake python3 alpine-sdk libtool glib-dev \
		fontconfig-dev vips-dev zxing-cpp-dev

# liblqr needs to be built manually since alpine doesn't have it in their repos.
# This is the expensive stage, and it only depends on the base image, so it stays
# cached until the base image itself changes.
RUN git clone --depth 1 https://github.com/carlobaldassi/liblqr ~/liblqr \
		&& cd ~/liblqr \
		&& ./configure --prefix=/usr \
		&& make -j$(nproc) \
		&& make DESTDIR=/built install \
		&& rm -rf ~/liblqr

RUN cp -a /built/* /

FROM native-build-${LQR} AS build
ARG LQR
# Each COPY below pulls in only what the step after it actually reads, so that
# touching an unrelated file doesn't invalidate an expensive layer. The natives
# build in particular is by far the slowest step here, so it goes first and sees
# only the files it compiles from.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml /app/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Rebuilt only when natives/, CMakeLists.txt or the package version change.
# Detect liblqr usage and adjust build accordingly
COPY CMakeLists.txt /app/
COPY natives /app/natives
RUN if [ "$LQR" = "1" ] ; then pnpm run build:natives --CDWITH_BACKWARD=OFF ; else pnpm run build:natives:no-lqr --CDWITH_BACKWARD=OFF ; fi

# Rebuilt only when src/, config/ or tsconfig.json change. config/ is here
# because tsconfig maps #config/* onto it, so tsc reads it at compile time.
COPY tsconfig.json /app/
COPY config /app/config
COPY src /app/src
RUN pnpm run build:ts

FROM native-build-${LQR} AS prod-deps
COPY package.json /app/
COPY pnpm-workspace.yaml /app/
COPY pnpm-lock.yaml /app/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM base
COPY . /app
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/build/Release /app/build/Release
COPY --from=build /app/dist /app/dist
COPY --from=build /built/ /
RUN rm -f .env
RUN rm -rf src natives

RUN mkdir /app/help && chmod 777 /app/help
RUN mkdir /app/temp && chmod 777 /app/temp
RUN mkdir /app/logs && chmod 777 /app/logs

ENTRYPOINT ["node"]
CMD ["dist/app.js"]
