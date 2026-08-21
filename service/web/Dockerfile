FROM nginx:alpine

LABEL maintainer="lidalao"
LABEL description="Static dashboard frontend for ServerStatus"

# 前端静态资源打包进镜像(json/stats.json 运行时由 ./json 挂载提供)
COPY . /usr/share/nginx/html

# 覆盖默认 server 块: 给 html/css/js 加 no-cache 头
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 配置写错的话在这里就构建失败, 而不是等容器起来 crash loop
RUN nginx -t
