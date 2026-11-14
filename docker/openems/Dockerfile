# Headless openEMS electromagnetic FDTD solver with Python bindings.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/opt/openEMS/venv/bin:$PATH \
    LD_LIBRARY_PATH=/opt/openEMS/lib:/opt/openEMS/lib64 \
    MPLBACKEND=Agg \
    OPENEMS_INSTALL_PATH=/opt/openEMS \
    CSXCAD_INSTALL_PATH=/opt/openEMS
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git bash python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*
# Build from the upstream headless installer; pin this ref for reproducibility
# once the initial build has been validated.
ARG OPENEMS_PROJECT_REF=master
RUN git clone --recursive https://github.com/thliebig/openEMS-Project.git /tmp/openEMS-Project && \
    cd /tmp/openEMS-Project && git checkout "$OPENEMS_PROJECT_REF" && \
    git submodule update --init --recursive && \
    ./scripts/install_deps.sh --auto --disable-gui --python && \
    ./update_openEMS.sh --disable-GUI --python --njobs=2 /opt/openEMS && \
    rm -rf /tmp/openEMS-Project /var/lib/apt/lists/*
WORKDIR /work
CMD ["python", "-c", "import openEMS, CSXCAD; print('openEMS + CSXCAD Python imports OK')"]
