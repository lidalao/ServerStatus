FROM nginx:alpine

LABEL maintainer="lidalao"
LABEL description="Static dashboard frontend for ServerStatus"

# 前端静态资源打包进镜像(json/stats.json 运行时由 ./json 挂载提供)
COPY . /usr/share/nginx/html
