import fs from "node:fs";
import path from "node:path";
import { Snapshot, Ticker, IntervalReport, SavedReport } from "./types.js";

const DATA_DIR = path.join(process.cwd(), "data");
const SNAPSHOTS_FILE = path.join(DATA_DIR, "snapshots.json");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");
const DEFAULT_MAX_SNAPSHOTS = 1_440; // 24 hours at one snapshot per minute
const DEFAULT_MAX_REPORTS = 720; // enough for latest interval outputs without bloating dashboard fetches

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function keepNewest<T>(items: T[], maxItems: number): T[] {
  if (items.length <= maxItems) return items;
  return items.slice(items.length - maxItems);
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(SNAPSHOTS_FILE)) {
    fs.writeFileSync(SNAPSHOTS_FILE, "[]\n", "utf-8");
  }
  if (!fs.existsSync(REPORTS_FILE)) {
    fs.writeFileSync(REPORTS_FILE, "[]\n", "utf-8");
  }
}

export function loadSnapshots(): Snapshot[] {
  ensureDataDir();
  if (!fs.existsSync(SNAPSHOTS_FILE)) return [];

  try {
    const raw = fs.readFileSync(SNAPSHOTS_FILE, "utf-8");
    return JSON.parse(raw) as Snapshot[];
  } catch {
    console.error("[storage] Failed to parse snapshots file, starting fresh.");
    return [];
  }
}

export function saveSnapshot(tickers: Ticker[]): Snapshot {
  const snapshots = loadSnapshots();
  const maxSnapshots = positiveIntFromEnv("PRICE_MONITORING_MAX_SNAPSHOTS", DEFAULT_MAX_SNAPSHOTS);
  const now = new Date();

  const newSnapshot: Snapshot = {
    timestamp: now.toISOString(),
    tickers,
  };

  snapshots.push(newSnapshot);
  const retainedSnapshots = keepNewest(snapshots, maxSnapshots);

  fs.writeFileSync(SNAPSHOTS_FILE, JSON.stringify(retainedSnapshots, null, 2), "utf-8");
  console.log(
    `[storage] Saved snapshot at ${newSnapshot.timestamp}. Total kept: ${retainedSnapshots.length}`
  );

  return newSnapshot;
}

/**
 * Find the snapshot whose timestamp is closest to (now - targetMs).
 * Returns null if no snapshots exist or none are within tolerance.
 */
export function findClosestSnapshot(
  snapshots: Snapshot[],
  targetMs: number,
  toleranceMs = 10 * 60 * 1000 // ±10 min tolerance
): Snapshot | null {
  if (snapshots.length === 0) return null;

  const targetTime = Date.now() - targetMs;
  let best: Snapshot | null = null;
  let bestDiff = Infinity;

  for (const s of snapshots) {
    const diff = Math.abs(new Date(s.timestamp).getTime() - targetTime);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }

  if (best && bestDiff <= toleranceMs) return best;
  return null;
}

export function saveReport(report: IntervalReport, runAt: string): void {
  ensureDataDir();
  const maxReports = positiveIntFromEnv("PRICE_MONITORING_MAX_REPORTS", DEFAULT_MAX_REPORTS);

  let reports: SavedReport[] = [];
  if (fs.existsSync(REPORTS_FILE)) {
    try {
      reports = JSON.parse(fs.readFileSync(REPORTS_FILE, "utf-8")) as SavedReport[];
    } catch {
      console.error("[storage] Failed to parse reports file, starting fresh.");
    }
  }

  reports.push({ ...report, run_at: runAt });
  const retainedReports = keepNewest(reports, maxReports);

  fs.writeFileSync(REPORTS_FILE, JSON.stringify(retainedReports, null, 2), "utf-8");
}
