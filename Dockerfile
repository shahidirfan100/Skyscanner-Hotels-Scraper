FROM apify/actor-node:22

COPY --chown=myuser:myuser package*.json Dockerfile ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --include=optional \
    && node -e "import('impit').then(() => console.log('impit native modules loaded'))" \
    && rm -rf ~/.npm

COPY --chown=myuser:myuser . ./

ENV APIFY_LOG_LEVEL=INFO

CMD npm start --silent
