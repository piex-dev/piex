FROM python:3.12-slim-bookworm

RUN pip install --no-cache-dir swebench==3.1.0

WORKDIR /workspace

# SWE-bench per-repo base image — used by Phase 2 (src/benchmarks/swebench.ts).
# Provides Python + swebench harness. Derivative images pre-install per-repo deps.
