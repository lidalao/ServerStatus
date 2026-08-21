FROM nginx:alpine

LABEL maintainer="lidalao"
LABEL description="Static dashboard frontend for ServerStatus"

# 前端静态资源打包进镜像(json/stats.json 运行时由 ./json 挂载提供)
COPY . /usr/share/nginx/html

# 覆盖默认 server 块: 给 html/css/js 加 no-cache 头
# (nginx.conf 不能进 .dockerignore, 否则这里 COPY 不到; 改成事后从站点根目录删)
COPY nginx.conf /etc/nginx/conf.d/default.conf
RUN rm -f /usr/share/nginx/html/nginx.conf && nginx -t
