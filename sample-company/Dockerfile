FROM node:24-alpine AS build
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.base.json ./
COPY examples/external-services/sample-company/package.json examples/external-services/sample-company/package.json
RUN npm ci
COPY examples/external-services/sample-company examples/external-services/sample-company
RUN npm run build --workspace @digital-workforce-examples/sample-company

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=build /workspace/package.json /workspace/package-lock.json ./
COPY --from=build /workspace/node_modules node_modules
COPY --from=build /workspace/examples/external-services/sample-company/package.json examples/external-services/sample-company/package.json
COPY --from=build /workspace/examples/external-services/sample-company/dist examples/external-services/sample-company/dist
USER 1000