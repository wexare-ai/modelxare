# The development relay's strfry image (pinned by digest), plus Node for the
# write policy, which strfry runs as a plugin. Still runs as the image's
# unprivileged strfry user.
FROM ghcr.io/hoytech/strfry@sha256:36f1886d185a88ca57c66ebe52e6e9e8428dac2486eea0a5d50ff934f18b60c3
USER root
RUN apk add --no-cache nodejs
COPY strfry.conf.template render-config.mjs write-policy.mjs /app/deploy/
RUN chmod 644 /app/deploy/* && chmod 755 /app/deploy/write-policy.mjs
USER strfry
ENTRYPOINT ["/bin/sh", "-c", "node /app/deploy/render-config.mjs > /tmp/strfry.conf && exec /app/strfry --config=/tmp/strfry.conf relay"]
