# syntax=docker/dockerfile:1.7

# Runtime-only image used on the cloud host. Build frontend/dist locally first.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/cloud/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY frontend/dist /usr/share/nginx/html
EXPOSE 8080
