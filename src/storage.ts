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

// Write via a temp file + atomic rename so a crash mid-write can never leave a
// truncated JSON array that trips Array.isArray guards on the next load.
function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

// parseJsonArray tolerates a corrupt/non-array file instead of letting a
// TypeError crash the collector permanently; [] is the safe "fresh start" shape.
function parseJsonArray<T>(file: string, label: string): T[] {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    console.error(`[storage] Failed to parse ${label} file, starting fresh.`);
    return [];
  }
}

export function loadSnapshots(): Snapshot[] {
  ensureDataDir();
  if (!fs.existsSync(SNAPSHOTS_FILE)) return [];
  return parseJsonArray<Snapshot>(SNAPSHOTS_FILE, "snapshots");
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

  writeJsonAtomic(SNAPSHOTS_FILE, retainedSnapshots);
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
    reports = parseJsonArray<SavedReport>(REPORTS_FILE, "reports");
  }

  reports.push({ ...report, run_at: runAt });
  const retainedReports = keepNewest(reports, maxReports);

  writeJsonAtomic(REPORTS_FILE, retainedReports);
}
