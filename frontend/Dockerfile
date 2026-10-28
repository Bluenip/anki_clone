# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ARG VITE_PACKAGE_API_URL=
ENV VITE_PACKAGE_API_URL=$VITE_PACKAGE_API_URL
RUN npm run build

# Stage 2: Serve with Nginx
FROM nginx:alpine

# Copy built files
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
