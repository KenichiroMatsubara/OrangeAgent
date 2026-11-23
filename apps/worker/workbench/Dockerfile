# The image every container OrangeAgent lends a run's code starts from (ADR 0202):
# Python 3 with the libraries that read and write office files, tables, PDFs,
# and charts, Node.js, and Japanese fonts, so a chart or a PDF made here sets
# Japanese in a Japanese face. The container is started with no network, so
# nothing can be installed at run time: what the code needs is here.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip fonts-noto-cjk fontconfig coreutils findutils \
  && rm -rf /var/lib/apt/lists/* \
  && fc-cache -f

RUN pip3 install --no-cache-dir --break-system-packages \
  pandas openpyxl python-docx python-pptx reportlab matplotlib pypdf

# matplotlib sets Japanese in Noto Sans CJK rather than a face without its glyphs.
RUN mkdir -p /etc/matplotlib && printf 'font.family: Noto Sans CJK JP\n' > /etc/matplotlib/matplotlibrc

# The helper the Sandbox SDK's Files runs to move a job's files in and out. Its tag
# is the version of @cloudflare/sandbox in apps/worker/package.json: the two speak
# one protocol, so they change together (deployment-contract.test.ts holds them so).
COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

RUN mkdir -p /workspace/out
WORKDIR /workspace

# The Durable Object runs every command with exec; the container itself only waits.
CMD ["sleep", "infinity"]
