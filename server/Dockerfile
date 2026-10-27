# 用官方精简镜像，和 DSM 自带的 Node 版本对齐
FROM node:18-alpine

RUN apk add --no-cache tzdata \
 && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
 && echo "Asia/Shanghai" > /etc/timezone

WORKDIR /app
COPY package.json ./
COPY server.mjs ./

# 数据卷：宿主机 /volume3/docker/photo-wall 挂进来
ENV DATA_DIR=/data \
    PORT=8788 \
    TZ=Asia/Shanghai \
    NODE_ENV=production

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8788
VOLUME ["/data"]

HEALTHCHECK --interval=60s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8788/api/health',r=>process.exit(r.statusCode===401?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.mjs"]
