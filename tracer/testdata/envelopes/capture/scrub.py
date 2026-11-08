#!/usr/bin/env python3
"""Scrub a tracer dump (TRACER_DUMP_DIR pair: <base>.body + <base>.meta.json) into a
committed fixture: decompress, replace credentials and device identifiers with fixed
values, recompute item lengths. Usage: scrub.py <dump-base> <out.envelope> [<other-dump-base>…]
Extra dump bases are only read to learn identifiers (an id first seen in another
envelope of the same run is still replaced).
Writes <out.envelope> (plain) and <out>.meta.json (sender headers, redacted)."""
import gzip, json, sys, zlib

FIXTURE_KEY = "fixturewritekeyfixturewritekey00"
FIXTURE_RES = "trc_fixture01"
FIXTURE_DSN = f"https://{FIXTURE_KEY}@trace.invalid/{FIXTURE_RES}"
FIXED_DEVICE = "0" * 32

def parse(b):
    head, rest = b.split(b"\n", 1) if b"\n" in b else (b, b"")
    items = []
    while rest.strip():
        ih, rest = rest.split(b"\n", 1) if b"\n" in rest else (rest, b"")
        ih = json.loads(ih)
        if "length" in ih:
            p = rest[: ih["length"]]
            rest = rest[ih["length"]:]
            if rest.startswith(b"\n"):
                rest = rest[1:]
        else:
            p, _, rest = rest.partition(b"\n")
        items.append([ih, p])
    return json.loads(head), items

SEEN = {}  # original value -> same-length fixture value, applied to every payload's bytes

def remember(orig, kind):
    if not isinstance(orig, str) or not orig or orig in SEEN:
        return
    if kind == "id":
        SEEN[orig] = ("0" * len(orig))
    elif kind == "time":
        SEEN[orig] = "2026-01-01T00:00:00.000Z"[: len(orig)].ljust(len(orig), "0")
    elif kind == "tz":
        SEEN[orig] = ("UTC" if len(orig) == 3 else "Etc/UTC".ljust(len(orig), "_"))[: len(orig)]

def collect(e):
    u = e.get("user") if isinstance(e, dict) else None
    if isinstance(u, dict): remember(u.get("id"), "id")
    ctx = (e.get("contexts") or {}) if isinstance(e, dict) else {}
    dev = ctx.get("device") or {}
    remember(dev.get("id"), "id"); remember(dev.get("boot_time"), "time"); remember(dev.get("timezone"), "tz")
    cul = ctx.get("culture") or {}
    remember(cul.get("timezone"), "tz")
    if isinstance(e, dict): remember(e.get("did"), "id")

def scrub_event(e):
    u = e.get("user")
    if isinstance(u, dict):
        if "id" in u: u["id"] = FIXED_DEVICE
        u.pop("ip_address", None); u.pop("email", None); u.pop("username", None)
    dev = (e.get("contexts") or {}).get("device")
    if isinstance(dev, dict):
        for k in ("id", "name", "boot_time"):
            if k in dev: dev[k] = FIXED_DEVICE if k == "id" else ("fixture-device" if k == "name" else "2026-01-01T00:00:00.000Z")
    return e

def scrub_payload(ih, p):
    t = ih.get("type")
    if t in ("event", "transaction", "feedback"):
        return json.dumps(scrub_event(json.loads(p)), separators=(",", ":")).encode()
    if t in ("session",):
        s = json.loads(p)
        if "did" in s: s["did"] = FIXED_DEVICE
        return json.dumps(s, separators=(",", ":")).encode()
    if t == "sessions":
        s = json.loads(p)
        return json.dumps(s, separators=(",", ":")).encode()
    if t == "log":
        s = json.loads(p)
        for it in s.get("items", []):
            attrs = it.get("attributes") or {}
            for k in ("user.id", "device.id", "user.email", "user.name"):
                if k in attrs: attrs[k]["value"] = FIXED_DEVICE
        return json.dumps(s, separators=(",", ":")).encode()
    if ih.get("attachment_type") == "event.view_hierarchy" or (t == "attachment" and ih.get("content_type") == "application/json"):
        return p  # widget tree of the synthetic capture app
    return p

def main():
    base, out = sys.argv[1], sys.argv[2]
    for other in sys.argv[3:]:
        oraw = open(other + ".body", "rb").read()
        try:
            oraw = gzip.decompress(oraw)
        except OSError:
            pass
        for _, op in parse(oraw)[1]:
            try:
                collect(json.loads(op))
            except Exception:
                pass
    raw = open(base + ".body", "rb").read()
    meta = json.load(open(base + ".meta.json"))
    enc = meta["headers"].get("Content-Encoding", "")
    if enc == "gzip": raw = gzip.decompress(raw)
    elif enc == "deflate": raw = zlib.decompress(raw)
    head, items = parse(raw)
    for ih, p in items:
        try:
            collect(json.loads(p))
        except Exception:
            pass
    if "dsn" in head: head["dsn"] = FIXTURE_DSN
    tr = head.get("trace")
    if isinstance(tr, dict) and "public_key" in tr: tr["public_key"] = FIXTURE_KEY
    lines = [json.dumps(head, separators=(",", ":")).encode()]
    for ih, p in items:
        p = scrub_payload(ih, p)
        # Same-length byte replacement catches the values inside binary or
        # nested payloads (replay_video is msgpack holding a replay_event).
        for orig, fixed in SEEN.items():
            p = p.replace(orig.encode(), fixed.encode())
        ih["length"] = len(p)
        lines.append(json.dumps(ih, separators=(",", ":")).encode())
        lines.append(p)
    body = b"\n".join(lines) + b"\n"
    open(out, "wb").write(body)
    hdrs = {k: v for k, v in meta["headers"].items() if k in ("Content-Encoding", "Content-Type", "User-Agent", "X-Sentry-Auth")}
    if "X-Sentry-Auth" in hdrs:
        hdrs["X-Sentry-Auth"] = hdrs["X-Sentry-Auth"].replace("<redacted>", FIXTURE_KEY)
    json.dump({"path": meta["path"].replace(meta["path"].split("/")[2], FIXTURE_RES), "headers": hdrs}, open(out[: -len(".envelope")] + ".meta.json", "w"), indent=2, sort_keys=True)
    open(out[: -len(".envelope")] + ".meta.json", "a").write("\n")

main()
