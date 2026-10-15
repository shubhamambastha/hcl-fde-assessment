"""
Small utility module provided as an optional starting point for the
API integration health case study.

Feel free to use, modify, replace, or ignore this entirely -- it is not
guaranteed to be complete or bug-free.
"""
import json


def load_logs(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("logs", [])


def logs_for_integration(logs, integration_name):
    return [l for l in logs if l["integration"] == integration_name]


def compute_error_rate(logs):
    """
    Error rate as a percentage, over requests that either succeeded or
    explicitly errored out.
    """
    relevant = [l for l in logs if l["status"] in ("success", "error")]
    if not relevant:
        return 0.0
    errors = sum(1 for l in relevant if l["status"] == "error")
    return errors / len(relevant) * 100


def average_latency_ms(logs):
    latencies = [l["latency_ms"] for l in logs if l["status"] == "success"]
    if not latencies:
        return None
    return sum(latencies) / len(latencies)


def summarize_integrations(logs):
    """Return a dict of integration_name -> {error_rate_pct, avg_latency_ms, count}."""
    integrations = sorted(set(l["integration"] for l in logs))
    summary = {}
    for name in integrations:
        entries = logs_for_integration(logs, name)
        summary[name] = {
            "error_rate_pct": compute_error_rate(entries),
            "avg_latency_ms": average_latency_ms(entries),
            "count": len(entries),
        }
    return summary
