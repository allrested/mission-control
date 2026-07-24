FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server sudo git curl ca-certificates jq procps bash \
    && rm -rf /var/lib/apt/lists/*

# Agent CLIs on PATH for interactive use.
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Shared-repos group + mountpoint (setgid so new files inherit the group).
RUN groupadd devs \
    && mkdir -p /srv/repos /var/run/sshd \
    && chgrp devs /srv/repos && chmod 2775 /srv/repos

COPY sshd_config /etc/ssh/sshd_config
COPY reconcile-users.sh /usr/local/bin/reconcile-users.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/reconcile-users.sh /usr/local/bin/entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
