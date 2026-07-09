# Multi-stage build: frontend (Node) → backend (Go) → minimal runtime image.
# Result: a ~20 MB image containing one static binary and the built frontend.

FROM node:22-alpine AS frontend
# Provenance for the in-app version link; .git is not in the build context.
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.24-alpine AS backend
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /otelflow ./cmd/server
# In-browser validator: WASM build of the validation engine + Go's JS shim.
RUN GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o /validate.wasm ./cmd/wasm && \
    cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" /wasm_exec.js

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=backend /otelflow /app/otelflow
COPY --from=frontend /app/web/dist /app/web/dist
COPY --from=backend /validate.wasm /app/web/dist/validate.wasm
COPY --from=backend /wasm_exec.js /app/web/dist/wasm_exec.js
EXPOSE 7317
ENTRYPOINT ["/app/otelflow"]
